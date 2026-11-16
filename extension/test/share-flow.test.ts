// Tests for the rules in src/content/share-flow.ts: stale results, outdated
// replies, the one-time Share permission, and no double sharing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, type AnalyzeResponse, type TextSource } from "../../shared/contract";
import { PUBLISH_TIMEOUT_MS, SHARE_PERMISSION_MS, ShareFlow, draftKey } from "../src/content/share-flow";

function caption(text: string): TextSource[] {
  return [{ id: "caption", type: "caption", text }];
}

function result(summary = "ok"): AnalyzeResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: "r",
    draftHash: "0".repeat(64),
    mode: "mock",
    model: null,
    promptVersion: null,
    analyzedAt: "2026-11-14T12:00:00Z",
    summary,
    findings: [],
    droppedFindings: 0,
    historyUsed: [],
  };
}

const KEY_A = draftKey(caption("hello"), "img:blob:1");
const KEY_B = draftKey(caption("hello!"), "img:blob:1");

// --- draft keys --------------------------------------------------------------

test("the draft key changes when the caption, photo text or photo changes", () => {
  const base = draftKey(caption("hi"), "img:1");
  assert.notEqual(base, draftKey(caption("hi "), "img:1"));
  assert.notEqual(base, draftKey([...caption("hi"), { id: "image_text:1", type: "image_text", text: "x" }], "img:1"));
  assert.notEqual(base, draftKey(caption("hi"), "img:2")); // different photo, same (empty) OCR text
  assert.equal(base, draftKey(caption("hi"), "img:1"));
});

// --- stale and outdated --------------------------------------------------------

test("a result is current until the draft changes", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  const id = flow.startCheck()!;
  assert.equal(flow.receiveResult(id, result()), "accepted");
  assert.equal(flow.hasCurrentResult(), true);
  assert.equal(flow.updateDraft(KEY_B), true, "reports that the result became stale");
  assert.equal(flow.hasCurrentResult(), false);
  // Changing back to the checked text makes it current again.
  flow.updateDraft(KEY_A);
  assert.equal(flow.hasCurrentResult(), true);
});

test("a reply for a draft that changed while waiting is ignored", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  const id = flow.startCheck()!;
  flow.updateDraft(KEY_B);
  assert.equal(flow.receiveResult(id, result()), "outdated");
  assert.equal(flow.lastResult(), null);
});

test("only the newest request is accepted, even if an older reply arrives last", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  const first = flow.startCheck()!;
  flow.updateDraft(KEY_B);
  const second = flow.startCheck()!;
  assert.equal(flow.receiveResult(second, result("new")), "accepted");
  assert.equal(flow.receiveResult(first, result("old")), "outdated");
  assert.equal(flow.lastResult()?.summary, "new");
});

test("errors for old requests are ignored too", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  const first = flow.startCheck()!;
  flow.updateDraft(KEY_B);
  flow.startCheck();
  assert.equal(flow.receiveError(first), "outdated");
});

test("the same draft is not sent twice while a check is running", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  assert.notEqual(flow.startCheck(), null);
  assert.equal(flow.startCheck(), null);
  assert.equal(flow.isChecking(), true);
});

test("there is nothing to check when no composer is open", () => {
  assert.equal(new ShareFlow().startCheck(), null);
});

test("edits are only allowed for the exact draft that was checked", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.receiveResult(flow.startCheck()!, result());
  assert.equal(flow.canApplyEdit(KEY_A), true);
  // The page already shows different text, even if updateDraft hasn't run yet.
  assert.equal(flow.canApplyEdit(KEY_B), false);
  flow.updateDraft(KEY_B);
  assert.equal(flow.canApplyEdit(KEY_A), false);
});

// --- Share button ----------------------------------------------------------------

test("a Share click is intercepted unless the user chose to continue", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  assert.equal(flow.onShareClick(1000), "intercept");
});

test("'continue' lets exactly ONE later Share click through", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.allowNextShare(1000);
  assert.equal(flow.onShareClick(1500), "allow");
  // A second click while that share is running is blocked (no double post).
  assert.equal(flow.onShareClick(1600), "block");
});

test("the permission to share expires", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.allowNextShare(1000);
  assert.equal(flow.onShareClick(1000 + SHARE_PERMISSION_MS + 1), "intercept");
});

test("changing the draft after 'continue' takes the permission away", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.allowNextShare(1000);
  flow.updateDraft(KEY_B);
  assert.equal(flow.onShareClick(1100), "intercept");
});

test("'back to editing' and closing the composer take the permission away", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.allowNextShare(1000);
  flow.cancelShare();
  assert.equal(flow.onShareClick(1100), "intercept");

  flow.allowNextShare(1200);
  flow.composerClosed();
  assert.equal(flow.isShareAllowed(1300), false);
});

test("'continue' does nothing when no composer is open", () => {
  const flow = new ShareFlow();
  flow.allowNextShare(1000);
  assert.equal(flow.isShareAllowed(1000), false);
});

// --- After Share --------------------------------------------------------------------

test("only a share that was let through can be reported, and only once", () => {
  const flow = new ShareFlow();
  assert.equal(flow.finishPublishing("published"), null, "nothing was shared");
  flow.updateDraft(KEY_A);
  flow.allowNextShare(0);
  flow.onShareClick(1);
  assert.equal(flow.finishPublishing("published"), "published");
  assert.equal(flow.finishPublishing("published"), null, "not reported twice");
});

test("after a failed share the next click is intercepted again", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.allowNextShare(0);
  flow.onShareClick(1);
  flow.finishPublishing("failed");
  assert.equal(flow.onShareClick(2), "intercept");
});

test("a share with no answer times out instead of blocking forever", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.allowNextShare(0);
  flow.onShareClick(1);
  assert.equal(flow.publishTimedOut(PUBLISH_TIMEOUT_MS), false);
  assert.equal(flow.publishTimedOut(PUBLISH_TIMEOUT_MS + 1), true);
  assert.equal(flow.onShareClick(PUBLISH_TIMEOUT_MS + 2), "intercept");
});

test("a running share survives the caption step disappearing", () => {
  const flow = new ShareFlow();
  flow.updateDraft(KEY_A);
  flow.allowNextShare(0);
  flow.onShareClick(1);
  flow.composerClosed(); // Instagram replaces the caption step with "Sharing…"
  assert.equal(flow.isPublishing(), true);
  assert.equal(flow.finishPublishing("published"), "published");
});
