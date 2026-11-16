// Text in everyday photos ("scene text": a sign on a building, a name tag, a
// jersey) instead of a scanned page.
//
// The problem this solves: on a photo of a building, Tesseract reads the
// sign correctly (e.g. "1200 OBSERVATORY DRIVE" at 96% confidence) but ALSO
// turns brickwork, windows and railings into a hundred junk "words" ("=",
// "|", "EAE"...). Judged as a whole, that read looks unreliable and was
// thrown away, real sign text included. Small sign text is also partly
// missed at the photo's own size ("WATERS" in "WATERS RESIDENCE HALL").
//
// So engine.ts reads the whole photo once, then "zooms in": it reads an
// enlarged crop around each patch of SMALL text it found (zoomRegions). This
// file:
//   1. keeps only the clearly readable lines of each read (readableLines), and
//   2. merges the reads without repeating lines (combineReads).
// The result is an ordinary Tesseract-shaped page for convert.ts.
//
// (Enlarging the WHOLE photo instead was tried: in Chrome, Tesseract then
// treats the photo as a picture and finds nothing, and it takes seconds.)
//
// No DOM and no Tesseract import here, so it can be tested in Node
// (test/ocr-scene.test.ts).
import type { RawBbox, RawLine, RawPage, RawWord } from "./convert";

/** A word must be at least this confident (0-100) to count as clearly read. */
export const STRONG_CONFIDENCE = 70;
/** A line with only ONE clearly read word needs this much confidence, and 4+ letters unless it's a number (stray junk is often a lone short "word"). */
export const LONE_WORD_CONFIDENCE = 85;
/** A kept line's words must average at least this confidence. */
export const MIN_LINE_CONFIDENCE = 60;
/** Text lines shorter than this (in pixels) are read again, enlarged to about this height. */
export const ZOOM_LINE_HEIGHT = 32;
/** At most this many zoomed crops per photo (keeps reading fast). */
export const MAX_ZOOM_REGIONS = 4;

/** Punctuation that stands alone in real text, e.g. "U10 Tigers - Spring Season", "Salt & Pepper". */
const NORMAL_SEPARATORS = /^[-–—&+/]$/;

/**
 * Is this "word" probably noise rather than real text? For example "©", "~",
 * "00000000000", "oooo", or a stray single letter. (Single digits like "3" on a
 * jersey, and separators like "-" or "&", are kept as real.)
 */
export function isJunkWord(word: string): boolean {
  if (NORMAL_SEPARATORS.test(word.trim())) return false;
  const core = word.replace(/[^\p{L}\p{N}]/gu, "");
  if (core.length === 0) return true;                   // only symbols: "©", "~", ":"
  if (/(.)\1{3,}/iu.test(core)) return true;            // 4+ of the same character: "00000000000"
  if (core.length === 1 && /\p{L}/u.test(core) && !/^[aAiI]$/.test(core)) return true; // stray letter
  return false;
}

/** Letters and digits in a word ("LIZ'S" -> 4). */
function coreLength(word: string): number {
  return word.replace(/[^\p{L}\p{N}]/gu, "").length;
}

function coreText(word: RawWord): string {
  return String(word.text ?? "").replace(/[^\p{L}\p{N}]/gu, "");
}

/** Clearly read: not junk, confident, and at least 2 letters/digits (or a digit). */
function isStrong(word: RawWord): boolean {
  const text = String(word.text ?? "").trim();
  if (!text || isJunkWord(text) || !(word.confidence >= STRONG_CONFIDENCE)) return false;
  return coreLength(text) >= 2 || /^\p{N}$/u.test(coreText(word));
}

/** Below this confidence, even a longer unsure word at the end of a line is dropped. */
const EDGE_KEEP_CONFIDENCE = 30;

/** An unsure word at the start or end of a line that's probably not part of it. */
function isEdgeJunk(word: RawWord): boolean {
  if (isStrong(word)) return false;
  return coreLength(String(word.text)) < 3 || !(word.confidence >= EDGE_KEEP_CONFIDENCE);
}

/** One kept line, with its box in ORIGINAL image pixels. */
export interface ReadableLine {
  words: RawWord[];
  box: RawBbox;
}

function unionBox(words: RawWord[]): RawBbox {
  return {
    x0: Math.min(...words.map((w) => w.bbox.x0)),
    y0: Math.min(...words.map((w) => w.bbox.y0)),
    x1: Math.max(...words.map((w) => w.bbox.x1)),
    y1: Math.max(...words.map((w) => w.bbox.y1)),
  };
}

/**
 * The clearly readable lines of one read, in reading order. `scale` is how
 * much the image was enlarged for this read and `offset` where the crop
 * starts in the original image; boxes are converted back to the original
 * image. Junk words are removed, and stray bits at the START or END of a line
 * are trimmed ("a'", "3"). Other unsure words are kept: they're usually real
 * words the user can fix ("Burtivday", "Hollow"), and the photo notice
 * points them out.
 */
export function readableLines(page: RawPage, scale = 1, offset = { x: 0, y: 0 }): { lines: ReadableLine[]; totalWords: number } {
  const lines: ReadableLine[] = [];
  let totalWords = 0;
  for (const block of page?.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        const words = (line?.words ?? []).filter((w) => w?.bbox && String(w.text ?? "").trim());
        totalWords += words.length;
        const real = words.filter((w) => !isJunkWord(String(w.text)));
        const strong = real.filter(isStrong);
        if (strong.length === 0) continue;
        // Trim stray bits at the ends ("a'", "3"); keep longer unsure words ("Hollow Parks").
        let first = 0;
        while (isEdgeJunk(real[first])) first++;
        let last = real.length - 1;
        while (isEdgeJunk(real[last])) last--;
        const kept = real.slice(first, last + 1);
        const strongChars = strong.reduce((n, w) => n + coreLength(String(w.text)), 0);
        // Too little to trust: a line whose only clear word is short, like "EN" or "HEE"
        // from a window grid. A lone word needs 4+ letters ("MARKET"), or must be a number ("32").
        if (strongChars < 3) {
          if (!(strong.length === 1 && /^\p{N}{2}$/u.test(coreText(strong[0])))) continue;
        }
        if (strong.length === 1) {
          const lone = coreText(strong[0]);
          if (strong[0].confidence < LONE_WORD_CONFIDENCE) continue;
          if (lone.length < 4 && !/^\p{N}+$/u.test(lone)) continue;
        }
        // Mostly unsure words between a few clear ones: a pattern, not a sentence.
        if (kept.reduce((n, w) => n + w.confidence, 0) / kept.length < MIN_LINE_CONFIDENCE) continue;
        const scaled = kept.map((w) => ({
          ...w,
          bbox: {
            x0: w.bbox.x0 / scale + offset.x, y0: w.bbox.y0 / scale + offset.y,
            x1: w.bbox.x1 / scale + offset.x, y1: w.bbox.y1 / scale + offset.y,
          },
        }));
        lines.push({ words: scaled, box: unionBox(scaled) });
      }
    }
  }
  return { lines, totalWords };
}

/** How much two boxes overlap, as a share of the smaller one (0..1). */
function overlap(a: RawBbox, b: RawBbox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const area = (r: RawBbox) => Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
  return (w * h) / Math.min(area(a), area(b));
}

/**
 * How many words two lines share, i.e. words read at the same spot. Two reads
 * of the same line share words: "RESIDENCE HALL" and "WATERS RESIDENCE HALL",
 * or "Party at Oak" and "at Oak Hollow Park". (Comparing whole-line boxes
 * instead goes wrong for tilted text, whose boxes are tall and overlap.)
 */
function sharedWords(a: ReadableLine, b: ReadableLine): number {
  return b.words.filter((w) => a.words.some((t) => overlap(t.bbox, w.bbox) >= 0.5)).length;
}

/** One Tesseract read: of the whole photo, or of an enlarged crop of it. */
export interface Read {
  page: RawPage;
  /** How much the image was enlarged for this read (1 = original size). */
  scale: number;
  /** Where the crop starts in the original image (missing = the whole photo). */
  offset?: { x: number; y: number };
}

export interface CombinedRead {
  /** Only the clearly readable lines, ready for pageToOcrResult(). */
  page: RawPage;
  /** Words found in all reads, before cleaning (duplicates across reads counted twice). */
  totalWords: number;
  /** Words the FIRST (whole-photo) read found but left out as unclear or junk (for the user notice). */
  droppedWords: number;
}

/**
 * Merges one or more reads of the SAME photo, in order of trust (the
 * whole-photo read first, then the zoomed crops). Each read keeps only its readable lines. A line a
 * later read found that isn't there yet is added. If an earlier read already
 * has that line, the earlier version is kept and only the later read's CLEAR
 * words that are missing from it are added (e.g. "WATERS" before "RESIDENCE
 * HALL"). Lines are ordered top to bottom, then left to right.
 */
export function combineReads(reads: Read[]): CombinedRead {
  const kept: ReadableLine[] = [];
  let totalWords = 0;
  let droppedWords = 0;
  for (const [i, read] of reads.entries()) {
    const { lines, totalWords: total } = readableLines(read.page, read.scale, read.offset);
    totalWords += total;
    if (i === 0) {
      droppedWords = total - lines.reduce((n, l) => n + l.words.length, 0);
      kept.push(...lines);
      continue;
    }
    for (const line of lines) {
      let twin: ReadableLine | undefined;
      let most = 0;
      for (const k of kept) {
        const shared = sharedWords(k, line);
        if (shared > most) [twin, most] = [k, shared];
      }
      if (!twin) {
        kept.push(line);
        continue;
      }
      const missing = line.words.filter((w) => isStrong(w) && !twin.words.some((t) => overlap(t.bbox, w.bbox) >= 0.3));
      if (missing.length === 0) continue;
      twin.words = [...twin.words, ...missing].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      twin.box = unionBox(twin.words);
    }
  }
  // Reading order. Lines whose middles are within half a line height count as one row.
  kept.sort((a, b) => {
    const height = Math.min(a.box.y1 - a.box.y0, b.box.y1 - b.box.y0);
    const dy = (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2;
    return Math.abs(dy) > height / 2 ? dy : a.box.x0 - b.box.x0;
  });
  const lines: RawLine[] = kept.map((l) => ({ words: l.words }));
  return { page: { blocks: [{ paragraphs: lines.map((line) => ({ lines: [line] })) }] }, totalWords, droppedWords };
}

/** A crop of the photo to read again, enlarged. In ORIGINAL image pixels. */
export interface ZoomRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** How much to enlarge the crop. */
  factor: number;
}

/** The largest enlarged crop, in pixels per side. */
const MAX_ZOOM_SIDE = 2400;

/**
 * Where to zoom in: around each line of SMALL text the first read found,
 * padded so that words next to it that were missed ("WATERS" left of
 * "RESIDENCE HALL") and lines just above or below are inside the crop.
 * Nearby crops are merged. Returns [] when all the text is already big enough.
 */
export function zoomRegions(page: RawPage, imageWidth: number, imageHeight: number): ZoomRegion[] {
  type Box = RawBbox & { factor: number };
  let boxes: Box[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        if (line.words.length === 0) continue;
        const box = unionBox(line.words);
        const lineHeight = box.y1 - box.y0;
        if (!(lineHeight > 0)) continue;
        const factor = Math.min(3, ZOOM_LINE_HEIGHT / lineHeight);
        if (factor < 1.5) continue; // big enough already
        const padX = Math.max(box.x1 - box.x0, lineHeight * 4);
        const padY = lineHeight * 2;
        boxes.push({
          x0: Math.max(0, box.x0 - padX), y0: Math.max(0, box.y0 - padY),
          x1: Math.min(imageWidth, box.x1 + padX), y1: Math.min(imageHeight, box.y1 + padY), factor,
        });
      }
    }
  }
  // Merge overlapping crops until none overlap.
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
          boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), factor: Math.max(a.factor, b.factor) };
          boxes = boxes.filter((_, k) => k !== j);
          merged = true;
          break outer;
        }
      }
    }
  }
  const regions: ZoomRegion[] = [];
  for (const b of boxes) {
    const x = Math.floor(b.x0), y = Math.floor(b.y0);
    const width = Math.ceil(b.x1) - x, height = Math.ceil(b.y1) - y;
    const factor = Math.min(b.factor, MAX_ZOOM_SIDE / width, MAX_ZOOM_SIDE / height);
    if (factor >= 1.5) regions.push({ x, y, width, height, factor: Math.round(factor * 100) / 100 });
  }
  return regions.slice(0, MAX_ZOOM_REGIONS);
}
