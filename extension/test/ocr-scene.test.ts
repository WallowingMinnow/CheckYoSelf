// Tests for reading text in everyday photos (src/ocr/scene.ts): keeping only
// clearly readable lines, where to zoom in, and merging the whole-photo read
// with zoomed crops.
// The word lists below are modelled on real Tesseract reads of a photo of a
// building with a sign ("WATERS RESIDENCE HALL / LIZ'S MARKET / 1200
// OBSERVATORY DRIVE") that the extension used to read as nothing at all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pageToOcrResult, type RawPage, type RawWord } from "../src/ocr/convert";
import { combineReads, readableLines, zoomRegions } from "../src/ocr/scene";
import { describePhotoRead } from "../src/photo-text";

/** A word at (x, y), `w` wide and 12 high. */
function wd(text: string, confidence: number, x: number, y: number, w = 10 * text.length): RawWord {
  return { text, confidence, bbox: { x0: x, y0: y, x1: x + w, y1: y + 12 } };
}
function page(...lines: RawWord[][]): RawPage {
  return { blocks: [{ paragraphs: lines.map((words) => ({ lines: [{ words }] })) }] };
}
function textOf(p: RawPage): string {
  return pageToOcrResult(p, 1, 2000, 2000, "test").text;
}

const BRICKWORK = [
  [wd("=", 83, 52, 144), wd("a", 40, 80, 144), wd("stam", 30, 100, 144)],
  [wd("]", 83, 0, 235), wd("Cr", 45, 20, 235), wd("RE", 50, 60, 235), wd("—", 70, 100, 235)],
  [wd("EAE", 63, 1064, 601), wd("|", 61, 1041, 620)],
  [wd("EN", 79, 1165, 300)],                                     // lone 2-letter "word" from a window grid
  [wd("2", 83, 724, 888), wd("A", 30, 873, 896), wd("Xi", 26, 891, 906), wd("SE", 0, 950, 891), wd("3", 91, 1124, 915)],
];

test("junk lines from brickwork and windows are dropped; the sign line is kept", () => {
  const sign = [wd("~", 40, 830, 836), wd("{", 30, 850, 836), wd("1200", 96, 893, 836), wd("OBSERVATORY", 96, 929, 836, 90), wd("DRIVE", 96, 1024, 838)];
  const { lines, totalWords } = readableLines(page(...BRICKWORK, sign));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.map((w) => w.text).join(" "), "1200 OBSERVATORY DRIVE");
  assert.equal(totalWords, 20);
});

test("unsure real words are kept (the user can fix them); stray bits at the ends are trimmed", () => {
  const { lines } = readableLines(page([wd("a'", 40, 0, 0), wd("Happy", 90, 30, 0), wd("Burtivday", 50, 90, 0), wd("Milo!", 88, 200, 0), wd("3", 30, 260, 0)]));
  assert.equal(lines[0].words.map((w) => w.text).join(" "), "Happy Burtivday Milo!");
  // The script card's real read: "Hollow" and "Parks" are unsure but real.
  const card = readableLines(page([wd("Party", 86, 41, 185), wd("at", 94, 173, 166), wd("Oak", 77, 235, 166), wd("Hollow", 35, 331, 182), wd("Parks", 42, 507, 166), wd("stam", 20, 600, 166)]));
  assert.equal(card.lines[0].words.map((w) => w.text).join(" "), "Party at Oak Hollow Parks");
});

test("a word alone on a line needs high confidence and 4+ letters, or must be a number", () => {
  assert.equal(readableLines(page([wd("32", 90, 0, 0)])).lines.length, 1, "a jersey number");
  assert.equal(readableLines(page([wd("HEE", 88, 0, 0)])).lines.length, 0, "short lone 'word' from a window grid");
  assert.equal(readableLines(page([wd("Tigers", 92, 0, 0)])).lines.length, 1);
  assert.equal(readableLines(page([wd("Tigers", 80, 0, 0)])).lines.length, 0, "lone word under 85%");
  assert.equal(readableLines(page([wd("7", 95, 0, 0)])).lines.length, 0, "a single digit alone");
});

const SIGN_LINES = [
  [wd("RESIDENCE", 96, 941, 803, 90), wd("HALL", 83, 1040, 804)],
  [wd("LIZ'S", 85, 933, 819), wd("MARKET", 96, 972, 820)],
  [wd("1200", 96, 893, 836), wd("OBSERVATORY", 96, 929, 836, 90), wd("DRIVE", 96, 1024, 838)],
];

test("a zoomed crop adds words and lines the whole-photo read missed, without duplicates", () => {
  const whole = page(...BRICKWORK, ...SIGN_LINES);
  // A crop starting at (700, 775), enlarged 2x: crop coordinates = (photo - origin) * 2.
  const at = (text: string, conf: number, x: number, y: number, w: number) => wd(text, conf, (x - 700) * 2, (y - 775) * 2, w * 2);
  const zoomed = page(
    [at("WATERS", 95, 866, 803, 65), at("RESIDENCE", 96, 941, 803, 90), at("HALL", 96, 1040, 804, 40)],
    [at("LIZ'S", 84, 933, 819, 30), at("MARKET", 96, 972, 820, 60)],
    [at("HEE", 88, 1010, 860, 30)],
  );
  const combined = combineReads([{ page: whole, scale: 1 }, { page: zoomed, scale: 2, offset: { x: 700, y: 775 } }]);
  assert.equal(textOf(combined.page), "WATERS RESIDENCE HALL\nLIZ'S MARKET\n1200 OBSERVATORY DRIVE");
  assert.equal(combined.droppedWords, 15, "all the brickwork words from the whole-photo read");
  // Boxes from the crop are moved back onto the whole photo.
  const waters = combined.page.blocks![0].paragraphs[0].lines[0].words[0];
  assert.equal(waters.text, "WATERS");
  assert.deepEqual([waters.bbox.x0, waters.bbox.y0, waters.bbox.x1], [866, 803, 931]);
});

test("zoom regions: one padded crop around a small sign, none for big text", () => {
  const sign = combineReads([{ page: page(...SIGN_LINES), scale: 1 }]).page;
  const regions = zoomRegions(sign, 1134, 1029);
  assert.equal(regions.length, 1, "the three sign lines merge into one crop");
  const r = regions[0];
  assert.ok(r.x <= 866 - 20 && r.x + r.width >= 1085, `covers the missed "WATERS" to the left: ${JSON.stringify(r)}`);
  assert.ok(r.y < 803 && r.y + r.height > 850);
  assert.ok(r.x + r.width <= 1134 && r.y + r.height <= 1029, "stays inside the photo");
  assert.ok(r.factor >= 2 && r.factor <= 3, `${r.factor}`);

  const big = page([wd("Riverside", 95, 100, 100, 300)].map((w) => ({ ...w, bbox: { ...w.bbox, y1: w.bbox.y0 + 40 } })));
  assert.deepEqual(zoomRegions(big, 900, 420), [], "40px-tall text is big enough");
  assert.deepEqual(zoomRegions(page(), 900, 420), []);
});

test("zooming is capped: at most 4 crops, each at most 2400 pixels per side", () => {
  const spread = page(...Array.from({ length: 8 }, (_, i) => [wd("Tiny", 95, (i % 4) * 1500, Math.floor(i / 4) * 1500)]));
  const regions = zoomRegions(spread, 6000, 3000);
  assert.equal(regions.length, 4);
  for (const r of regions) assert.ok(r.width * r.factor <= 2400 + 1 && r.height * r.factor <= 2400 + 1);
});

test("a later read that only overlaps part of a line extends it instead of repeating it", () => {
  const normal = page([wd("Party", 90, 100, 300), wd("at", 90, 160, 300), wd("Oak", 90, 190, 300)]);
  const enlarged = page([wd("at", 92, 320, 600, 40), wd("Oak", 92, 380, 600, 60), wd("Hollow", 92, 460, 600, 120), wd("Park", 92, 600, 600, 80)]);
  assert.equal(textOf(combineReads([{ page: normal, scale: 1 }, { page: enlarged, scale: 2 }]).page), "Party at Oak Hollow Park");
});

test("tilted text read twice is not mixed into the wrong line", () => {
  // Tilted lines: tall boxes that overlap vertically.
  const tall = (text: string, x: number, y: number, s = 1): RawWord => ({ text, confidence: 95, bbox: { x0: x * s, y0: y * s, x1: (x + 60) * s, y1: (y + 40) * s } });
  const lineA = (s: number) => [tall("Open", 100, 100, s), tall("daily", 170, 90, s), tall("7am", 240, 80, s)];
  const lineB = (s: number) => [tall("Maple", 100, 125, s), tall("Street", 170, 115, s), tall("Bakery", 240, 105, s)];
  const c = combineReads([{ page: page(lineA(1), lineB(1)), scale: 1 }, { page: page(lineA(2), lineB(2)), scale: 2 }]);
  assert.equal(textOf(c.page), "Open daily 7am\nMaple Street Bakery");
});

test("the OCR team's team-banner read loses only its junk line", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/ocr-team-banner.page.json", import.meta.url), "utf8")) as { page: RawPage };
  const c = combineReads([{ page: fixture.page, scale: 1 }]);
  assert.equal(textOf(c.page), "Riverside Youth Soccer\nU10 Tigers - Spring Season\nCoach Dana 608-555-0142");
  assert.equal(c.droppedWords, 2);
});

test("the user is told when unclear bits were left out, or when only unclear bits were found", () => {
  const p = page([wd("1200", 96, 0, 0), wd("OBSERVATORY", 96, 50, 0, 90), wd("DRIVE", 96, 150, 0)]);
  const kept = describePhotoRead({ ...pageToOcrResult(p, 1, 500, 500, "test"), droppedWords: 148 });
  assert.equal(kept.text, "1200 OBSERVATORY DRIVE");
  assert.equal(kept.discarded, false);
  assert.match(kept.notices.map((n) => n.text).join(" "), /Only the clearly readable text was kept; 148 unclear bits/);

  const none = describePhotoRead({ ...pageToOcrResult(page(), 1, 500, 500, "test"), droppedWords: 19 });
  assert.equal(none.text, "");
  assert.equal(none.discarded, true);
  assert.equal(none.notices[0].kind, "poor");
  assert.match(none.notices[0].text, /^No readable text found\. The text reader only saw 19 unclear bits/);

  const clean = describePhotoRead(pageToOcrResult(p, 1, 500, 500, "test"));
  assert.deepEqual(clean.notices, []);
});
