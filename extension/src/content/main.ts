// Content script for https://www.instagram.com/* (milestone 4).
//
// Supported workflow: ONE single-photo post made in the desktop website's
// "Create" dialog. When the caption step is open, it:
//   - shows a "Check this post" button (always available, the manual path),
//   - pauses a click on Share and offers: check / back to editing / continue,
//   - sends ONLY text to the service worker, which calls our local backend,
//   - marks results stale on any change, and ignores outdated replies,
//   - never clicks Share itself: "continue" lets the user's next click through.
//
// Instagram-specific page details are in instagram-adapter.ts.
// The rules (stale, outdated, one-time permission, no double share) are in
// share-flow.ts, which is unit-tested.
import type {
  BackendStatusReply,
  HistorySuggestionsReply,
  StoredHistoryPost,
  SaveToHistoryReply,
  CheckDraftReply,
  ExtensionMessage,
  InstagramDraftReply,
  SuggestedEdit,
  TextSource,
} from "../../../shared/contract";
import { hashSources } from "../api";
import { applyEditToText } from "../edits";
import { describePhotoRead, PHOTO_TEXT_MAX_CHARS } from "../photo-text";
import type { CompareView, OcrPort, WarningPanel, WarningPanelActions } from "../ports";
import { offscreenOcr } from "./offscreen-ocr";
import { carouselProgress, PhotoSet } from "./photo-set";
import { historySourcesFor, preselect, suggestionMeta } from "../compare";
import {
  detectPublishOutcome,
  readComposer,
  readImageBlob,
  shareButtonFromEvent,
  writeCaption,
  type ComposerSnapshot,
  type PostType,
} from "./instagram-adapter";
import { createOverlayPanel } from "./overlay";
import { ShareFlow, draftKey, type PublishOutcome } from "./share-flow";

/**
 * The kinds of post the extension helps with. For anything else (video, or a
 * post we can't recognise) the extension does nothing at all: no button, and
 * Share is never paused. Each photo gets its own "Text in photo N" box and
 * source (image_text:1, :2, ...); see photo-set.ts.
 */
export const SUPPORTED_POST_TYPES: PostType[] = ["single-photo", "multi-photo"];

/** Is the caption step of a supported post open right now? */
function isSupportedCaptionStep(snapshot: ComposerSnapshot): boolean {
  return snapshot.step === "caption-step" && SUPPORTED_POST_TYPES.includes(snapshot.postType);
}

export interface IntegrationOptions {
  ocr: OcrPort;
  createPanel: (actions: WarningPanelActions) => WarningPanel;
}

export function startInstagramIntegration(options: IntegrationOptions) {
  const flow = new ShareFlow();
  let panel: WarningPanel | null = null; // created the first time a composer appears

  // What we last read from the page.
  let snapshot: ComposerSnapshot = readComposer(document);
  // The post's photos and the text in each (photo-set.ts). For a carousel,
  // photos are added as the user clicks through the slides.
  const photos = new PhotoSet();
  let photoGeneration = 0; // bumped when the composer closes, so old reads are ignored
  // Photos waiting to be read. ONE at a time: the OCR page cancels a running
  // read when another photo from the same tab arrives.
  const readQueue: { key: string; blob: Promise<Blob | null>; generation: number }[] = [];
  let queueRunning = false;
  let reachedLastSlide = false; // the carousel's last photo was shown (no "next" arrow)
  let sharedDraftHash: Promise<string> | null = null; // hash of the draft that was shared
  let sharedPost: { caption: string; imageText: string } | null = null; // its text, for "Save to history?"
  let pendingSave: { caption: string; imageText: string; publishedAt: string } | null = null;
  let saveHideTimer: ReturnType<typeof setTimeout> | undefined;

  // The panel's optional "Compare with my past posts" (closed by default).
  let compareOpen = false;
  const comparePicked = new Set<string>();
  let useProfile = true;
  let profileFacts = 0;
  let compareSuggestions: Extract<HistorySuggestionsReply, { kind: "history-suggestions" }>["suggestions"] = [];

  // -------------------------------------------------------------------------
  // The draft
  // -------------------------------------------------------------------------

  /** The draft as TextSources. Only text — never the image. */
  function currentSources(): TextSource[] {
    return [{ id: "caption", type: "caption", text: snapshot.caption }, ...photos.sources()];
  }

  function currentKey(): string {
    return draftKey(currentSources(), photos.key());
  }

  function getPanel(): WarningPanel {
    if (!panel) panel = options.createPanel(actions);
    return panel;
  }

  /** Re-reads the page and reacts to any change. Called (debounced) on every page change. */
  function scan() {
    snapshot = readComposer(document);

    if (flow.isPublishing()) watchPublishOutcome();

    if (!isSupportedCaptionStep(snapshot)) {
      if (panel) {
        panel.showLauncher(false);
        panel.close();
        panel.setShareReady(false);
      }
      if (photos.key() !== null || flow.isShareAllowed(Date.now())) {
        // The user closed the composer or went back a step without sharing.
        if (flow.isShareAllowed(Date.now())) console.info("[CheckYo'Self] Share outcome: cancelled");
        flow.composerClosed();
        photos.reset();
        photoGeneration++; // ignore reads still running for the closed post
        readQueue.length = 0;
        reachedLastSlide = false;
        panel?.setPhotos([], { text: "", done: false });
        panel?.setLauncherPrompt(null);
        // A new post starts with Compare closed again (it's never forced).
        compareOpen = false;
        comparePicked.clear();
        compareSuggestions = [];
        panel?.setCompare(compareView("", false));
        panel?.clearResult();
        panel?.setStale(false);
      }
      return;
    }

    const p = getPanel();
    if (!p.isOpen()) p.showLauncher(true);

    // New photos on screen (a carousel shows one slide at a time): number
    // them, grab each one's data NOW (the slide may leave the page when the
    // user moves on), and queue it to be read.
    const added = photos.sync(snapshot.images.map((image) => image.key));
    for (const entry of added) {
      const image = snapshot.images.find((i) => i.key === entry.key)!;
      readQueue.push({ key: entry.key, blob: readImageBlob(image), generation: photoGeneration });
    }
    if (snapshot.carousel.hasPrev && !snapshot.carousel.hasNext) reachedLastSlide = true;
    if (added.length) void runReadQueue();
    renderPhotos(); // also updates the carousel prompt (e.g. the last photo was reached)

    draftChanged();
  }

  /** Tell the flow about the current draft; update the stale banner and Share hint. */
  function draftChanged() {
    const becameStale = flow.updateDraft(currentKey());
    if (becameStale) {
      panel?.setMessage("You changed the post. Check again before sharing.");
    }
    if (panel) {
      panel.setStale(flow.lastResult() !== null && !flow.hasCurrentResult());
      panel.setShareReady(flow.isShareAllowed(Date.now()));
      panel.setBusy(flow.isChecking());
    }
  }

  // -------------------------------------------------------------------------
  // OCR: the selected photo is grabbed from Instagram's composer (no upload
  // prompt) and read on this computer by the offscreen OCR page. Reading it
  // sends nothing for analysis; see content/offscreen-ocr.ts.
  // -------------------------------------------------------------------------

  /** Draws one "Text in photo N" box per photo, plus a note for carousels. */
  function renderPhotos() {
    const all = photos.all();
    const many = all.length > 1 || snapshot.postType === "multi-photo";
    const p = getPanel();
    // A carousel: prompt the user (on the corner button AND in the panel) to
    // click through every photo, until the last one has been shown and read.
    const progress = many ? carouselProgress(all.length, reachedLastSlide, photos.isReading()) : null;
    p.setLauncherPrompt(progress?.launcher ?? null);
    p.setPhotos(
      all.map((ph) => ({ index: ph.index, label: many ? `Text in photo ${ph.index}` : "Text in the photo", text: ph.text, hint: ph.hint, notices: ph.notices })),
      { text: progress?.banner ?? "", done: progress?.complete ?? false },
    );
  }

  /** Reads the queued photos one by one, on this computer (see content/offscreen-ocr.ts). */
  async function runReadQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (readQueue.length) {
        const job = readQueue.shift()!;
        if (job.generation !== photoGeneration) continue; // that post was closed
        const index = photos.all().find((p) => p.key === job.key)?.index ?? 1;
        const read = await readOnePhoto(job.blob, index);
        if (job.generation !== photoGeneration) continue;
        photos.finishReading(job.key, read.text, read.hint, read.notices);
        renderPhotos();
        draftChanged(); // the photo text is part of the draft
      }
    } finally {
      queueRunning = false;
    }
  }

  async function readOnePhoto(blobPromise: Promise<Blob | null>, index: number) {
    const typeIt = "Type any text you can see in this photo (signs, name tags, jerseys).";
    if (!options.ocr.available) return { text: "", hint: `Automatic photo reading isn't available. ${typeIt}`, notices: [] };
    const blob = await blobPromise;
    if (!blob) return { text: "", hint: `Couldn't read this photo from the page. ${typeIt}`, notices: [] };
    try {
      const result = await options.ocr.readImageText(blob, index); // stays inside the browser
      // Same rules as the popup (src/photo-text.ts): an unreliable read is
      // thrown away (empty box + notice), a noisy one gets a notice, and the
      // text is cut to the strict PHOTO_TEXT_MAX_CHARS limit.
      const view = describePhotoRead(result);
      if (view.truncated || view.quality !== "clean") {
        console.info(`[CheckYo'Self] Photo ${index} read: quality=${view.quality}, discarded=${view.discarded}, truncated=${view.truncated}`); // no photo text in logs
      }
      return { text: view.text, hint: view.hint, notices: view.notices };
    } catch (err) {
      // OCR errors carry a user-readable message (src/ocr/README.md). A failure is never "no text".
      const reason = err instanceof Error ? ` ${err.message}` : "";
      return { text: "", hint: `Reading the photo failed.${reason} ${typeIt}`, notices: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Panel actions
  // -------------------------------------------------------------------------

  let statusTurn = 0; // so an older status answer can't overwrite a newer one

  /**
   * Updates the status pill in the panel's header. Asks the service worker,
   * which asks the backend's /api/health: no Databricks call, nothing sent.
   * Called when the panel opens and after every check.
   */
  async function refreshBackendStatus() {
    const myTurn = ++statusTurn;
    let reply: BackendStatusReply | { kind: "rejected"; reason: string } | undefined;
    try {
      const message: ExtensionMessage = { kind: "get-backend-status" };
      reply = await chrome.runtime.sendMessage(message);
    } catch {
      reply = undefined; // the extension was reloaded; this page needs a refresh
    }
    if (myTurn !== statusTurn || !panel) return;
    if (reply?.kind === "backend-status") {
      panel.setBackendStatus({ state: reply.state, label: reply.label, title: reply.title });
    } else {
      panel.setBackendStatus({ state: "offline", label: "Status unknown", title: "CheckYo'Self was reloaded. Refresh this page." });
    }
  }

  const actions: WarningPanelActions = {
    onOpen() {
      // The corner button only OPENS the panel, so the user sees the photo
      // text before anything is sent. Sending needs a click on "Check this post".
      const p = getPanel();
      if (!p.isOpen()) p.open("manual");
      void refreshBackendStatus();
    },
    onCheck() {
      const p = getPanel();
      if (!p.isOpen()) p.open("manual"); // keep the "Before you share" heading if Share opened it
      void checkDraft();
    },
    onBack() {
      flow.cancelShare();
      const p = getPanel();
      p.setShareReady(false);
      p.close();
      p.showLauncher(isSupportedCaptionStep(snapshot));
      snapshot.editor?.focus();
    },
    onContinue() {
      // Does NOT share. Only lets the user's next real click on Share through.
      flow.allowNextShare(Date.now());
      const p = getPanel();
      const ready = flow.isShareAllowed(Date.now());
      p.setShareReady(ready);
      p.setMessage(flow.hasCurrentResult() ? "" : "Not checked. Click Share when you're ready.");
      if (ready) {
        // Get out of the way: the open panel can cover Instagram's Share
        // button (checked live). The small corner button now says "Ready";
        // clicking it reopens the panel (without sending anything) and without cancelling.
        p.close();
        p.showLauncher(true);
      }
    },
    onApplyEdit(edit) {
      void applyEdit(edit);
    },
    onCompareToggle(open) {
      compareOpen = open;
      if (open) void loadCompare();
      else getPanel().setCompare(compareView("", false));
    },
    onComparePick(postId, picked) {
      if (picked) comparePicked.add(postId);
      else comparePicked.delete(postId);
    },
    onUseProfile(use) {
      useProfile = use;
    },
    onOpenHistory() {
      const message: ExtensionMessage = { kind: "open-history-page" };
      chrome.runtime.sendMessage(message).catch(() => undefined);
    },
    onSaveToHistory() {
      void saveSharedPost();
    },
    onSkipSave() {
      pendingSave = null;
      getPanel().setSavePrompt({ kind: "hidden" });
    },
    onImageTextInput(text, index) {
      photos.setTyped(index, text);
      draftChanged();
    },
  };

  function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /** What the Compare section shows right now. */
  function compareView(status: string, error: boolean): CompareView {
    return {
      open: compareOpen,
      status,
      error,
      profile:
        compareOpen && profileFacts > 0
          ? { label: `Use my profile: ${profileFacts} fact${profileFacts === 1 ? "" : "s"} from my saved posts (finds links even without shared words)`, checked: useProfile }
          : null,
      items: compareOpen
        ? compareSuggestions.map((s) => ({ postId: s.postId, caption: s.caption, meta: suggestionMeta(s, shortDate), checked: comparePicked.has(s.postId) }))
        : [],
    };
  }

  /** Opened Compare: ask the worker which saved posts look related (no AI call). */
  async function loadCompare() {
    const p = getPanel();
    p.setCompare(compareView("Looking for related past posts…", false));
    let reply: HistorySuggestionsReply | { kind: "rejected"; reason: string } | undefined;
    try {
      const message: ExtensionMessage = { kind: "get-history-suggestions", sources: currentSources().filter((s) => s.text.trim()) };
      reply = await chrome.runtime.sendMessage(message);
    } catch {
      reply = undefined;
    }
    if (!compareOpen) return; // closed meanwhile
    if (reply?.kind !== "history-suggestions") {
      const why = reply?.kind === "history-error" ? reply.message : reply?.kind === "rejected" ? reply.reason : "CheckYo'Self was reloaded. Refresh this page.";
      p.setCompare(compareView(why, true));
      return;
    }
    compareSuggestions = reply.suggestions;
    profileFacts = reply.profile.facts;
    comparePicked.clear();
    for (const id of preselect(reply.suggestions)) comparePicked.add(id);
    const status =
      reply.savedPosts === 0
        ? "You haven't saved any past posts yet. Import some (button below), or save posts after you share them."
        : comparePicked.size > 0
          ? `${comparePicked.size} of your ${reply.savedPosts} saved posts look related and are ticked. Untick any you don't want included.`
          : `None of your ${reply.savedPosts} saved posts share words with this post. Tick any you want to include anyway.`;
    p.setCompare(compareView(status, false));
  }

  /** The user clicked "Save to history" on the after-share card. */
  async function saveSharedPost() {
    const p = getPanel();
    if (!pendingSave) return p.setSavePrompt({ kind: "hidden" });
    const message: ExtensionMessage = { kind: "save-to-history", ...pendingSave };
    p.setSavePrompt({ kind: "saving" });
    let reply: SaveToHistoryReply | { kind: "rejected"; reason: string } | undefined;
    try {
      reply = await chrome.runtime.sendMessage(message);
    } catch {
      reply = undefined;
    }
    if (reply?.kind === "history-saved") {
      pendingSave = null;
      p.setSavePrompt({ kind: "done", ok: true, text: "Saved to your history ✓ Manage it from the CheckYo'Self popup → Your past posts." });
      saveHideTimer = setTimeout(() => p.setSavePrompt({ kind: "hidden" }), 6000);
    } else {
      const why = reply?.kind === "history-error" ? reply.message : reply?.kind === "rejected" ? reply.reason : "CheckYo'Self was reloaded. Refresh this page.";
      p.setSavePrompt({ kind: "done", ok: false, text: `Couldn't save it: ${why}` });
      saveHideTimer = setTimeout(() => p.setSavePrompt({ kind: "hidden" }), 10000);
    }
  }

  async function checkDraft() {
    snapshot = readComposer(document);
    const p = getPanel();
    if (!isSupportedCaptionStep(snapshot)) {
      p.setMessage("Open the caption step of a photo post first.", "error");
      return;
    }
    draftChanged();
    if (photos.isReading()) {
      // Don't send a draft that is missing photo text the user hasn't seen yet.
      p.setMessage("Still reading the photos. Check again in a moment, once their text appears above.", "error");
      return;
    }
    const tooLong = photos.all().find((ph) => ph.text.length > PHOTO_TEXT_MAX_CHARS);
    if (tooLong) {
      // Can't normally happen (each box has the same limit); never send it if it does.
      p.setMessage(`The text of photo ${tooLong.index} is longer than ${PHOTO_TEXT_MAX_CHARS} characters. Shorten it before checking.`, "error");
      return;
    }
    // A carousel whose last photo wasn't shown yet: check anyway, but say so.
    const unseenWarning =
      snapshot.postType === "multi-photo" && !reachedLastSlide
        ? ` Not all photos were shown: only the ${photos.all().length} you clicked to were checked. Click › to show the rest, then check again.`
        : "";
    const sources = currentSources();
    if (!sources.some((s) => s.text.trim())) {
      p.setMessage("Write a caption (or type the photo's text) first.", "error");
      return;
    }

    const requestId = flow.startCheck();
    if (requestId === null) return; // this exact draft is already being checked
    p.setBusy(true);
    p.setMessage("Checking your post…");

    let reply: CheckDraftReply | { kind: "rejected"; reason: string } | undefined;
    try {
      const draftHash = await hashSources(sources);
      const message: ExtensionMessage = { kind: "check-draft", requestId, draftHash, sources };
      // Opt-in: the posts ticked in Compare, and/or the profile.
      if (compareOpen) {
        if (comparePicked.size) message.historyPostIds = [...comparePicked];
        if (useProfile && profileFacts > 0) message.usePortfolio = true;
      }
      reply = await chrome.runtime.sendMessage(message);
    } catch {
      reply = { kind: "check-error", requestId, message: "CheckYo'Self was reloaded. Refresh this page and try again." };
    }

    if (!reply || reply.kind === "rejected") {
      if (flow.receiveError(requestId) === "accepted") {
        p.setMessage(reply ? reply.reason : "No answer from CheckYo'Self. Try again.", "error");
      }
    } else if (reply.kind === "check-error") {
      if (flow.receiveError(reply.requestId) === "accepted") p.setMessage(reply.message, "error");
    } else if (flow.receiveResult(reply.requestId, reply.result) === "accepted") {
      // Show (and highlight) the earlier posts the check used, after the draft.
      const asStored: StoredHistoryPost[] = compareSuggestions.map((s) => ({
        postId: s.postId, status: "published", publishedAt: s.publishedAt, caption: s.caption,
        ...(s.imageText ? { imageText: s.imageText } : {}), approvalId: "", importedAt: "",
      }));
      p.showResult(reply.result, [...sources, ...historySourcesFor(reply.result, asStored)]);
      const n = reply.result.findings.length;
      const parts: string[] = [];
      if (reply.result.historyUsed.length) parts.push(`${reply.result.historyUsed.length} past post${reply.result.historyUsed.length === 1 ? "" : "s"}`);
      if (reply.result.portfolioUsed) parts.push(`your profile (${reply.result.portfolioUsed.facts} facts)`);
      const compared = parts.length ? ` Compared with ${parts.join(" and ")}.` : "";
      if (reply.result.droppedFindings > 0) {
        p.setMessage(`Check incomplete: ${n} thing${n === 1 ? "" : "s"} shown, ${reply.result.droppedFindings} not shown.${unseenWarning}${compared}`, "error");
      } else if (unseenWarning) {
        p.setMessage(`Check incomplete:${unseenWarning}${compared}`, "error");
      } else {
        p.setMessage((n === 0 ? "Check complete." : `Check complete: ${n} thing${n === 1 ? "" : "s"} to review.`) + compared);
      }
    }
    // An "outdated" reply is ignored on purpose: the draft changed while we waited.
    draftChanged();
    void refreshBackendStatus(); // a real Databricks call just succeeded or failed
  }

  let applying = false; // so a double-click on Apply can't start two edits at once

  /** "Apply" on a suggested edit: only if the caption still matches what was checked. */
  async function applyEdit(edit: SuggestedEdit) {
    if (applying) return;
    const p = getPanel();
    snapshot = readComposer(document); // read the caption as it is RIGHT NOW
    if (!isSupportedCaptionStep(snapshot) || !snapshot.editor) {
      p.setMessage("The caption box isn't open any more.", "error");
      return;
    }
    if (!flow.canApplyEdit(currentKey())) {
      p.setMessage("Your post changed since this check. Check again before applying suggestions.", "error");
      draftChanged();
      return;
    }
    const result = applyEditToText(snapshot.caption, edit);
    if (!result.ok) {
      p.setMessage(result.reason, "error");
      return;
    }
    const captionBefore = snapshot.caption;
    applying = true;
    p.setMessage("Applying the change…");
    let changed = false;
    try {
      changed = await writeCaption(snapshot.editor, result.text);
    } finally {
      applying = false;
    }
    scan(); // the caption (may have) changed, so the result is now stale
    if (changed) {
      p.setMessage("Change applied. Check again to see updated results.");
      return;
    }
    // Instagram's editor didn't take the change. Never leave a half-edit
    // silently: tell the user, and offer the text to paste themselves.
    const copied = await navigator.clipboard.writeText(result.text).then(() => true, () => false);
    const copyNote = copied ? " The suggested caption was copied; paste it in yourself." : "";
    p.setMessage(
      snapshot.caption === captionBefore
        ? "Couldn't change Instagram's caption box." + copyNote
        : "Couldn't apply this change cleanly, and your caption may have changed. Please check it." + copyNote,
      "error",
    );
  }

  // -------------------------------------------------------------------------
  // Share button interception
  // -------------------------------------------------------------------------

  /**
   * Runs BEFORE Instagram sees any click (capture phase on window, added at
   * document_start, so ours runs first). Stopping the event here means
   * Instagram's own handler never runs.
   */
  function onPointerOrClick(event: Event) {
    const shareButton = shareButtonFromEvent(event);
    if (!shareButton) return;
    // Only supported post types (see SUPPORTED_POST_TYPES); for others we
    // never get in the way.
    if (!isSupportedCaptionStep(readComposer(document))) return;

    const now = Date.now();
    if (event.type !== "click") {
      // pointerdown/mousedown/etc.: block them unless the user chose to continue,
      // in case Instagram reacts to them instead of "click".
      if (!flow.isShareAllowed(now)) stop(event);
      return;
    }

    const decision = flow.onShareClick(now);
    if (decision === "allow") {
      // The user's own click goes through to Instagram, untouched.
      snapshot = readComposer(document);
      sharedDraftHash = hashSources(currentSources());
      sharedPost = { caption: snapshot.caption, imageText: photos.joinedText() };
      const p = getPanel();
      p.setShareReady(false);
      p.close();
      p.showLauncher(false);
      return;
    }
    stop(event);
    if (decision === "block") {
      getPanel().setMessage("Your post is already being shared.", "error");
      return;
    }
    // "intercept": show our choice instead.
    scan();
    const p = getPanel();
    p.open("share-clicked");
    void refreshBackendStatus();
    p.setShareReady(false);
    p.setMessage(flow.hasCurrentResult() ? "You checked this exact post. Continue, or go back to edit." : "");
  }

  /** Enter/Space on a focused Share button. */
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!shareButtonFromEvent(event) || !isSupportedCaptionStep(readComposer(document))) return;
    if (flow.isShareAllowed(Date.now())) return; // let it through; the click that follows decides
    stop(event);
    scan();
    getPanel().open("share-clicked");
    void refreshBackendStatus();
  }

  function stop(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "touchend", "click"]) {
    // passive: false, or Chrome ignores preventDefault() on touch events.
    window.addEventListener(type, onPointerOrClick, { capture: true, passive: false });
  }
  window.addEventListener("keydown", onKeyDown, { capture: true, passive: false });

  // -------------------------------------------------------------------------
  // After Share
  // -------------------------------------------------------------------------

  function watchPublishOutcome() {
    const seen = detectPublishOutcome(document);
    let outcome: PublishOutcome | null = null;
    if (seen === "published") outcome = flow.finishPublishing("published");
    else if (seen === "failed") outcome = flow.finishPublishing("failed");
    // Closed without a confirmation or error: we can't tell what happened.
    else if (seen === "closed") outcome = flow.finishPublishing("unknown");
    else if (flow.publishTimedOut(Date.now())) outcome = flow.finishPublishing("unknown");
    if (outcome) reportOutcome(outcome);
  }

  async function reportOutcome(outcome: PublishOutcome) {
    console.info(`[CheckYo'Self] Share outcome: ${outcome}`);
    const post = sharedPost;
    sharedPost = null;
    if (outcome !== "published" || !sharedDraftHash) return; // only CONFIRMED posts count
    // Ask (never automatic) whether to save it to history.
    if (post && (post.caption.trim() || post.imageText.trim())) {
      pendingSave = { ...post, publishedAt: new Date().toISOString() };
      clearTimeout(saveHideTimer);
      getPanel().setSavePrompt({ kind: "ask" });
    }
    const message: ExtensionMessage = {
      kind: "post-published",
      draftHash: await sharedDraftHash,
      postId: null, // UNVERIFIED whether Instagram shows the new post's id; not read yet
      publishedAt: new Date().toISOString(),
    };
    sharedDraftHash = null;
    chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // The popup's "Use draft from Instagram tab"
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only our own popup (an extension page, not a tab) may ask.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if ((message as ExtensionMessage | null)?.kind !== "get-instagram-draft") return false;
    snapshot = readComposer(document);
    const found = isSupportedCaptionStep(snapshot);
    const reply: InstagramDraftReply = {
      kind: "instagram-draft",
      found,
      caption: found ? snapshot.caption : "",
      imageText: found ? photos.joinedText() : "",
    };
    sendResponse(reply);
    return false;
  });

  // -------------------------------------------------------------------------
  // Watching the page
  // -------------------------------------------------------------------------

  let scanTimer: number | undefined;
  function scheduleScan() {
    if (scanTimer !== undefined) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = undefined;
      scan();
    }, 150);
  }
  // attributeFilter "src": a carousel may change slides by swapping the
  // photo's src instead of adding a new <img>; either way we rescan.
  new MutationObserver(scheduleScan).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src"] });
  document.addEventListener("input", scheduleScan, true);
  // Also check now and then, so a share that never gets an answer times out.
  window.setInterval(() => flow.isPublishing() && scan(), 2000);
}

startInstagramIntegration({ ocr: offscreenOcr, createPanel: createOverlayPanel });
