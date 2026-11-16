// Moves the photo from the Instagram tab to the OCR page, INSIDE THE BROWSER.
//
// Why this exists: the OCR engine (src/ocr) can't start inside a content
// script on instagram.com (see src/ocr/README.md). So the content script
// hands the photo to the service worker, which hands it to an offscreen
// extension page (offscreen.html) that runs readImageText(). Only the OCR
// result (text and word boxes) comes back.
//
//   content script --"ocr-image"--> service worker --"ocr-run"--> offscreen page
//   content script <--OcrReply----- service worker <--OcrReply--- offscreen page
//
// PRIVACY: these messages carry image data, so they are kept OUT of
// shared/contract.ts (which the backend imports and which promises "only
// text" in ExtensionMessage). Nothing here can reach the backend: the handler
// below has no access to api.ts, and the backend path (worker-handler.ts,
// messages.ts) still rejects image data. Running OCR is NOT analysis: the
// photo's text goes to the LLM only when the user clicks the check button.
//
// No DOM and no Chrome calls here, so it can be tested in Node
// (see test/ocr-relay.test.ts).
import type { OcrErrorCode, OcrResult } from "./ocr/types";
import { OCR_LIMITS } from "./ocr/types";

/** content script -> service worker: "read the text in this photo". */
export interface OcrImageRequest {
  kind: "ocr-image";
  requestId: number;
  /** The photo as a data: URL (PNG, JPEG, WebP or GIF). Never leaves the browser. */
  imageDataUrl: string;
}

/** service worker -> offscreen page. `target` keeps other extension pages from acting on it. */
export interface OcrRunMessage {
  kind: "ocr-run";
  target: "offscreen";
  /** One job per tab: a newer photo from the same tab cancels the older scan. */
  jobKey: string;
  imageDataUrl: string;
}

/** The answer, passed back unchanged from the offscreen page to the content script. */
export type OcrReply =
  | { kind: "ocr-result"; requestId: number; result: OcrResult }
  | { kind: "ocr-error"; requestId: number; code: OcrErrorCode | "UNAVAILABLE"; message: string };

/** What the offscreen page sends back for one "ocr-run" (no requestId; the worker adds it). */
export type OcrRunReply =
  | { kind: "ocr-result"; result: OcrResult }
  | { kind: "ocr-error"; code: OcrErrorCode | "UNAVAILABLE"; message: string };

/** Image types the relay accepts (what Instagram's preview and canvases produce). */
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Longest data: URL accepted: the OCR size limit, plus base64's ~4/3 growth and the prefix. */
export const MAX_IMAGE_DATA_URL_LENGTH = Math.ceil((OCR_LIMITS.maxImageBytes * 4) / 3) + 64;

/** The parts of chrome.runtime.MessageSender we look at. */
export interface RelaySender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

const INSTAGRAM_PREFIX = "https://www.instagram.com/";

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Is this one of the relay's messages (so the worker should answer it)? */
export function isOcrImageMessage(raw: unknown): boolean {
  return (raw as { kind?: unknown } | null)?.kind === "ocr-image";
}

/** Checks an "ocr-image" message and returns a clean copy. */
export function parseOcrImageRequest(raw: unknown): Parsed<OcrImageRequest> {
  if (typeof raw !== "object" || raw === null || (raw as { kind?: unknown }).kind !== "ocr-image") {
    return { ok: false, reason: "Not a photo-reading request." };
  }
  const { requestId, imageDataUrl } = raw as Record<string, unknown>;
  if (typeof requestId !== "number" || !Number.isInteger(requestId)) {
    return { ok: false, reason: "requestId must be a whole number." };
  }
  if (typeof imageDataUrl !== "string" || imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return { ok: false, reason: "The photo is missing or too large to read." };
  }
  if (!IMAGE_DATA_URL.test(imageDataUrl)) {
    return { ok: false, reason: "The photo must be a PNG, JPEG, WebP or GIF image." };
  }
  return { ok: true, value: { kind: "ocr-image", requestId, imageDataUrl } };
}

/** Checks an "ocr-run" message on the offscreen page. Only the service worker may send it. */
export function parseOcrRunMessage(raw: unknown, sender: RelaySender, extensionId: string): Parsed<OcrRunMessage> {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "Not a message." };
  const { kind, target, jobKey, imageDataUrl } = raw as Record<string, unknown>;
  if (kind !== "ocr-run" || target !== "offscreen") return { ok: false, reason: "Not for the OCR page." };
  // The service worker is part of this extension and is not in a tab.
  if (sender.id !== extensionId || sender.tab) return { ok: false, reason: "Only the service worker may run OCR." };
  if (typeof jobKey !== "string" || !/^[\w:-]{1,40}$/.test(jobKey)) return { ok: false, reason: "Bad job key." };
  if (typeof imageDataUrl !== "string" || imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH || !IMAGE_DATA_URL.test(imageDataUrl)) {
    return { ok: false, reason: "The photo must be a PNG, JPEG, WebP or GIF image." };
  }
  return { ok: true, value: { kind: "ocr-run", target: "offscreen", jobKey, imageDataUrl } };
}

export interface RelayDeps {
  extensionId: string;
  /** Makes sure the offscreen page exists, sends it the job, and returns its answer. */
  runOcr(message: OcrRunMessage): Promise<OcrRunReply>;
}

/**
 * The service worker's handling of one "ocr-image" message.
 * Returns undefined if the message isn't one (the worker then ignores it).
 */
export async function handleOcrImageMessage(raw: unknown, sender: RelaySender, deps: RelayDeps): Promise<OcrReply | undefined> {
  if (!isOcrImageMessage(raw)) return undefined;
  const requestId = typeof (raw as { requestId?: unknown }).requestId === "number" ? (raw as { requestId: number }).requestId : -1;

  // Only our own content script on instagram.com, running in a tab.
  const tabId = sender.tab?.id;
  if (sender.id !== deps.extensionId || typeof tabId !== "number" || !sender.url?.startsWith(INSTAGRAM_PREFIX)) {
    return { kind: "ocr-error", requestId, code: "UNAVAILABLE", message: "Photos are only read for the Instagram page." };
  }
  const parsed = parseOcrImageRequest(raw);
  if (!parsed.ok) return { kind: "ocr-error", requestId, code: "NOT_AN_IMAGE", message: parsed.reason };

  try {
    const reply = await deps.runOcr({
      kind: "ocr-run",
      target: "offscreen",
      jobKey: `tab:${tabId}`,
      imageDataUrl: parsed.value.imageDataUrl,
    });
    if (!reply || (reply.kind !== "ocr-result" && reply.kind !== "ocr-error")) {
      return { kind: "ocr-error", requestId, code: "UNAVAILABLE", message: "The photo reader didn't answer." };
    }
    return { ...reply, requestId };
  } catch (err) {
    const detail = err instanceof Error ? ` (${err.message.slice(0, 200)})` : "";
    return { kind: "ocr-error", requestId, code: "UNAVAILABLE", message: `The photo reader couldn't start${detail}.` };
  }
}
