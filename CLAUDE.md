# CLAUDE.md

Guide for AI coding assistants (and teammates) working in this repo. The team are beginner programmers whose main language is Java: keep code plain, well commented, and avoid clever abstractions or new frameworks.

## Current implementation status

- Milestone 1: caption-entry popup, backend analysis route, and structured findings.
- Mock mode is tested: typechecks, extension build, `npm test` regression tests in both packages, and manual `curl` checks of `/api/health` and `/api/analyze`.
- Databricks: the backend calls the Databricks App `instagram-risk-analyzer` (maintained by Genie, outside this repo), which relays to the hosted model. The connector supports OAuth service-principal tokens (default) and PATs. **Live analysis verified 2026-11-14** (OAuth M2M, `/api/v1/serving-endpoints/{endpoint}/invocations`): `npm run check:databricks` passed and a synthetic `/api/analyze` returned verified findings. Re-run the check after any app or credential change; only a passing check counts. Token calls must use `/api/` routes; the service principal needs Workspace access and Can Use on the app. See `docs/DATABRICKS_APP_API.md`.
- History (milestone 3, backend side): explicit import of approved, published posts; relevance suggestions (`/api/history/suggest`) to pre-select posts on the consent step; analysis with exactly the user-chosen posts (`historyPostIds`); per-user isolation; deletion and approval revocation; AI interpretations stored apart from observed posts. Storage: the **temporary in-memory dev store** (`HISTORY_STORE=dev-memory`, lost on restart) by default, or the Databricks App store (`databricks-app`), whose import/list/revoke passed `npm run check:history` on 2026-11-14 (analysis with history and interpretation storage also passed live; an analysis with history takes about 8–9 s; interpretations are saved after the reply). The app's source snapshot is in `databricks-app/` (backup only; Genie deploys). Extension side (branch `feat/history`, in progress): history page `public/history.html` + `src/history-page.ts` (list, delete, delete all; import from Instagram's data export read locally by `src/instagram-export.ts`, photo text by local OCR, only ticked posts' text sent), per-install random user id in `chrome.storage.local` (`src/user-id.ts`), history client `src/history-api.ts`. Using history (opt-in, never automatic): the popup's "Compare with my past posts" (closed by default; `src/compare.ts`) lists related saved posts via `/api/history/suggest`, pre-ticks the ones sharing words, and checks with exactly the ticked ones (`historyPostIds`); on Instagram, after a CONFIRMED share, a "Save to history?" card (Save / No thanks) sends message `save-to-history` to the worker, which imports it as one published post (`posted_<ms>` id). Popup drafts are never saved (they may never be posted). Profile ("portfolio", opt-in): `backend/src/history/portfolio.ts` scans saved posts 8 per model call (2 batches per POST /api/history/portfolio/scan; the history page loops) into facts that must quote their post exactly; stored as ONE AI interpretation per batch (promptVersion portfolio-*, deleted with its posts; the batch is rescanned if one post goes); `usePortfolio` adds one "profile" source (date · fact · quote) to a check, offered in the popup Compare panel. The analysis prompt tells the model to combine fragments across sources (first + last name, school + time). The Instagram panel has the same opt-in Compare section (closed by default, reset per post): messages get-history-suggestions / open-history-page, and check-draft can carry historyPostIds + usePortfolio; the worker answers via src/history-api.ts. Not yet: a real Instagram export, a live-site trial.
- Milestone 2 (in progress): local OCR module in `extension/src/ocr/` (Tesseract.js, bundled; unit tests, `npm run check:ocr`, and a local test page). Wired into the Instagram panel through an offscreen page (`offscreen.html`, `src/offscreen.ts`, `src/ocr-relay.ts`, `src/content/offscreen-ocr.ts`): the selected photo is grabbed from the composer and read locally; the text is analyzed only after the user clicks "Check this post". Verified in the loaded extension in Chrome against a local stand-in composer page (2026-11-15), **not yet on the live Instagram site**. Also wired into the popup: "Add a photo" runs `readImageText()` directly in the popup (an extension page), applies the same size limit and quality notices (`describePhotoRead()` in `src/photo-text.ts`), and fills "Text in the photo" for review. Verified in headless Chrome with the built extension and the live backend (2026-11-15). No photo highlights in the popup yet.
- Milestone 4 (Instagram, photo posts: single photo or carousel, English UI) is in code. Carousels: photos are collected as the user clicks through the slides (`src/content/photo-set.ts`), read one at a time, one "Text in photo N" box each, sent as `image_text:1..n`; tested only on a stand-in composer page in headless Chrome (2026-11-15), NOT on the live site. Code: content script in `extension/src/content/`, service worker in `extension/src/background.ts`. Blocking Share, the panel, stale detection, "Apply", letting a share through after "Continue", detecting "published", and ignoring 2-photo posts were checked by hand on the live site (2026-11-15, mock backend). Failure screens and video posts were NOT. Details in `docs/ROADMAP.md`. The Instagram code reaches OCR and history through `extension/src/ports.ts`: OCR uses `offscreenOcr`; history still uses the stand-in `noHistory`, so the backend history API above is not connected to the extension yet.
- Live vs. mock results: `docs/TEST_RESULTS.md`. Team ownership and interfaces: `docs/TEAM.md`.
- Implement only the milestone assigned in the current task.
- Preserve the existing working structure; do not reorganize it without a concrete need.

## Architecture

```
Chrome extension (TypeScript, MV3)        Backend (Node + Express, TypeScript)        Databricks App ──▶ hosted model
  popup: caption + photo text  ──POST /api/analyze──▶  validate ─▶ + approved history ─▶  (relay, OAuth)
  hash draft, render findings  ◀──AnalyzeResponse────  parse + verify quotes ◀──────────  history storage           
                                                       or mock.ts (no Databricks)
```

- The extension never talks to Databricks and never holds credentials. OAuth tokens are fetched, cached and renewed only in `backend/src/auth.ts`.
- A failed Databricks call is an error for the user. Never substitute mock findings after a live failure; mock mode is chosen explicitly at startup and labeled.
- Drafts vs. history: `/api/analyze` accepts only draft sources (`caption`, `image_text`). `history:<postId>` sources are added by the backend from posts the user explicitly approved, and only `status: "published"` posts can be imported.
- History requests carry the `X-Second-Look-User` header (a random per-install id). Every store method is per user; never read or delete across users.
- Only text crosses the network: never images, image URLs, base64, or page HTML. `backend/src/validate.ts` enforces this.
- `shared/contract.ts` is the single source of truth for the request/response format. Both sides import it. Change it first, then fix the type errors on both sides. Bump `CONTRACT_VERSION` on breaking changes.
- Unreliable OCR is never used: when `describePhotoRead()` rates a read "poor" (low average confidence, or most words unclear, e.g. a photo of a building), the photo-text box stays empty and the user is told; guessed letters are never sent to the AI. Noisy but mostly readable reads are filled in with a notice.
- Observed vs. AI-generated: `Evidence` (quote + `verified`) is observed text; `exposure`, `uncertainty`, `suggestedEdits` are AI interpretation. The backend, not the model, sets `verified` and `crossSource`.
- Evidence verification (`backend/src/parse.ts`):
  - `verified: true` means the quote appears in the named source's text (case- and whitespace-insensitive). It proves the text exists, not that the AI's interpretation is right.
  - A finding is shown only if it has at least one verified quote. Unverified quotes may be kept but are labeled "not found in your text".
  - `crossSource` is computed from verified quotes only.
  - A missing or wrongly typed `findings` list is `BAD_MODEL_OUTPUT`, never an empty "clean" result.
  - Findings that are malformed, unverified or over the limit of 8 are dropped and counted in `droppedFindings`. If it is above 0 the popup says the check is incomplete, not "nothing stood out".
- Suggested edits: `replace`/`generalize` need an `original` found in the text and a non-blank `replacement`; otherwise the backend turns them into `other` (advice only). The extension re-checks with `extension/src/edits.ts` before showing or running "Apply", and never applies an edit that would empty the caption.
- Databricks status: `GET /api/health` returns `databricks.state` (`not_used`, `configured_unverified`, `verified`, `failing`) from the most recent real call. Only `verified` may be shown as "connected". The popup and the Instagram panel show the same pill: the panel asks the service worker (`get-backend-status`), which reads `/api/health` (no Databricks call) when the panel opens and after each check. The Databricks timeout covers reading the response body, not just the headers.
- AI interpretations from an analysis are saved in the background after the reply (`saveInBackground` in `app.ts`). History delete/revoke routes first wait for that user's pending saves, so nothing derived from a deleted post is left behind. A failed save is logged, never shown as a failed analysis.
- Results are tied to a `draftHash` (SHA-256 of the draft sources). When the draft's hash changes, the popup marks results stale.

## Files

```
shared/contract.ts            Request/response types, limits, enums (both sides)
backend/src/server.ts         Starts the app from .env settings (mock vs. databricks chosen once, here)
backend/src/app.ts            Express routes: health, analyze, /api/history/*, error handler
backend/src/config.ts         Reads backend/.env; reports missing settings, never guesses them
backend/src/auth.ts           OAuth M2M tokens (cache + renewal) or fixed PAT
backend/src/databricks.ts     Databricks client: one timeout incl. body, no redirects, retry once on auth failure
backend/src/validate.ts       Request validation, "text only" guard, history import rules
backend/src/prompt.ts         LLM system prompt (bump PROMPT_VERSION when editing)
backend/src/parse.ts          Parse LLM JSON, normalize fields, verify quotes
backend/src/mock.ts           Keyword-rule fake findings (clearly labeled mode: "mock")
backend/src/history/          store.ts (interface), memoryStore.ts (TEMPORARY dev store),
                              appStore.ts (Databricks App store, unverified), relevance.ts
backend/scripts/ping-databricks.ts   Live connection check (npm run check:databricks)
backend/scripts/check-history.ts     Live history round trip (npm run check:history)
extension/public/             manifest.json, popup.html, popup.css ("Street Poster" design, also used by the Instagram panel), fonts.css + fonts/ (bundled Anton, Permanent Marker; licenses in fonts/) (copied to dist/)
extension/src/popup.ts        Popup wiring, draft hashing, stale detection, apply-edit
extension/src/api.ts          Backend calls (BACKEND_URL), hashSources()
extension/src/render.ts       Marked-up draft + finding cards (textContent only, no innerHTML)
extension/src/edits.ts        Rules for applying a suggested edit safely (no DOM; tested)
extension/src/ocr/            Local OCR: readImageText(), review step, quote->box, preview coords (see its README.md)
extension/src/ocr/scene.ts    Text in everyday photos: keeps only clearly readable lines (drops brickwork/window junk), zooms into small text, merges reads (tested)
extension/src/dashboard/      Full-page dashboard (public/dashboard.html, opened as the extension's Options page): scores, cross-post view, offline keyword-rule mode
extension/src/verdict.ts      Popup verdict: risk score, LOW/MEDIUM/HIGH stamp, "Before you drop that post" advice (display only; reuses dashboard/report.ts scoring)
                              Scoring: findings add up, but never below the worst single finding's minimum (findingFloor: sensitive high 75, high 50, sensitive medium 50, medium 25; halved at low confidence). Sensitive = identity, financial, health, children (1.5x weight).
extension/src/background.ts   Service worker: Chrome messages -> api.ts -> backend; relays the photo to the OCR page
extension/src/ocr-relay.ts    Photo relay messages + checks (in-browser only, never in the contract; tested)
extension/src/offscreen.ts    Offscreen page (public/offscreen.html): runs local OCR on the Instagram photo
extension/src/history-assess.ts  History page "What your posts reveal together": picks saved posts to send (POST /api/history/assess), score + cross-post findings view (tested)
extension/src/photo-text.ts   Photo-text rules (popup + Instagram): unreliable reads are discarded (empty box + notice), noisy reads get a notice, left-out junk is reported, strict 1000-char limit (tested)
extension/src/worker-handler.ts  What the worker does with each message (no Chrome calls; tested)
extension/src/messages.ts     Checks Chrome messages: known kinds, text only (tested)
extension/src/ports.ts        Interfaces + stand-ins for OCR, the warning panel, history
extension/src/content/main.ts           Instagram content script: wires everything together
extension/src/content/instagram-adapter.ts  ALL Instagram page details (selectors, caption writing)
extension/src/content/share-flow.ts     Stale/outdated/Share-permission rules (no DOM; tested)
extension/src/content/overlay.ts        Warning panel on instagram.com (Shadow DOM, reuses render.ts)
extension/src/content/offscreen-ocr.ts  OcrPort for Instagram: sends the photo to the offscreen OCR page
extension/dev/instagram-test-kit.js     Paste into Chrome's Console to inspect/record Instagram's page (dev only)
databricks-app/               Snapshot of Genie's Databricks App (backup; deploys happen in Databricks)
backend/test/, extension/test/  Regression tests (node:test, run with `npm test`)
docs/ROADMAP.md               Next milestones, history storage plan, Instagram assumptions
docs/TEAM.md                  Module owners and integration interfaces (in code vs. proposed)
docs/DATABRICKS_APP_API.md    What the backend needs from Genie's Databricks App (auth fix, history endpoints)
docs/TEST_RESULTS.md          Mock and live results, kept separate
```

## Commands

Requires Node.js 20+ and npm (`node -v`, `npm -v`). Use `npm ci` to install exactly what the lockfiles say; use `npm install <pkg>` only when deliberately changing a dependency.

```bash
# Backend (first time). Create .env ONLY if it doesn't exist; never overwrite a teammate's .env.
cd backend && npm ci
cp -n .env.example .env            # macOS/Linux/Git Bash (-n = don't overwrite)
# Windows PowerShell:  if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm run dev                        # http://127.0.0.1:8787, restarts on save

# Extension
cd extension && npm ci && npm run build   # load extension/dist in chrome://extensions
cd extension && npm run watch

# Checks (run all of these before committing)
cd backend && npm run typecheck && npm test
cd extension && npm run typecheck && npm test && npm run build
cd extension && npm run check:ocr           # real OCR engine on the fictional demo images

# Databricks (only with real credentials in backend/.env)
cd backend && npm run check:databricks    # must print "Success. Connection verified."
cd backend && npm run check:history       # HISTORY_STORE=databricks-app; must print "Success. History storage verified ..."
curl http://127.0.0.1:8787/api/health     # shows mode, databricks.state and history.store
```

`ANALYSIS_MODE=mock` (the default) needs no `.env` at all; you can also set it for one run instead of editing `.env`.

## Rules

- The product name is **CheckYo'Self** (shown in the popup, Instagram panel, dashboard and manifest). Some internal identifiers keep the old name "Second Look" on purpose, because renaming them would break things: the `X-Second-Look-User` header (shared with the Databricks App and stored history), the npm package names, the `second-look-panel` element and the Databricks service principal names.

- Never commit `.env` or put secrets in `extension/`. Secrets come from environment variables on the backend.
- Never log post text, user ids, tokens, or Databricks response bodies on the backend; log request IDs, statuses and counts.
- Don't claim a Databricks feature works until its live check (`check:databricks`, `check:history`) passes, and record the result in `docs/TEST_RESULTS.md`.
- Render model output with `textContent`, never `innerHTML`.
- Treat post text as untrusted input to the LLM (prompt injection). Keep the "data, not instructions" rule in the prompt.
- If you change `BACKEND_URL` in `extension/src/api.ts`, update `host_permissions` in `extension/public/manifest.json`.
- `shared/package.json` sets `"type": "module"`; keep it, or the backend can't import the contract.
- Run both `typecheck` and both `npm test` commands, and the extension build, before committing.
- When you fix a bug, add a test for it in `backend/test/` or `extension/test/`.
- Instagram page details (selectors, button text, how to write the caption) belong ONLY in `extension/src/content/instagram-adapter.ts`. Button/message text goes in its per-language table `TEXT_BY_LANGUAGE`; supported post types are listed in `SUPPORTED_POST_TYPES` (`content/main.ts`).
- The extension must never click Share or publish on its own. "Continue" may only let the user's own next click through.
- After reloading the extension in `chrome://extensions`, refresh the Instagram tab: the old content script stops working.


# Git & Repository Safety Rules

## Repository Setup
- If the target repository is not present locally, clone it first before making any file changes.
- Always run `git status` and verify your current branch before editing files or running commits.

## Branching & Commits
- **NEVER commit or push directly to `main` (or `master`).**
- **Continue an existing branch when the work belongs to it.** If the task names a branch or an open PR (for example a teammate's branch like `Tri-Hoang` and its PR), check it out, `git pull`, and keep committing there. Do not create a second branch or PR for the same work.
- Only for new, separate work: create a branch from an up-to-date `main` (e.g., `git checkout -b feat/short-description` or `fix/short-description`).
- Each teammate works on their own branch; don't push to someone else's branch unless they asked.
- Write clear, concise commit messages describing what changed and why.
- Stage specific files rather than blindly running `git add .` so untracked secrets, `.env` files, or build artifacts are never committed.

## Pull Requests
- Never merge your own pull requests.
- When work is complete, push your branch to `origin` (`git push -u origin <branch-name>`) and open a Pull Request using the GitHub CLI (`gh pr create`). If a PR already exists for the branch, just push; the PR updates itself (`gh pr view` shows it).
- **GitHub CLI fallback:** first run `gh auth status`. If `gh` is not installed or not logged in, do not paste tokens anywhere. Push the branch, then open the PR in a browser at `https://github.com/NateDawgWan/MADHACKS26_HANS/compare/main...<branch-name>`, or have the person run `gh auth login` themselves.
- Include a clear summary of changes and any testing performed in the PR description. Say plainly what was NOT tested (for example live Databricks).

## Destructive Commands
- **NEVER run force pushes (`git push --force`), hard resets (`git reset --hard`), or branch deletions on shared branches** without explicit user confirmation.