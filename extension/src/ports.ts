// "Ports": the agreed shapes of modules that other teammates are still
// building. The Instagram integration codes against these interfaces, and
// uses the simple stand-ins below where the real modules aren't connected
// yet (history). OCR is connected: content/offscreen-ocr.ts.
//
//   OcrPort       -> Person B (OCR), will live in extension/src/ocr/
//   WarningPanel  -> Person D (warning interface); default: content/overlay.ts
//   HistoryClient -> Person C (history), will call the backend's /api/history
//
// To plug in a real module, pass it to startInstagramIntegration() in
// content/main.ts (OCR, panel) or to the worker in background.ts (history).
import type { BackendStatusReply, AnalyzeResponse, SuggestedEdit, TextSource } from "../../shared/contract";
import type { OcrResult } from "./ocr";

// ---------------------------------------------------------------------------
// OCR (docs/TEAM.md section B)
// ---------------------------------------------------------------------------

/**
 * Same shape as Person B's readImageText() in src/ocr/. On instagram.com it
 * can't be called directly (the OCR worker can't start inside a content
 * script, see src/ocr/README.md), so Instagram uses `offscreenOcr`
 * (content/offscreen-ocr.ts), which passes the photo to the offscreen
 * extension page (offscreen.html) that runs OCR there, inside the browser.
 */
export interface OcrPort {
  /** false while OCR can't run here; the panel then asks the user to type photo text. */
  readonly available: boolean;
  /** Reads text from one image ON THIS COMPUTER. Must never upload the image. Throws OcrError on failure. */
  readImageText(image: Blob, index: number): Promise<OcrResult>;
}

/** Stand-in for places where OCR can't run (e.g. tests): never called (available is false). */
export const unavailableOcr: OcrPort = {
  available: false,
  async readImageText(): Promise<OcrResult> {
    throw new Error("OCR is not available on Instagram yet.");
  },
};

// ---------------------------------------------------------------------------
// Warning interface shown on instagram.com (docs/TEAM.md section E)
// ---------------------------------------------------------------------------

/** What the panel's buttons do. main.ts provides these. */
export interface WarningPanelActions {
  onOpen(): void;                        // the corner button: open the panel only (sends nothing)
  onCheck(): void;                       // "Check this post": the user's OK to send the text for analysis
  onBack(): void;                        // "Back to editing"
  onContinue(): void;                    // "Continue to Share" (checked or not)
  onApplyEdit(edit: SuggestedEdit): void;
  onImageTextInput(text: string, index: number): void;
  onSaveToHistory(): void;               // "Save to history" on the after-share prompt
  onSkipSave(): void;                    // "No thanks"
  onCompareToggle(open: boolean): void;  // "+ Compare with my past posts" (optional)
  onComparePick(postId: string, picked: boolean): void;
  onUseProfile(use: boolean): void;
  onOpenHistory(): void;                 // "Manage or import past posts"
}

export type MessageKind = "info" | "error";

/** One notice about a photo read (see WarningPanel.setPhotos). */
/** What the panel's Compare section shows. */
export interface CompareView {
  open: boolean;
  status: string;
  error: boolean;
  /** "Use my profile…" (null when there's no profile). */
  profile: { label: string; checked: boolean } | null;
  items: Array<{ postId: string; caption: string; meta: string; checked: boolean }>;
}

/** What the panel shows for one photo. */
export interface PhotoView {
  index: number;
  label: string;
  text: string;
  hint: string;
  notices: PhotoNotice[];
}

export interface PhotoNotice {
  kind: "poor" | "warning";
  text: string;
}

export interface WarningPanel {
  /** The always-visible "Check this post" button next to the composer. */
  showLauncher(visible: boolean): void;
  /** Open the panel. `reason` changes the heading ("Before you share" vs. "Check this post"). */
  open(reason: "share-clicked" | "manual"): void;
  close(): void;
  isOpen(): boolean;
  /**
   * One "Text in photo N" box per photo (a single photo: "Text in the photo"),
   * each with its hint and notices ("poor" = unreliable read, text dropped;
   * "warning" = some words unclear or cut to the limit). `note` is shown above
   * the boxes (for carousels: "use Instagram's arrows…"). [] clears them.
   * A box the user is typing in is never overwritten.
   */
  setPhotos(photos: PhotoView[], note: { text: string; done: boolean }): void;
  /**
   * The small card shown after a CONFIRMED share: "Save this post to your
   * history?" ("ask"), then "saving", then a result ("done"), or hidden.
   */
  setSavePrompt(state: { kind: "ask" } | { kind: "saving" } | { kind: "done"; text: string; ok: boolean } | { kind: "hidden" }): void;
  /** The optional "Compare with my past posts" section (closed by default). */
  setCompare(view: CompareView): void;
  /** What the corner button says before the panel is opened (null: the default). */
  setLauncherPrompt(text: string | null): void;
  /** The Databricks/backend status pill in the panel's header (same states as the popup's pill). */
  setBackendStatus(status: Omit<BackendStatusReply, "kind">): void;
  setBusy(busy: boolean): void;
  setMessage(text: string, kind?: MessageKind): void;
  showResult(result: AnalyzeResponse, sources: TextSource[]): void;
  clearResult(): void;
  /** Mark the shown result as out of date (the draft changed after the check). */
  setStale(stale: boolean): void;
  /** Show or hide the "Now click Share to post" hint. */
  setShareReady(ready: boolean): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// History (docs/TEAM.md section D)
// ---------------------------------------------------------------------------

export interface PublishedPostInfo {
  draftHash: string;
  postId: string | null;
  publishedAt: string; // ISO 8601
}

export interface HistoryClient {
  /**
   * Called by the service worker ONLY after a confirmed publication.
   * The real version must still ask the user before importing anything.
   */
  recordPublished(info: PublishedPostInfo): Promise<void>;
}

/** Stand-in until Person C's history API exists: stores nothing. */
export const noHistory: HistoryClient = {
  async recordPublished(): Promise<void> {
    // Intentionally empty: there is no history storage yet, and nothing may
    // be stored without the user's explicit approval.
  },
};
