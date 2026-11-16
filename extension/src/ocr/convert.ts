// Turns Tesseract's raw output into our OcrResult, and OcrResult text into the
// TextSource the backend already understands. No DOM and no Tesseract import
// here, so it can be tested in Node (see test/ocr-convert.test.ts).
import { LIMITS, type TextSource } from "../../../shared/contract";
import { LOW_CONFIDENCE, OcrError, type OcrBox, type OcrLine, type OcrResult, type OcrWord } from "./types";

// ---------------------------------------------------------------------------
// The parts of Tesseract's output we read. Tesseract.js returns much more;
// declaring only these keeps the tests simple and documents what we rely on.
// (Tesseract.js only fills `blocks` when recognize() is called with
// { blocks: true } as its output option. engine.ts does that.)
// ---------------------------------------------------------------------------
export interface RawBbox { x0: number; y0: number; x1: number; y1: number }
export interface RawWord { text: string; confidence: number; bbox: RawBbox }
export interface RawLine { words: RawWord[] }
export interface RawParagraph { lines: RawLine[] }
export interface RawBlock { paragraphs: RawParagraph[] }
export interface RawPage { blocks: RawBlock[] | null }

/** "image_text:<index>" for image number `index` (1, 2, 3...). */
export function imageSourceId(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`Image index must be a whole number 1 or more, got ${index}.`);
  }
  return `image_text:${index}`;
}

/** Keeps a number between low and high. Treats NaN as `low`. */
function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/** Makes sure a box is inside the image and not upside down. */
function cleanBox(b: RawBbox, width: number, height: number): OcrBox {
  const x0 = clamp(Math.min(b.x0, b.x1), 0, width);
  const x1 = clamp(Math.max(b.x0, b.x1), 0, width);
  const y0 = clamp(Math.min(b.y0, b.y1), 0, height);
  const y1 = clamp(Math.max(b.y0, b.y1), 0, height);
  return { x0, y0, x1, y1 };
}

/** The smallest box that contains all the given boxes. */
function unionBox(boxes: OcrBox[]): OcrBox {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

function average(numbers: number[]): number {
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

/** Rounds to one decimal place, e.g. 91.4567 -> 91.5 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Converts one Tesseract page into an OcrResult.
 *
 * Throws OcrError("RECOGNITION_FAILED") if the output isn't shaped the way we
 * expect. That is deliberate: a broken result must NEVER look like
 * "the photo has no text".
 */
export function pageToOcrResult(
  page: RawPage,
  imageIndex: number,
  imageWidth: number,
  imageHeight: number,
  engine: string,
): OcrResult {
  const sourceId = imageSourceId(imageIndex);

  if (!(imageWidth > 0 && imageHeight > 0)) {
    throw new OcrError("RECOGNITION_FAILED", "The image size is unknown, so the text positions can't be trusted.");
  }
  if (!page || !Array.isArray(page.blocks)) {
    // Tesseract.js gives blocks: null when it wasn't asked for them, or when
    // something went wrong. Either way we have no word list to trust.
    throw new OcrError("RECOGNITION_FAILED", "The text reader returned no word list.");
  }

  const words: OcrWord[] = [];
  const lines: OcrLine[] = [];
  let text = "";

  for (const block of page.blocks) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const rawLine of paragraph?.lines ?? []) {
        const lineId = `${sourceId}#l${lines.length + 1}`;
        const lineWords: OcrWord[] = [];

        for (const rawWord of rawLine?.words ?? []) {
          // Collapse any spaces inside a "word" and skip empty ones.
          const wordText = String(rawWord?.text ?? "").replace(/\s+/g, " ").trim();
          if (!wordText || !rawWord.bbox) continue;

          // Words on a line are separated by one space; lines by "\n".
          if (lineWords.length > 0) text += " ";
          else if (text.length > 0) text += "\n";

          const word: OcrWord = {
            id: `${sourceId}#w${words.length + 1}`,
            lineId,
            text: wordText,
            confidence: round1(clamp(rawWord.confidence, 0, 100)),
            box: cleanBox(rawWord.bbox, imageWidth, imageHeight),
            start: text.length,
            end: text.length + wordText.length,
          };
          text += wordText;
          words.push(word);
          lineWords.push(word);
        }

        if (lineWords.length === 0) continue; // a line with only blanks
        lines.push({
          id: lineId,
          text: lineWords.map((w) => w.text).join(" "),
          confidence: round1(average(lineWords.map((w) => w.confidence))),
          box: unionBox(lineWords.map((w) => w.box)),
          wordIds: lineWords.map((w) => w.id),
        });
      }
    }
  }

  return {
    sourceId,
    status: words.length > 0 ? "text_found" : "no_text",
    text,
    confidence: words.length > 0 ? round1(average(words.map((w) => w.confidence))) : null,
    imageWidth,
    imageHeight,
    lines,
    words,
    lowConfidenceWordIds: words.filter((w) => w.confidence < LOW_CONFIDENCE).map((w) => w.id),
    engine,
  };
}

/** The result of turning reviewed OCR text into a TextSource. */
export type ToSourceResult =
  | { ok: true; source: TextSource }
  | { ok: false; reason: "empty" | "too_long"; message: string };

/**
 * Turns the text the user reviewed (and maybe corrected) into the
 * "image_text" TextSource that goes to POST /api/analyze.
 *
 * ONLY the text is included. Boxes, sizes and confidence stay in the browser.
 *  - Blank text -> { ok: false, reason: "empty" }: leave this source out of the request.
 *  - Text longer than the backend allows -> { ok: false, reason: "too_long" }:
 *    ask the user to shorten it. We never cut it silently.
 */
export function toTextSource(sourceId: string, reviewedText: string): ToSourceResult {
  if (!/^image_text:[1-9][0-9]*$/.test(sourceId)) {
    throw new Error(`"${sourceId}" is not an image_text source id.`);
  }
  if (!reviewedText.trim()) {
    return { ok: false, reason: "empty", message: "No text from this photo to check." };
  }
  if (reviewedText.length > LIMITS.maxCharsPerSource) {
    return {
      ok: false,
      reason: "too_long",
      message: `The photo text is ${reviewedText.length} characters; the limit is ${LIMITS.maxCharsPerSource}. Remove the parts you don't need checked.`,
    };
  }
  return { ok: true, source: { id: sourceId, type: "image_text", text: reviewedText } };
}
