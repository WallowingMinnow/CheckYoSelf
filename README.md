# CheckYo'Self

A Chrome extension that shows what an Instagram post could reveal about you before you share it, including things that only become revealing when combined with your earlier posts. Built for MadHacks 2026.

**Status: milestones 1 and 4.** The popup sends a caption and the text in the photo (read on your computer with local OCR when you add a photo, or typed) to a small local backend, which asks a Databricks-hosted LLM for structured privacy findings and shows them, linked to the exact text they're based on. On instagram.com, the same check is offered before you share a single-photo post. Post history in the extension comes next (see [docs/ROADMAP.md](docs/ROADMAP.md)).

## What you need

- Node.js 20 or newer (`node -v`)
- Google Chrome
- For real AI results: access to our Databricks App (a service principal with CAN USE). Without it, the backend runs in **practice (mock) mode**.

## Setup

```bash
# 1. Backend
cd backend
npm ci
cp -n .env.example .env     # -n: never overwrite an existing .env
                            # Windows PowerShell: if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run dev                 # starts http://127.0.0.1:8787 and restarts on save

# 2. Extension (in a second terminal)
cd extension
npm ci
npm run build               # or: npm run watch
```

Load the extension in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/dist` folder.
3. Pin "CheckYo'Self" from the puzzle-piece menu and click it.
4. Click **Use sample post**, then **Check this post**.

**On Instagram (photo posts, one photo or a carousel, English):** with the backend running, open instagram.com, click **Create**, pick your photo(s) and go to the caption step. For a carousel, click through the photos with Instagram's arrows once: each one's text is read as it appears (Photo 1, Photo 2…). A **CheckYo'Self: Check this post** button appears at the bottom-right, and clicking **Share** first shows a "Before you share" panel. CheckYo'Self never shares for you: after **Continue to Share**, click Instagram's Share button yourself. See [docs/ROADMAP.md](docs/ROADMAP.md) for what has and hasn't been tested.

After changing extension code, rebuild (or leave `npm run watch` running) and click the reload icon on the extension's card in `chrome://extensions`.

Tip: the popup closes when you click elsewhere. While developing, open it in a normal tab instead: `chrome-extension://<your-extension-id>/popup.html` (the ID is on its card in `chrome://extensions`). You can then right-click and Inspect it like any page.

### Windows: keep the backend running without a terminal

Double-click these files in `scripts\windows\` (needs Node.js and a filled-in `backend\.env`):

| File | What it does |
|---|---|
| `install-autostart.cmd` | Starts the backend now, hidden, and again every time you sign in to Windows. It adds one shortcut to your own Startup folder (no admin rights). |
| `uninstall-autostart.cmd` | Removes that shortcut and stops the backend. |
| `start-backend.cmd` | Starts it once (does nothing if it's already running). Installs the packages on first run. |
| `stop-backend.cmd` | Stops it until the next sign-in. |

The backend's output goes to `backend\backend.log` (ids, statuses and counts only; it's never committed). It runs the code that is checked out in this folder: after `git pull` or switching branches, run `stop-backend.cmd` then `start-backend.cmd`. If you move the project folder, run `install-autostart.cmd` again. Port 8787 is then taken, so stop it before using `npm run dev`.

## Practice (mock) mode vs. real Databricks

`ANALYSIS_MODE=mock` (the default) returns findings from simple keyword rules in `backend/src/mock.ts`. **These are not AI results.** The popup shows a "Practice mode" label and a purple banner whenever results are mocked.

Real analysis goes through our Databricks App (`instagram-risk-analyzer`), which relays to a hosted model. Genie maintains the app; the backend only needs settings in `backend/.env` (see `backend/.env.example`):

1. Get a **service principal** with **CAN USE** on the app, and its client ID and secret (ask the app owner; the secret must be shared privately, never in GitHub or chat).
2. Edit `backend/.env`:
   ```
   ANALYSIS_MODE=databricks
   DATABRICKS_HOST=https://instagram-risk-analyzer-7474656363418981.aws.databricksapps.com
   DATABRICKS_SERVING_ENDPOINT=gpt-oss-120b
   DATABRICKS_INVOCATIONS_PATH=/api/v1/serving-endpoints/{endpoint}/invocations
   DATABRICKS_AUTH_TYPE=oauth-m2m
   DATABRICKS_WORKSPACE_HOST=https://dbc-d050c3b5-83dc.cloud.databricks.com
   DATABRICKS_CLIENT_ID=<client id>
   DATABRICKS_CLIENT_SECRET=<secret>
   ```
   The backend gets short-lived OAuth tokens and renews them itself.
3. Test the connection: `npm run check:databricks` (in `backend/`). It should print `Success. Connection verified.`
4. Restart `npm run dev`. The popup shows **"Databricks not tested yet"** until the first call succeeds, then **"Databricks connected"**. If a call fails it shows **"Databricks error"** (hover for the reason). Filled-in settings alone are never shown as connected. A failed call is shown as an error, never replaced with practice results.

**Status: live analysis verified (2026-11-14).** `npm run check:databricks` printed `Success. Connection verified.` with OAuth M2M (service principal `second-look-backend`) through the app's `/api/v1/...` route, and a synthetic caption analyzed through the backend returned two findings with verified quotes. The service principal needs **Workspace access** and **Can Use** on the app. History storage in Databricks is still unverified (the app has no history endpoints yet). A personal access token (`DATABRICKS_AUTH_TYPE=pat`) is also supported, but Databricks documents OAuth for calling apps. Details: [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md).

If `check:databricks` fails: an OAuth token error means the workspace host, client ID or secret is wrong; an "auth" error from the app (401/403, or a redirect to the browser login) means the token isn't accepted for the app or the route isn't under `/api/`; 404 means the host, endpoint name or path is wrong.

### Earlier posts (history)

The backend can compare a draft with earlier posts the user **explicitly approved**. The consent step lists the posts (pre-selected with `POST /api/history/suggest`), and the user's final choice goes in `historyPostIds` on `/api/analyze`, plus the `X-Second-Look-User` header. Exactly those posts are used: nothing is added or swapped, and a post that was deleted or revoked meanwhile makes the check fail rather than be silently skipped. Only published posts can be imported, users never see each other's history, and approvals can be revoked (deleting those posts and anything the AI derived from them). Routes are listed in `shared/contract.ts`.

Storage today is **temporary and in memory** (`HISTORY_STORE=dev-memory`): not Databricks, and cleared on restart. Databricks storage (`HISTORY_STORE=databricks-app`) waits on the app endpoints in [docs/DATABRICKS_APP_API.md](docs/DATABRICKS_APP_API.md); verify it with `npm run check:history`. The popup has no history screen yet.

## Keeping secrets safe

- Databricks credentials live **only** in `backend/.env`, which `.gitignore` excludes. Never put them in the extension: anyone can read an extension's code.
- Each teammate creates their own `backend/.env` (or you share it privately, not through GitHub or Slack).
- If a token is ever committed, revoke it in Databricks immediately; deleting the commit is not enough.
- The backend listens on `127.0.0.1` only, so others on the hackathon Wi-Fi can't use it. Optionally set `ALLOWED_EXTENSION_ID` so it only answers your extension.

## What gets sent where

| Data | Stays in the browser | Sent to backend and Databricks |
|---|---|---|
| Photo, image URLs, base64 image data | Yes | **Never** (the backend rejects these) |
| Caption text | | Yes, when you click "Check this post" |
| Text in the photo (typed now, OCR'd locally later) | | Yes, same |
| Earlier posts (milestone 3) | | Only posts you approved importing |

The backend logs request IDs and counts, not post text.

## Commands

| Where | Command | What it does |
|---|---|---|
| backend | `npm run dev` | Run the server, restart on save |
| backend | `npm run typecheck` | Check types without running |
| backend | `npm test` | Run the regression tests |
| backend | `npm run check:databricks` | Live test of the Databricks connection |
| backend | `npm run check:history` | Live test of Databricks history storage |
| extension | `npm run build` | Build into `extension/dist` |
| extension | `npm run watch` | Rebuild on save |
| extension | `npm run typecheck` | Check types (source and tests) |
| extension | `npm test` | Run the regression tests |

## Project layout

See [CLAUDE.md](CLAUDE.md) for the architecture and file-by-file overview, and [docs/TEAM.md](docs/TEAM.md) for who owns which part and how the parts connect.
