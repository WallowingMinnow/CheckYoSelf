// Tests for the service worker's message handling (src/worker-handler.ts)
// and the message checks it relies on (src/messages.ts). Uses a fake backend.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, type AnalyzeResponse, type HistoryPost, type TextSource } from "../../shared/contract";
import { nonTextProblem, parseExtensionMessage } from "../src/messages";
import type { HistoryClient, PublishedPostInfo } from "../src/ports";
import { handleWorkerMessage, type SenderInfo, type WorkerDeps } from "../src/worker-handler";

const HASH = "a".repeat(64);
const OUR_ID = "our-extension-id";
const INSTAGRAM_TAB: SenderInfo = { id: OUR_ID, url: "https://www.instagram.com/", tab: {} };
const POPUP: SenderInfo = { id: OUR_ID, url: `chrome-extension://${OUR_ID}/popup.html` };

function response(draftHash = HASH): AnalyzeResponse {
  return {
    contractVersion: CONTRACT_VERSION, requestId: "r", draftHash, mode: "mock", model: null,
    promptVersion: null, analyzedAt: "2026-11-14T12:00:00Z", summary: "", findings: [], droppedFindings: 0,
    historyUsed: [],
  };
}

/** A fake backend and history that record what they were given. */
type Status = Awaited<ReturnType<WorkerDeps["backendStatus"]>>;
const CONNECTED: Status = { state: "databricks-verified", label: "Databricks connected", title: "Last successful call: now." };

function fakes(answer: () => Promise<AnalyzeResponse> = async () => response(), status: () => Promise<Status> = async () => CONNECTED) {
  const analyzed: TextSource[][] = [];
  const recorded: PublishedPostInfo[] = [];
  const saved: HistoryPost[] = [];
  const analyzedWith: Array<{ historyPostIds: string[]; usePortfolio: boolean } | undefined> = [];
  let openedHistory = 0;
  const history: HistoryClient = { async recordPublished(info) { recorded.push(info); } };
  const deps: WorkerDeps = {
    extensionId: OUR_ID,
    analyze: async (sources, _hash, history) => { analyzed.push(sources); analyzedWith.push(history); return answer(); },
    history,
    backendStatus: status,
    saveToHistory: async (post) => { saved.push(post); },
    historySuggestions: async () => ({
      suggestions: [{ postId: "ig_1", publishedAt: "2024-03-09T12:00:00.000Z", sharedWords: 2, caption: "Season opener!" }],
      savedPosts: 3,
      profile: { facts: 4, scannedPosts: 3 },
    }),
    openHistoryPage: async () => { openedHistory++; },
  };
  return { deps, analyzed, recorded, saved, analyzedWith, opened: () => openedHistory };
}

function checkDraft(sources: unknown, requestId = 7) {
  return { kind: "check-draft", requestId, draftHash: HASH, sources };
}

// --- text only ----------------------------------------------------------------

test("image data and image links are not treated as text", () => {
  assert.notEqual(nonTextProblem("data:image/png;base64,AAAA"), null);
  assert.notEqual(nonTextProblem("see blob:https://www.instagram.com/1234-abcd"), null);
  assert.notEqual(nonTextProblem("https://scontent.cdninstagram.com/v/t51/abc.jpg"), null);
  assert.notEqual(nonTextProblem("A".repeat(500)), null);
  assert.equal(nonTextProblem("Back home on Maple St! 🏡"), null);
});

test("extra fields on a source (like an image) are dropped", () => {
  const parsed = parseExtensionMessage(checkDraft([{ id: "caption", type: "caption", text: "hi", image: "x" }]));
  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.value.kind === "check-draft") {
    assert.deepEqual(parsed.value.sources, [{ id: "caption", type: "caption", text: "hi" }]);
  }
});

test("malformed messages are rejected", () => {
  assert.equal(parseExtensionMessage(null).ok, false);
  assert.equal(parseExtensionMessage({ kind: "nope" }).ok, false);
  assert.equal(parseExtensionMessage({ ...checkDraft([]), draftHash: "short" }).ok, false);
  assert.equal(parseExtensionMessage(checkDraft([])).ok, false);
  assert.equal(parseExtensionMessage(checkDraft([{ id: "caption", type: "image_text", text: "x" }])).ok, false);
});

// --- check-draft ----------------------------------------------------------------

test("a check from the Instagram tab is sent to the backend and the request id is echoed", async () => {
  const { deps, analyzed } = fakes();
  const reply = await handleWorkerMessage(checkDraft([{ id: "caption", type: "caption", text: "hi" }]), INSTAGRAM_TAB, deps);
  assert.deepEqual(reply && reply.kind === "check-result" ? reply.requestId : null, 7);
  assert.equal(analyzed.length, 1);
});

test("a check containing image data never reaches the backend", async () => {
  const { deps, analyzed } = fakes();
  const reply = await handleWorkerMessage(
    checkDraft([{ id: "caption", type: "caption", text: "data:image/jpeg;base64,/9j/4AAQ" }]),
    INSTAGRAM_TAB,
    deps,
  );
  assert.equal(reply?.kind, "rejected");
  assert.equal(analyzed.length, 0);
});

test("checks are only accepted from our content script on instagram.com", async () => {
  const { deps, analyzed } = fakes();
  const msg = checkDraft([{ id: "caption", type: "caption", text: "hi" }]);
  assert.equal((await handleWorkerMessage(msg, POPUP, deps))?.kind, "rejected");
  assert.equal((await handleWorkerMessage(msg, { ...INSTAGRAM_TAB, url: "https://evil.example/" }, deps))?.kind, "rejected");
  assert.equal((await handleWorkerMessage(msg, { ...INSTAGRAM_TAB, id: "other-extension" }, deps))?.kind, "rejected");
  assert.equal(analyzed.length, 0);
});

test("a backend answer about different text is not passed on", async () => {
  const { deps } = fakes(async () => response("b".repeat(64)));
  const reply = await handleWorkerMessage(checkDraft([{ id: "caption", type: "caption", text: "hi" }]), INSTAGRAM_TAB, deps);
  assert.equal(reply?.kind, "check-error");
});

test("backend errors come back as check-error with the request id", async () => {
  const { deps } = fakes(async () => { throw new Error("Can't reach the backend."); });
  const reply = await handleWorkerMessage(checkDraft([{ id: "caption", type: "caption", text: "hi" }], 9), INSTAGRAM_TAB, deps);
  assert.deepEqual(reply, { kind: "check-error", requestId: 9, message: "Can't reach the backend." });
});

// --- post-published ---------------------------------------------------------------

test("a confirmed publication is passed to history; nothing else is", async () => {
  const { deps, recorded } = fakes();
  const msg = { kind: "post-published", draftHash: HASH, postId: null, publishedAt: "2026-11-14T12:00:00Z" };
  assert.deepEqual(await handleWorkerMessage(msg, INSTAGRAM_TAB, deps), { kind: "ok" });
  assert.equal(recorded.length, 1);
  assert.equal((await handleWorkerMessage(msg, POPUP, deps))?.kind, "rejected");
  assert.equal(recorded.length, 1);
});

test("the popup's request for the Instagram draft is not answered by the worker", async () => {
  const { deps } = fakes();
  assert.equal(await handleWorkerMessage({ kind: "get-instagram-draft" }, POPUP, deps), undefined);
});

// --- status pill on the Instagram panel ------------------------------------------

test("the Instagram panel gets the same backend status as the popup's pill", async () => {
  const { deps, analyzed } = fakes();
  const reply = await handleWorkerMessage({ kind: "get-backend-status" }, INSTAGRAM_TAB, deps);
  assert.deepEqual(reply, { kind: "backend-status", ...CONNECTED });
  assert.equal(analyzed.length, 0, "asking for the status never analyzes anything");
});

test("if the backend can't be asked, the panel shows it as offline instead of failing", async () => {
  const { deps } = fakes(undefined, async () => { throw new Error("network down"); });
  const reply = await handleWorkerMessage({ kind: "get-backend-status" }, INSTAGRAM_TAB, deps);
  assert.equal((reply as { state?: string }).state, "offline");
  assert.equal((reply as { kind?: string }).kind, "backend-status");
});

test("status is only reported to our content script on instagram.com", async () => {
  const { deps } = fakes();
  const fromOtherSite = await handleWorkerMessage({ kind: "get-backend-status" }, { id: OUR_ID, url: "https://example.com/", tab: {} }, deps);
  assert.equal((fromOtherSite as { kind?: string }).kind, "rejected");
  const fromOtherExtension = await handleWorkerMessage({ kind: "get-backend-status" }, { ...INSTAGRAM_TAB, id: "someone-else" }, deps);
  assert.equal((fromOtherExtension as { kind?: string }).kind, "rejected");
});

// --- "Save to history?" after a confirmed share --------------------------------------

const SAVE = { kind: "save-to-history", caption: "Season opener this weekend!", imageText: "Photo 1: Coach Dana 608-555-0142", publishedAt: "2026-11-15T12:00:00.000Z" };

test("a shared post the user chose to save becomes one published history post (text only)", async () => {
  const { deps, saved } = fakes();
  const reply = await handleWorkerMessage(SAVE, INSTAGRAM_TAB, deps);
  assert.deepEqual(reply, { kind: "history-saved", postId: "posted_" + Date.parse(SAVE.publishedAt) });
  assert.deepEqual(saved, [{ postId: "posted_" + Date.parse(SAVE.publishedAt), status: "published", publishedAt: SAVE.publishedAt, caption: SAVE.caption, imageText: SAVE.imageText }]);
});

test("no photo text: imageText is left out, not saved empty", async () => {
  const { deps, saved } = fakes();
  await handleWorkerMessage({ ...SAVE, imageText: "  " }, INSTAGRAM_TAB, deps);
  assert.equal("imageText" in saved[0], false);
});

test("saving is only accepted from our Instagram content script", async () => {
  const { deps, saved } = fakes();
  assert.equal(((await handleWorkerMessage(SAVE, POPUP, deps)) as { kind: string }).kind, "rejected");
  assert.equal(((await handleWorkerMessage(SAVE, { ...INSTAGRAM_TAB, id: "someone-else" }, deps)) as { kind: string }).kind, "rejected");
  assert.equal(saved.length, 0);
});

test("image data, empty posts and future dates are refused before saving", async () => {
  const { deps, saved } = fakes();
  for (const bad of [
    { ...SAVE, imageText: "data:image/png;base64,AAAA" },
    { ...SAVE, caption: " ", imageText: "" },
    { ...SAVE, publishedAt: "2999-01-01T00:00:00Z" },
    { ...SAVE, caption: 42 },
  ]) {
    assert.equal(((await handleWorkerMessage(bad, INSTAGRAM_TAB, deps)) as { kind: string }).kind, "rejected", JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(saved.length, 0);
});

test("a backend error while saving comes back as history-error", async () => {
  const { deps } = fakes();
  deps.saveToHistory = async () => { throw new Error("History is limited to 500 posts per user."); };
  assert.deepEqual(await handleWorkerMessage(SAVE, INSTAGRAM_TAB, deps), { kind: "history-error", message: "History is limited to 500 posts per user." });
});

// --- "Compare with my past posts" in the Instagram panel ----------------------------

test("a check without Compare is a plain check; with Compare it carries the ticked posts and the profile", async () => {
  const { deps, analyzedWith } = fakes();
  const draft = [{ id: "caption", type: "caption", text: "Go Mitchells!" }];
  await handleWorkerMessage(checkDraft(draft), INSTAGRAM_TAB, deps);
  await handleWorkerMessage({ ...checkDraft(draft), historyPostIds: ["ig_1", "ig_1", "ig_2"], usePortfolio: true }, INSTAGRAM_TAB, deps);
  await handleWorkerMessage({ ...checkDraft(draft), usePortfolio: false, historyPostIds: [] }, INSTAGRAM_TAB, deps);
  assert.deepEqual(analyzedWith, [undefined, { historyPostIds: ["ig_1", "ig_2"], usePortfolio: true }, undefined]);
});

test("bad Compare choices are refused before anything is analyzed", async () => {
  const { deps, analyzed } = fakes();
  const draft = [{ id: "caption", type: "caption", text: "hi" }];
  for (const bad of [{ historyPostIds: "ig_1" }, { historyPostIds: ["bad id!"] }, { historyPostIds: Array.from({ length: 9 }, (_, i) => `p${i}`) }, { usePortfolio: "yes" }]) {
    assert.equal(((await handleWorkerMessage({ ...checkDraft(draft), ...bad }, INSTAGRAM_TAB, deps)) as { kind: string }).kind, "rejected");
  }
  assert.equal(analyzed.length, 0);
});

test("suggestions are only for our Instagram page, and only the draft (never history) can be sent", async () => {
  const { deps } = fakes();
  const draft = [{ id: "caption", type: "caption", text: "Season opener tonight" }];
  const ok = await handleWorkerMessage({ kind: "get-history-suggestions", sources: draft }, INSTAGRAM_TAB, deps);
  assert.equal((ok as { kind: string }).kind, "history-suggestions");
  assert.deepEqual((ok as any).profile, { facts: 4, scannedPosts: 3 });
  const notInstagram = await handleWorkerMessage({ kind: "get-history-suggestions", sources: draft }, POPUP, deps);
  assert.equal((notInstagram as { kind: string }).kind, "rejected");
  const smuggled = await handleWorkerMessage({ kind: "get-history-suggestions", sources: [{ id: "history:x", type: "history", text: "old" }] }, INSTAGRAM_TAB, deps);
  assert.equal((smuggled as { kind: string }).kind, "rejected");
});

test("a failing suggestion lookup comes back as history-error; the history page opens only for our page", async () => {
  const { deps, opened } = fakes();
  deps.historySuggestions = async () => { throw new Error("Can't reach the backend."); };
  assert.deepEqual(await handleWorkerMessage({ kind: "get-history-suggestions", sources: [] }, INSTAGRAM_TAB, deps), { kind: "history-error", message: "Can't reach the backend." });
  await handleWorkerMessage({ kind: "open-history-page" }, INSTAGRAM_TAB, deps);
  await handleWorkerMessage({ kind: "open-history-page" }, { id: OUR_ID, url: "https://example.com/", tab: {} }, deps);
  assert.equal(opened(), 1);
});
