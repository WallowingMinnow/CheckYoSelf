# Team setup: who owns what, and how the pieces connect

Four teammates, four areas. Each area has one **owner** who reviews changes to it. Anyone may help, but talk to the owner first.

Put names next to the roles when you assign them:

| # | Area | Owner | Main folders and files | Milestone |
|---|---|---|---|---|
| 1 | Backend and Databricks (analysis, prompt, history storage) | _name_ | `backend/` | 1 (done), 3 (history storage) |
| 2 | Warning interface (popup, results, Apply) | _name_ | `extension/src/popup.ts`, `render.ts`, `edits.ts`, `extension/public/` | 1 (done), polish |
| 3 | OCR (text from the photo, on the user's computer) | _name_ | new `extension/src/ocr/` | 2 |
| 4 | Instagram integration (content script, service worker) | _name_ | new `extension/src/content/`, `extension/src/background.ts` | 4 |

**Outside this repo:** the Databricks App `instagram-risk-analyzer`, maintained by Genie. The backend talks to it only as described in `docs/DATABRICKS_APP_API.md`.

**Shared, owned by everyone:** `shared/contract.ts`. Changes to it need a quick OK from whoever's code uses the changed type (usually owners 1 and 2).

## Ground rules for working in parallel

1. **One contract.** Every type that crosses a boundary (extension ↔ backend over HTTP, or content script ↔ service worker ↔ popup over Chrome messages) lives in `shared/contract.ts`. No copies of these types anywhere else.
2. **Contract first.** To change a boundary: edit `shared/contract.ts`, bump `CONTRACT_VERSION` if old code would break, then fix the type errors on both sides in the same pull request.
3. **Only text crosses the network.** Images, image URLs, base64 and page HTML stay in the browser. `backend/src/validate.ts` enforces this; don't loosen it.
4. **Your own branch.** Each teammate works on their own branch and opens a pull request into `main`. Continue an existing branch/PR for the same work instead of starting a new one. Nobody merges their own PR.
5. **Before every push:** `npm run typecheck` and `npm test` in both `backend/` and `extension/`, and `npm run build` in `extension/`.

## The interfaces between areas

Status key: **in code** = exists today; **proposed** = planned shape, not written yet. When you build a proposed interface, add its types to `shared/contract.ts` first, then update this table.

### A. Extension → backend: analysis (owners 1 and 2) — **in code**

```
POST /api/analyze   AnalyzeRequest  -> AnalyzeResponse | ErrorResponse
GET  /api/health                    -> HealthResponse
```

What each side can rely on (see the comments in `shared/contract.ts`):

- Every shown `Finding` has at least one evidence quote with `verified: true` (the backend checked it really appears in the text). Unverified quotes may also appear and must be labeled as such.
- `crossSource` is computed by the backend from verified evidence only.
- `droppedFindings > 0` means the check is **incomplete**. The UI must not show "nothing stood out" in that case.
- A malformed model answer is an error (`BAD_MODEL_OUTPUT`), never an empty result.
- `SuggestedEdit` with `replace` / `generalize` always has non-blank `replacement`; edits that break the rules arrive as `other` (advice only). The extension still re-checks with `extension/src/edits.ts` before applying.
- `HealthResponse.databricks.state` is `"verified"` only after a real call succeeded. Settings alone give `"configured_unverified"`.

### B. OCR → warning interface (owners 3 and 2) — **in code**: OCR module, popup ("Add a photo") and Instagram panel (offscreen page), milestone 2

OCR runs inside the extension and produces ordinary `TextSource` objects, so the backend needs no change. Full details, integration steps and limitations: `extension/src/ocr/README.md`.

```ts
// extension/src/ocr/index.ts
// Reads text from one image on the user's computer. Never uploads the image.
export async function readImageText(image: Blob, index: number,
  options?: { signal?: AbortSignal; onProgress?: (p: OcrProgress) => void }): Promise<OcrResult>;
export function startReview(result: OcrResult): OcrReview;            // user reviews/corrects
export function reviewToTextSource(review: OcrReview): ToSourceResult; // -> { id: "image_text:<n>", type: "image_text", text }
export function locateQuote(result: OcrResult, quote: string): QuoteLocation; // evidence quote -> word boxes
export function imageBoxesToPreview(boxes: OcrBox[], layout: PreviewLayout): PreviewRect[]; // boxes -> resized preview
```

- `OcrResult` has `sourceId`, `status` (`"text_found"` | `"no_text"`), `text`, mean `confidence`, `imageWidth`/`imageHeight`, and `words`/`lines` with stable ids (`image_text:1#w3`), boxes and per-word confidence.
- **Failures throw `OcrError`** (`CANCELLED`, `NOT_AN_IMAGE`, `IMAGE_TOO_LARGE`, `ENGINE_LOAD_FAILED`, `RECOGNITION_FAILED`). A failure is never an empty "no text" result.
- The OCR types live in `extension/src/ocr/types.ts`, **not** in `shared/contract.ts` as first proposed. They never cross the network or a Chrome message, and keeping boxes and image sizes out of the shared file means the backend can't start accepting them by accident. What crosses the network is the existing `TextSource`.
- The popup shows the OCR text in the existing "Text in the photo" box for the user to correct, then sends it as `{ id: "image_text:<n>", type: "image_text", text }`.
- Manifest V3 forbids remote code: the engine worker, WASM cores and English data are bundled into `dist/ocr/` by `extension/build.mjs`. The extension-page CSP with `'wasm-unsafe-eval'` is now in `manifest.json`.
- **Instagram (owner 4):** the Instagram panel calls OCR through `OcrPort` in `extension/src/ports.ts`, which has the same shape as `readImageText()` and returns this `OcrResult`. The OCR worker can't start inside a content script, so Instagram uses `offscreenOcr` (`content/offscreen-ocr.ts`): the photo is passed inside the browser to the offscreen page `offscreen.html` (`src/offscreen.ts`), which runs `readImageText()`. The relay messages are in `src/ocr-relay.ts`, deliberately **not** in `shared/contract.ts`: they carry image data, which must never reach the backend. Reading the photo sends nothing for analysis; the user reviews the text and clicks "Check this post" first.

### C. Instagram page → extension (owners 4 and 2) — **in code**, milestone 4

The content script on instagram.com cannot call the backend directly (page CORS rules), so it sends Chrome messages to the service worker (`extension/src/background.ts`), which calls the backend using the same `api.ts` functions.

```ts
// In code: shared/contract.ts
export type ExtensionMessage =
  | { kind: "check-draft"; requestId: number; draftHash: string; sources: TextSource[] } // content script -> worker
  | { kind: "post-published"; draftHash: string; postId: string | null; publishedAt: string } // content script -> worker, confirmed posts only
  | { kind: "get-instagram-draft" };                                                     // popup -> content script

export type CheckDraftReply =                                   // worker -> content script
  | { kind: "check-result"; requestId: number; result: AnalyzeResponse }
  | { kind: "check-error"; requestId: number; message: string };

export interface InstagramDraftReply { kind: "instagram-draft"; found: boolean; caption: string; imageText: string } // content script -> popup
```

- `requestId` is echoed so the content script can ignore replies for older checks. The worker checks every message (`extension/src/messages.ts`): text only, our own content script on instagram.com only.
- The proposed `draft-changed` message was not needed: the content script tracks changes itself (`extension/src/content/share-flow.ts`).
- What was verified on the live site, and what wasn't, is listed in `docs/ROADMAP.md`. The "Check this post" button stays as the fallback.

### D. History (owners 1 and 4): backend **in code**, Databricks storage **requested**, extension UI **proposed**, milestone 3

Only posts the user explicitly approved, and only published posts. All types are in `shared/contract.ts` (contract version 3). The backend stores them; the extension never holds Databricks credentials.

Extension side so far: the service worker calls `HistoryClient.recordPublished({ draftHash, postId, publishedAt })` (`extension/src/ports.ts`) **only** after Instagram confirmed a publication. The stand-in `noHistory` stores nothing. Person C: replace it in `background.ts` with a client for the endpoints below, and ask the user before importing anything.

```
POST   /api/history/import                        HistoryImportRequest -> HistoryImportResponse
GET    /api/history                               -> HistoryListResponse
DELETE /api/history/posts/:postId                 -> HistoryDeleteResponse
POST   /api/history/approvals/:approvalId/revoke  -> HistoryDeleteResponse
DELETE /api/history                               -> HistoryDeleteResponse   ("delete all my history")
POST   /api/history/suggest                       { sources } -> HistorySuggestResponse (pre-selection only)
POST   /api/analyze  { ..., historyPostIds: [...] } -> AnalyzeResponse with historyUsed
```

- Every history call (and `historyPostIds`) needs the `X-Second-Look-User` header: a random id the extension creates once per install and keeps in `chrome.storage`. That's for owner 2 or 4 to add.
- `approval.postIds` must list exactly the imported posts. The response's `approvalId` is what the user revokes later.
- Consent flow: call `/api/history/suggest` with the draft, show the user's approved posts with the suggestions pre-ticked, and let the user change the selection. Send the final postIds in `historyPostIds`; the consent step lists exactly those posts. The backend adds them as `history:<postId>` sources (with `date`), in that order, and refuses the request if any is no longer in the user's approved history. The extension never sends `history` sources itself.
- Use the backend's `HistoryPost` / `StoredHistoryPost` shapes (`publishedAt`, `status: "published"`), and use the `approvalId` the backend returns from import (don't make your own).
- Storage is behind one interface (`backend/src/history/store.ts`): a temporary in-memory dev store today, and the Databricks App store once Genie builds the endpoints in `docs/DATABRICKS_APP_API.md`. AI interpretations are stored apart from posts and deleted with them.

### E. Warning interface (owner 2) — **in code**, consumed by everyone

`extension/src/render.ts` → `renderResults(elements, result, sources, onApplyEdit)` draws any `AnalyzeResponse`. The Instagram panel (`extension/src/content/overlay.ts`) reuses it, and popup.css, inside a Shadow DOM. Its methods are the `WarningPanel` interface in `extension/src/ports.ts`; owner 2 can replace the panel with their own by implementing that interface. Rules: `textContent` only (never `innerHTML`), show the "Practice mode" banner for `mode: "mock"`, the incomplete banner for `droppedFindings > 0`, and the stale banner when the draft hash changes.

## Not done yet (do not assume these work)

- **Live Databricks analysis** passed with real credentials on 2026-11-14 (`npm run check:databricks` printed `Success. Connection verified.`). Re-run it after any app or credential change. Results go in `docs/TEST_RESULTS.md`.
- **Databricks history storage** passed `npm run check:history` on 2026-11-14 (import, list, revoke). A live analysis with history (and saving its AI interpretations) also passed, and now takes about 8–9 s (interpretations are saved after the reply). Import and delete take about 10–12 s each. Set `HISTORY_STORE=databricks-app` to use it; the default `dev-memory` is temporary.
- The OCR module (`extension/src/ocr/`) is used by the popup ("Add a photo", run in the popup itself) and by the Instagram panel (through the offscreen page). The popup path was run in headless Chrome with the built extension and the live backend on 2026-11-15: OCR text was checked and quoted by the model. The Instagram path is not yet tried on the live site.
- Instagram integration covers photo posts (single photo or carousel) in English only; carousel support is not yet tried on the live site. Blocking Share, letting a share through after "Continue", detecting "published", and staying out of the way for 2-photo posts are verified on the live site (2026-11-15, mock backend). Failure screens and video posts are **not**. See `docs/ROADMAP.md`.
- The extension's history screen is not implemented, and the extension doesn't call the history API yet (`noHistory` stand-in in `ports.ts`).
- The popup has only been checked through its code and automated tests, not by clicking through it in Chrome.
