// Everything this extension knows about Instagram's web page lives in THIS
// file. If Instagram changes its page, this is the only file to fix.
//
// IMPORTANT: Instagram's class names are generated and change often, so we
// only use roles, aria-labels, contenteditable and visible button text.
//
// Every selector below is marked VERIFIED (checked on the live site, with
// the date) or UNVERIFIED; see docs/ROADMAP.md. To re-check them, use the
// test kit in extension/dev/instagram-test-kit.js.

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/** Visible text we look for, in one language. Lower-case; compared after trimming. */
export interface InstagramText {
  share: string[];     // the Share button on the caption step
  published: string[]; // text shown after a successful share
  failed: string[];    // text shown when a share fails
  slideArrows: string[]; // aria-labels of the arrows next to the photo when SEVERAL photos are selected
  slideNext: string[];   // the ones among slideArrows that go to the NEXT photo (to the right)
}

/**
 * One entry per supported Instagram language, keyed by the page's language
 * code (<html lang="...">). TO ADD A LANGUAGE: record its texts with the test
 * kit, add an entry here, and add a test in test/instagram-adapter.test.ts.
 * On a page in any other language, the extension stays out of the way.
 */
export const TEXT_BY_LANGUAGE: Record<string, InstagramText> = {
  en: {
    share: ["share"], // VERIFIED 2026-11-14
    published: ["your post has been shared", "post shared"], // VERIFIED 2026-11-15 (title "Post shared", text "Your post has been shared.")
    failed: ["couldn't be shared", "could not be shared", "couldn't share", "something went wrong", "try again"], // UNVERIFIED
    // VERIFIED 2026-11-15: a 2-photo post's caption step shows "Right chevron"
    // on photo 1 and "Left chevron" on photo 2; a single photo shows neither.
    // NOT "Down chevron icon": that is on the Accessibility / Advanced settings
    // sections of every post. "go back"/"next" are older guesses (UNVERIFIED).
    slideArrows: ["right chevron", "left chevron", "go back", "next"],
    slideNext: ["right chevron", "next"],
  },
};

/** The texts for a page language like "en" or "en-US", or null if unsupported. */
export function textForLanguage(lang: string | null | undefined): InstagramText | null {
  const code = (lang ?? "").trim().toLowerCase().split("-")[0];
  return TEXT_BY_LANGUAGE[code] ?? null;
}

/** The texts for the current Instagram page, or null if its language isn't supported. */
function pageText(doc: Document): InstagramText | null {
  return textForLanguage(doc.documentElement.lang);
}

// ---------------------------------------------------------------------------
// Post types
// ---------------------------------------------------------------------------

/**
 * What kind of post is being made. Only the types in SUPPORTED_POST_TYPES
 * (content/main.ts) get any help from the extension. TO SUPPORT A NEW TYPE:
 * make sure it is detected correctly here, then add it to that list and
 * handle its photos/text in main.ts.
 */
export type PostType = "single-photo" | "multi-photo" | "video" | "unknown";

export interface PostTypeClues {
  photoCount: number;     // large photos in the dialog
  hasVideo: boolean;
  carouselHints: number;  // slide arrows / dots near the photo
}

export function classifyPostType(clues: PostTypeClues): PostType {
  if (clues.hasVideo) return "video";
  if (clues.photoCount > 1 || clues.carouselHints > 0) return "multi-photo";
  if (clues.photoCount === 1) return "single-photo";
  return "unknown"; // no photo found: don't guess
}

const SELECTORS = {
  // UNVERIFIED: Instagram's modal dialogs use role="dialog".
  dialog: '[role="dialog"]',
  // UNVERIFIED: the caption box is an editable div with role="textbox"
  // (aria-label "Write a caption..." in English).
  captionEditor: '[contenteditable="true"][role="textbox"], [contenteditable="true"][aria-label*="caption" i]',
  // UNVERIFIED: header buttons are either <button> or div[role="button"].
  button: 'button, [role="button"]',
  // UNVERIFIED: the selected photo is shown as an <img> with a blob: URL
  // (or drawn on a <canvas> after filters).
  previewImage: 'img[src^="blob:"]',
  previewCanvas: "canvas",
  video: "video",
  // Anything with a label; isCarouselHintLabel() decides which ones are
  // the arrows shown next to the photo when several are selected.
  labelled: "[aria-label]",
};

/** Is this aria-label one of the slide arrows of a multi-photo post? (see slideArrows) */
export function isCarouselHintLabel(label: string | null | undefined, words: InstagramText): boolean {
  return words.slideArrows.includes((label ?? "").trim().toLowerCase());
}

/**
 * Which carousel arrows are showing. Instagram shows only the arrows that
 * apply (VERIFIED 2026-11-15: "Right chevron" on photo 1, "Left chevron" on
 * photo 2 of a 2-photo post), so: a "next" arrow means more photos to the
 * right; only a "previous" arrow means this is the LAST photo.
 */
export function carouselArrows(labels: (string | null | undefined)[], words: InstagramText): { hasNext: boolean; hasPrev: boolean } {
  let hasNext = false;
  let hasPrev = false;
  for (const raw of labels) {
    const label = (raw ?? "").trim().toLowerCase();
    if (!words.slideArrows.includes(label)) continue;
    if (words.slideNext.includes(label)) hasNext = true;
    else hasPrev = true;
  }
  return { hasNext, hasPrev };
}

/** Images smaller than this (in CSS pixels) are icons or avatars, not the post. */
const MIN_PREVIEW_SIZE = 150;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM): tested in test/instagram-adapter.test.ts
// ---------------------------------------------------------------------------

/** Caption text as the user sees it: no non-breaking spaces, no Windows line ends, trimmed. */
export function normalizeCaption(text: string): string {
  return text.replace(/ /g, " ").replace(/\r\n?/g, "\n").replace(/\n+$/g, "").trim();
}

/** Is this the text of a Share button (in the given language)? */
export function isShareLabel(text: string | null | undefined, words: InstagramText): boolean {
  return words.share.includes((text ?? "").trim().toLowerCase());
}

/** Does this dialog text show a confirmed publication, a failure, or neither? */
export function classifyOutcomeText(text: string, words: InstagramText): "published" | "failed" | null {
  const lower = text.toLowerCase();
  if (words.published.some((t) => lower.includes(t))) return "published";
  if (words.failed.some((t) => lower.includes(t))) return "failed";
  return null;
}

// ---------------------------------------------------------------------------
// Reading the composer
// ---------------------------------------------------------------------------

export interface PreviewImage {
  /** Changes whenever a different photo (or a different crop/filter render) is shown. */
  key: string;
  element: HTMLImageElement | HTMLCanvasElement;
}

export interface ComposerSnapshot {
  /**
   * "none":         no post composer is open.
   * "other-step":   a composer dialog is open, but not at the caption step.
   * "caption-step": the caption box and Share button are both visible.
   */
  step: "none" | "other-step" | "caption-step";
  dialog: HTMLElement | null;
  editor: HTMLElement | null;
  shareButton: HTMLElement | null;
  caption: string;
  /** The selected photos, in order (one for a single-photo post). */
  images: PreviewImage[];
  postType: PostType;
  /** Visible carousel arrows (both false for a single photo). */
  carousel: { hasNext: boolean; hasPrev: boolean };
}

const NO_COMPOSER: ComposerSnapshot = {
  step: "none", dialog: null, editor: null, shareButton: null, caption: "", images: [], postType: "unknown", carousel: { hasNext: false, hasPrev: false },
};

function isVisible(node: Element): boolean {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The Share button inside a dialog, or null. */
function findShareButton(dialog: Element, words: InstagramText): HTMLElement | null {
  for (const button of dialog.querySelectorAll<HTMLElement>(SELECTORS.button)) {
    if (isShareLabel(button.textContent, words) && isVisible(button)) return button;
  }
  return null;
}

/** The biggest visible photo in the dialog (the post), ignoring avatars and icons. */
function findPreviewImages(dialog: Element): PreviewImage[] {
  const found: PreviewImage[] = [];
  for (const img of dialog.querySelectorAll<HTMLImageElement>(SELECTORS.previewImage)) {
    const rect = img.getBoundingClientRect();
    if (rect.width >= MIN_PREVIEW_SIZE && rect.height >= MIN_PREVIEW_SIZE) {
      found.push({ key: `img:${img.src}`, element: img });
    }
  }
  if (found.length === 0) {
    for (const canvas of dialog.querySelectorAll<HTMLCanvasElement>(SELECTORS.previewCanvas)) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width >= MIN_PREVIEW_SIZE && rect.height >= MIN_PREVIEW_SIZE) {
        found.push({ key: `canvas:${canvas.width}x${canvas.height}`, element: canvas });
      }
    }
  }
  return found;
}

/** Looks at the page and describes the post composer, if one is open. */
export function readComposer(doc: Document): ComposerSnapshot {
  const words = pageText(doc);
  if (!words) return NO_COMPOSER; // Instagram is in a language we don't support yet

  // There can be several dialogs (for example a "Discard post?" prompt on top).
  for (const dialog of doc.querySelectorAll<HTMLElement>(SELECTORS.dialog)) {
    const editor = dialog.querySelector<HTMLElement>(SELECTORS.captionEditor);
    const shareButton = findShareButton(dialog, words);
    if (!editor || !shareButton) continue;

    const images = findPreviewImages(dialog);
    // Only arrows actually on screen count (a hidden one isn't clickable).
    const arrowLabels = [...dialog.querySelectorAll(SELECTORS.labelled)]
      .filter((node) => isVisible(node))
      .map((node) => node.getAttribute("aria-label"));
    const postType = classifyPostType({
      photoCount: images.length,
      hasVideo: dialog.querySelector(SELECTORS.video) !== null,
      carouselHints: arrowLabels.filter((label) => isCarouselHintLabel(label, words)).length,
    });

    return {
      step: "caption-step",
      dialog,
      editor,
      shareButton,
      caption: normalizeCaption(editor.innerText ?? editor.textContent ?? ""),
      images,
      postType,
      carousel: carouselArrows(arrowLabels, words),
    };
  }
  // A dialog with a Share-less "Next" button, etc. We only care that a
  // composer-like dialog is open, so outcome detection can keep watching it.
  return doc.querySelector(SELECTORS.dialog) ? { ...NO_COMPOSER, step: "other-step" } : NO_COMPOSER;
}

/**
 * If this event's target is (inside) the Share button of a post composer,
 * returns that button. Checked fresh on every event, because Instagram
 * re-creates its buttons when the page re-renders.
 */
export function shareButtonFromEvent(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const words = pageText(target.ownerDocument);
  if (!words) return null;
  const button = target.closest<HTMLElement>(SELECTORS.button);
  if (!button || !isShareLabel(button.textContent, words)) return null;
  const dialog = button.closest(SELECTORS.dialog);
  // Only the composer's Share button: the dialog must also have a caption box.
  if (!dialog || !dialog.querySelector(SELECTORS.captionEditor)) return null;
  return button;
}

// ---------------------------------------------------------------------------
// The selected photo (stays on this computer)
// ---------------------------------------------------------------------------

/**
 * Gets the selected photo as a Blob, for local OCR. Returns null if the page
 * doesn't let us read it. The photo is NEVER uploaded: it is only passed,
 * inside the browser, to the extension's offscreen OCR page
 * (content/offscreen-ocr.ts -> ocr-relay.ts -> offscreen.ts).
 */
export async function readImageBlob(image: PreviewImage): Promise<Blob | null> {
  try {
    const el = image.element;
    if (el instanceof HTMLImageElement) {
      // blob: URLs belong to instagram.com, which this content script runs on.
      const response = await fetch(el.src);
      return response.ok ? await response.blob() : null;
    }
    // A canvas: copy its pixels. (May be blank if Instagram draws with WebGL
    // without keeping the picture; UNVERIFIED.)
    return await new Promise<Blob | null>((resolve) => el.toBlob((blob) => resolve(blob), "image/png"));
  } catch {
    return null; // e.g. the canvas is "tainted" by a cross-site image
  }
}

// ---------------------------------------------------------------------------
// Changing the caption (for "Apply" on a suggested edit)
// ---------------------------------------------------------------------------

// VERIFIED (2026-11-14): Instagram's caption box is a Lexical editor
// (data-lexical-editor, role="textbox", aria-label "Add a caption...").
// Lexical keeps its own copy of the text and its own copy of the selection,
// which it updates a moment AFTER the page's selection changes. Changing the
// page's text directly, or inserting before Lexical has seen the new
// selection, gets undone by Lexical. (First live test: Apply did nothing.)

/** Wait `ms` milliseconds, so the editor can react to what we just did. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Select everything in the caption box, the way Ctrl+A would. */
function selectWholeCaption(editor: HTMLElement): boolean {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Way 1: the browser's "insert text" command, as if the user typed. */
function typeText(text: string): void {
  document.execCommand("insertText", false, text);
}

/** Way 2: a pretend paste. Rich editors handle paste events themselves. */
function pasteText(editor: HTMLElement, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

function captionIs(editor: HTMLElement, text: string): boolean {
  return normalizeCaption(editor.innerText ?? "") === normalizeCaption(text);
}

/**
 * Replaces the whole caption with `text`, so that Instagram's editor knows
 * about the change (setting textContent directly would not work).
 * Returns true only if the caption box now really contains `text`.
 */
export async function writeCaption(editor: HTMLElement, text: string): Promise<boolean> {
  const ways: [string, () => void][] = [
    ["insert text", () => typeText(text)],
    ["paste", () => pasteText(editor, text)],
  ];
  for (const [name, write] of ways) {
    if (!selectWholeCaption(editor)) return false;
    await pause(60);  // let the editor notice the new selection
    write();
    await pause(120); // the editor updates the page a moment later
    if (captionIs(editor, text)) {
      console.info(`[CheckYo'Self] Caption changed using: ${name}`);
      return true;
    }
    console.info(`[CheckYo'Self] Changing the caption using "${name}" did not work.`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// After Share: did it work?
// ---------------------------------------------------------------------------

/**
 * Looks for Instagram's confirmation or error after a share.
 *  - "published": a confirmation was shown.
 *  - "failed":    an error was shown.
 *  - "closed":    no composer dialog is open any more, and we saw neither.
 *  - null:        still waiting.
 */
export function detectPublishOutcome(doc: Document): "published" | "failed" | "closed" | null {
  const words = pageText(doc);
  const dialogs = [...doc.querySelectorAll<HTMLElement>(SELECTORS.dialog)];
  for (const dialog of dialogs) {
    if (!words) break; // can't read the page's language: report "closed"/null only
    // Skip a dialog that still shows the caption box: its text includes the
    // user's own caption, which could contain words like "post shared".
    if (dialog.querySelector(SELECTORS.captionEditor)) continue;
    const outcome = classifyOutcomeText(dialog.innerText ?? dialog.textContent ?? "", words);
    if (outcome) return outcome;
  }
  return dialogs.length === 0 ? "closed" : null;
}
