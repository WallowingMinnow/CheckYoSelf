// Rules for the photo text the OCR reads, before the user sees it:
//   1. a STRICT size limit (demo safety: keeps requests to the backend small
//      and stops a text-heavy photo from breaking anything), and
//   2. a quality check, so a noisy, low-quality read is explained to the user
//      instead of being passed along silently.
// No DOM and no Chrome here, so it can be tested in Node (test/photo-text.test.ts).
import { isJunkWord } from "./ocr/scene";
import type { OcrResult } from "./ocr/types";

/**
 * The most photo text we keep, in characters (about 150-200 words).
 * Deliberately far below the backend's 5000 per source: this is a demo, and a
 * caption photo rarely has more text than this. OCR text past this point is
 * dropped, and the user is told. The photo-text box enforces it too.
 */
export const PHOTO_TEXT_MAX_CHARS = 1000;

export interface LimitedText {
  text: string;
  /** true if text was dropped to stay within the limit. */
  truncated: boolean;
  /** Length before cutting, to tell the user how much was dropped. */
  originalLength: number;
}

/**
 * Cuts `text` to at most `max` characters, at a word boundary when possible
 * (so a word is never cut in half), and trims the end.
 */
export function limitPhotoText(text: string, max: number = PHOTO_TEXT_MAX_CHARS): LimitedText {
  if (text.length <= max) return { text, truncated: false, originalLength: text.length };
  const head = text.slice(0, max);
  const lastBreak = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"));
  // Cut at the last space/line break, unless that would throw away most of the text.
  const cut = lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head;
  return { text: cut.trimEnd(), truncated: true, originalLength: text.length };
}

/** The message shown when OCR text was cut to the limit. */
export function truncationNotice(limited: LimitedText, max: number = PHOTO_TEXT_MAX_CHARS): string {
  return (
    `This photo has a lot of text (${limited.originalLength} characters). The reader stopped at the ` +
    `${max}-character limit, so only the first part is kept and checked.`
  );
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

/** Below this average reader confidence (0-100) the whole read is treated as unreliable. */
export const POOR_MEAN_CONFIDENCE = 60;
/** If at least this share of the words are unclear or junk, the read is poor. */
export const POOR_NOISE_SHARE = 0.4;

// isJunkWord lives with the OCR code that also uses it to keep only readable lines.
export { isJunkWord };

export type PhotoQuality = "clean" | "noisy" | "poor" | "no_text";

export interface QualityReport {
  level: PhotoQuality;
  /** Words that are low-confidence or look like junk. */
  noisyWordCount: number;
  wordCount: number;
  /** A few of the noisy words, to show the user what was unclear. */
  examples: string[];
  /** What to tell the user, or null when there's nothing to say. */
  message: string | null;
}

/** How trustworthy is this OCR read? Decides the notice shown above the photo text. */
export function assessPhotoQuality(result: OcrResult): QualityReport {
  const words = result.words;
  if (result.status === "no_text" || words.length === 0) {
    return { level: "no_text", noisyWordCount: 0, wordCount: 0, examples: [], message: null };
  }
  const low = new Set(result.lowConfidenceWordIds);
  const noisy = words.filter((w) => low.has(w.id) || isJunkWord(w.text));
  const examples = [...new Set(noisy.map((w) => w.text))].slice(0, 4);
  const share = noisy.length / words.length;
  const meanTooLow = result.confidence !== null && result.confidence < POOR_MEAN_CONFIDENCE;
  const quoted = examples.map((t) => `“${t}”`).join(", ");

  if (meanTooLow || share >= POOR_NOISE_SHARE) {
    return {
      level: "poor", noisyWordCount: noisy.length, wordCount: words.length, examples,
      message:
        "Poor photo quality: the text reader couldn't read this photo reliably " +
        `(${noisy.length} of ${words.length} words unclear${quoted ? `, e.g. ${quoted}` : ""}), so the photo text below is probably wrong. ` +
        "Delete anything you can't see in the photo, or type the text yourself. A sharper, brighter, straight-on photo reads better.",
    };
  }
  if (noisy.length > 0) {
    return {
      level: "noisy", noisyWordCount: noisy.length, wordCount: words.length, examples,
      message:
        `Some of the photo couldn't be read clearly (${noisy.length} of ${words.length} words${quoted ? `: ${quoted}` : ""}). ` +
        "This happens with blurry, dark, small or stylized lettering. Delete or fix anything below that isn't really in the photo.",
    };
  }
  return { level: "clean", noisyWordCount: 0, wordCount: words.length, examples: [], message: null };
}

// ---------------------------------------------------------------------------
// What to show after a read (used by the popup's "Add a photo")
// ---------------------------------------------------------------------------

/** One notice about the photo read. Same shape as PhotoNotice in ports.ts. */
export interface PhotoReadNotice {
  kind: "poor" | "warning";
  text: string;
}

/** Everything a UI needs after one OCR read: the text to put in the box, notices, and a hint. */
export interface PhotoReadView {
  /**
   * The photo text to put in the box, already cut to PHOTO_TEXT_MAX_CHARS.
   * EMPTY when the read was unreliable ("poor"): guessed text is never filled in.
   */
  text: string;
  /** Unreliable / noisy / truncated notices (empty when the read is clean). */
  notices: PhotoReadNotice[];
  /** One line under the box: where the text came from and what to do next. */
  hint: string;
  quality: PhotoQuality;
  truncated: boolean;
  /** true when the reader's text was thrown away because it wasn't confident enough. */
  discarded: boolean;
}

/** What the user is told when an unreliable read is thrown away. */
export function unreliableReadNotice(result: OcrResult, quality: QualityReport): string {
  const sure = result.confidence === null ? "" : `confidence ${Math.round(result.confidence)}%, `;
  return (
    "No readable text found. The text reader wasn't confident about this photo " +
    `(${sure}${quality.noisyWordCount} of ${quality.wordCount} "words" unclear), so nothing was added. ` +
    "Buildings, brickwork, windows, patterns and scenery often look like letters to it. " +
    "If the photo does have text you want checked, type it in the box."
  );
}

function bits(n: number): string {
  return `${n} unclear bit${n === 1 ? "" : "s"}`;
}

/** The reader found only unclear shapes (all left out by the OCR engine, see ocr/scene.ts). */
export function unclearOnlyNotice(dropped: number): string {
  return (
    `No readable text found. The text reader only saw ${bits(dropped)} it couldn't read clearly, so nothing was added. ` +
    "Buildings, brickwork, windows, patterns and scenery often look like letters to it. " +
    "If the photo does have text you want checked, type it in the box."
  );
}

/** Some text was read clearly; the unclear rest was left out. */
export function partialReadNotice(dropped: number): string {
  return (
    `Only the clearly readable text was kept; ${bits(dropped)} (often brickwork, windows or patterns) ` +
    `${dropped === 1 ? "was" : "were"} left out. If the photo has other text you want checked, add it in the box.`
  );
}

/**
 * Applies the confidence check and the size limit to one OCR result.
 * Used by both the popup ("Add a photo") and the Instagram panel (content/main.ts),
 * so they always behave the same.
 *
 *  - poor (low average confidence, or most "words" unclear): the text is NOT
 *    used. The box stays empty and the user is told why. Sending guessed
 *    letters to the AI only produces noise.
 *  - noisy (a few unclear words): the text is used, with a notice to fix it.
 *  - clean: the text is used.
 */
export function describePhotoRead(result: OcrResult): PhotoReadView {
  const quality = assessPhotoQuality(result);
  const dropped = result.droppedWords ?? 0;
  if (result.words.length === 0 && dropped > 0) {
    // The reader saw only shapes it couldn't read clearly (the OCR engine already left them out).
    return {
      text: "",
      notices: [{ kind: "poor", text: unclearOnlyNotice(dropped) }],
      hint: "Nothing was read from this photo. Type any text you can see in it, or leave the box empty.",
      quality: "poor",
      truncated: false,
      discarded: true,
    };
  }
  if (quality.level === "poor") {
    return {
      text: "",
      notices: [{ kind: "poor", text: unreliableReadNotice(result, quality) }],
      hint: "Nothing was read from this photo. Type any text you can see in it, or leave the box empty.",
      quality: quality.level,
      truncated: false,
      discarded: true,
    };
  }
  const limited = limitPhotoText(result.text);
  const notices: PhotoReadNotice[] = [];
  if (quality.message) notices.push({ kind: "warning", text: quality.message }); // "noisy": some unclear words
  if (dropped > 0 && limited.text.trim()) notices.push({ kind: "warning", text: partialReadNotice(dropped) });
  if (limited.truncated) notices.push({ kind: "warning", text: truncationNotice(limited) });
  const sure = result.confidence === null ? "" : ` (confidence ${Math.round(result.confidence)}%)`;
  const hint =
    result.status === "no_text" || !limited.text.trim()
      ? "No text found in the photo. Type any text you can see in it."
      : `Read from the photo on your computer${sure}. Check it and fix any mistakes before checking the post.`;
  return { text: limited.text, notices, hint, quality: quality.level, truncated: limited.truncated, discarded: false };
}

/** Progress line while a photo is read, e.g. "Reading text… 40%". */
export function photoProgressLabel(stage: "preparing_image" | "loading_engine" | "recognizing", fraction: number): string {
  const label = { preparing_image: "Opening the photo", loading_engine: "Starting the text reader", recognizing: "Reading text" }[stage];
  return `${label}… ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}
