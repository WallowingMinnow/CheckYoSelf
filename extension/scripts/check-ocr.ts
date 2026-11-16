// Runs the REAL OCR engine (Tesseract.js, in Node) on the fictional demo
// images and checks what comes out, using the same conversion code the
// extension uses (src/ocr/convert.ts). Slower than `npm test` (a few seconds),
// so it's a separate command:
//   npm run check:ocr
//
// Node, not Chrome: this checks the engine version, the bundled language file
// and our conversion. It does NOT check that the extension can load the worker
// and WASM; for that, open ocr-demo.html in the loaded extension (see
// src/ocr/README.md). Uses only local files; nothing is downloaded.
import { readFileSync } from "node:fs";
import { createWorker, PSM } from "tesseract.js";
import { pageToOcrResult, type RawPage } from "../src/ocr/convert";
import { locateQuote } from "../src/ocr/review";
import { combineReads } from "../src/ocr/scene";
import type { OcrResult } from "../src/ocr/types";

const IMAGES = "src/ocr/demo/images";
const LANG_DIR = "node_modules/@tesseract.js-data/eng/4.0.0_best_int"; // same file build.mjs bundles

/** Reads width and height from a PNG file header (bytes 16-23). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}`);
  if (!ok) failures++;
}

// debug_file: same as engine.ts (silences "Estimating resolution..." notes).
const worker = await createWorker("eng", 1, { langPath: LANG_DIR, cacheMethod: "none", gzip: true }, { debug_file: "/dev/null" } as Parameters<typeof createWorker>[3]);

/** One whole-photo read with the given page layout. */
async function read(bytes: Buffer, mode: PSM): Promise<RawPage> {
  await worker.setParameters({ tessedit_pageseg_mode: mode });
  return (await worker.recognize(bytes, {}, { text: true, blocks: true })).data as RawPage;
}

// Same steps as engine.ts (SINGLE_BLOCK and AUTO, merged), except zooming in on
// small text (needs a browser canvas).
async function scan(name: string): Promise<OcrResult> {
  const bytes = readFileSync(`${IMAGES}/${name}`);
  const { width, height } = pngSize(bytes);
  const reads = [
    { page: await read(bytes, PSM.SINGLE_BLOCK), scale: 1 },
    { page: await read(bytes, PSM.AUTO), scale: 1 },
  ];
  const result = pageToOcrResult(combineReads(reads).page, 1, width, height, "check-ocr");
  console.log(`\n${name}: status=${result.status}, ${result.words.length} words, confidence=${result.confidence}`);
  console.log(`  text: ${JSON.stringify(result.text)}`);
  return result;
}

try {
  // 1. Clear printed text: the important words must be read and locatable.
  const banner = await scan("team-banner.png");
  check(banner.status === "text_found", "banner: text found");
  for (const quote of ["Riverside Youth Soccer", "Coach Dana", "608-555-0142"]) {
    const where = locateQuote(banner, quote);
    check(where.found, `banner: "${quote}" read and located (${where.wordIds.join(", ")})`);
  }
  const phone = locateQuote(banner, "608-555-0142");
  // The phone number is drawn at about x=330..590, y=250..290 in a 900x420 image.
  const box = phone.boxes[0];
  check(!!box && box.x0 > 250 && box.x1 < 650 && box.y0 > 230 && box.y1 < 310, "banner: phone box is where it was drawn");
  check(banner.imageWidth === 900 && banner.imageHeight === 420, "banner: original size kept");

  // 2. No text: must be a SUCCESSFUL scan, and must not invent real words.
  const blank = await scan("no-text.png");
  check(blank.status === "no_text" || blank.words.every((w) => w.confidence < 70),
    "no-text: empty, or only low-confidence noise for the user to delete");

  // 3. A slightly tilted sign: read by the automatic page layout (PSM.AUTO) read.
  const rotated = await scan("rotated-sign.png");
  check(locateQuote(rotated, "Maple Street Bakery").found, "rotated: \"Maple Street Bakery\" read");

  // 3b. A SMALL, clean sign on a busy brick building: AUTO alone garbles it into
  // low-confidence pieces (all dropped), the SINGLE_BLOCK read gets it right.
  const sign = await scan("small-sign.png");
  for (const quote of ["HOLLIS RESIDENCE HALL", "1400 LAKEVIEW DRIVE"]) {
    check(locateQuote(sign, quote).found, `small sign: "${quote}" read`);
  }
  check(sign.words.length <= 8, `small sign: no junk from bricks or windows (${sign.words.length} words)`);

  // 4. Limitation: script lettering. Printed for information, not checked.
  await scan("script-card.png");
} finally {
  await worker.terminate();
}

console.log(failures === 0 ? "\nOCR check passed." : `\nOCR check FAILED (${failures}).`);
process.exit(failures === 0 ? 0 : 1);
