// Popup logic: type a caption, add photo text (typed, or read from a photo
// ON THIS COMPUTER with the local OCR module), send the TEXT to the backend,
// show the findings, and mark them out of date as soon as the draft changes.
// The photo itself is never sent anywhere.
import type {
  AnalyzeResponse,
  ExtensionMessage,
  InstagramDraftReply,
  StoredHistoryPost,
  SuggestedEdit,
  TextSource,
} from "../../shared/contract";
import { analyzeDraft, checkHealth, describeBackendStatus, hashSources } from "./api";
import { historySourcesFor, preselect, suggestionMeta, type Suggestion } from "./compare";
import { applyEditToText } from "./edits";
import { analyzeWithHistory, getPortfolio, listHistory, suggestHistory } from "./history-api";
import { OcrError, readImageText } from "./ocr";
import { describePhotoRead, photoProgressLabel, PHOTO_TEXT_MAX_CHARS, type PhotoReadNotice } from "./photo-text";
import { renderResults, type ResultElements } from "./render";
import { renderVerdict, type VerdictElements } from "./verdict";

const SAMPLE_CAPTION =
  "Back at Lincoln Park Elementary pickup again 🙃 same 3:15 chaos every weekday. " +
  "Then home to Maple St before Sam's soccer at 6pm Tuesdays! Leaving for Cancun Friday for a whole week ✈️";
const SAMPLE_IMAGE_TEXT = "Riverside Youth Soccer, U10 Tigers. Coach Dana 608-555-0142";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in popup.html`);
  return node as T;
}

const captionInput = byId<HTMLTextAreaElement>("caption");
const imageTextInput = byId<HTMLTextAreaElement>("image-text");
const analyzeButton = byId<HTMLButtonElement>("analyze");
const reanalyzeButton = byId<HTMLButtonElement>("reanalyze");
const sampleButton = byId<HTMLButtonElement>("load-sample");
const instagramButton = byId<HTMLButtonElement>("load-instagram");
const message = byId<HTMLParagraphElement>("message");
const statusPill = byId<HTMLSpanElement>("backend-status");
const staleBanner = byId<HTMLDivElement>("stale-banner");
const photoInput = byId<HTMLInputElement>("photo");
const photoCancelButton = byId<HTMLButtonElement>("photo-cancel");
const photoRemoveButton = byId<HTMLButtonElement>("photo-remove");
const photoPreviewWrap = byId<HTMLDivElement>("photo-preview-wrap");
const photoPreview = byId<HTMLImageElement>("photo-preview");
const photoProgress = byId<HTMLProgressElement>("photo-progress");
const photoStatus = byId<HTMLParagraphElement>("photo-status");
const photoNotices = byId<HTMLDivElement>("photo-notices");
const compareToggle = byId<HTMLButtonElement>("compare-toggle");
const comparePanel = byId<HTMLDivElement>("compare-panel");
const compareStatus = byId<HTMLParagraphElement>("compare-status");
const compareList = byId<HTMLUListElement>("compare-list");
const compareRefresh = byId<HTMLButtonElement>("compare-refresh");
const compareProfileRow = byId<HTMLLabelElement>("compare-profile-row");
const compareProfile = byId<HTMLInputElement>("compare-profile");
const compareProfileLabel = byId<HTMLSpanElement>("compare-profile-label");
const resultEls: ResultElements = {
  root: byId("results"),
  summary: byId("summary"),
  markedDraft: byId("marked-draft"),
  findings: byId("findings"),
  meta: byId("meta"),
  mockBanner: byId("mock-banner"),
  incompleteBanner: byId("incomplete-banner"),
};
// Score, LOW/MEDIUM/HIGH stamp and advice cards (display only, see verdict.ts).
const verdictEls: VerdictElements = {
  root: byId("verdict"),
  score: byId("verdict-score"),
  stamp: byId("verdict-stamp"),
  headline: byId("verdict-headline"),
  note: byId("verdict-note"),
  advice: byId("advice"),
  adviceList: byId("advice-list"),
};

/** The last result we showed, plus the exact text it was about. */
let lastResult: AnalyzeResponse | null = null;
let hashTurn = 0;

function setMessage(text: string, kind: "info" | "error" = "info") {
  message.textContent = text;
  message.dataset.kind = kind;
}

/** The draft as TextSources. Only text — never the image itself. */
function collectSources(): TextSource[] {
  const sources: TextSource[] = [{ id: "caption", type: "caption", text: captionInput.value }];
  if (imageTextInput.value.trim()) {
    sources.push({ id: "image_text:1", type: "image_text", text: imageTextInput.value });
  }
  return sources;
}

/** Step 6: if the draft no longer matches the analyzed text, mark results stale. */
async function updateStaleness() {
  if (!lastResult) return;
  const myTurn = ++hashTurn;
  const currentHash = await hashSources(collectSources());
  if (myTurn !== hashTurn) return; // a newer keystroke already started a check
  const stale = currentHash !== lastResult.draftHash;
  staleBanner.hidden = !stale;
  resultEls.root.classList.toggle("is-stale", stale);
}

// ---------------------------------------------------------------------------
// "Add a photo": read its text on this computer (local OCR, src/ocr)
// ---------------------------------------------------------------------------

let currentScan: AbortController | null = null; // the photo being read, if any
let previewUrl: string | null = null;            // local blob: URL for the preview (never uploaded)
let ocrFilledText: string | null = null;         // the text OCR last put in the box
let typedDuringScan = false;                     // the user typed while reading: keep their text

function setPhotoStatus(text: string, kind: "info" | "error" = "info") {
  photoStatus.textContent = text;
  photoStatus.dataset.kind = kind;
}

/** Notices quote words read from the photo, so they are set with textContent only. */
function showPhotoNotices(notices: PhotoReadNotice[]) {
  photoNotices.replaceChildren(
    ...notices.map((n) => {
      const p = document.createElement("p");
      p.className = n.kind === "poor" ? "banner banner-incomplete" : "banner banner-stale";
      p.textContent = n.text;
      return p;
    }),
  );
}

function setImageText(text: string) {
  imageTextInput.value = text;
  imageTextInput.dispatchEvent(new Event("input")); // results may now be stale
}

async function readPhoto(file: File) {
  currentScan?.abort(); // only the newest photo matters
  const scan = new AbortController();
  currentScan = scan;
  typedDuringScan = false;

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  photoPreview.src = previewUrl;
  photoPreviewWrap.hidden = false;
  photoRemoveButton.hidden = false;
  photoCancelButton.hidden = false;
  photoProgress.hidden = false;
  photoProgress.value = 0;
  showPhotoNotices([]);
  setPhotoStatus("Reading the photo on this computer… (nothing is sent yet)");

  try {
    const result = await readImageText(file, 1, {
      signal: scan.signal,
      onProgress: (p) => {
        photoProgress.value = p.fraction;
        setPhotoStatus(photoProgressLabel(p.stage, p.fraction));
      },
    });
    if (currentScan !== scan) return; // a newer photo was picked meanwhile
    const view = describePhotoRead(result);
    showPhotoNotices(view.notices);
    if (typedDuringScan) {
      setPhotoStatus(`${view.hint} You typed the photo text while it was being read, so yours was kept.`);
    } else {
      ocrFilledText = view.text;
      setImageText(view.text);
      setPhotoStatus(view.hint);
    }
  } catch (err) {
    if (currentScan !== scan) return;
    // OCR errors carry a readable message. A failure is never treated as "no text".
    if (err instanceof OcrError && err.code === "CANCELLED") {
      setPhotoStatus("Stopped reading the photo. Type any text you can see in it.");
    } else {
      const reason = err instanceof Error ? ` ${err.message}` : "";
      setPhotoStatus(`Reading the photo failed.${reason} Type any text you can see in it.`, "error");
    }
  } finally {
    if (currentScan === scan) {
      currentScan = null;
      photoCancelButton.hidden = true;
      photoProgress.hidden = true;
    }
  }
}

/** Forget the photo. Its text is cleared too, unless the user has edited it. */
function removePhoto() {
  currentScan?.abort();
  currentScan = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  photoPreview.removeAttribute("src");
  photoPreviewWrap.hidden = true;
  photoRemoveButton.hidden = true;
  photoCancelButton.hidden = true;
  photoProgress.hidden = true;
  photoInput.value = "";
  showPhotoNotices([]);
  setPhotoStatus("");
  if (ocrFilledText !== null && imageTextInput.value === ocrFilledText) setImageText("");
  ocrFilledText = null;
}

// ---------------------------------------------------------------------------
// "Compare with my past posts" (optional; see compare.ts)
// ---------------------------------------------------------------------------

let savedPosts: StoredHistoryPost[] = [];
const comparePicked = new Set<string>();

function isComparing(): boolean {
  return !comparePanel.hidden;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Asks the backend which saved posts look related to the draft (no AI call), and lists them. */
async function loadSuggestions() {
  compareStatus.textContent = "Looking for related past posts…";
  compareStatus.dataset.kind = "info";
  compareList.replaceChildren();
  let suggestions: Suggestion[];
  try {
    savedPosts = (await listHistory()).posts;
    if (savedPosts.length === 0) {
      compareStatus.textContent = "You haven't saved any past posts yet. Import some with the link below, or save posts after you share them on Instagram.";
      comparePicked.clear();
      return;
    }
    suggestions = (await suggestHistory(collectSources().filter((s) => s.text.trim()))).suggestions;
    // The profile, if one was built: offered (ticked) but the user can untick it.
    const profile = await getPortfolio();
    compareProfileRow.hidden = profile.facts.length === 0;
    compareProfileLabel.textContent = `Use my profile: ${profile.facts.length} fact${profile.facts.length === 1 ? "" : "s"} from ${profile.scannedPosts} saved post${profile.scannedPosts === 1 ? "" : "s"} (finds links even without shared words)`;
  } catch (err) {
    compareStatus.textContent = (err as Error).message;
    compareStatus.dataset.kind = "error";
    return;
  }
  comparePicked.clear();
  for (const id of preselect(suggestions)) comparePicked.add(id);
  const byId = new Map(savedPosts.map((p) => [p.postId, p]));
  compareStatus.textContent =
    comparePicked.size > 0
      ? `${comparePicked.size} of your ${savedPosts.length} saved posts look related and are ticked. Untick any you don't want included.`
      : `None of your ${savedPosts.length} saved posts share words with this draft. Tick any you want to include anyway.`;
  compareList.replaceChildren(
    ...suggestions.map((s) => {
      const post = byId.get(s.postId);
      const li = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = comparePicked.has(s.postId);
      box.addEventListener("change", () => {
        if (box.checked) comparePicked.add(s.postId);
        else comparePicked.delete(s.postId);
      });
      const text = document.createElement("span");
      text.className = "compare-caption";
      text.textContent = post?.caption || "(no caption)"; // textContent only: captions are untrusted
      const meta = document.createElement("span");
      meta.className = "compare-meta";
      meta.textContent = suggestionMeta(s, shortDate);
      label.append(box, text, meta);
      li.append(label);
      return li;
    }),
  );
}

function setComparing(open: boolean) {
  comparePanel.hidden = !open;
  compareToggle.setAttribute("aria-expanded", String(open));
  compareToggle.firstChild!.textContent = open ? "− Don't compare with past posts " : "+ Compare with my past posts ";
  if (open) void loadSuggestions();
}

async function analyze() {
  if (currentScan) {
    // Don't send a draft without the photo text the user hasn't seen yet.
    setMessage("Still reading the photo. Check again once its text appears above.", "error");
    return;
  }
  const sources = collectSources();
  if (!sources.some((s) => s.text.trim())) {
    setMessage("Write a caption first.", "error");
    return;
  }

  analyzeButton.disabled = true;
  reanalyzeButton.disabled = true;
  setMessage("Checking your post…");
  try {
    const draftHash = await hashSources(sources);
    const pastIds = isComparing() ? [...comparePicked] : [];
    const useProfile = isComparing() && !compareProfileRow.hidden && compareProfile.checked;
    const result =
      pastIds.length > 0 || useProfile ? await analyzeWithHistory(sources, draftHash, pastIds, useProfile) : await analyzeDraft(sources, draftHash);
    lastResult = result;
    // Show (and highlight) the earlier posts that were used, after the draft.
    const shown = [...sources, ...historySourcesFor(result, savedPosts)];
    renderResults(resultEls, result, shown, applyEdit);
    renderVerdict(verdictEls, result, shown);
    const n = result.findings.length;
    const parts: string[] = [];
    if (result.historyUsed.length) parts.push(`${result.historyUsed.length} past post${result.historyUsed.length === 1 ? "" : "s"}`);
    if (result.portfolioUsed) parts.push(`your profile (${result.portfolioUsed.facts} facts)`);
    const compared = parts.length ? ` Compared with ${parts.join(" and ")}.` : "";
    if (result.droppedFindings > 0) {
      // Some warnings could not be checked, so don't call this "complete".
      setMessage(`Check incomplete: ${n} thing${n === 1 ? "" : "s"} shown, ${result.droppedFindings} not shown.${compared}`, "error");
    } else {
      setMessage((n === 0 ? "Check complete." : `Check complete: ${n} thing${n === 1 ? "" : "s"} to review.`) + compared);
    }
    await updateStaleness(); // the user may have typed while we waited
  } catch (err) {
    setMessage((err as Error).message, "error");
  } finally {
    analyzeButton.disabled = false;
    reanalyzeButton.disabled = false;
    // A Databricks call just succeeded or failed, so the status may have changed.
    showBackendStatus();
  }
}

/** "Apply" on a suggested edit: change the caption, which makes results stale. */
function applyEdit(edit: SuggestedEdit) {
  // Checked again here (not just when drawing the button): the caption may
  // have changed since, and an incomplete edit must never delete text.
  const result = applyEditToText(captionInput.value, edit);
  if (!result.ok) {
    setMessage(result.reason, "error");
    return;
  }
  captionInput.value = result.text;
  captionInput.dispatchEvent(new Event("input"));
  setMessage("Change applied. Check again to see updated results.");
}

/**
 * The pill in the corner. "Databricks connected" is shown ONLY after a real
 * call succeeded; filled-in settings alone show "Databricks not tested yet".
 */
async function showBackendStatus() {
  const health = await checkHealth();
  const { state, label, title } = describeBackendStatus(health);
  statusPill.dataset.state = state;
  statusPill.textContent = label;
  statusPill.title = title;
  if (!health) setMessage("Start the backend: open the backend folder and run `npm run dev`.", "error");
}

/**
 * "Use Instagram draft": copy the caption (and photo text) from the Instagram
 * post being written in the current tab into the boxes above. This is the
 * manual fallback if the check on Instagram's page doesn't appear.
 * It only reads text; it never changes or shares the Instagram post.
 */
async function loadInstagramDraft() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const notFound = "Open the caption step of a new Instagram post in this tab first.";
  if (tab?.id === undefined) {
    setMessage(notFound, "error");
    return;
  }
  let reply: InstagramDraftReply | undefined;
  try {
    const request: ExtensionMessage = { kind: "get-instagram-draft" };
    reply = await chrome.tabs.sendMessage(tab.id, request);
  } catch {
    reply = undefined; // not an Instagram tab, or the page was open before the extension loaded
  }
  if (!reply?.found) {
    setMessage(notFound + " (If it is open, refresh the Instagram page.)", "error");
    return;
  }
  removePhoto(); // the Instagram draft replaces any photo picked here
  captionInput.value = reply.caption;
  imageTextInput.value = reply.imageText;
  captionInput.dispatchEvent(new Event("input"));
  setMessage("Copied your Instagram draft. Changes here don't change the post on Instagram.");
}

captionInput.addEventListener("input", updateStaleness);
imageTextInput.maxLength = PHOTO_TEXT_MAX_CHARS; // same strict limit as OCR text
imageTextInput.addEventListener("input", (event) => {
  if (event.isTrusted && currentScan) typedDuringScan = true; // a real keystroke, not our own update
  updateStaleness();
});
photoInput.addEventListener("change", () => {
  const file = photoInput.files?.[0];
  if (file) void readPhoto(file);
});
photoCancelButton.addEventListener("click", () => currentScan?.abort());
photoRemoveButton.addEventListener("click", removePhoto);
window.addEventListener("pagehide", () => currentScan?.abort()); // popup closed: stop reading
analyzeButton.addEventListener("click", analyze);
compareToggle.addEventListener("click", () => setComparing(comparePanel.hidden));
compareRefresh.addEventListener("click", () => void loadSuggestions());
reanalyzeButton.addEventListener("click", analyze);
sampleButton.addEventListener("click", () => {
  removePhoto(); // the sample has its own photo text
  captionInput.value = SAMPLE_CAPTION;
  imageTextInput.value = SAMPLE_IMAGE_TEXT;
  captionInput.dispatchEvent(new Event("input"));
  captionInput.focus();
});
instagramButton.addEventListener("click", loadInstagramDraft);

showBackendStatus();
