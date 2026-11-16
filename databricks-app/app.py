"""Chat-completions relay for the Instagram privacy-risk Chrome extension.

Drop-in replacement for a Databricks model serving endpoint: the local
Node backend (backend/src/databricks.ts) calls
POST /serving-endpoints/<name>/invocations with {messages, max_tokens,
temperature} plus a Databricks bearer token. The app forwards the
messages verbatim to a system.ai model service via the Unity Gateway
MLflow Chat Completions API and returns the standard
{choices: [{message: {content}}]} shape.

Only text passes through. Message content (post text) is never logged —
only request metadata: counts, sizes, latency. The Databricks token the
Node backend sends (DATABRICKS_TOKEN in backend/.env) acts as its API
key; the Apps proxy enforces it.

Because the Apps proxy only accepts external token-authenticated calls
on routes under /api/, the relay is also exposed at POST
/api/v1/serving-endpoints/<name>/invocations with identical behavior —
that is the path the Node backend should use. GET /api/health provides a
token-friendly health check.

The app also stores user-approved, published post history (text only) in
Unity Catalog under /api/v1/history/*, always isolated by the caller's
userId, with real row deletion on delete endpoints.
"""

import json
import logging
import os
import re
import time

import requests
from databricks.sdk import WorkspaceClient
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("instagram-risk-analyzer")

LOG_TABLE = "workspace.instagram_risk.relay_requests"

# Serving-endpoint names this app answers to, mapped to Unity Gateway model
# services. Unknown names get a 404 — the same semantics the Node backend's
# error hints expect ("Check DATABRICKS_HOST and DATABRICKS_SERVING_ENDPOINT").
ALLOWED_MODELS = {
    "gpt-oss-120b": "system.ai.gpt-oss-120b",
    "system.ai.gpt-oss-120b": "system.ai.gpt-oss-120b",
    "llama-4-maverick": "system.ai.llama-4-maverick",
    "system.ai.llama-4-maverick": "system.ai.llama-4-maverick",
}
DEFAULT_MODEL = "system.ai.gpt-oss-120b"

# History storage (user-approved, published posts; text only)
POSTS_TABLE = "workspace.instagram_risk.observed_posts"
APPROVALS_TABLE = "workspace.instagram_risk.history_approvals"
INTERP_TABLE = "workspace.instagram_risk.ai_interpretations"
API_LOG_TABLE = "workspace.instagram_risk.api_request_log"

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_IMPORT_POSTS = 200
MAX_SAVE_INTERPRETATIONS = 100
MAX_IDS_PER_INTERPRETATION = 64
MAX_TEXT_CHARS = 5000

app = FastAPI(title="Instagram Risk Analyzer")

# The local Node backend calls server-to-server, so CORS is irrelevant, but
# keep permissive middleware so browser-based debugging also works. No
# cookies are used, so wildcard origins are safe here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def _unhandled_to_detail(request, exc):
    """Never leak a plain-text 500: unhandled failures become {"detail": ...} 502."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=502,
        content={
            "detail": (
                f"upstream or internal failure: {type(exc).__name__}: "
                f"{str(exc)[:300]}"
            )
        },
    )


# The Apps runtime provides DATABRICKS_HOST, DATABRICKS_CLIENT_ID, and
# DATABRICKS_CLIENT_SECRET for the app's service principal; the SDK discovers
# them and mints an OAuth bearer token for each call.
w = WorkspaceClient()


class ChatMessage(BaseModel):
    role: str
    content: str


class InvocationRequest(BaseModel):
    messages: list[ChatMessage]
    max_tokens: int = 2000
    temperature: float = 0.1


def _auth_headers() -> dict:
    return {**w.config.authenticate(), "Content-Type": "application/json"}


def _relay_chat(service: str, messages: list, max_tokens: int, temperature: float) -> str:
    """Forward chat messages to the model service; return the model's text.

    The Node backend aborts after 45s, so timeout at 40s to fail first.
    """
    url = f"{w.config.host.rstrip('/')}/ai-gateway/mlflow/v1/chat/completions"
    body = {
        "model": service,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    try:
        headers = _auth_headers()
    except Exception as e:
        # The app's OWN identity failed to authenticate for the model call.
        # SDK errors are not requests errors, so catch them explicitly —
        # otherwise they escape as an unhandled 500.
        logger.exception("App identity authentication for model call failed")
        raise HTTPException(
            status_code=502,
            detail=(
                "App identity could not authenticate to the model service: "
                f"{type(e).__name__}: {str(e)[:200]}"
            ),
        )
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=40)
    except requests.Timeout:
        raise HTTPException(status_code=504, detail="Model service did not answer within 40s.")
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Could not reach model service: {e}")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Model service error ({resp.status_code}): {resp.text[:300]}",
        )
    try:
        content = resp.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise HTTPException(
            status_code=502,
            detail=f"Model service returned an unreadable response: {e}",
        )
    # Some models return content as a list of text blocks — join them like
    # the Node backend's extractText() does.
    if isinstance(content, list):
        content = "\n".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    if not isinstance(content, str):
        raise HTTPException(status_code=502, detail="Model service returned no text content.")
    return content


def _warehouse_id() -> str:
    """Pick a SQL warehouse for the logging INSERT (prefer a running one)."""
    warehouses = list(w.warehouses.list())
    if not warehouses:
        raise RuntimeError("no SQL warehouse available in the workspace")

    def state_of(wh) -> str:
        return (getattr(wh.state, "value", None) or str(wh.state) or "").upper()

    running = [wh for wh in warehouses if state_of(wh) == "RUNNING"]
    return (running or warehouses)[0].id


def log_relay(endpoint_name: str, message_count: int, request_chars: int, response_chars: int, latency_ms: int, service: str):
    """INSERT request metadata (never message content) into the UC table.

    Returns an error message on failure, or None. Only counts, sizes, the
    endpoint name, and latency are stored — never prompts, post text,
    quotes, or model output.
    """
    try:
        host = w.config.host.rstrip("/")
        statement = (
            f"INSERT INTO {LOG_TABLE} (endpoint_name, message_count, request_chars, "
            "response_chars, latency_ms, model, analyzed_at) VALUES "
            "(:endpoint_name, :message_count, :request_chars, :response_chars, "
            ":latency_ms, :model, current_timestamp())"
        )
        created = requests.post(
            f"{host}/api/2.0/sql/statements/",
            headers=_auth_headers(),
            json={
                "statement": statement,
                "warehouse_id": _warehouse_id(),
                "wait_timeout": "50s",
                "parameters": [
                    {"name": "endpoint_name", "value": endpoint_name, "type": "STRING"},
                    {"name": "message_count", "value": str(message_count), "type": "INT"},
                    {"name": "request_chars", "value": str(request_chars), "type": "INT"},
                    {"name": "response_chars", "value": str(response_chars), "type": "INT"},
                    {"name": "latency_ms", "value": str(latency_ms), "type": "INT"},
                    {"name": "model", "value": service, "type": "STRING"},
                ],
            },
            timeout=60,
        )
        created.raise_for_status()
        state = created.json()

        # Poll if the wait window expired before the INSERT finished.
        for _ in range(4):
            if state.get("status", {}).get("state") in ("SUCCEEDED", "FAILED", "CANCELED"):
                break
            time.sleep(3)
            got = requests.get(
                f"{host}/api/2.0/sql/statements/{state['statement_id']}",
                headers=_auth_headers(),
                timeout=30,
            )
            got.raise_for_status()
            state = got.json()

        if state.get("status", {}).get("state") != "SUCCEEDED":
            reason = state.get("status", {}).get("state")
            return f"insert finished in state {reason}"
        return None
    except Exception as e:  # logging must never break the analysis response
        logger.exception("Failed to log relay metadata to %s", LOG_TABLE)
        return str(e)


MAX_MESSAGES = 64
MAX_TOTAL_CHARS = 80000
MAX_TOKENS_CAP = 4000


@app.get("/")
def health():
    return {"status": "ok", "model": DEFAULT_MODEL}


def _invoke_chat(endpoint_name: str, req: InvocationRequest):
    """Serve a serving-endpoint-style chat invocation (backend/src/databricks.ts)."""
    service = ALLOWED_MODELS.get(endpoint_name)
    if service is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Unknown serving endpoint {endpoint_name!r}. Available: "
                + ", ".join(sorted(set(ALLOWED_MODELS)))
            ),
        )
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages must be a non-empty list")
    if len(req.messages) > MAX_MESSAGES:
        raise HTTPException(
            status_code=413, detail=f"too many messages: {len(req.messages)} > {MAX_MESSAGES}"
        )
    if any(m.role not in ("system", "user", "assistant") for m in req.messages):
        raise HTTPException(
            status_code=400,
            detail='message roles must be "system", "user", or "assistant"',
        )
    request_chars = sum(len(m.content) for m in req.messages)
    if request_chars > MAX_TOTAL_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"messages total {request_chars} chars > {MAX_TOTAL_CHARS}",
        )
    max_tokens = min(max(1, req.max_tokens), MAX_TOKENS_CAP)
    temperature = min(max(0.0, req.temperature), 1.0)
    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    started = time.time()
    text = _relay_chat(service, messages, max_tokens, temperature)  # raises on failure
    latency_ms = int((time.time() - started) * 1000)
    log_error = log_relay(
        endpoint_name, len(messages), request_chars, len(text), latency_ms, service
    )
    if log_error:
        logger.warning("relay metadata logging failed: %s", log_error)
    return {
        "choices": [
            {"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
        "model": service,
    }


# ---------------------------------------------------------------------------
# Token-friendly routes. The Apps proxy only accepts token-authenticated
# external calls on /api/* routes, so the relay (and a health check) are
# mirrored there with identical behavior.
# ---------------------------------------------------------------------------


@app.get("/api/health")
def api_health():
    return {"status": "ok", "model": DEFAULT_MODEL}


@app.post("/serving-endpoints/{endpoint_name}/invocations")
def invoke(endpoint_name: str, req: InvocationRequest):
    return _invoke_chat(endpoint_name, req)


@app.post("/api/v1/serving-endpoints/{endpoint_name}/invocations")
def invoke_v1(endpoint_name: str, req: InvocationRequest):
    return _invoke_chat(endpoint_name, req)


# ---------------------------------------------------------------------------
# History storage: only posts the user explicitly approved, only published
# posts, text only (never images). Every query is filtered by the userId in
# the request body so one user can never read, change, or delete another
# user's rows. Deletes are real DELETEs (no soft-delete flags).
# ---------------------------------------------------------------------------


class HistoryPost(BaseModel):
    postId: str
    status: str = "published"
    publishedAt: str
    caption: str
    imageText: str | None = None


class ImportRequest(BaseModel):
    userId: str
    approvalId: str
    approvedAt: str
    posts: list[HistoryPost]


class UserRequest(BaseModel):
    userId: str


class DeletePostRequest(UserRequest):
    postId: str


class RevokeApprovalRequest(UserRequest):
    approvalId: str


class EvidenceItem(BaseModel):
    sourceId: str
    quote: str


class InterpretationItem(BaseModel):
    interpretationId: str
    postIds: list[str]
    category: str
    severity: str
    exposure: str
    evidence: list[EvidenceItem]
    model: str
    promptVersion: str
    requestId: str
    createdAt: str


class SaveInterpretationsRequest(UserRequest):
    interpretations: list[InterpretationItem]


def _param(name: str, value, type_: str = "STRING") -> dict:
    return {"name": name, "value": value if isinstance(value, str) else str(value), "type": type_}


def _run_sql(statement: str, params: list | None = None, fetch: bool = False):
    """Run one parameterized SQL statement; return rows when fetch=True.

    Raises HTTPException 500 on database failure. Errors never contain
    request content — only the database's own message, truncated.
    """
    host = w.config.host.rstrip("/")
    body: dict = {
        "statement": statement,
        "warehouse_id": _warehouse_id(),
        "wait_timeout": "50s",
    }
    if params:
        body["parameters"] = params
    if fetch:
        body["disposition"] = "INLINE"
        body["format"] = "JSON_ARRAY"
        body["row_limit"] = 10000
    created = requests.post(
        f"{host}/api/2.0/sql/statements/",
        headers=_auth_headers(),
        json=body,
        timeout=60,
    )
    created.raise_for_status()
    state = created.json()
    for _ in range(4):
        if state.get("status", {}).get("state") in ("SUCCEEDED", "FAILED", "CANCELED"):
            break
        time.sleep(3)
        got = requests.get(
            f"{host}/api/2.0/sql/statements/{state['statement_id']}",
            headers=_auth_headers(),
            timeout=30,
        )
        got.raise_for_status()
        state = got.json()
    status = state.get("status", {})
    if status.get("state") != "SUCCEEDED":
        msg = (status.get("error") or {}).get("message") or f"statement finished in state {status.get('state')}"
        raise HTTPException(status_code=500, detail=f"database error: {msg[:300]}")
    if fetch:
        return state.get("result", {}).get("data_array") or []
    return None


def _count(table: str, where: str, params: list) -> int:
    rows = _run_sql(f"SELECT COUNT(*) FROM {table} WHERE {where}", params, fetch=True)
    return int(rows[0][0]) if rows else 0


def _require_user(user_id: str) -> str:
    if not USER_ID_RE.match(user_id or ""):
        raise HTTPException(
            status_code=400,
            detail="userId must be 8-64 characters from [A-Za-z0-9_-]",
        )
    return user_id


def _log_api_call(endpoint_name: str, item_count: int, latency_ms: int):
    """Log endpoint name, count, latency only — never text, quotes, or userIds."""
    try:
        _run_sql(
            f"INSERT INTO {API_LOG_TABLE} (endpoint_name, item_count, latency_ms, analyzed_at) "
            "VALUES (:e, :n, :ms, current_timestamp())",
            [
                _param("e", endpoint_name),
                _param("n", item_count, "INT"),
                _param("ms", latency_ms, "INT"),
            ],
        )
    except Exception:
        logger.exception("Failed to log API call metadata to %s", API_LOG_TABLE)


@app.post("/api/v1/history/import")
def history_import(req: ImportRequest):
    u = _require_user(req.userId)
    if not req.approvalId or len(req.approvalId) > 256:
        raise HTTPException(status_code=400, detail="approvalId must be 1-256 characters")
    if not req.posts:
        raise HTTPException(status_code=400, detail="posts must be a non-empty list")
    if len(req.posts) > MAX_IMPORT_POSTS:
        raise HTTPException(
            status_code=413, detail=f"too many posts: {len(req.posts)} > {MAX_IMPORT_POSTS}"
        )
    seen: set[str] = set()
    for p in req.posts:
        if not p.postId or len(p.postId) > 256:
            raise HTTPException(status_code=400, detail="postId must be 1-256 characters")
        if p.postId in seen:
            raise HTTPException(status_code=400, detail=f"duplicate postId in import: {p.postId!r}")
        seen.add(p.postId)
        if p.status != "published":
            raise HTTPException(status_code=400, detail="only status 'published' is stored")
        if len(p.caption) > MAX_TEXT_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"caption exceeds {MAX_TEXT_CHARS} characters",
            )
        if p.imageText is not None and len(p.imageText) > MAX_TEXT_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"imageText exceeds {MAX_TEXT_CHARS} characters",
            )

    started = time.time()
    # Upsert the approval row (scoped to this user).
    _run_sql(
        f"DELETE FROM {APPROVALS_TABLE} WHERE user_id = :u AND approval_id = :a",
        [_param("u", u), _param("a", req.approvalId)],
    )
    _run_sql(
        f"INSERT INTO {APPROVALS_TABLE} (user_id, approval_id, approved_at, post_ids, revoked_at) "
        "VALUES (:u, :a, :approved, from_json(:pids, 'array<string>'), NULL)",
        [
            _param("u", u),
            _param("a", req.approvalId),
            _param("approved", req.approvedAt),
            _param("pids", json.dumps([p.postId for p in req.posts])),
        ],
    )
    # Re-importing an existing (userId, postId) replaces it and moves it to
    # the new approval: delete the old rows first, then insert in one batch.
    delete_marks = [f":d{i}" for i in range(len(req.posts))]
    delete_params = [_param("u", u)] + [
        _param(f"d{i}", p.postId) for i, p in enumerate(req.posts)
    ]
    _run_sql(
        f"DELETE FROM {POSTS_TABLE} WHERE user_id = :u AND post_id IN ({', '.join(delete_marks)})",
        delete_params,
    )
    insert_values = []
    insert_params = [_param("u", u), _param("a", req.approvalId)]
    for i, p in enumerate(req.posts):
        img = f":img{i}" if p.imageText is not None else "NULL"
        insert_values.append(
            f"(:u, :p{i}, 'published', :pub{i}, :cap{i}, {img}, :a, current_timestamp())"
        )
        insert_params += [
            _param(f"p{i}", p.postId),
            _param(f"pub{i}", p.publishedAt),
            _param(f"cap{i}", p.caption),
        ]
        if p.imageText is not None:
            insert_params.append(_param(f"img{i}", p.imageText))
    _run_sql(
        f"INSERT INTO {POSTS_TABLE} (user_id, post_id, status, published_at, caption, "
        "image_text, approval_id, imported_at) VALUES " + ", ".join(insert_values),
        insert_params,
    )
    _log_api_call("/api/v1/history/import", len(req.posts), int((time.time() - started) * 1000))
    return {"imported": len(req.posts)}


@app.post("/api/v1/history/list")
def history_list(req: UserRequest):
    u = _require_user(req.userId)
    started = time.time()
    rows = _run_sql(
        f"SELECT post_id, status, published_at, caption, image_text, approval_id, imported_at "
        f"FROM {POSTS_TABLE} WHERE user_id = :u ORDER BY imported_at, post_id",
        [_param("u", u)],
        fetch=True,
    )
    posts = []
    for r in rows:
        post = {
            "postId": r[0],
            "status": r[1],
            "publishedAt": r[2],
            "caption": r[3],
            "approvalId": r[5],
            "importedAt": r[6],
        }
        if r[4] is not None:
            post["imageText"] = r[4]
        posts.append(post)
    _log_api_call("/api/v1/history/list", len(posts), int((time.time() - started) * 1000))
    return {"posts": posts}


@app.post("/api/v1/history/delete-post")
def history_delete_post(req: DeletePostRequest):
    u = _require_user(req.userId)
    if not req.postId or len(req.postId) > 256:
        raise HTTPException(status_code=400, detail="postId must be 1-256 characters")
    started = time.time()
    # Deleting a post deletes every interpretation whose postIds include it.
    n_interp = _count(
        INTERP_TABLE,
        "user_id = :u AND array_contains(post_ids, :p)",
        [_param("u", u), _param("p", req.postId)],
    )
    if n_interp:
        _run_sql(
            f"DELETE FROM {INTERP_TABLE} WHERE user_id = :u AND array_contains(post_ids, :p)",
            [_param("u", u), _param("p", req.postId)],
        )
    n_posts = _count(
        POSTS_TABLE, "user_id = :u AND post_id = :p", [_param("u", u), _param("p", req.postId)]
    )
    if n_posts:
        _run_sql(
            f"DELETE FROM {POSTS_TABLE} WHERE user_id = :u AND post_id = :p",
            [_param("u", u), _param("p", req.postId)],
        )
    _log_api_call("/api/v1/history/delete-post", 1, int((time.time() - started) * 1000))
    return {"deletedPosts": 1 if n_posts else 0, "deletedInterpretations": n_interp}


@app.post("/api/v1/history/revoke-approval")
def history_revoke_approval(req: RevokeApprovalRequest):
    u = _require_user(req.userId)
    if not req.approvalId or len(req.approvalId) > 256:
        raise HTTPException(status_code=400, detail="approvalId must be 1-256 characters")
    started = time.time()
    exists = _count(
        APPROVALS_TABLE,
        "user_id = :u AND approval_id = :a",
        [_param("u", u), _param("a", req.approvalId)],
    )
    if not exists:
        _log_api_call("/api/v1/history/revoke-approval", 0, int((time.time() - started) * 1000))
        return {"found": False}
    # The approval's CURRENT posts (re-imported posts already moved away).
    rows = _run_sql(
        f"SELECT post_id FROM {POSTS_TABLE} WHERE user_id = :u AND approval_id = :a",
        [_param("u", u), _param("a", req.approvalId)],
        fetch=True,
    )
    pids = [r[0] for r in rows]
    n_interp = 0
    if pids:
        # Delete interpretations whose postIds include any of these posts.
        n_interp = _count(
            INTERP_TABLE,
            "user_id = :u AND arrays_overlap(post_ids, from_json(:pids, 'array<string>'))",
            [_param("u", u), _param("pids", json.dumps(pids))],
        )
        if n_interp:
            _run_sql(
                f"DELETE FROM {INTERP_TABLE} WHERE user_id = :u AND "
                "arrays_overlap(post_ids, from_json(:pids, 'array<string>'))",
                [_param("u", u), _param("pids", json.dumps(pids))],
            )
        _run_sql(
            f"DELETE FROM {POSTS_TABLE} WHERE user_id = :u AND approval_id = :a",
            [_param("u", u), _param("a", req.approvalId)],
        )
    _run_sql(
        f"UPDATE {APPROVALS_TABLE} SET revoked_at = current_timestamp() "
        "WHERE user_id = :u AND approval_id = :a",
        [_param("u", u), _param("a", req.approvalId)],
    )
    _log_api_call("/api/v1/history/revoke-approval", len(pids), int((time.time() - started) * 1000))
    return {"deletedPosts": len(pids), "deletedInterpretations": n_interp}


@app.post("/api/v1/history/delete-all")
def history_delete_all(req: UserRequest):
    u = _require_user(req.userId)
    started = time.time()
    n_interp = _count(INTERP_TABLE, "user_id = :u", [_param("u", u)])
    n_posts = _count(POSTS_TABLE, "user_id = :u", [_param("u", u)])
    if n_interp:
        _run_sql(f"DELETE FROM {INTERP_TABLE} WHERE user_id = :u", [_param("u", u)])
    if n_posts:
        _run_sql(f"DELETE FROM {POSTS_TABLE} WHERE user_id = :u", [_param("u", u)])
    _run_sql(f"DELETE FROM {APPROVALS_TABLE} WHERE user_id = :u", [_param("u", u)])
    _log_api_call("/api/v1/history/delete-all", n_posts, int((time.time() - started) * 1000))
    return {"deletedPosts": n_posts, "deletedInterpretations": n_interp}


@app.post("/api/v1/history/interpretations/save")
def history_save_interpretations(req: SaveInterpretationsRequest):
    u = _require_user(req.userId)
    if not req.interpretations:
        raise HTTPException(status_code=400, detail="interpretations must be a non-empty list")
    if len(req.interpretations) > MAX_SAVE_INTERPRETATIONS:
        raise HTTPException(
            status_code=413,
            detail=f"too many interpretations: {len(req.interpretations)} > {MAX_SAVE_INTERPRETATIONS}",
        )
    for it in req.interpretations:
        if not it.interpretationId or len(it.interpretationId) > 256:
            raise HTTPException(status_code=400, detail="interpretationId must be 1-256 characters")
        if not it.postIds:
            raise HTTPException(status_code=400, detail="postIds must be a non-empty list")
        if len(it.postIds) > MAX_IDS_PER_INTERPRETATION:
            raise HTTPException(
                status_code=413,
                detail=f"too many postIds: {len(it.postIds)} > {MAX_IDS_PER_INTERPRETATION}",
            )
        if not it.evidence:
            raise HTTPException(status_code=400, detail="evidence must be a non-empty list")

    started = time.time()
    saved = 0
    for it in req.interpretations:
        unique_pids = list(dict.fromkeys(it.postIds))
        # Every referenced post must still exist for THIS user.
        marks = [f":p{i}" for i in range(len(unique_pids))]
        params = [_param("u", u)] + [
            _param(f"p{i}", pid) for i, pid in enumerate(unique_pids)
        ]
        n_existing = _run_sql(
            f"SELECT COUNT(DISTINCT post_id) FROM {POSTS_TABLE} "
            f"WHERE user_id = :u AND post_id IN ({', '.join(marks)})",
            params,
            fetch=True,
        )
        if not n_existing or int(n_existing[0][0]) < len(unique_pids):
            continue  # skip: some postIds no longer exist for this user
        # Replace-on-resave for (userId, interpretationId).
        _run_sql(
            f"DELETE FROM {INTERP_TABLE} WHERE user_id = :u AND interpretation_id = :i",
            [_param("u", u), _param("i", it.interpretationId)],
        )
        _run_sql(
            f"INSERT INTO {INTERP_TABLE} (user_id, interpretation_id, post_ids, category, "
            "severity, exposure, evidence, model, prompt_version, request_id, created_at) "
            "VALUES (:u, :i, from_json(:pids, 'array<string>'), :cat, :sev, :exp, "
            "from_json(:ev, 'array<struct<sourceId string, quote string>>'), "
            ":m, :pv, :rid, :created)",
            [
                _param("u", u),
                _param("i", it.interpretationId),
                _param("pids", json.dumps(unique_pids)),
                _param("cat", it.category),
                _param("sev", it.severity),
                _param("exp", it.exposure),
                _param("ev", json.dumps([e.model_dump() for e in it.evidence])),
                _param("m", it.model),
                _param("pv", it.promptVersion),
                _param("rid", it.requestId),
                _param("created", it.createdAt),
            ],
        )
        saved += 1
    _log_api_call(
        "/api/v1/history/interpretations/save", saved, int((time.time() - started) * 1000)
    )
    return {"saved": saved}


def _as_obj(v):
    """JSON_ARRAY results may deliver arrays/structs as parsed JSON or strings."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


@app.post("/api/v1/history/interpretations/list")
def history_list_interpretations(req: UserRequest):
    u = _require_user(req.userId)
    started = time.time()
    rows = _run_sql(
        f"SELECT interpretation_id, post_ids, category, severity, exposure, evidence, "
        f"model, prompt_version, request_id, created_at FROM {INTERP_TABLE} "
        "WHERE user_id = :u ORDER BY created_at, interpretation_id",
        [_param("u", u)],
        fetch=True,
    )
    out = []
    for r in rows:
        out.append(
            {
                "interpretationId": r[0],
                "postIds": _as_obj(r[1]) or [],
                "category": r[2],
                "severity": r[3],
                "exposure": r[4],
                "evidence": _as_obj(r[5]) or [],
                "model": r[6],
                "promptVersion": r[7],
                "requestId": r[8],
                "createdAt": r[9],
            }
        )
    _log_api_call(
        "/api/v1/history/interpretations/list",
        len(out),
        int((time.time() - started) * 1000),
    )
    return {"interpretations": out}


if __name__ == "__main__":
    import uvicorn

    # The Apps runtime sets DATABRICKS_APP_PORT (and UVICORN_HOST/PORT for
    # FastAPI apps) — bind explicitly so it works under the Apps platform.
    port = int(os.environ.get("DATABRICKS_APP_PORT", os.environ.get("UVICORN_PORT", "8000")))
    uvicorn.run(app, host="0.0.0.0", port=port)
