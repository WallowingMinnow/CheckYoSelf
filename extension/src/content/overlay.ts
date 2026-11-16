// The warning panel shown on instagram.com. Default WarningPanel (see
// ports.ts); Person D can replace it with their own as long as it keeps the
// same methods.
//
// It reuses renderResults() from render.ts, so warnings look and behave the
// same as in the popup (textContent only, practice-mode banner, incomplete
// banner, stale banner).
//
// It lives in a Shadow DOM so Instagram's styles can't change it and ours
// can't change Instagram's page. It sits OUTSIDE Instagram's own dialog.
import type { AnalyzeResponse, TextSource } from "../../../shared/contract";
import { PHOTO_TEXT_MAX_CHARS } from "../photo-text";
import type { CompareView, MessageKind, PhotoView, WarningPanel, WarningPanelActions } from "../ports";
import { renderResults, type ResultElements } from "../render";
import { renderVerdict, type VerdictElements } from "../verdict";
// The popup's stylesheet, bundled as text by esbuild (see build.mjs).
import popupCss from "../../public/popup.css";

/** Panel-only styles. The popup's colors and finding styles come from popup.css. */
const PANEL_CSS = `
:host { all: initial; }
.launcher, .panel { font: 14px/1.45 var(--ui-font); color: var(--ink); }
.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  box-shadow: 0 4px 16px rgba(0,0,0,.25);
}
.panel {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  width: 400px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
  overflow: auto; background: var(--paper); border: 1px solid var(--line);
  border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.35); padding: 14px 16px 16px;
}
.panel[hidden], .launcher[hidden] { display: none; }
.panel-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.panel-head h1 { font-size: 16px; }
.panel-head-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.close { padding: 2px 8px; }
.photos-note { margin: 8px 0; padding: 8px 10px; border: 2px solid var(--asphalt, #151515); background: var(--amber, #f0a43a); color: var(--asphalt, #151515); font-weight: 700; font-size: 13px; }
.photos-note.is-done { background: var(--lime, #d6f04a); }
.photos-note[hidden] { display: none; }
.save-card {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 340px; max-width: calc(100vw - 40px);
  padding: 12px 14px; background: var(--paper); border: 2px solid var(--asphalt, #151515); box-shadow: 4px 4px 0 var(--asphalt, #151515);
  font: 13.5px/1.45 var(--ui-font); color: var(--ink);
}
.save-card[hidden], .save-buttons[hidden] { display: none; }
.save-card[data-state="ok"] { background: var(--lime, #d6f04a); }
.save-card[data-state="error"] { background: var(--high-mark, #f9d3cf); }
.save-text { margin: 0 0 8px; }
.save-buttons { display: flex; gap: 8px; justify-content: flex-end; }
.intro { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.share-ready { margin: 10px 0 0; padding: 8px 10px; border-radius: 6px; background: var(--low-mark); color: var(--low); font-weight: 600; }
.actions { flex-wrap: wrap; }
.photo-notices .banner { margin: 4px 0 6px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className: string, onClick: () => void) {
  const b = el("button", className, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function createOverlayPanel(actions: WarningPanelActions): WarningPanel {
  const host = document.createElement("second-look-panel");
  const shadow = host.attachShadow({ mode: "closed" });

  // Don't let clicks and key presses inside our panel reach Instagram's page,
  // which might treat them as "clicked outside the dialog" (closing the
  // composer) or as keyboard shortcuts.
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "keydown", "keyup", "keypress", "input", "focusin"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const style = el("style");
  // popup.css styles :root and body; inside a shadow root the equivalent is :host.
  style.textContent = popupCss.replaceAll(":root", ":host") + PANEL_CSS;

  // Opens the panel only. Nothing is sent until "Check this post" inside it.
  const launcher = button("CheckYo'Self: Check this post", "primary launcher", () => actions.onOpen());
  launcher.hidden = true;

  const panel = el("section", "panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "CheckYo'Self");

  const head = el("div", "panel-head");
  const title = el("h1", undefined, "CheckYo'Self");
  // Same pill as the popup (popup.css .status-pill), so you can see whether the AI is reachable.
  const statusPill = el("span", "status-pill", "Checking backend…");
  statusPill.dataset.state = "checking";
  statusPill.setAttribute("role", "status");
  const headRight = el("div", "panel-head-right");
  headRight.append(statusPill, button("Close", "secondary small close", () => actions.onBack()));
  head.append(title, headRight);
  const intro = el("p", "intro");

  // One block per photo ("Text in photo N"), drawn by setPhotos().
  const photosNote = el("p", "photos-note");
  photosNote.setAttribute("role", "status");
  const photoBlocks = el("div", "photo-blocks");

  const checkButton = button("Check this post", "primary", () => actions.onCheck());
  const backButton = button("Back to editing", "secondary", () => actions.onBack());
  const continueButton = button("Share without checking", "secondary", () => actions.onContinue());
  const buttonRow = el("div", "actions");
  buttonRow.append(backButton, continueButton, checkButton);
  // What "Check this post" sends. Shown before the user clicks it.
  const consent = el(
    "p",
    "hint consent-note",
    "“Check this post” sends your caption and the photo text above (as text only) to your CheckYo'Self backend, " +
      "which uses a cloud AI model to analyze it. The photo itself never leaves your computer. Nothing is sent until you click it.",
  );

  const shareReady = el("p", "share-ready", "Ready. Click Instagram's Share button to post.");
  shareReady.hidden = true;
  const message = el("p", "message");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");

  // The same structure popup.html gives renderResults().
  const results = el("section", "results");
  results.hidden = true;
  const mockBanner = el("p", "banner banner-mock", "Practice results. These come from simple keyword rules, not AI.");
  const incompleteBanner = el("p", "banner banner-incomplete");
  incompleteBanner.setAttribute("role", "alert");
  const staleBanner = el("div", "banner banner-stale");
  staleBanner.append(el("span", undefined, "You changed the post after this check, so these results may be wrong."));
  staleBanner.append(button("Check again", "primary small", () => actions.onCheck()));
  staleBanner.hidden = true;
  const summary = el("p", "summary");
  const markedDraft = el("div", "marked-draft");
  const findings = el("ol", "findings");
  const meta = el("p", "meta");

  // The verdict (risk score, LOW/MEDIUM/HIGH stamp, headline) and the advice
  // cards: the same structure and classes as popup.html, drawn by the same
  // renderVerdict() (src/verdict.ts, display only).
  const verdict = el("div", "verdict");
  verdict.hidden = true;
  const verdictScoreBox = el("div", "verdict-score");
  const verdictScore = el("span", "verdict-number", "0");
  verdictScoreBox.append(el("span", "verdict-label", "Risk score"), verdictScore, el("span", "verdict-max", "/ 100"));
  const verdictStamp = el("span", "verdict-stamp", "LOW");
  const verdictHeadline = el("p", "verdict-headline");
  const verdictNote = el("p", "verdict-note");
  verdict.append(verdictScoreBox, verdictStamp, verdictHeadline, verdictNote);
  const advice = el("section", "advice");
  advice.hidden = true;
  const adviceList = el("ol", "advice-list");
  advice.append(el("h3", "advice-title", "Before you drop that post…"), adviceList);
  const verdictEls: VerdictElements = {
    root: verdict, score: verdictScore, stamp: verdictStamp, headline: verdictHeadline, note: verdictNote, advice, adviceList,
  };

  results.append(
    el("h2", "results-title", "What this post could reveal"),
    verdict, mockBanner, incompleteBanner, staleBanner, summary, markedDraft, findings, advice, meta,
  );

  const resultEls: ResultElements = { root: results, summary, markedDraft, findings, meta, mockBanner, incompleteBanner };

  // Optional "Compare with my past posts" (closed by default; same look as the popup's).
  const compare = el("div", "compare");
  const compareToggle = button("+ Compare with my past posts (optional)", "link-button", () => actions.onCompareToggle(comparePanel.hidden));
  compareToggle.setAttribute("aria-expanded", "false");
  const comparePanel = el("div", "compare-panel");
  comparePanel.hidden = true;
  const compareHint = el(
    "p",
    "hint",
    "Check this post together with earlier posts you saved, to spot what they reveal together (for example a first name in one post and a last name in another). Only what you tick is used.",
  );
  const profileRow = el("label", "compare-profile");
  const profileBox = el("input");
  profileBox.type = "checkbox";
  profileBox.addEventListener("change", () => actions.onUseProfile(profileBox.checked));
  const profileLabel = el("span");
  profileRow.append(profileBox, profileLabel);
  const compareStatus = el("p", "hint");
  compareStatus.setAttribute("role", "status");
  const compareList = el("ul", "compare-list");
  const compareLinks = el("p", "compare-links");
  compareLinks.append(button("Manage or import past posts", "secondary small", () => actions.onOpenHistory()));
  comparePanel.append(compareHint, profileRow, compareStatus, compareList, compareLinks);
  compare.append(compareToggle, comparePanel);

  panel.append(head, intro, photosNote, photoBlocks, compare, consent, buttonRow, shareReady, message, results);
  // "Save this post to your history?" after a confirmed share. Never automatic.
  const saveCard = el("section", "save-card");
  saveCard.hidden = true;
  saveCard.setAttribute("role", "dialog");
  saveCard.setAttribute("aria-label", "Save to CheckYo'Self history");
  const saveText = el("p", "save-text");
  const saveButtons = el("div", "save-buttons");
  const saveYes = button("Save to history", "primary small", () => actions.onSaveToHistory());
  const saveNo = button("No thanks", "secondary small", () => actions.onSkipSave());
  saveButtons.append(saveNo, saveYes);
  saveCard.append(saveText, saveButtons);

  shadow.append(style, launcher, panel, saveCard);
  document.documentElement.append(host);

  let hasResult = false;
  let isShareReady = false;
  let launcherPrompt: string | null = null; // e.g. "click › to show each photo"

  function updateLauncherText() {
    // After "Continue" the panel closes (it can cover Instagram's Share
    // button), so the corner button tells the user what to do next.
    launcher.textContent = isShareReady
      ? "CheckYo'Self: ready. Click Instagram's Share to post."
      : (launcherPrompt ?? "CheckYo'Self: Check this post");
  }
  let stale = false;

  function updateContinueLabel() {
    continueButton.textContent = hasResult && !stale ? "Continue to Share" : "Share without checking";
  }

  return {
    showLauncher(visible) {
      launcher.hidden = !visible;
    },
    open(reason) {
      title.textContent = reason === "share-clicked" ? "Before you share" : "Check this post";
      intro.textContent =
        reason === "share-clicked"
          ? "CheckYo'Self paused sharing so you can check what this post could reveal. Nothing has been posted."
          : "Check what this post could reveal. The photo's text is read on your computer; review it below before checking.";
      panel.hidden = false;
      launcher.hidden = true;
    },
    close() {
      panel.hidden = true;
    },
    isOpen() {
      return !panel.hidden;
    },
    setPhotos(photos: PhotoView[], note) {
      photosNote.textContent = note.text;
      photosNote.hidden = !note.text;
      photosNote.classList.toggle("is-done", note.done);
      // Keep existing boxes (so typing isn't interrupted); add or remove as needed.
      while (photoBlocks.children.length > photos.length) photoBlocks.lastElementChild!.remove();
      photos.forEach((photo, i) => {
        let block = photoBlocks.children[i] as HTMLElement | undefined;
        if (!block) {
          block = el("div", "photo-block");
          const label = el("label");
          const hint = el("p", "hint");
          const notices = el("div", "photo-notices");
          notices.setAttribute("role", "status");
          const box = el("textarea");
          box.rows = 4; // OCR text is often several lines
          box.maxLength = PHOTO_TEXT_MAX_CHARS; // strict limit on photo text (src/photo-text.ts)
          box.placeholder = "e.g. a sign, name tag or jersey in the photo";
          box.addEventListener("input", () => actions.onImageTextInput(box.value, Number(block!.dataset.index)));
          block.append(label, hint, notices, box);
          photoBlocks.append(block);
        }
        const [label, hint, notices, box] = [...block.children] as [HTMLLabelElement, HTMLElement, HTMLElement, HTMLTextAreaElement];
        block.dataset.index = String(photo.index);
        box.id = `sl-image-text-${photo.index}`;
        label.htmlFor = box.id;
        label.textContent = photo.label;
        hint.textContent = photo.hint;
        // textContent only: notices quote OCR words, which come from the photo.
        notices.replaceChildren(
          ...photo.notices.map((n) => el("p", n.kind === "poor" ? "banner banner-incomplete photo-poor" : "banner banner-stale photo-warning", n.text)),
        );
        // Never overwrite a box the user is typing in.
        const typing = shadow.activeElement === box; // closed shadow root: use our own reference
        if (!typing && box.value !== photo.text) box.value = photo.text;
      });
    },
    setBackendStatus(status) {
      statusPill.dataset.state = status.state;
      statusPill.textContent = status.label;
      statusPill.title = status.title;
    },
    setBusy(busy) {
      checkButton.disabled = busy;
      continueButton.disabled = busy;
    },
    setMessage(text: string, kind: MessageKind = "info") {
      message.textContent = text;
      message.dataset.kind = kind;
    },
    showResult(result: AnalyzeResponse, sources: TextSource[]) {
      // Apply buttons call back into main.ts, which re-checks the edit
      // against the caption that is on the page at that moment.
      renderResults(resultEls, result, sources, (edit) => actions.onApplyEdit(edit));
      renderVerdict(verdictEls, result, sources); // score + stamp + advice, same as the popup
      hasResult = true;
      updateContinueLabel();
    },
    clearResult() {
      results.hidden = true;
      hasResult = false;
      updateContinueLabel();
    },
    setStale(value) {
      stale = value;
      staleBanner.hidden = !value;
      results.classList.toggle("is-stale", value);
      updateContinueLabel();
    },
    setShareReady(ready) {
      shareReady.hidden = !ready;
      isShareReady = ready;
      updateLauncherText();
    },
    setSavePrompt(state) {
      saveCard.hidden = state.kind === "hidden";
      saveButtons.hidden = state.kind !== "ask";
      saveCard.dataset.state = state.kind === "done" ? (state.ok ? "ok" : "error") : state.kind;
      saveText.textContent =
        state.kind === "ask"
          ? "Posted. Save it to your CheckYo'Self history? Later checks can then spot what your posts reveal together. Only the caption and photo text are saved; delete it any time."
          : state.kind === "saving"
            ? "Saving…"
            : state.kind === "done"
              ? state.text
              : "";
    },
    setCompare(view: CompareView) {
      comparePanel.hidden = !view.open;
      compareToggle.setAttribute("aria-expanded", String(view.open));
      compareToggle.textContent = view.open ? "− Don't compare with past posts" : "+ Compare with my past posts (optional)";
      compareStatus.textContent = view.status;
      compareStatus.dataset.kind = view.error ? "error" : "info";
      profileRow.hidden = view.profile === null;
      if (view.profile) {
        profileLabel.textContent = view.profile.label;
        profileBox.checked = view.profile.checked;
      }
      // textContent only: captions come from the user's posts.
      compareList.replaceChildren(
        ...view.items.map((item) => {
          const li = el("li");
          const label = el("label");
          const box = el("input");
          box.type = "checkbox";
          box.checked = item.checked;
          box.addEventListener("change", () => actions.onComparePick(item.postId, box.checked));
          label.append(box, el("span", "compare-caption", item.caption || "(no caption)"), el("span", "compare-meta", item.meta));
          li.append(label);
          return li;
        }),
      );
    },
    setLauncherPrompt(text) {
      launcherPrompt = text;
      updateLauncherText();
    },
    destroy() {
      host.remove();
    },
  };
}
