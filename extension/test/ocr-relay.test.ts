// Tests for the in-browser photo relay (src/ocr-relay.ts): Instagram tab ->
// service worker -> offscreen OCR page. Uses a fake OCR page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nonTextProblem, parseExtensionMessage } from "../src/messages";
import {
  handleOcrImageMessage,
  MAX_IMAGE_DATA_URL_LENGTH,
  parseOcrImageRequest,
  parseOcrRunMessage,
  type OcrRunMessage,
  type OcrRunReply,
  type RelaySender,
} from "../src/ocr-relay";
import type { OcrResult } from "../src/ocr/types";

const OUR_ID = "our-extension-id";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const INSTAGRAM_TAB: RelaySender = { id: OUR_ID, url: "https://www.instagram.com/", tab: { id: 42 } };
const WORKER: RelaySender = { id: OUR_ID, url: `chrome-extension://${OUR_ID}/background.js` };

const RESULT: OcrResult = {
  sourceId: "image_text:1", status: "text_found", text: "Coach Dana 608-555-0142", confidence: 88,
  imageWidth: 10, imageHeight: 10, lines: [], words: [], lowConfidenceWordIds: [], engine: "test",
};

/** A fake offscreen page that records the jobs it was given. */
function fakeOcrPage(answer: (m: OcrRunMessage) => Promise<OcrRunReply> = async () => ({ kind: "ocr-result", result: RESULT })) {
  const jobs: OcrRunMessage[] = [];
  return { jobs, deps: { extensionId: OUR_ID, runOcr: async (m: OcrRunMessage) => { jobs.push(m); return answer(m); } } };
}

const request = (imageDataUrl: unknown = PNG, requestId: unknown = 5) => ({ kind: "ocr-image", requestId, imageDataUrl });

// --- who may ask ----------------------------------------------------------------

test("a photo from our Instagram content script is read and the result returned with its requestId", async () => {
  const page = fakeOcrPage();
  const reply = await handleOcrImageMessage(request(), INSTAGRAM_TAB, page.deps);
  assert.deepEqual(reply, { kind: "ocr-result", requestId: 5, result: RESULT });
  assert.deepEqual(page.jobs, [{ kind: "ocr-run", target: "offscreen", jobKey: "tab:42", imageDataUrl: PNG }]);
});

test("photos are refused from other extensions, non-Instagram pages, or senders without a tab", async () => {
  const senders: RelaySender[] = [
    { ...INSTAGRAM_TAB, id: "someone-else" },
    { ...INSTAGRAM_TAB, url: "https://evil.example/" },
    { id: OUR_ID, url: `chrome-extension://${OUR_ID}/popup.html` }, // no tab
  ];
  for (const sender of senders) {
    const page = fakeOcrPage();
    const reply = await handleOcrImageMessage(request(), sender, page.deps);
    assert.equal(reply?.kind, "ocr-error");
    assert.equal(page.jobs.length, 0, "the OCR page must not be asked");
  }
});

test("messages that aren't photo requests are ignored by the relay", async () => {
  const page = fakeOcrPage();
  assert.equal(await handleOcrImageMessage({ kind: "check-draft" }, INSTAGRAM_TAB, page.deps), undefined);
  assert.equal(page.jobs.length, 0);
});

// --- what is accepted --------------------------------------------------------------

test("only PNG/JPEG/WebP/GIF data: URLs of a sane size are accepted", () => {
  assert.equal(parseOcrImageRequest(request()).ok, true);
  for (const bad of [
    "https://scontent.cdninstagram.com/photo.jpg",
    "blob:https://www.instagram.com/123",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/png;base64,not base64!",
    `data:image/png;base64,${"A".repeat(MAX_IMAGE_DATA_URL_LENGTH)}`,
    42,
  ]) {
    assert.equal(parseOcrImageRequest(request(bad)).ok, false, String(bad).slice(0, 40));
  }
  assert.equal(parseOcrImageRequest(request(PNG, 1.5)).ok, false);
});

test("a bad photo is reported as an error without bothering the OCR page", async () => {
  const page = fakeOcrPage();
  const reply = await handleOcrImageMessage(request("blob:https://www.instagram.com/x"), INSTAGRAM_TAB, page.deps);
  assert.equal(reply?.kind, "ocr-error");
  assert.equal(page.jobs.length, 0);
});

test("OCR failures and a missing OCR page come back as errors, never as 'no text'", async () => {
  const failing = fakeOcrPage(async () => ({ kind: "ocr-error", code: "RECOGNITION_FAILED", message: "crashed" }));
  assert.deepEqual(await handleOcrImageMessage(request(), INSTAGRAM_TAB, failing.deps), {
    kind: "ocr-error", requestId: 5, code: "RECOGNITION_FAILED", message: "crashed",
  });
  const missing = fakeOcrPage(async () => { throw new Error("no offscreen document"); });
  const reply = await handleOcrImageMessage(request(), INSTAGRAM_TAB, missing.deps);
  assert.equal(reply?.kind, "ocr-error");
  const silent = fakeOcrPage(async () => undefined as unknown as OcrRunReply);
  assert.equal((await handleOcrImageMessage(request(), INSTAGRAM_TAB, silent.deps))?.kind, "ocr-error");
});

// --- the offscreen page only takes jobs from the service worker ----------------------

test("the OCR page accepts 'ocr-run' only from the service worker", () => {
  const job = { kind: "ocr-run", target: "offscreen", jobKey: "tab:42", imageDataUrl: PNG };
  assert.equal(parseOcrRunMessage(job, WORKER, OUR_ID).ok, true);
  assert.equal(parseOcrRunMessage(job, INSTAGRAM_TAB, OUR_ID).ok, false, "a content script may not run OCR directly");
  assert.equal(parseOcrRunMessage(job, { ...WORKER, id: "other" }, OUR_ID).ok, false);
  assert.equal(parseOcrRunMessage({ ...job, target: "popup" }, WORKER, OUR_ID).ok, false);
  assert.equal(parseOcrRunMessage(request(), WORKER, OUR_ID).ok, false, "content-script requests are not jobs");
});

// --- the photo can never reach the backend --------------------------------------------

test("the backend path still refuses photo data, so a photo can't be sent for analysis", () => {
  assert.notEqual(nonTextProblem(PNG), null);
  assert.equal(parseExtensionMessage(request()).ok, false, "'ocr-image' is not a backend message");
  const sneaky = { kind: "check-draft", requestId: 1, draftHash: "a".repeat(64), sources: [{ id: "image_text:1", type: "image_text", text: PNG }] };
  assert.equal(parseExtensionMessage(sneaky).ok, false);
});
