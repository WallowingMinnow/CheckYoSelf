// Tests for the OCR module (src/ocr/). These run in Node, so they test the
// parts with no browser or engine: converting Tesseract output, the review
// step, finding quotes, preview coordinates, and cancel/progress rules.
// The real engine is checked separately with `npm run check:ocr`.
//
// The fixture is real Tesseract.js output for a FICTIONAL image
// (src/ocr/demo/images/team-banner.png).
// Run with: npm test   (in the extension folder)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LIMITS } from "../../shared/contract";
import { makeProgressReporter, waitFor } from "../src/ocr/control";
import { imageSourceId, pageToOcrResult, toTextSource, type RawPage } from "../src/ocr/convert";
import { imageBoxToPreview, imageBoxesToPreview } from "../src/ocr/coords";
import {
  isEdited,
  locateQuote,
  reviewHint,
  reviewToTextSource,
  startReview,
  updateReviewedText,
} from "../src/ocr/review";
import { OcrError, type OcrProgress } from "../src/ocr/types";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ocr-team-banner.page.json", import.meta.url), "utf8")) as {
  imageWidth: number;
  imageHeight: number;
  page: RawPage;
};

function bannerResult() {
  return pageToOcrResult(fixture.page, 1, fixture.imageWidth, fixture.imageHeight, "test");
}

/** A tiny fake Tesseract page: one line per entry, words as [text, confidence, x0]. */
function fakePage(lines: [string, number, number][][]): RawPage {
  return {
    blocks: [{
      paragraphs: [{
        lines: lines.map((words, row) => ({
          words: words.map(([text, confidence, x0]) => ({
            text, confidence, bbox: { x0, y0: row * 50, x1: x0 + 40, y1: row * 50 + 30 },
          })),
        })),
      }],
    }],
  };
}

function assertOcrError(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof OcrError && e.code === code);
}

// ---------------------------------------------------------------------------
// convert.ts
// ---------------------------------------------------------------------------

test("real Tesseract output becomes text, words, lines and boxes", () => {
  const r = bannerResult();
  assert.equal(r.sourceId, "image_text:1");
  assert.equal(r.status, "text_found");
  assert.equal(r.text, "0 00000000000\nRiverside Youth Soccer\nU10 Tigers - Spring Season\nCoach Dana 608-555-0142");
  assert.equal(r.imageWidth, 900);
  assert.equal(r.imageHeight, 420);
  assert.equal(r.words.length, 13);
  assert.equal(r.lines.length, 4);
  assert.ok(r.confidence !== null && r.confidence > 0 && r.confidence <= 100);
});

test("every word's start/end points at that word in the text", () => {
  const r = bannerResult();
  for (const w of r.words) assert.equal(r.text.slice(w.start, w.end), w.text, w.id);
});

test("evidence ids are numbered in reading order and stable across runs", () => {
  const a = bannerResult();
  const b = bannerResult();
  assert.deepEqual(a, b);
  assert.deepEqual(a.words.map((w) => w.id), a.words.map((_, i) => `image_text:1#w${i + 1}`));
  assert.deepEqual(a.lines.map((l) => l.id), ["image_text:1#l1", "image_text:1#l2", "image_text:1#l3", "image_text:1#l4"]);
  assert.equal(a.words[12].lineId, "image_text:1#l4");
});

test("low-confidence words are flagged (the misread colored bar at the top)", () => {
  const r = bannerResult();
  assert.deepEqual(r.lowConfidenceWordIds, ["image_text:1#w1", "image_text:1#w2"]);
});

test("image index sets the source id; bad indexes are rejected", () => {
  assert.equal(pageToOcrResult(fixture.page, 3, 900, 420, "t").words[0].id, "image_text:3#w1");
  assert.equal(imageSourceId(2), "image_text:2");
  for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => imageSourceId(bad));
});

test("FAILURE IS NOT 'NO TEXT': missing word list throws RECOGNITION_FAILED", () => {
  assertOcrError(() => pageToOcrResult({ blocks: null }, 1, 100, 100, "t"), "RECOGNITION_FAILED");
  assertOcrError(() => pageToOcrResult(undefined as unknown as RawPage, 1, 100, 100, "t"), "RECOGNITION_FAILED");
  assertOcrError(() => pageToOcrResult({} as RawPage, 1, 100, 100, "t"), "RECOGNITION_FAILED");
});

test("unknown image size throws instead of returning boxes that can't be trusted", () => {
  assertOcrError(() => pageToOcrResult(fixture.page, 1, 0, 420, "t"), "RECOGNITION_FAILED");
  assertOcrError(() => pageToOcrResult(fixture.page, 1, 900, NaN, "t"), "RECOGNITION_FAILED");
});

test("a successful scan with no words is 'no_text', not an error", () => {
  for (const page of [{ blocks: [] }, fakePage([]), fakePage([[["   ", 90, 0]]])]) {
    const r = pageToOcrResult(page, 1, 100, 100, "t");
    assert.equal(r.status, "no_text");
    assert.equal(r.text, "");
    assert.equal(r.confidence, null);
    assert.deepEqual(r.words, []);
    assert.deepEqual(r.lines, []);
  }
});

test("blank words are skipped and spaces inside a word are collapsed", () => {
  const r = pageToOcrResult(fakePage([[["Oak", 90, 0], ["", 90, 50], ["Hollow \n Park", 90, 100]]]), 1, 500, 500, "t");
  assert.equal(r.text, "Oak Hollow Park");
  assert.equal(r.words.length, 2);
});

test("boxes are kept inside the image and confidence inside 0-100", () => {
  const page: RawPage = {
    blocks: [{ paragraphs: [{ lines: [{ words: [
      { text: "edge", confidence: 140, bbox: { x0: 120, y0: -5, x1: 80, y1: 60 } }, // upside down + outside
      { text: "nan", confidence: NaN, bbox: { x0: 1, y0: 1, x1: 2, y1: 2 } },
    ] }] }] }],
  };
  const r = pageToOcrResult(page, 1, 100, 50, "t");
  assert.deepEqual(r.words[0].box, { x0: 80, y0: 0, x1: 100, y1: 50 });
  assert.equal(r.words[0].confidence, 100);
  assert.equal(r.words[1].confidence, 0);
});

test("toTextSource sends ONLY id, type and text (no boxes, sizes or confidence)", () => {
  const out = toTextSource("image_text:1", "Coach Dana");
  assert.ok(out.ok);
  assert.deepEqual(out.source, { id: "image_text:1", type: "image_text", text: "Coach Dana" });
  assert.deepEqual(Object.keys(out.source).sort(), ["id", "text", "type"]);
});

test("toTextSource: blank text is left out, too-long text is refused (never cut silently)", () => {
  const empty = toTextSource("image_text:1", "  \n ");
  assert.equal(empty.ok, false);
  assert.equal(!empty.ok && empty.reason, "empty");

  const long = toTextSource("image_text:1", "a".repeat(LIMITS.maxCharsPerSource + 1));
  assert.equal(long.ok, false);
  assert.equal(!long.ok && long.reason, "too_long");

  assert.ok(toTextSource("image_text:1", "a".repeat(LIMITS.maxCharsPerSource)).ok);
});

test("toTextSource rejects ids that aren't image_text ids", () => {
  for (const bad of ["caption", "image_text:0", "image_text:", "image_text:1#w2", "history:1"]) {
    assert.throws(() => toTextSource(bad, "x"), bad);
  }
});

// ---------------------------------------------------------------------------
// review.ts
// ---------------------------------------------------------------------------

test("review: the user's corrected text is what gets sent", () => {
  let review = startReview(bannerResult());
  assert.equal(isEdited(review), false);
  assert.equal(review.reviewedText, review.result.text);

  const corrected = "Riverside Youth Soccer\nU10 Tigers - Spring Season\nCoach Dana 608-555-0142";
  review = updateReviewedText(review, corrected);
  assert.equal(isEdited(review), true);
  const out = reviewToTextSource(review);
  assert.ok(out.ok);
  assert.equal(out.source.text, corrected);
  // The OCR result itself is unchanged.
  assert.ok(review.result.text.startsWith("0 00000000000"));
});

test("review: clearing the text means nothing is sent for this photo", () => {
  const review = updateReviewedText(startReview(bannerResult()), "");
  assert.equal(reviewToTextSource(review).ok, false);
});

test("reviewHint covers no text, all-noise, some unclear words, and all clear", () => {
  const noText = pageToOcrResult({ blocks: [] }, 1, 10, 10, "t");
  assert.match(reviewHint(noText) ?? "", /No text was found/);

  const noise = pageToOcrResult(fakePage([[["y", 40, 0], ["-", 50, 50]]]), 1, 500, 500, "t");
  assert.match(reviewHint(noise) ?? "", /may have no real text/);

  assert.match(reviewHint(bannerResult()) ?? "", /^2 words may be misread/);

  const clear = pageToOcrResult(fakePage([[["Hello", 95, 0]]]), 1, 500, 500, "t");
  assert.equal(reviewHint(clear), null);
});

test("locateQuote ignores case and extra spaces, like the backend's check", () => {
  const r = bannerResult();
  const where = locateQuote(r, "  coach   DANA 608-555-0142 ");
  assert.equal(where.found, true);
  assert.deepEqual(where.wordIds, ["image_text:1#w11", "image_text:1#w12", "image_text:1#w13"]);
  assert.equal(where.boxes.length, 3);
});

test("locateQuote across a line break", () => {
  const where = locateQuote(bannerResult(), "Season Coach");
  assert.deepEqual(where.wordIds, ["image_text:1#w10", "image_text:1#w11"]);
});

test("locateQuote: part of a word highlights the whole word", () => {
  assert.deepEqual(locateQuote(bannerResult(), "555").wordIds, ["image_text:1#w13"]);
});

test("locateQuote: text the user typed (not in the OCR text) is not found", () => {
  assert.deepEqual(locateQuote(bannerResult(), "Coach Dina"), { found: false, wordIds: [], boxes: [] });
  assert.equal(locateQuote(bannerResult(), "   ").found, false);
});

test("locateQuote returns every place a repeated quote appears", () => {
  const r = pageToOcrResult(fakePage([[["Milo", 90, 0], ["and", 90, 50]], [["Milo", 90, 0]]]), 1, 500, 500, "t");
  assert.deepEqual(locateQuote(r, "milo").wordIds, ["image_text:1#w1", "image_text:1#w3"]);
});

// ---------------------------------------------------------------------------
// coords.ts
// ---------------------------------------------------------------------------

const box = { x0: 100, y0: 50, x1: 300, y1: 150 };

test("fill: stretches x and y separately", () => {
  const r = imageBoxToPreview(box, { imageWidth: 1000, imageHeight: 500, previewWidth: 500, previewHeight: 500, fit: "fill" });
  assert.deepEqual(r, { left: 50, top: 50, width: 100, height: 100 });
  // "fill" is the default, like CSS.
  assert.deepEqual(imageBoxToPreview(box, { imageWidth: 1000, imageHeight: 500, previewWidth: 500, previewHeight: 500 }), r);
});

test("contain: same scale both ways, centered with empty bars", () => {
  // 1000x500 into 500x500 -> scale 0.5, image is 500x250, bars of 125 above and below.
  const r = imageBoxToPreview(box, { imageWidth: 1000, imageHeight: 500, previewWidth: 500, previewHeight: 500, fit: "contain" });
  assert.deepEqual(r, { left: 50, top: 150, width: 100, height: 50 });
});

test("cover: edges cut off; boxes are trimmed or dropped", () => {
  // 1000x500 into 500x500 -> scale 1, image is 1000x500 centered: 250 cut off each side.
  const layout = { imageWidth: 1000, imageHeight: 500, previewWidth: 500, previewHeight: 500, fit: "cover" as const };
  assert.equal(imageBoxToPreview({ x0: 0, y0: 0, x1: 200, y1: 100 }, layout), null); // fully in the cut-off part
  // x 100..300 -> -150..50 on screen: only the right 50px are visible.
  assert.deepEqual(imageBoxToPreview(box, layout), { left: 0, top: 50, width: 50, height: 100 });
  assert.deepEqual(imageBoxToPreview({ x0: 200, y0: 0, x1: 300, y1: 100 }, layout), { left: 0, top: 0, width: 50, height: 100 });
  assert.deepEqual(imageBoxToPreview({ x0: 500, y0: 100, x1: 600, y1: 200 }, layout), { left: 250, top: 100, width: 100, height: 100 });
});

test("zero or missing sizes give no highlight instead of NaN positions", () => {
  assert.equal(imageBoxToPreview(box, { imageWidth: 0, imageHeight: 500, previewWidth: 500, previewHeight: 500 }), null);
  assert.equal(imageBoxToPreview(box, { imageWidth: 1000, imageHeight: 500, previewWidth: 0, previewHeight: 0 }), null);
});

test("a located quote in the real fixture lands on the right spot of a 360x240 preview", () => {
  const r = bannerResult();
  const where = locateQuote(r, "608-555-0142");
  const rects = imageBoxesToPreview(where.boxes, {
    imageWidth: r.imageWidth, imageHeight: r.imageHeight, previewWidth: 360, previewHeight: 240, fit: "contain",
  });
  assert.equal(rects.length, 1);
  // scale 0.4, vertical bars of (240 - 168) / 2 = 36
  const b = where.boxes[0];
  assert.ok(Math.abs(rects[0].left - b.x0 * 0.4) < 1e-9);
  assert.ok(Math.abs(rects[0].top - (36 + b.y0 * 0.4)) < 1e-9);
});

// ---------------------------------------------------------------------------
// control.ts (cancel, timeout, progress)
// ---------------------------------------------------------------------------

const neverTimesOut = () => new OcrError("RECOGNITION_FAILED", "timeout");

test("waitFor passes through results and errors", async () => {
  assert.equal(await waitFor(Promise.resolve(5), undefined, 1000, neverTimesOut), 5);
  await assert.rejects(waitFor(Promise.reject(new Error("boom")), undefined, 1000, neverTimesOut), /boom/);
});

test("waitFor rejects with CANCELLED when aborted, even if the work never finishes", async () => {
  const control = new AbortController();
  const pending = waitFor(new Promise(() => {}), control.signal, 10_000, neverTimesOut);
  control.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof OcrError && e.code === "CANCELLED");
});

test("waitFor rejects at once if already cancelled", async () => {
  const control = new AbortController();
  control.abort();
  await assert.rejects(waitFor(Promise.resolve(1), control.signal, 1000, neverTimesOut),
    (e: unknown) => e instanceof OcrError && e.code === "CANCELLED");
});

test("waitFor gives up after the timeout with the caller's error", async () => {
  await assert.rejects(
    waitFor(new Promise(() => {}), undefined, 10, () => new OcrError("ENGINE_LOAD_FAILED", "slow")),
    (e: unknown) => e instanceof OcrError && e.code === "ENGINE_LOAD_FAILED",
  );
});

test("progress fractions are kept between 0 and 1", () => {
  const seen: OcrProgress[] = [];
  const report = makeProgressReporter((p) => seen.push(p), undefined, () => false);
  report("recognizing", 1.7);
  report("recognizing", -1);
  report("loading_engine", NaN);
  report("loading_engine", 0.5);
  assert.deepEqual(seen.map((p) => p.fraction), [1, 0, 0, 0.5]);
});

test("REGRESSION: no progress after cancel, so 'cancelled' isn't overwritten by 'Starting... 100%'", () => {
  const seen: OcrProgress[] = [];
  const control = new AbortController();
  let done = false;
  const report = makeProgressReporter((p) => seen.push(p), control.signal, () => done);
  report("loading_engine", 0.2);
  control.abort();
  report("loading_engine", 1); // a late message from the worker that is shutting down
  assert.equal(seen.length, 1);

  const seen2: OcrProgress[] = [];
  const report2 = makeProgressReporter((p) => seen2.push(p), undefined, () => done);
  done = true;
  report2("recognizing", 1);
  assert.equal(seen2.length, 0);
});
