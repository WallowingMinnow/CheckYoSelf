# OCR module (milestone 2)

Reads the text in a photo **on the user's computer** with [Tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 and English language data. The user reviews and corrects the text, and only that text goes to the backend, as an ordinary `image_text` `TextSource`. The backend needs no change.

**Privacy rules this module keeps**

- Image pixels, box coordinates, image sizes and confidence numbers never leave the browser. Only `{ id, type: "image_text", text }` is sent, and only after the user has reviewed it.
- Nothing in `src/ocr/` calls the Node backend, Databricks, or any model.
- Nothing is downloaded from the internet. The engine worker, WASM cores and language file are bundled into `dist/ocr/` by `build.mjs`. The bundle still contains Tesseract.js's default CDN URL as an unused string; we always pass local paths instead.
- The language file is not cached in IndexedDB (`cacheMethod: "none"`).

## Files

| File | What it does | Runs in |
|---|---|---|
| `index.ts` | Public interface. Import from `./ocr`, not the files inside. | |
| `engine.ts` | `readImageText()`: decodes the image (applies EXIF rotation), runs Tesseract twice on the whole photo (SINGLE_BLOCK and automatic page layout, merged by scene.ts: each wins on different photos), then zoomed crops of small text, handles progress, cancel, timeouts and errors. | browser only |
| `convert.ts` | Tesseract output → `OcrResult` (words, lines, boxes, ids). `toTextSource()`. | anywhere (tested) |
| `scene.ts` | Text in everyday photos: keeps only clearly readable lines (drops brickwork/window junk), picks small text to zoom into, merges the reads. | anywhere (tested) |
| `review.ts` | Review/correct step, `reviewHint()`, `locateQuote()` (quote → boxes). | anywhere (tested) |
| `coords.ts` | Image-pixel boxes → preview positions (`fill` / `contain` / `cover`). | anywhere (tested) |
| `control.ts` | Cancel/timeout/progress helpers. | anywhere (tested) |
| `types.ts` | `OcrResult`, `OcrWord`, `OcrBox`, `OcrError`, limits. | |
| `demo/` | Test page `ocr-demo.html` and FICTIONAL sample images. | browser |

## The interface

```ts
import { readImageText, startReview, updateReviewedText, reviewToTextSource,
         reviewHint, locateQuote, imageBoxesToPreview, OcrError } from "./ocr";

// 1. Scan (File from <input type="file">, or any Blob). index 1 = first photo.
const controller = new AbortController();           // controller.abort() cancels
const result = await readImageText(file, 1, {
  signal: controller.signal,
  onProgress: (p) => { /* p.stage: "preparing_image" | "loading_engine" | "recognizing"; p.fraction 0..1 */ },
});
// result.status  "text_found" | "no_text"   (no_text = scan WORKED, found nothing)
// result.text    words joined by " ", lines by "\n"
// result.words   [{ id: "image_text:1#w3", lineId, text, confidence, box: {x0,y0,x1,y1}, start, end }]
// result.lines   [{ id: "image_text:1#l1", text, confidence, box, wordIds }]
// result.imageWidth / imageHeight   size of the scanned image (after EXIF rotation)
// result.confidence                 mean word confidence 0-100, or null
// result.lowConfidenceWordIds       words under 60%, worth pointing out

// 2. Let the user review and correct.
let review = startReview(result);                    // review.reviewedText starts as result.text
review = updateReviewedText(review, textarea.value); // on every edit

// 3. Turn it into the request source (text only).
const out = reviewToTextSource(review);
if (out.ok) sources.push(out.source);                // { id: "image_text:1", type: "image_text", text }
else if (out.reason === "too_long") showError(out.message); // "empty" = just leave it out
```

**Errors.** Every failure throws an `OcrError` with a `code` and a user-readable `message`. A failure never comes back as an empty result.

| `code` | Meaning |
|---|---|
| `CANCELLED` | `signal` was aborted. Usually show nothing, or "Scan cancelled". |
| `NOT_AN_IMAGE` | The file can't be decoded as an image (e.g. a .txt, or HEIC, which Chrome can't open). |
| `IMAGE_TOO_LARGE` | Over 25 MB or over 8000 px on a side (`OCR_LIMITS`). |
| `ENGINE_LOAD_FAILED` | Worker, WASM or language file didn't load (bad build, or blocked by the manifest's CSP). Reported at once, or after 60 s at most. |
| `RECOGNITION_FAILED` | The engine crashed, took over 120 s, or returned output we can't trust. |

**Evidence ids.** Words are `image_text:<n>#w<k>` and lines `image_text:<n>#l<k>`, numbered in reading order. The same image and engine version always give the same ids. They identify OCR evidence inside the extension. The backend only sees the `image_text:<n>` source id and quotes.

## Popup integration (done)

**Status:** steps 1-3 and 5 below are done: the popup has "Add a photo" (`popup.ts`, `popup.html`), with progress, Stop reading, Remove photo, the 1000-character limit and the quality notices from `describePhotoRead()` in `src/photo-text.ts`. Step 4 (highlights on the photo preview) is not done yet. The original instructions are kept below for reference. `demo/demo.ts` is a complete working example of every step.

1. **`popup.html`**: next to the existing "Text in the photo" textarea (`#image-text`), add:
   - `<input type="file" id="photo" accept="image/*">`
   - a `<progress>`, a status line, and a Cancel button
   - a preview `<img>` inside a `position: relative` wrapper (for highlights)
   - a hint line for `reviewHint(result)`

   Remove the "Type it by hand for now" hint.
2. **`popup.ts`**: on file change, call `readImageText(file, 1, { signal, onProgress })`.
   - On success, put `review.reviewedText` into `#image-text` and show `reviewHint(result)`.
   - On the textarea's `input` event, call `updateReviewedText`. It already triggers `updateStaleness`.
   - In `collectSources()`, replace the hand-built `image_text:1` source with `reviewToTextSource(review)` when a review exists. If the user only typed text and has no photo, keep the current behavior.
   - On `OcrError`, show `error.message` in the status line, but not for `CANCELLED`. Never treat an error as "no text".
   - Cancel any running scan when a new file is picked or the popup closes.
3. **Stale results**: the draft hash already covers the `image_text` text. Picking a new photo changes the text, so results go stale automatically. You don't need anything extra.
4. **`render.ts`** (optional, highlights): for each finding's `Evidence` with `verified: true` and `sourceId` starting with `image_text:`:
   - call `locateQuote(result, evidence.quote)`, then `imageBoxesToPreview(where.boxes, { imageWidth, imageHeight, previewWidth: img.clientWidth, previewHeight: img.clientHeight, fit })`
   - draw absolutely positioned `<div>`s using `textContent` and `style` only
   - `fit` must match the `<img>`'s CSS `object-fit`
   - If `where.found` is false (the user corrected that text), show the finding without a photo highlight.
5. **`manifest.json`** (please add; it's your file). OCR compiles WebAssembly, which needs `'wasm-unsafe-eval'` in the extension-page CSP. Chrome's MV3 default may already include it, but declaring it makes the requirement explicit:

   ```json
   "content_security_policy": {
     "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
   }
   ```

   No new permissions and no `web_accessible_resources` are needed while OCR runs in the popup.

## Checks

```bash
cd extension
npm test            # unit tests (test/ocr.test.ts), no engine needed
npm run check:ocr   # runs the REAL engine in Node on the fictional demo images (a few seconds)
npm run build       # copies the engine into dist/ocr/ (adds ~15 MB to dist/)
```

**Manual check in Chrome:** load `extension/dist` on `chrome://extensions`. Then open `chrome-extension://<extension id>/ocr-demo.html` (copy the id from the extensions page). Try the sample buttons, Cancel, editing the text, and the quote highlight box.

## Limitations

- **Cropping.** Boxes are in the pixels of the file that was scanned. If the preview, or the post, shows a crop of that file, the boxes are offset or fall outside it. Scan the cropped image, or draw the preview from the same file with no extra crop. `object-fit: cover` crops too, and `imageBoxToPreview` trims or drops boxes in the cut-off part.
- **Rotation.** EXIF rotation from phones is applied before scanning, so boxes match how the photo looks. Text that is itself rotated or slanted is not straightened. Slightly tilted text (the `rotated-sign.png` sample) reads fine since the engine uses automatic page layout; strongly tilted or sideways text still won't. Ask the user to type it.
- **Everyday photos (scene text).** On a photo of a building, Tesseract reads the sign but also turns brickwork and windows into junk "words". `scene.ts` keeps only clearly readable lines (the rest is counted in `OcrResult.droppedWords` and the user is told), and engine.ts re-reads an enlarged crop around SMALL text it found, which recovers missed words (e.g. "WATERS" in "WATERS RESIDENCE HALL"). Text that the first read misses completely is not zoomed into. Enlarging the whole photo instead was tried: in Chrome, Tesseract then finds nothing.
- **Handwriting and stylized lettering** are often misread (see `script-card.png`: "Birthday" → "Burtivday"). That's why the user reviews the text, and why low-confidence words are flagged.
- **Photos without text** used to produce a few low-confidence "words" from shapes (`no-text.png` gave `y -`). These are now left out by `scene.ts`, and the user is told how many unclear bits were left out (`describePhotoRead()` in `src/photo-text.ts`).
- **Scanned image vs. Instagram's final image.** We scan the file the user picks. Instagram may then crop it (e.g. to 1:1 or 4:5), resize and compress it, apply filters, or let the user add text and stickers in its editor. Text added in Instagram is not in our file, and text cropped away by Instagram may still be in our scan. Whether the final edited image can be read from the page is unverified (`docs/ROADMAP.md`, assumption 4).
- **Language.** English only (`eng`, 4.0.0 best_int). Other scripts need more language files, each about 1-10 MB.
- **Size and speed.** About 1-3 seconds per image on the test machine. One engine is started per scan and stopped afterwards. Very large images are refused (`OCR_LIMITS`), not scaled down.
- **Content script (milestone 4).** A content script on instagram.com can't start this worker directly: the worker must be same-origin with the page. Run OCR in an extension page instead and pass the image there. For Instagram this is now built: `offscreen.html` / `src/offscreen.ts` runs `readImageText()`, and `src/ocr-relay.ts` passes the photo to it inside the browser. It's tested end to end in Chrome against a local stand-in page, not yet on the live site.
- **If loading fails early** (missing language file), Tesseract.js doesn't hand back its worker, so that idle worker stays until the page closes. The popup closes often, so this is minor.

## Upgrading Tesseract.js

1. Update `tesseract.js` (and, if needed, `@tesseract.js-data/eng`) in `package.json`.
2. Check that the file names in `OCR_ASSETS` in `build.mjs` still exist.
3. Update `ENGINE_NAME` in `engine.ts`.
4. Regenerate the test fixture with `npx tsx scripts/make-ocr-fixture.ts` and review the diff.
5. Run `npm test`, `npm run check:ocr`, and the demo page.
