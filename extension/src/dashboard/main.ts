// Entry point of the dashboard page (dashboard.html, built to dist/dashboard.js).
// Open it from chrome://extensions -> CheckYo'Self -> Details -> Extension options,
// or at chrome-extension://<extension id>/dashboard.html.
//
// It shows either the FICTIONAL sample report or "My checks": posts the user
// analyzes here, in one of two ways:
//  - Offline: keyword rules run in this page (offline.ts). No backend, no AI.
//  - Backend: sent to the local backend with the same api.ts functions the
//    popup uses (only text).
// Checks are kept in memory only: closing the tab forgets them.
// This page does not read photos or run OCR.
import type { AnalyzeResponse, TextSource } from "../../../shared/contract";
import { analyzeDraft, checkHealth, describeBackendStatus, hashSources } from "../api";
import { icon } from "./icons";
import { analyzeOffline, OFFLINE_EXAMPLES, type EarlierPost } from "./offline";
import { buildReport, type AnalyzedPost, type DashboardReport } from "./report";
import { SAMPLE_POSTS } from "./sample-data";
import {
  renderActions,
  renderCrossPost,
  renderEvidence,
  renderOverview,
  renderPosts,
  type ReportKind,
  type ViewActions,
  type ViewName,
} from "./view";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in dashboard.html`);
  return node as T;
}

// --- Page elements ----------------------------------------------------------
const views: Record<ViewName, HTMLElement> = {
  overview: byId("view-overview"),
  "cross-post": byId("view-cross-post"),
  posts: byId("view-posts"),
  actions: byId("view-actions"),
};
const tabs = [...document.querySelectorAll<HTMLAnchorElement>(".tab")];
const sampleButton = byId<HTMLButtonElement>("show-sample");
const liveButton = byId<HTMLButtonElement>("show-live");
const liveCount = byId<HTMLSpanElement>("live-count");
const datasetNote = byId<HTMLParagraphElement>("dataset-note");
const rescanButton = byId<HTMLButtonElement>("rescan");
const openAnalyzeButton = byId<HTMLButtonElement>("open-analyze");
const toast = byId<HTMLParagraphElement>("toast");
const evidenceDialog = byId<HTMLDialogElement>("evidence-dialog");
const analyzeDialog = byId<HTMLDialogElement>("analyze-dialog");
const analyzeForm = byId<HTMLFormElement>("analyze-form");
const analyzeName = byId<HTMLInputElement>("analyze-name");
const analyzeCaption = byId<HTMLTextAreaElement>("analyze-caption");
const analyzeImageText = byId<HTMLTextAreaElement>("analyze-image-text");
const analyzeSubmit = byId<HTMLButtonElement>("analyze-submit");
const analyzeMessage = byId<HTMLParagraphElement>("analyze-message");
const analyzeFinePrint = byId<HTMLParagraphElement>("analyze-fine-print");
const backendOptionSub = byId<HTMLSpanElement>("engine-backend-sub");
const fillExampleButton = byId<HTMLButtonElement>("fill-example");
const engineRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="engine"]')];
const offlineRadio = engineRadios.find((r) => r.value === "offline")!;
const backendRadio = engineRadios.find((r) => r.value === "backend")!;

// --- State -----------------------------------------------------------------
/** Posts the user analyzed in this tab. Memory only; never saved. */
const liveChecks: AnalyzedPost[] = [];
let kind: ReportKind = "sample";
let currentView: ViewName = "overview";
let report: DashboardReport = buildReport(SAMPLE_POSTS);
let busy = false;
/** Result of the last /api/health call. */
let backendOnline = false;
/** Which fictional example "Fill a fictional example" uses next. */
let exampleIndex = 0;

const actions: ViewActions = {
  openEvidence,
  openAnalyze,
  goTo: (view) => {
    location.hash = view;
  },
};

// --- Drawing ---------------------------------------------------------------
function render() {
  report = buildReport(kind === "sample" ? SAMPLE_POSTS : liveChecks);
  renderOverview(views.overview, report, kind, actions);
  renderCrossPost(views["cross-post"], report, kind, actions);
  renderPosts(views.posts, report, actions);
  renderActions(views.actions, report, actions);

  sampleButton.setAttribute("aria-pressed", String(kind === "sample"));
  liveButton.setAttribute("aria-pressed", String(kind === "live"));
  liveCount.textContent = String(liveChecks.length);
  datasetNote.textContent =
    kind === "sample"
      ? "Fictional posts with hand-written results, to show how a report looks."
      : "Your checks from this tab. They are gone when you close it.";
  rescanButton.hidden = kind === "sample" || liveChecks.length === 0;
}

function showView(view: ViewName) {
  currentView = view;
  for (const [name, node] of Object.entries(views) as [ViewName, HTMLElement][]) node.hidden = name !== view;
  for (const tab of tabs) {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  // Re-draw so the view's animations play when you switch to it.
  render();
  window.scrollTo({ top: 0 });
}

function viewFromHash(): ViewName {
  const name = location.hash.slice(1);
  return name in views ? (name as ViewName) : "overview";
}

let toastTimer: number | undefined;
function showToast(text: string, kindOfToast: "info" | "error" = "info") {
  toast.textContent = text;
  toast.dataset.kind = kindOfToast;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 5000);
}

// --- Evidence --------------------------------------------------------------
function openEvidence(findingKey: string) {
  const rf = report.findings.find((f) => f.key === findingKey);
  if (!rf) return;
  renderEvidence(byId("evidence-title"), byId("evidence-body"), rf, report);
  evidenceDialog.showModal();
}

// --- Analyze a post --------------------------------------------------------
function openAnalyze() {
  analyzeMessage.textContent = "";
  updateEngineChoice();
  analyzeDialog.showModal();
  analyzeCaption.focus();
  // The backend may have started or stopped since the page loaded.
  void showBackendStatus();
}

function selectedEngine(): "offline" | "backend" {
  return backendRadio.checked ? "backend" : "offline";
}

/** Backend option only when the backend answers; otherwise offline is used. */
function updateEngineChoice() {
  backendRadio.disabled = !backendOnline;
  backendOptionSub.textContent = backendOnline
    ? "Analysis through your local backend (AI if Databricks is connected)."
    : "Not reachable right now. Start it with `npm run dev` in backend/.";
  if (!backendOnline) offlineRadio.checked = true;
  analyzeFinePrint.textContent =
    selectedEngine() === "offline"
      ? "Offline: checked by keyword rules in this page. Nothing is sent anywhere, and no AI is used."
      : "Only this text is sent to your local backend.";
  analyzeFinePrint.textContent += " Results stay in this tab and are gone when you close it.";
}

function fillExample() {
  const example = OFFLINE_EXAMPLES[exampleIndex % OFFLINE_EXAMPLES.length];
  exampleIndex++;
  analyzeName.value = example.name;
  analyzeCaption.value = example.caption;
  analyzeImageText.value = example.imageText;
}

/** The checks before position `index`, as earlier posts for offline mode. */
function earlierPosts(index: number): EarlierPost[] {
  return liveChecks.slice(0, index).map((check) => ({
    historyId: check.historyPostId ?? check.id,
    text: check.sources.map((s) => s.text).join("\n"),
    date: check.date,
  }));
}

/** Runs one check. `index` = its position in liveChecks (earlier checks come before it). */
async function runCheck(engine: "offline" | "backend", sources: TextSource[], index: number): Promise<AnalyzeResponse> {
  const draftHash = await hashSources(sources);
  if (engine === "offline") return analyzeOffline(sources, earlierPosts(index), draftHash);
  return analyzeDraft(sources, draftHash);
}

function collectSources(): TextSource[] {
  const sources: TextSource[] = [{ id: "caption", type: "caption", text: analyzeCaption.value }];
  if (analyzeImageText.value.trim()) {
    sources.push({ id: "image_text:1", type: "image_text", text: analyzeImageText.value });
  }
  return sources;
}

const TONES: AnalyzedPost["tone"][] = ["blue", "violet", "teal", "amber"];

async function submitAnalyze(event: SubmitEvent) {
  event.preventDefault();
  if (busy) return;
  const sources = collectSources();
  if (!sources.some((s) => s.text.trim())) {
    analyzeMessage.textContent = "Write a caption first.";
    analyzeMessage.dataset.kind = "error";
    return;
  }
  busy = true;
  analyzeSubmit.disabled = true;
  analyzeMessage.dataset.kind = "info";
  analyzeMessage.textContent = "Analyzing…";
  const engine = selectedEngine();
  try {
    const result = await runCheck(engine, sources, liveChecks.length);
    const n = liveChecks.length + 1;
    const caption = analyzeCaption.value.trim();
    liveChecks.push({
      id: `check-${n}`,
      // Later offline checks point back to this one as "history:check-<n>".
      historyPostId: `check-${n}`,
      title: analyzeName.value.trim() || (caption ? shorten(caption, 32) : `Check ${n}`),
      date: result.analyzedAt,
      sources,
      result,
      tone: TONES[(n - 1) % TONES.length],
      engine,
    });
    analyzeForm.reset();
    analyzeDialog.close();
    kind = "live";
    showView("posts");
    showToast(
      result.droppedFindings > 0
        ? "Check incomplete: some warnings could not be verified."
        : `Analyzed. ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}.`,
      result.droppedFindings > 0 ? "error" : "info",
    );
  } catch (err) {
    analyzeMessage.dataset.kind = "error";
    analyzeMessage.textContent = (err as Error).message;
  } finally {
    busy = false;
    analyzeSubmit.disabled = false;
    showBackendStatus();
  }
}

function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** Re-runs every check in "My checks" with the same text. */
async function rescan() {
  if (busy || liveChecks.length === 0) return;
  busy = true;
  rescanButton.disabled = true;
  let failed = 0;
  try {
    for (const [i, check] of liveChecks.entries()) {
      showToast(`Rescanning ${i + 1} of ${liveChecks.length}…`);
      try {
        // Same way as the first time. Offline checks are compared with the checks before them again.
        check.result = await runCheck(check.engine ?? "backend", check.sources, i);
      } catch {
        failed++;
      }
    }
  } finally {
    busy = false;
    rescanButton.disabled = false;
  }
  render();
  showToast(
    failed ? `Rescan finished, but ${failed} check${failed === 1 ? "" : "s"} failed. Is the backend running?` : "Rescan complete.",
    failed ? "error" : "info",
  );
  showBackendStatus();
}

// --- Backend status --------------------------------------------------------
async function showBackendStatus() {
  const status = byId<HTMLSpanElement>("backend-status");
  const health = await checkHealth();
  backendOnline = health !== null;
  const { state, label, title } = describeBackendStatus(health);
  status.dataset.state = state;
  byId("backend-status-label").textContent = backendOnline ? label : "Backend offline · offline mode available";
  status.title = backendOnline ? title : `${title} You can still analyze posts offline with keyword rules (no AI).`;
  updateEngineChoice();
}

// --- Wiring ----------------------------------------------------------------
byId("brand-mark").append(icon("shield", 18));
byId("profile-avatar").append(icon("user", 16));
openAnalyzeButton.append(icon("plus", 16), document.createTextNode("Analyze a post"));
rescanButton.append(icon("refresh", 16), document.createTextNode("Rescan"));
for (const closeButton of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
  if (closeButton.classList.contains("icon-btn")) closeButton.append(icon("x", 18));
  closeButton.addEventListener("click", () => closeButton.closest("dialog")?.close());
}
// Clicking the dark area around a dialog closes it.
for (const dialog of [evidenceDialog, analyzeDialog]) {
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

sampleButton.addEventListener("click", () => {
  kind = "sample";
  showView(currentView);
});
liveButton.addEventListener("click", () => {
  kind = "live";
  showView(currentView);
});
openAnalyzeButton.addEventListener("click", openAnalyze);
rescanButton.addEventListener("click", rescan);
analyzeForm.addEventListener("submit", submitAnalyze);
fillExampleButton.addEventListener("click", fillExample);
for (const radio of engineRadios) radio.addEventListener("change", updateEngineChoice);
window.addEventListener("hashchange", () => showView(viewFromHash()));

showView(viewFromHash());
showBackendStatus();
