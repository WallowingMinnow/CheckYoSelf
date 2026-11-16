// The "review and correct" step between OCR and analysis, plus finding where a
// finding's quote is in the photo. No DOM here, so it can be tested in Node.
//
// Flow for the popup owner:
//   const result = await readImageText(file, 1);        // engine.ts
//   let review = startReview(result);                   // show review.reviewedText in a textarea
//   review = updateReviewedText(review, textarea.value);// on every "input" event
//   const out = reviewToTextSource(review);             // when the user clicks "Check"
//   if (out.ok) sources.push(out.source);               // only text goes to the backend
import { toTextSource, type ToSourceResult } from "./convert";
import type { OcrBox, OcrResult, OcrWord } from "./types";

/** What OCR read, and what the user changed it to. */
export interface OcrReview {
  /** The engine's output. Never changed by the review. */
  readonly result: OcrResult;
  /** The text the user approved. Starts as result.text. */
  readonly reviewedText: string;
}

export function startReview(result: OcrResult): OcrReview {
  return { result, reviewedText: result.text };
}

/** Returns a NEW review with the user's corrected text. */
export function updateReviewedText(review: OcrReview, text: string): OcrReview {
  return { result: review.result, reviewedText: text };
}

/** True if the user changed anything OCR read. */
export function isEdited(review: OcrReview): boolean {
  return review.reviewedText !== review.result.text;
}

/** The reviewed text as an "image_text" TextSource (see toTextSource()). */
export function reviewToTextSource(review: OcrReview): ToSourceResult {
  return toTextSource(review.result.sourceId, review.reviewedText);
}

/**
 * A short hint for the review box, e.g.
 *   "3 words may be misread. Please check the text before analyzing."
 * Returns null when there's nothing to warn about.
 */
export function reviewHint(result: OcrResult): string | null {
  if (result.status === "no_text") {
    return "No text was found in this photo. If you can see text in it, type it in yourself.";
  }
  const n = result.lowConfidenceWordIds.length;
  if (n === 0) return null;
  if (n === result.words.length) {
    // Typical for photos without text: Tesseract reads shapes as stray marks.
    return "Only unclear marks were found. This photo may have no real text: delete anything you can't see in it.";
  }
  return `${n} word${n === 1 ? "" : "s"} may be misread. Please check the text before analyzing.`;
}

// ---------------------------------------------------------------------------
// Finding a quote in the photo (for highlights)
// ---------------------------------------------------------------------------

/** Where a quote is in the photo, if we could find it. */
export interface QuoteLocation {
  /** false if the quote isn't in the text OCR read (for example the user typed it). */
  found: boolean;
  /** The words that make up the quote (stable ids like "image_text:1#w3"). */
  wordIds: string[];
  /** One box per word, in ORIGINAL image pixels. Convert with coords.ts before drawing. */
  boxes: OcrBox[];
}

/**
 * Lower-cases `text` and squeezes every run of whitespace into one space,
 * the same way the backend compares quotes (backend/src/parse.ts).
 * Also returns, for each character of the result, its index in `text`.
 */
function normalizeWithMap(text: string): { normalized: string; originalIndex: number[] } {
  let normalized = "";
  const originalIndex: number[] = [];
  let lastWasSpace = true; // true at the start = drop leading whitespace
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        normalized += " ";
        originalIndex.push(i);
      }
      lastWasSpace = true;
    } else {
      normalized += ch.toLowerCase();
      originalIndex.push(i);
      lastWasSpace = false;
    }
  }
  // Drop a trailing space.
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    originalIndex.pop();
  }
  return { normalized, originalIndex };
}

/**
 * Finds the words in the photo that a finding's evidence quote points to.
 *
 * Matching ignores upper/lower case and extra spaces, like the backend's
 * `verified` check. It searches the text OCR READ, not the user's corrected
 * text, because only OCR text has positions. So if the user corrected a word,
 * a quote containing the corrected word won't be found (found: false). Show
 * the finding without a photo highlight in that case.
 *
 * If the quote appears more than once, every place it appears is returned.
 */
export function locateQuote(result: OcrResult, quote: string): QuoteLocation {
  const notFound: QuoteLocation = { found: false, wordIds: [], boxes: [] };
  const q = normalizeWithMap(quote).normalized;
  if (!q) return notFound;

  const { normalized, originalIndex } = normalizeWithMap(result.text);
  const matched = new Set<OcrWord>();

  let from = 0;
  while (true) {
    const at = normalized.indexOf(q, from);
    if (at === -1) break;
    const start = originalIndex[at];
    const end = originalIndex[at + q.length - 1] + 1; // one past the last character
    // A word is part of the match if any of its characters are inside it.
    for (const word of result.words) {
      if (word.start < end && word.end > start) matched.add(word);
    }
    from = at + 1;
  }

  if (matched.size === 0) return notFound;
  const words = result.words.filter((w) => matched.has(w)); // keep reading order
  return { found: true, wordIds: words.map((w) => w.id), boxes: words.map((w) => w.box) };
}
