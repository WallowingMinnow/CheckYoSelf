// The offscreen page (offscreen.html): runs local OCR for the Instagram tab.
//
// The service worker creates this hidden extension page when a photo needs
// reading (chrome.offscreen, reason WORKERS), because the OCR engine needs a
// page that can start its worker and WebAssembly; a content script can't.
// This page only reads text from the photo it is given and answers with the
// OcrResult. It never calls the backend and never stores the photo.
import { OcrError, readImageText } from "./ocr";
import { parseOcrRunMessage, type OcrRunReply } from "./ocr-relay";

/** The running scan for each tab, so a newer photo cancels the older scan. */
const running = new Map<string, AbortController>();

/** data:image/...;base64,.... -> Blob, decoded here (no network). */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const type = dataUrl.slice(5, dataUrl.indexOf(";")); // "image/png"
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function runJob(jobKey: string, imageDataUrl: string): Promise<OcrRunReply> {
  running.get(jobKey)?.abort(); // only the newest photo from a tab matters
  const control = new AbortController();
  running.set(jobKey, control);
  try {
    const result = await readImageText(dataUrlToBlob(imageDataUrl), 1, { signal: control.signal });
    return { kind: "ocr-result", result };
  } catch (err) {
    if (err instanceof OcrError) return { kind: "ocr-error", code: err.code, message: err.message };
    return { kind: "ocr-error", code: "RECOGNITION_FAILED", message: "The text reader failed unexpectedly." };
  } finally {
    if (running.get(jobKey) === control) running.delete(jobKey);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const parsed = parseOcrRunMessage(message, sender, chrome.runtime.id);
  if (!parsed.ok) return false; // not for this page (e.g. the content script's own messages)
  runJob(parsed.value.jobKey, parsed.value.imageDataUrl).then(sendResponse);
  return true; // answer later, when the scan is done
});
