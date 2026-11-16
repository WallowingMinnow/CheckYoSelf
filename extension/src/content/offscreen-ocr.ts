// The real OcrPort for Instagram (see ports.ts): reads the text in the photo
// being posted by handing it to the extension's offscreen OCR page.
//
// The photo goes content script -> service worker -> offscreen page, all
// inside the browser (src/ocr-relay.ts). It is never uploaded, and reading it
// does not send anything for analysis: the text only goes to the backend when
// the user clicks the check button in the panel.
//
// Imports only src/ocr/types (not src/ocr), so the OCR engine itself is not
// bundled into the Instagram content script.
import type { OcrImageRequest, OcrReply } from "../ocr-relay";
import { OcrError, OCR_LIMITS, type OcrResult } from "../ocr/types";
import type { OcrPort } from "../ports";

let nextRequestId = 1;

/** Blob -> data: URL, so it can travel in a Chrome message (which can't carry Blobs). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new OcrError("NOT_AN_IMAGE", "The photo couldn't be read from the page."));
    reader.readAsDataURL(blob);
  });
}

export const offscreenOcr: OcrPort = {
  available: true,

  async readImageText(image: Blob, index: number): Promise<OcrResult> {
    if (!Number.isInteger(index) || index < 1) throw new OcrError("RECOGNITION_FAILED", "Photo number must be 1 or more.");
    if (image.size === 0) throw new OcrError("NOT_AN_IMAGE", "The photo is empty.");
    if (image.size > OCR_LIMITS.maxImageBytes) {
      throw new OcrError("IMAGE_TOO_LARGE", `This photo is bigger than ${Math.round(OCR_LIMITS.maxImageBytes / 1048576)} MB.`);
    }
    const requestId = nextRequestId++;
    const request: OcrImageRequest = { kind: "ocr-image", requestId, imageDataUrl: await blobToDataUrl(image) };

    let reply: OcrReply | undefined;
    try {
      reply = await chrome.runtime.sendMessage(request);
    } catch {
      throw new OcrError("ENGINE_LOAD_FAILED", "CheckYo'Self was reloaded. Refresh this page to read the photo.");
    }
    if (!reply || reply.requestId !== requestId) {
      throw new OcrError("RECOGNITION_FAILED", "The photo reader didn't answer.");
    }
    if (reply.kind === "ocr-error") {
      // "UNAVAILABLE" isn't an OCR engine code; report it as the engine not starting.
      throw new OcrError(reply.code === "UNAVAILABLE" ? "ENGINE_LOAD_FAILED" : reply.code, reply.message);
    }
    return reply.result;
  },
};
