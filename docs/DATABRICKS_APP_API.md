# Databricks App API spec (for Genie)

This is what the Node backend (`backend/`) needs from the Databricks App `instagram-risk-analyzer`. Genie maintains the app; the backend owner maintains `backend/`. Neither edits the other's code. Change this spec by PR, and say in the PR which side has implemented each part.

```
Extension ──▶ Node backend (127.0.0.1:8787) ──▶ Databricks App ──▶ hosted model
             validates, verifies quotes,        relays chat, stores
             holds all credentials              approved history
```

Status key: **live** = exists in the deployed app; **requested** = not built yet.

---

## 1. Authentication (needs a change in the app)

What we found on 2026-11-14 (no credentials used, only probes):

| Request | Result |
|---|---|
| `GET /` with no token | 302 to the workspace's browser login |
| `GET /api/health` with no token | 401 (a normal API answer) |
| `POST /serving-endpoints/gpt-oss-120b/invocations` with a fake token | 302 or 401, never JSON |
| `POST https://dbc-d050c3b5-83dc.cloud.databricks.com/oidc/v1/token` with a fake client | 401 (endpoint exists) |

Databricks' docs say token calls to an app need an **OAuth** token, and only work on routes under **`/api/`** ([Connect to an API Databricks app using token authentication](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/connect-local)). The handoff's personal access token on `/serving-endpoints/...` has not been shown to work.

**Requested from Genie:**

1. **Serve the chat relay under `/api/`** as well, with identical request and response:
   `POST /api/v1/serving-endpoints/{endpoint_name}/invocations`
   The backend switches with one setting: `DATABRICKS_INVOCATIONS_PATH=/api/v1/serving-endpoints/{endpoint}/invocations`.
2. **A service principal for the backend**: create one (or name an existing one), give it **CAN USE** on the app, and tell the backend owner its **client ID**. The **secret** goes to the backend owner privately (never in GitHub, chat logs or this file). The backend gets OAuth tokens itself:
   `POST https://dbc-d050c3b5-83dc.cloud.databricks.com/oidc/v1/token`, `grant_type=client_credentials`, `scope=all-apis`, HTTP Basic auth with the client ID and secret. Tokens are cached and renewed automatically.
3. If the app uses **user authorization** scopes, list them. The token's scopes must cover them.
4. Keep answering **401/403 as JSON** (not a redirect) on `/api/` routes when the token is bad. The backend treats any 3xx as "token not accepted".

The backend still supports `DATABRICKS_AUTH_TYPE=pat` as the handoff describes, in case it turns out to work.

## 2. Chat relay (live at the handoff's path; `/api/` alias requested)

Unchanged from the handoff. The backend sends:

```json
{ "messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}], "max_tokens": 4000, "temperature": 0.1 }
```

`max_tokens` is 4000, the relay's cap (`MAX_TOKENS_CAP`). It was 2000 until 2026-11-15, which cut long answers off mid-JSON. Note: the relay always returns `finish_reason: "stop"`, even when the model was cut off; passing the model's real `finish_reason` through would let the backend report "answer too long" instead of "malformed JSON".

and expects:

```json
{ "choices": [{"message": {"role": "assistant", "content": "<model text>"}, "finish_reason": "stop"}], "model": "system.ai.gpt-oss-120b" }
```

The relay must forward `messages` **verbatim** and return the model's text **unchanged**. The backend's prompt (`backend/src/prompt.ts`), quote verification and parsing (`backend/src/parse.ts`) depend on it. The app must not add, drop or rewrite findings.

Errors: `{"detail": "..."}` with 400 / 401 / 403 / 404 / 413 / 422 / 502 / 504, as in the handoff. Please **don't put request content in `detail`**: the backend never logs error bodies, but other tools might. The backend's timeout is 45 s and covers reading the whole response; the app's model timeout (40 s) should stay below that.

## 3. History storage (requested)

Only earlier posts the user **explicitly approved**, and only **published** posts (never drafts). Text only, never images. The backend validates everything before calling the app. The app must still refuse anything malformed.

### Rules for the app

- **Isolation:** every row is keyed by `userId`. Every endpoint filters by the `userId` in the request body. A request must never read, change or delete another `userId`'s rows. `userId` is a random per-install id (8–64 chars `A-Za-z0-9_-`), not a person's name or email.
- **Observed vs. AI-generated are separate tables.** Posts are what the user approved. Interpretations are what the model concluded, can be regenerated, and are deleted whenever any post they used is deleted.
- **Deleting means deleting.** Rows are removed, not hidden. Revoking an approval deletes that approval's posts and their interpretations, and records `revoked_at`.
- **No post text in logs.** Log endpoint names, counts and timings only, like the relay does now.
- **POST everywhere, all under `/api/v1/history/`**, so `userId` and text never appear in URLs.

### Suggested Unity Catalog tables

| Table | Columns |
|---|---|
| `observed_posts` | `user_id`, `post_id`, `status` (always `published`), `published_at`, `caption`, `image_text` (nullable), `approval_id`, `imported_at`. Primary key (`user_id`, `post_id`). |
| `history_approvals` | `user_id`, `approval_id`, `approved_at`, `post_ids` (array), `revoked_at` (nullable) |
| `ai_interpretations` | `user_id`, `interpretation_id`, `post_ids` (array), `category`, `severity`, `exposure`, `evidence` (array of `{sourceId, quote}`), `model`, `prompt_version`, `request_id`, `created_at` |

Re-importing an existing (`user_id`, `post_id`) replaces the row and moves it to the new approval.

### Endpoints

All requests and responses are JSON. Errors use `{"detail": "..."}` with a 4xx/5xx status.

**`POST /api/v1/history/import`**
```json
// request
{ "userId": "u_8f3k2m9q1x", "approvalId": "6f1c...uuid", "approvedAt": "2026-11-14T20:00:00.000Z",
  "posts": [ { "postId": "1789...", "status": "published", "publishedAt": "2026-10-01T12:00:00.000Z",
               "caption": "Riverside soccer at 6pm", "imageText": "U10 Tigers" } ] }
// response: imported must equal posts.length, or the backend treats it as a failure
{ "imported": 1 }
```

**`POST /api/v1/history/list`**
```json
{ "userId": "u_8f3k2m9q1x" }
// response
{ "posts": [ { "postId": "1789...", "status": "published", "publishedAt": "2026-10-01T12:00:00.000Z",
               "caption": "Riverside soccer at 6pm", "imageText": "U10 Tigers",
               "approvalId": "6f1c...uuid", "importedAt": "2026-11-14T20:00:00.000Z" } ] }
```
(`imageText` may be omitted or null.)

**`POST /api/v1/history/delete-post`**: `{ "userId", "postId" }` returns `{ "deletedPosts": 0|1, "deletedInterpretations": n }`

**`POST /api/v1/history/revoke-approval`**: `{ "userId", "approvalId" }` returns `{ "deletedPosts": n, "deletedInterpretations": n }`, or `{ "found": false }` if this user has no such approval.

**`POST /api/v1/history/delete-all`**: `{ "userId" }` returns `{ "deletedPosts": n, "deletedInterpretations": n }`

**`POST /api/v1/history/interpretations/save`**
```json
{ "userId": "u_8f3k2m9q1x",
  "interpretations": [ { "interpretationId": "uuid", "postIds": ["1789..."], "category": "routine_schedule",
    "severity": "medium", "exposure": "Shows a weekly soccer time.", "evidence": [{"sourceId": "history:1789...", "quote": "6pm"}],
    "model": "gpt-oss-120b", "promptVersion": "2026-11-14.2", "requestId": "uuid", "createdAt": "2026-11-14T20:05:00.000Z" } ] }
// response
{ "saved": 1 }
```
Skip (don't save) any interpretation whose `postIds` no longer exist for that user.

**`POST /api/v1/history/interpretations/list`**: `{ "userId" }` returns `{ "interpretations": [ ...same shape as saved... ] }`

### How we'll verify it

With `HISTORY_STORE=databricks-app` and working OAuth settings in `backend/.env`:

```bash
cd backend && npm run check:history
# must print: Success. History storage verified (import, read, revoke, delete).
```

It uses one made-up post and a throwaway `userId`, and deletes them again. Until it prints that line, Databricks history storage is **unverified**, and the backend uses the clearly labeled temporary in-memory store (`HISTORY_STORE=dev-memory`).

## 4. Keep the app's code in GitHub

The app's source lives at the app owner's workspace folder, in `app.py`, `app.yaml` and `requirements.txt`. Copy these into `databricks-app/` on a feature branch and open a PR, so GitHub stays the source of truth. Don't commit tokens, secrets or workspace user emails.
