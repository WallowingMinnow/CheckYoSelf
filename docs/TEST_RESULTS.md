# Test results

Mock and live results are kept separate on purpose. A passing mock or fake test says **nothing** about whether Databricks works. Update this file whenever a live check is run.

Last updated: 2026-11-14, branch `Backend-Connection/History`.

## Mock and fake results (no Databricks involved)

| Check | Result |
|---|---|
| `npm run typecheck` (backend, extension) | Pass |
| `npm test` backend | 53/53 pass |
| `npm test` extension | 45/45 pass (includes the OCR module's tests from `main`) |
| `npm run build` (extension) | Pass |

What the backend tests cover, all against a **fake** `fetch` or the in-memory store:

- **Invalid model output:** a missing or wrongly typed `findings` list is `BAD_MODEL_OUTPUT` (parse tests, and through HTTP in `app.test.ts`).
- **Unsupported evidence:** findings without a verified quote are dropped and counted in `droppedFindings`. `crossSource` uses verified quotes only.
- **Service failures:** app statuses 404/413/422/502/504, network errors, non-JSON bodies, empty replies, a body that stalls after the headers (timeout).
- **Auth and token expiry:**
  - an OAuth token is cached, then renewed before it expires;
  - simultaneous requests share one token fetch;
  - a token rejected early is replaced once and the call retried;
  - a second rejection stops with a clear error;
  - a refused token request names the settings to check;
  - a 302 login redirect is an auth error.
- **No mock fallback:** a failed Databricks call returns an error with no findings.
- **History:**
  - only explicitly approved, published posts are imported, and drafts are refused;
  - history can't be smuggled into a draft;
  - users are isolated (list, analysis, delete and revoke);
  - revoking deletes the posts and the AI interpretations derived from them;
  - suggestions rank relevant posts without calling the model;
  - analysis uses exactly the chosen posts, in order, with source ids and dates;
  - unknown, other users', revoked, duplicate or too many post ids are refused before anything is analyzed;
  - a choice over the size limits is refused, never trimmed;
  - the app-store client sends POST requests to `/api/` routes with the user id in the body, and rejects malformed or partial app responses.

Manual mock-mode run (`ANALYSIS_MODE=mock`, `HISTORY_STORE=dev-memory`), using one synthetic post:

- `/api/health` showed `databricks.state: not_used` and `history.store: dev-memory`.
- Import, then analysis with `historyPostIds: ["p1"]` added `history:p1` with its date. A verified quote from it made the finding `crossSource: true`.
- `/api/history/suggest` ranked the post sharing words with the draft first. An unknown post id in `historyPostIds` was refused with 400 before anything was analyzed.
- Revoke deleted the post, and a second user id saw nothing.

## Live results (real Databricks)

| Check | Result |
|---|---|
| Unauthenticated probes of the app | `/` and `/serving-endpoints/...` redirect to the browser login (302). `/api/health` answers 401. |
| `check:databricks`, PAT mode, **fake** token, handoff path | Correctly failed: app answered HTTP 401, reported as `UPSTREAM_AUTH` with the OAuth hint. |
| `check:databricks`, OAuth mode, **fake** client, real workspace | Correctly failed: workspace `/oidc/v1/token` exists and answered 401, reported with the settings to check. |
| `check:databricks` with **real** credentials (service principal `secondlook-backend`, OAuth M2M, `/api/v1/...` route) | **Failed at the app's access gate.** The workspace issued a valid token (scope `all-apis`, workspace audience, correct client ID). The app then answered **HTTP 401 with an empty `{}` body on every route**, including `/` and `/api/health`, with or without a fresh token. Empty-body 401s come from the Databricks gate, not the app's code, so the request never reached Genie's relay. Most likely cause: the service principal lacks **Can Use** on the app. |
| Same check after **Can Use** was granted (the first grant had used a mistyped UUID) | **Still 401, empty body, every route.** Root cause found with a read-only workspace call (`GET /api/2.0/preview/scim/v2/Me` using the same token): **HTTP 403**, "disabled for users without the databricks-sql-access or workspace-access or workspace-consume entitlements". The service principal has **no workspace entitlements**, so the app's gate refuses it before checking Can Use. Fix: a workspace admin enables **Workspace access** (or Consumer access) on the service principal. |
| Same check after **Workspace access** was enabled | **Authentication works; the app's relay crashes.** The workspace now accepts the service principal (`scim/v2/Me` 200, entitlement `workspace-access`). App `GET /api/health` and `GET /` return 200 `{"status":"ok","model":"system.ai.gpt-oss-120b"}`. Both `POST /api/v1/serving-endpoints/gpt-oss-120b/invocations` (so the new route exists) and the old `/serving-endpoints/...` route return **HTTP 500, plain "Internal Server Error"**, an unhandled exception in the app. Needs Genie to check the app logs. |
| Same check after Genie **recreated the app** (its old app service principal was unrecoverable; same URL, new app identity, JSON `{"detail"}` errors) | **Pass.** `npm run check:databricks` printed `Success. Connection verified. Model replied: OK`. Both relay routes return 200 with the model's reply; `/api/health` 200. |
| Live `/api/analyze` through the backend (`ANALYSIS_MODE=databricks`, one **synthetic** caption with a made-up address and travel dates) | **Pass.** 200 in about 6 s, `mode: databricks`, 2 findings (`location`, `travel_absence`), every quote `verified: true`, `droppedFindings: 0`, valid suggested edits. `/api/health` then showed `databricks.state: verified`. |
| `check:history` against the app (`HISTORY_STORE=databricks-app` for that one run, deployment `01f1e0b30e7e1eabb94e4d52d7fef105`) | **Pass.** `Success. History storage verified (import, read, revoke, delete).` One synthetic post under a throwaway user id was imported, listed, revoked and confirmed gone. Not covered: the interpretations endpoints, and analysis with history through the live model. |
| Full history path through the backend (`HISTORY_STORE=databricks-app`, live model, one **synthetic** past post about a school and classroom, then a synthetic draft) | **Pass.** Import 200 and listed back. `/api/analyze` with `historyPostIds: ["synth1"]` returned 3 findings, 0 dropped, with verified quotes from both `caption` and `history:synth1`, and `historyUsed` named the post with its date. `DELETE /api/history` then removed 1 post and **2 saved AI interpretations** (so interpretation saving works live), and the list was empty. **Slow:** 42.7 s for the analysis with history (history list about 2 s, analysis without history about 10 s; the rest is the longer prompt and saving interpretations, each app SQL statement is slow). Each Databricks call has its own 45 s limit, so none timed out. |
| Same path after saving interpretations **after the reply** (backend change) | **Pass, faster.** Two analyses with history took **9.1 s and 8.0 s** (was 42.7 s), 3 and 2 findings, `historyUsed` correct. `DELETE /api/history` waited for the background saves, then removed 1 post and 3 interpretations; the list was empty. Still slow on the app side: import about 11 s, delete-all about 12 s (each app SQL statement is slow). |

**Status:**

- **Live analysis through the Databricks App: VERIFIED** (2026-11-14, OAuth M2M, `/api/v1/...` route). Re-run `npm run check:databricks` after any app or credential change.
- **Databricks history persistence: import, list and revoke VERIFIED** (2026-11-14, `check:history`). Analysis with history and interpretation storage also passed through the backend against the live model. The local `.env` now uses `HISTORY_STORE=databricks-app`. An analysis with history takes about 8–9 s now that interpretations are saved after the reply. History import and delete still take about 10–12 s each (app-side SQL).
- **Known-good app deployment:** `01f1e0b30e7e1eabb94e4d52d7fef105` (source snapshot in `databricks-app/`). Roll back to it if a new deploy fails these checks.
