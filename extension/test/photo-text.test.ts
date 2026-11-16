// Tests for the photo-text rules (src/photo-text.ts: size limit, quality
// notices), highlight matching across line breaks (src/render.ts), and the
// plain-language "too long" message (src/messages.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseExtensionMessage } from "../src/messages";
import { pageToOcrResult, type RawPage } from "../src/ocr/convert";
import type { OcrResult, OcrWord } from "../src/ocr/types";
import {
  assessPhotoQuality,
  describePhotoRead,
  isJunkWord,
  photoProgressLabel,
  limitPhotoText,
  PHOTO_TEXT_MAX_CHARS,
  truncationNotice,
} from "../src/photo-text";
import { findQuoteRange } from "../src/render";

// --- 2. strict size limit ----------------------------------------------------------

test("photo text within the limit is kept as is", () => {
  assert.deepEqual(limitPhotoText("Coach Dana 608-555-0142"), { text: "Coach Dana 608-555-0142", truncated: false, originalLength: 23 });
});

test("photo text over the limit is cut at a word boundary and never exceeds it", () => {
  const long = "word ".repeat(400); // 2000 characters
  const r = limitPhotoText(long);
  assert.equal(r.truncated, true);
  assert.equal(r.originalLength, 2000);
  assert.ok(r.text.length <= PHOTO_TEXT_MAX_CHARS);
  assert.ok(r.text.endsWith("word"), "no half words");
  assert.match(truncationNotice(r), /2000 characters.*1000-character limit/);
});

test("text with no spaces is still cut hard at the limit", () => {
  const r = limitPhotoText("x".repeat(5000));
  assert.equal(r.text.length, PHOTO_TEXT_MAX_CHARS);
  assert.equal(r.truncated, true);
});

test("the demo limit is far below the backend's per-source limit", () => {
  assert.ok(PHOTO_TEXT_MAX_CHARS <= 1000);
});

// --- 3. noise / quality ---------------------------------------------------------------

test("junk words are recognized; real short words and digits are not", () => {
  for (const junk of ["©", "~", ":", "=", ">", "00000000000", "oooo", "q"]) assert.equal(isJunkWord(junk), true, junk);
  for (const real of ["a", "I", "3", "U10", "608-555-0142", "Dana", "Hi!", "-", "—", "&"]) assert.equal(isJunkWord(real), false, real);
});

let n = 0;
function word(text: string, confidence = 90): OcrWord {
  n++;
  return { id: `image_text:1#w${n}`, lineId: "image_text:1#l1", text, confidence, box: { x0: 0, y0: 0, x1: 1, y1: 1 }, start: 0, end: text.length };
}
function ocr(words: OcrWord[], overrides: Partial<OcrResult> = {}): OcrResult {
  const mean = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : null;
  return {
    sourceId: "image_text:1", status: words.length ? "text_found" : "no_text", text: words.map((w) => w.text).join(" "),
    confidence: mean, imageWidth: 10, imageHeight: 10, lines: [], words,
    lowConfidenceWordIds: words.filter((w) => w.confidence < 60).map((w) => w.id), engine: "test", ...overrides,
  };
}

test("a clean read gets no notice", () => {
  const q = assessPhotoQuality(ocr([word("Riverside"), word("Youth"), word("Soccer")]));
  assert.equal(q.level, "clean");
  assert.equal(q.message, null);
});

test("a few unclear or junk words give a 'some of the photo couldn't be read clearly' notice", () => {
  const q = assessPhotoQuality(ocr([word("Riverside"), word("Youth"), word("Soccer"), word("Coach"), word("Dana"), word("~")]));
  assert.equal(q.level, "noisy");
  assert.match(q.message ?? "", /couldn't be read clearly \(1 of 6 words: “~”\)/);
});

test("mostly unclear words, or low average confidence, give an explicit poor-quality notice", () => {
  const mostlyJunk = assessPhotoQuality(ocr([word("oO"), word("=", 30), word("©", 20), word("Tigers")]));
  assert.equal(mostlyJunk.level, "poor");
  assert.match(mostlyJunk.message ?? "", /^Poor photo quality/);
  const blurry = assessPhotoQuality(ocr([word("Happy", 55), word("Burtivday", 50), word("Milo", 58)]));
  assert.equal(blurry.level, "poor", "average confidence under 60");
});

test("no text found is not reported as noise", () => {
  assert.deepEqual(assessPhotoQuality(ocr([])).level, "no_text");
});

test("the OCR team's real team-banner read is flagged as noisy, naming the junk line", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ocr-team-banner.page.json", import.meta.url), "utf8")) as {
    page: RawPage; imageWidth: number; imageHeight: number;
  };
  const result = pageToOcrResult(fixture.page, 1, fixture.imageWidth, fixture.imageHeight, "test");
  const q = assessPhotoQuality(result);
  assert.equal(q.level, "noisy");
  assert.ok(q.examples.includes("00000000000"), JSON.stringify(q.examples));
  assert.ok(!q.examples.includes("-"), "the real dash in 'U10 Tigers - Spring Season' is not noise");
});

test("notice text quotes OCR words as plain text (shown with textContent)", () => {
  const q = assessPhotoQuality(ocr([word("<img src=x onerror=alert(1)>", 10), word("ok")]));
  assert.ok(q.message?.includes("<img src=x onerror=alert(1)>"), "kept verbatim; overlay renders it with textContent");
});

// --- 1. highlights across line breaks --------------------------------------------------

const PHOTO = "0 00000000000\nRiverside Youth Soccer\nU10 Tigers - Spring Season\nCoach Dana 608-555-0142";

test("a quote that runs across a line break is found in the original text", () => {
  const r = findQuoteRange(PHOTO, "spring season coach dana");
  assert.ok(r);
  assert.equal(PHOTO.slice(r!.start, r!.end), "Spring Season\nCoach Dana");
});

test("case and extra spaces are ignored, like the backend's verified check", () => {
  const r = findQuoteRange("Back home on   Maple\tSt after practice", "maple st");
  assert.ok(r);
  assert.equal("Back home on   Maple\tSt after practice".slice(r!.start, r!.end), "Maple\tSt");
  assert.deepEqual(findQuoteRange(PHOTO, "608-555-0142"), { start: PHOTO.length - 12, end: PHOTO.length });
});

test("quotes that aren't there, or blank quotes, aren't highlighted", () => {
  assert.equal(findQuoteRange(PHOTO, "Lincoln Elementary"), null);
  assert.equal(findQuoteRange(PHOTO, "   "), null);
});

// --- 2. plain "too long" wording -------------------------------------------------------

test("an over-long source is reported in plain words, not 'sources[1]'", () => {
  const msg = { kind: "check-draft", requestId: 1, draftHash: "a".repeat(64), sources: [
    { id: "caption", type: "caption", text: "hi" },
    { id: "image_text:1", type: "image_text", text: "word ".repeat(1100) },
  ] };
  const parsed = parseExtensionMessage(msg);
  assert.equal(parsed.ok, false);
  assert.match(!parsed.ok ? parsed.reason : "", /^The photo text is too long to check \(5500 characters; the limit is 5000\)/);
});

// --- 4. what the popup shows after a read (describePhotoRead) -----------------------

test("a clean read fills the box with no notices and says to check it", () => {
  const view = describePhotoRead(ocr([word("Coach"), word("Dana"), word("608-555-0142")]));
  assert.equal(view.text, "Coach Dana 608-555-0142");
  assert.deepEqual(view.notices, []);
  assert.equal(view.quality, "clean");
  assert.ok(view.hint.startsWith("Read from the photo on your computer (confidence 90%). Check it"), view.hint);
});

test("an unreliable read is thrown away: empty box, and the user is told why", () => {
  const view = describePhotoRead(ocr([word("oO", 30), word("=", 20), word("©", 20)]));
  assert.equal(view.quality, "poor");
  assert.equal(view.discarded, true);
  assert.equal(view.text, "", "guessed letters must not be filled in (or sent to the AI)");
  assert.equal(view.notices.length, 1);
  assert.equal(view.notices[0].kind, "poor");
  assert.match(view.notices[0].text, /^No readable text found\. .*nothing was added/);
  assert.match(view.hint, /^Nothing was read from this photo/);
});

test("a photo of a building (thousands of low-confidence 'words', reported by a user) gives an empty box, not garbage", () => {
  // Like the real case: confidence 32%, ~1000 junk "words", ~3000 characters.
  const junk = ["PN", "=", "y", "_—=", "ZEN", ">", "AW/", "oii", "R", "5", "es", "dh", "SF", "==", "Wl", "|", "TZ", "A", "oa"];
  const words = Array.from({ length: 1067 }, (_, i) => word(junk[i % junk.length], i % 20 === 0 ? 70 : 25));
  const view = describePhotoRead(ocr(words));
  assert.equal(view.discarded, true);
  assert.equal(view.text, "");
  assert.equal(view.truncated, false, "no 'lot of text' notice for text we threw away");
  assert.deepEqual(view.notices.map((n) => n.kind), ["poor"]);
  assert.match(view.notices[0].text, /confidence \d+%, \d+ of 1067 "words" unclear/);
});

test("a noisy (mostly readable) read is still filled in, with a notice to fix it", () => {
  const view = describePhotoRead(ocr([word("Riverside"), word("Youth"), word("Soccer"), word("Coach"), word("Dana"), word("~")]));
  assert.equal(view.quality, "noisy");
  assert.equal(view.discarded, false);
  assert.equal(view.text, "Riverside Youth Soccer Coach Dana ~");
  assert.deepEqual(view.notices.map((n) => n.kind), ["warning"]);
});

test("an over-long read is cut to the limit and says so", () => {
  const view = describePhotoRead(ocr(Array.from({ length: 300 }, () => word("Riverside"))));
  assert.ok(view.text.length <= PHOTO_TEXT_MAX_CHARS);
  assert.equal(view.truncated, true);
  assert.ok(view.notices.some((n) => n.kind === "warning" && /character limit/.test(n.text)));
});

test("no text found: empty box and a hint to type it", () => {
  const view = describePhotoRead(ocr([]));
  assert.equal(view.text, "");
  assert.deepEqual(view.notices, []);
  assert.match(view.hint, /^No text found in the photo/);
});

test("progress labels name the stage and clamp the percentage", () => {
  assert.equal(photoProgressLabel("recognizing", 0.4), "Reading text… 40%");
  assert.equal(photoProgressLabel("loading_engine", 1.7), "Starting the text reader… 100%");
  assert.equal(photoProgressLabel("preparing_image", -1), "Opening the photo… 0%");
});
