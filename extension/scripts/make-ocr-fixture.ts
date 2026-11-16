// Regenerates test/fixtures/ocr-team-banner.page.json: real Tesseract.js
// output for the FICTIONAL demo image, trimmed to the fields convert.ts reads.
// Only needed after upgrading Tesseract.js. Run from the extension folder:
//   npx tsx scripts/make-ocr-fixture.ts
import { readFileSync, writeFileSync } from "node:fs";
import { createWorker } from "tesseract.js";
import type { RawPage } from "../src/ocr/convert";

const worker = await createWorker("eng", 1, {
  langPath: "node_modules/@tesseract.js-data/eng/4.0.0_best_int",
  cacheMethod: "none",
});
const { data } = await worker.recognize(readFileSync("src/ocr/demo/images/team-banner.png"), {}, { blocks: true });
await worker.terminate();

const round1 = (n: number) => Math.round(n * 10) / 10;
const page: RawPage = {
  blocks: (data.blocks ?? []).map((b) => ({
    paragraphs: b.paragraphs.map((p) => ({
      lines: p.lines.map((l) => ({
        words: l.words.map((w) => ({ text: w.text, confidence: round1(w.confidence), bbox: w.bbox })),
      })),
    })),
  })),
};

const fixture = {
  _note: "Real Tesseract.js 7.0.0 output for the FICTIONAL image src/ocr/demo/images/team-banner.png (900x420), trimmed to the fields convert.ts reads.",
  imageWidth: 900,
  imageHeight: 420,
  page,
};
writeFileSync("test/fixtures/ocr-team-banner.page.json", JSON.stringify(fixture, null, 1) + "\n");
console.log("Wrote test/fixtures/ocr-team-banner.page.json");
