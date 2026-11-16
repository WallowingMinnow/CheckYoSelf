// The history page (history.html): see, delete and import your past posts.
//
// Import reads Instagram's own data export ON THIS COMPUTER (instagram-export.ts),
// lets you tick which posts to save, optionally reads the text in their
// photos locally (OCR), and sends ONLY the ticked posts' captions and photo
// text to the backend (history-api.ts). Photos never leave the computer.
import { HISTORY_LIMITS, type HistoryPost, type StoredHistoryPost } from "../../shared/contract";
import { checkHealth, describeBackendStatus } from "./api";
import { assessHistory, deleteAllHistory, deleteHistoryPost, getPortfolio, importHistory, listHistory, scanPortfolio } from "./history-api";
import { assessmentView, pickPostsToAssess } from "./history-assess";
import { findPostFiles, joinPhotoTexts, jsonFilesSeen, parsePostFiles, resolvePhotoPath, type ExportPost } from "./instagram-export";
import { OcrError, readImageText } from "./ocr";
import { describePhotoRead } from "./photo-text";

/** Most photos read per post (a long carousel would take too long). */
const MAX_PHOTOS_PER_POST = 10;

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in history.html`);
  return node as T;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent only: captions are untrusted
  return node;
}

const statusPill = byId<HTMLSpanElement>("backend-status");
const savedSummary = byId<HTMLParagraphElement>("saved-summary");
const savedList = byId<HTMLOListElement>("saved-list");
const savedMessage = byId<HTMLParagraphElement>("saved-message");
const refreshButton = byId<HTMLButtonElement>("refresh");
const deleteAllButton = byId<HTMLButtonElement>("delete-all");
const folderInput = byId<HTMLInputElement>("export-folder");
const importStatus = byId<HTMLParagraphElement>("import-status");
const picker = byId<HTMLDivElement>("picker");
const importList = byId<HTMLOListElement>("import-list");
const readPhotos = byId<HTMLInputElement>("read-photos");
const importButton = byId<HTMLButtonElement>("import");
const importProgress = byId<HTMLProgressElement>("import-progress");
const importMessage = byId<HTMLParagraphElement>("import-message");
const profileSummary = byId<HTMLParagraphElement>("profile-summary");
const profileBuild = byId<HTMLButtonElement>("profile-build");
const profileProgress = byId<HTMLProgressElement>("profile-progress");
const profileMessage = byId<HTMLParagraphElement>("profile-message");
const profileList = byId<HTMLUListElement>("profile-list");
const assessScope = byId<HTMLParagraphElement>("assess-scope");
const assessButton = byId<HTMLButtonElement>("assess");
const assessMessage = byId<HTMLParagraphElement>("assess-message");
const assessResult = byId<HTMLDivElement>("assess-result");

let saved: StoredHistoryPost[] = [];
let exportPosts: ExportPost[] = [];
let photoFiles = new Map<string, File>(); // export-relative path -> file
const picked = new Set<string>();
let busy = false;

function setText(node: HTMLElement, text: string, kind: "info" | "error" = "info") {
  node.textContent = text;
  node.dataset.kind = kind;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function showBackendStatus() {
  const { state, label, title } = describeBackendStatus(await checkHealth());
  statusPill.dataset.state = state;
  statusPill.textContent = label;
  statusPill.title = title;
}

// --- Saved posts -----------------------------------------------------------------

/** Reloads the saved list. `keepMessage`: leave a just-shown confirmation (e.g. "Deleted…") on screen. */
async function loadSaved(keepMessage = false) {
  try {
    saved = (await listHistory()).posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  } catch (err) {
    savedSummary.textContent = "";
    setText(savedMessage, (err as Error).message, "error");
    return;
  }
  if (!keepMessage) setText(savedMessage, "");
  assessResult.hidden = true; // the saved posts may have changed: an old assessment could cite deleted posts
  savedSummary.textContent =
    saved.length === 0
      ? "No posts saved yet. Import some below."
      : `${saved.length} post${saved.length === 1 ? "" : "s"} saved (limit ${HISTORY_LIMITS.maxPostsPerUser}).`;
  deleteAllButton.disabled = saved.length === 0;
  savedList.replaceChildren(
    ...saved.map((post) => {
      const li = el("li", "hist-item");
      const body = el("div");
      body.append(el("div", "hist-date", shortDate(post.publishedAt)), el("p", "hist-caption", post.caption));
      if (post.imageText) body.append(el("p", "hist-photo-text", `Photo text: ${post.imageText}`));
      const remove = el("button", "secondary small", "Delete");
      remove.type = "button";
      remove.addEventListener("click", () => void removeOne(post.postId));
      li.append(el("span"), body, remove);
      return li;
    }),
  );
  renderPicker(); // "already saved" labels may have changed
  void loadProfile(); // saved posts changed, so the profile summary may have too
  updateAssessScope();
}

// --- What the saved posts reveal together --------------------------------------------

/** Says exactly which posts "Assess" will send (consent), and enables the button. */
function updateAssessScope() {
  const { postIds, left } = pickPostsToAssess(saved);
  assessButton.disabled = busy || postIds.length === 0;
  assessScope.textContent =
    postIds.length === 0
      ? "Save some posts first."
      : `"Assess my saved posts" sends the captions and photo text of your ${postIds.length} most recent saved post${postIds.length === 1 ? "" : "s"}` +
        `${left ? ` (${left} older or very long one${left === 1 ? " is" : "s are"} left out)` : ""} to your CheckYo'Self backend, which uses a cloud AI model to read them together.`;
}

async function assessSaved() {
  const { postIds } = pickPostsToAssess(saved);
  if (postIds.length === 0) return;
  busy = true;
  assessButton.disabled = true;
  assessResult.hidden = true;
  setText(assessMessage, `Reading your ${postIds.length} saved posts together…`);
  try {
    const response = await assessHistory(postIds);
    const view = assessmentView(response, saved, shortDate);
    setText(assessMessage, "");
    const verdict = byId<HTMLDivElement>("assess-verdict");
    verdict.dataset.level = view.verdict.complete ? view.verdict.level : "incomplete";
    byId("assess-score").textContent = String(view.verdict.score);
    byId("assess-stamp").textContent = view.verdict.stamp;
    byId("assess-headline").textContent = view.headline;
    byId("assess-note").textContent = view.note || `Estimate from the findings · ${view.postsAssessed} posts read together`;
    byId("assess-summary").textContent = response.summary;
    byId("assess-list").replaceChildren(
      ...view.findings.map((f) => {
        const li = el("li", `hist-item assess-item${f.crossPost ? " is-cross" : ""}`);
        const tags = el("div", "assess-tags");
        tags.append(el("span", `assess-tag sev-${f.finding.severity}`, `${f.finding.severity} risk`));
        if (f.crossPost) tags.append(el("span", "assess-tag cross", `Combines ${f.postCount} posts`));
        tags.append(el("span", "hist-date", f.finding.category.replace("_", " ")));
        const evidence = el("ul", "assess-evidence");
        for (const e of f.evidence) {
          const item = el("li");
          item.append(el("span", "hist-date", `Post: ${e.postLabel}`), el("span", undefined, `“${e.quote}”`));
          evidence.append(item);
        }
        li.append(tags, el("p", "assess-exposure", f.finding.exposure), evidence);
        if (f.finding.uncertainty) li.append(el("p", "assess-why", `Might be wrong because: ${f.finding.uncertainty}`));
        return li;
      }),
    );
    assessResult.hidden = false;
  } catch (err) {
    setText(assessMessage, `Couldn't assess: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    updateAssessScope();
  }
}

async function removeOne(postId: string) {
  try {
    const r = await deleteHistoryPost(postId);
    setText(savedMessage, `Deleted 1 post${r.deletedInterpretations ? ` and ${r.deletedInterpretations} AI note(s) made from it` : ""}.`);
  } catch (err) {
    setText(savedMessage, (err as Error).message, "error");
  }
  await loadSaved(true);
}

async function removeAll() {
  if (!confirm(`Delete all ${saved.length} saved posts and everything the AI concluded from them? This can't be undone.`)) return;
  try {
    const r = await deleteAllHistory();
    setText(savedMessage, `Deleted ${r.deletedPosts} posts and ${r.deletedInterpretations} AI note(s).`);
  } catch (err) {
    setText(savedMessage, (err as Error).message, "error");
  }
  await loadSaved(true);
}

// --- The profile -------------------------------------------------------------------

async function loadProfile() {
  let profile;
  try {
    profile = await getPortfolio();
  } catch (err) {
    profileSummary.textContent = "";
    setText(profileMessage, (err as Error).message, "error");
    return;
  }
  const left = profile.totalPosts - profile.scannedPosts;
  profileSummary.textContent =
    profile.totalPosts === 0
      ? "Save some posts first; then build your profile from them."
      : `${profile.facts.length} fact${profile.facts.length === 1 ? "" : "s"} from ${profile.scannedPosts} of ${profile.totalPosts} saved posts${left ? ` (${left} not scanned yet)` : " (all scanned)"}.`;
  profileBuild.disabled = busy || profile.totalPosts === 0;
  profileBuild.textContent = left ? `Build / update my profile (${left} to scan)` : "Profile up to date";
  if (!left && profile.totalPosts) profileBuild.disabled = true;
  profileList.replaceChildren(
    ...profile.facts
      .slice()
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((f) => {
        const li = el("li", "hist-item");
        const body = el("div");
        body.append(el("div", "hist-date", `${shortDate(f.publishedAt)} · ${f.severity} · ${f.category.replace("_", " ")}`), el("p", "hist-caption", f.fact), el("p", "hist-meta", `From the post: “${f.quote}”`));
        li.append(el("span"), body, el("span"));
        return li;
      }),
  );
}

/** Scans the saved posts in rounds (a few per request) until all are scanned. */
async function buildProfile() {
  busy = true;
  profileBuild.disabled = true;
  profileProgress.hidden = false;
  profileProgress.value = 0;
  try {
    for (let round = 0; round < 100; round++) {
      setText(profileMessage, "Reading your saved posts with the AI… (a few at a time)");
      const r = await scanPortfolio();
      profileProgress.value = r.totalPosts ? r.scannedPosts / r.totalPosts : 1;
      setText(profileMessage, `Scanned ${r.scannedPosts} of ${r.totalPosts} posts · ${r.facts} facts so far`);
      if (r.remaining === 0 || r.scannedNow === 0) break;
    }
    setText(profileMessage, "Profile ready. Use it from the popup: Compare with my past posts → Use my profile.");
  } catch (err) {
    setText(profileMessage, `Stopped: ${(err as Error).message} Click the button again to continue where it stopped.`, "error");
  } finally {
    busy = false;
    profileProgress.hidden = true;
    await loadProfile();
  }
}

// --- Import from the export ------------------------------------------------------

/** "instagram-me-2026/media/posts/a.jpg" -> "media/posts/a.jpg" (paths in the JSON are relative to the export root). */
function withoutRoot(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.slice(1).join("/");
}

/** The chosen file for a photo "uri" from the JSON (exports are laid out differently: resolvePhotoPath). */
function photoFile(uri: string): File | undefined {
  const path = resolvePhotoPath(uri, [...photoFiles.keys()]);
  return path === undefined ? undefined : photoFiles.get(path);
}

/** Says exactly what was looked at, so a wrong folder is easy to spot. */
function noPostsMessage(folder: string, paths: string[]): string {
  const json = jsonFilesSeen(paths);
  const seen = json.length
    ? `The .json files in it are: ${json.slice(0, 8).join(", ")}${json.length > 8 ? ` and ${json.length - 8} more` : ""}.`
    : "It has no .json files at all.";
  return (
    `No posts found in "${folder}" (${paths.length} file${paths.length === 1 ? "" : "s"} looked at). ${seen} ` +
    "Pick the UNZIPPED export folder: the one that has posts_1.json or posts.json inside (usually in a media or content folder). " +
    "If you picked a .zip, unzip it first (right-click → Extract All)."
  );
}

async function readExportFolder(files: FileList) {
  const all = [...files];
  const byPath = new Map(all.map((f) => [f.webkitRelativePath.replaceAll("\\", "/"), f]));
  const paths = [...byPath.keys()];
  const folder = paths[0]?.split("/")[0] || "the chosen folder";
  const postFiles = findPostFiles(paths);
  if (postFiles.length === 0) {
    picker.hidden = true;
    setText(importStatus, noPostsMessage(folder, paths), "error");
    return;
  }
  const texts = await Promise.all(postFiles.map((p) => byPath.get(p)!.text()));
  const { posts, skipped } = parsePostFiles(texts);
  if (posts.length === 0) {
    picker.hidden = true;
    setText(importStatus, `Read ${postFiles.join(", ")} in "${folder}", but found no published posts in it (${skipped} entries weren't posts, or were drafts).`, "error");
    return;
  }
  exportPosts = posts;
  photoFiles = new Map(all.map((f) => [withoutRoot(f.webkitRelativePath), f]));
  picked.clear();
  setText(
    importStatus,
    `Found ${posts.length} post${posts.length === 1 ? "" : "s"} on this computer${skipped ? ` (${skipped} entries skipped: not posts)` : ""}. Tick the ones to save.`,
  );
  picker.hidden = posts.length === 0;
  renderPicker();
}

function renderPicker() {
  if (exportPosts.length === 0) return;
  const savedIds = new Set(saved.map((p) => p.postId));
  importList.replaceChildren(
    ...exportPosts.map((post) => {
      const li = el("li", `hist-item${picked.has(post.postId) ? " is-picked" : ""}`);
      const box = el("input");
      box.type = "checkbox";
      box.checked = picked.has(post.postId);
      box.setAttribute("aria-label", `Save the post from ${shortDate(post.publishedAt)}`);
      box.addEventListener("change", () => {
        if (box.checked) picked.add(post.postId);
        else picked.delete(post.postId);
        li.classList.toggle("is-picked", box.checked);
        updateImportButton();
      });
      const body = el("div");
      const media = [`${post.photos.length} photo${post.photos.length === 1 ? "" : "s"}`];
      const missing = post.photos.filter((p) => !photoFile(p)).length;
      if (missing) media.push(`${missing} not found in the folder (its text won't be read)`);
      if (post.hasVideo) media.push("video (not read)");
      if (savedIds.has(post.postId)) media.push("already saved; saving again replaces it");
      body.append(el("div", "hist-date", shortDate(post.publishedAt)), el("p", "hist-caption", post.caption), el("p", "hist-meta", media.join(" · ")));
      li.append(box, body, el("span"));
      return li;
    }),
  );
  updateImportButton();
}

function updateImportButton() {
  importButton.disabled = busy || picked.size === 0;
  importButton.textContent = picked.size ? `Save ${picked.size} selected post${picked.size === 1 ? "" : "s"}` : "Save selected posts";
}

/** Reads the text in one post's photos, locally. Unreliable reads are dropped (describePhotoRead). */
async function photoTextFor(post: ExportPost): Promise<string | undefined> {
  const texts: string[] = [];
  for (const [i, path] of post.photos.slice(0, MAX_PHOTOS_PER_POST).entries()) {
    const file = photoFile(path);
    if (!file) continue; // photo not in the chosen folder (shown in the list)
    try {
      const view = describePhotoRead(await readImageText(file, i + 1));
      if (view.text) texts.push(view.text);
    } catch (err) {
      if (err instanceof OcrError && err.code === "CANCELLED") throw err;
      // One unreadable photo shouldn't stop the import; its text is just left out.
    }
  }
  return joinPhotoTexts(texts);
}

async function importPicked() {
  const chosen = exportPosts.filter((p) => picked.has(p.postId));
  if (chosen.length === 0) return;
  busy = true;
  updateImportButton();
  importProgress.hidden = false;
  importProgress.value = 0;
  setText(importMessage, "");

  const ready: HistoryPost[] = [];
  let emptySkipped = 0;
  try {
    for (const [i, post] of chosen.entries()) {
      setText(importMessage, readPhotos.checked && post.photos.length ? `Reading photos on this computer… (${i + 1} of ${chosen.length})` : `Preparing… (${i + 1} of ${chosen.length})`);
      const imageText = readPhotos.checked ? await photoTextFor(post) : undefined;
      if (!post.caption.trim() && !imageText) {
        emptySkipped++; // nothing to check in this post
      } else {
        ready.push({ postId: post.postId, status: "published", publishedAt: post.publishedAt, caption: post.caption, ...(imageText ? { imageText } : {}) });
      }
      importProgress.value = (i + 1) / chosen.length / 2;
    }

    let savedCount = 0;
    for (let start = 0; start < ready.length; start += HISTORY_LIMITS.maxPostsPerImport) {
      const batch = ready.slice(start, start + HISTORY_LIMITS.maxPostsPerImport);
      setText(importMessage, `Saving… (${savedCount} of ${ready.length})`);
      savedCount += (await importHistory(batch)).imported;
      importProgress.value = 0.5 + savedCount / Math.max(1, ready.length) / 2;
    }
    setText(
      importMessage,
      `Saved ${savedCount} post${savedCount === 1 ? "" : "s"}.${emptySkipped ? ` ${emptySkipped} had no caption or readable photo text, so there was nothing to save.` : ""}`,
    );
    picked.clear();
  } catch (err) {
    setText(importMessage, `Stopped: ${(err as Error).message}`, "error");
  } finally {
    busy = false;
    importProgress.hidden = true;
    await loadSaved();
  }
}

refreshButton.addEventListener("click", () => void loadSaved());
deleteAllButton.addEventListener("click", () => void removeAll());
folderInput.addEventListener("change", () => {
  if (folderInput.files?.length) void readExportFolder(folderInput.files);
});
byId<HTMLButtonElement>("select-all").addEventListener("click", () => {
  exportPosts.forEach((p) => picked.add(p.postId));
  renderPicker();
});
byId<HTMLButtonElement>("select-none").addEventListener("click", () => {
  picked.clear();
  renderPicker();
});
importButton.addEventListener("click", () => void importPicked());
profileBuild.addEventListener("click", () => void buildProfile());
assessButton.addEventListener("click", () => void assessSaved());

void showBackendStatus();
void loadSaved();
