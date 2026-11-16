// Types for local OCR (milestone 2). Everything in this file stays INSIDE the
// extension: boxes, image sizes and confidence numbers are never sent to the
// backend. Only the reviewed text goes out, as an ordinary "image_text"
// TextSource (see toTextSource() in convert.ts).
//
// Why these types are not in shared/contract.ts: they never cross the network
// or a Chrome message boundary, and keeping them out of the shared file means
// the backend can't accidentally start accepting coordinates or image data.

/**
 * A rectangle in ORIGINAL IMAGE pixels (after EXIF rotation is applied, i.e.
 * the way the photo looks on screen). (x0, y0) is the top-left corner,
 * (x1, y1) the bottom-right corner. Use coords.ts to draw it on a preview.
 */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One recognized word, with where it is in the image and in the text. */
export interface OcrWord {
  /**
   * Stable evidence id, e.g. "image_text:1#w3" = word 3 of image 1.
   * Same image + same engine version -> same ids, because words are numbered
   * in reading order.
   */
  id: string;
  /** Id of the line this word belongs to, e.g. "image_text:1#l1". */
  lineId: string;
  text: string;
  /** 0-100 from Tesseract. Below LOW_CONFIDENCE it's probably misread. */
  confidence: number;
  box: OcrBox;
  /** Where the word is in OcrResult.text: text.slice(start, end) === word.text */
  start: number;
  end: number;
}

/** One line of recognized text. */
export interface OcrLine {
  id: string;        // e.g. "image_text:1#l2"
  text: string;
  confidence: number;
  box: OcrBox;
  wordIds: string[];
}

/**
 * The result of a SUCCESSFUL scan. A failed scan is never an OcrResult: it
 * throws an OcrError instead. A successful scan with no text has
 * status "no_text" and an empty `text`.
 */
export interface OcrResult {
  /** "image_text:<n>", the TextSource id this image's text will use. */
  sourceId: string;
  status: "text_found" | "no_text";
  /** Text built from the words below: words joined by " ", lines by "\n". */
  text: string;
  /** Mean word confidence 0-100, or null if there are no words. */
  confidence: number | null;
  /** Size of the image that was scanned (after EXIF rotation). */
  imageWidth: number;
  imageHeight: number;
  lines: OcrLine[];
  words: OcrWord[];
  /** Ids of words with confidence below LOW_CONFIDENCE, to point out to the user. */
  lowConfidenceWordIds: string[];
  /** e.g. "tesseract.js 7.0.0 / eng 4.0.0_best_int", for debugging. */
  engine: string;
  /**
   * How many unclear or junk "words" (brickwork, windows, patterns...) the
   * reader found but left out, because only clearly readable lines are kept
   * (see scene.ts). Missing or 0 when nothing was left out.
   */
  droppedWords?: number;
}

/** Words with confidence under this are flagged as "check this word". */
export const LOW_CONFIDENCE = 60;

/** Progress updates while scanning. `fraction` is 0..1 for the current stage. */
export interface OcrProgress {
  stage: "preparing_image" | "loading_engine" | "recognizing";
  fraction: number;
}

export type OcrErrorCode =
  | "CANCELLED"            // the caller aborted (AbortSignal)
  | "NOT_AN_IMAGE"         // the file isn't an image the browser can open
  | "IMAGE_TOO_LARGE"      // over MAX_IMAGE_BYTES or MAX_IMAGE_SIDE
  | "ENGINE_LOAD_FAILED"   // the worker, WASM or language file didn't load
  | "RECOGNITION_FAILED";  // Tesseract crashed or returned something unusable

/**
 * Every OCR failure is thrown as one of these. Callers should show
 * `message` to the user and NOT treat a failure as "no text in the photo".
 */
export class OcrError extends Error {
  readonly code: OcrErrorCode;
  constructor(code: OcrErrorCode, message: string) {
    super(message);
    this.name = "OcrError";
    this.code = code;
  }
}

/** Limits to keep the popup responsive. */
export const OCR_LIMITS = {
  maxImageBytes: 25 * 1024 * 1024, // 25 MB file
  maxImageSide: 8000,              // pixels, either width or height
} as const;
