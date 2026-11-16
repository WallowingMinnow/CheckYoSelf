// Runs Tesseract.js on ONE image, entirely inside the extension.
//
// PRIVACY: the image is read and recognized in this browser only. This file
// never calls fetch() on our backend, Databricks, or any model. The only files
// it loads are the OCR engine files bundled inside the extension (dist/ocr/),
// which build.mjs copies there. Nothing is downloaded from the internet.
//
// Only works in a browser page (popup, options page, or later the content
// script's page). The Node tests cover the files it uses (convert.ts,
// control.ts); `npm run check:ocr` runs the real engine on the demo images.
import { createWorker, PSM, type Worker as TesseractWorker } from "tesseract.js";
import { makeProgressReporter, throwIfCancelled, waitFor } from "./control";
import { pageToOcrResult, type RawPage } from "./convert";
import { combineReads, zoomRegions, type Read, type ZoomRegion } from "./scene";
import { OCR_LIMITS, OcrError, type OcrProgress, type OcrResult } from "./types";

// Keep these in sync with package.json and build.mjs (OCR_ASSETS).
export const ENGINE_NAME = "tesseract.js 7.0.0 / eng 4.0.0_best_int";

/** How long we wait before giving up, so a broken engine can't spin forever. */
const LOAD_TIMEOUT_MS = 60_000;
const RECOGNIZE_TIMEOUT_MS = 120_000;

export interface ReadImageOptions {
  /** Called with progress updates. Safe to update the UI from here. */
  onProgress?: (progress: OcrProgress) => void;
  /** Abort this to cancel. readImageText() then throws OcrError("CANCELLED"). */
  signal?: AbortSignal;
  /**
   * Where the bundled OCR files are (worker.min.js, core/, lang/).
   * Default: the extension's own "ocr/" folder (chrome.runtime.getURL("ocr/")).
   * Only change this for the local demo page / testing.
   */
  assetBaseUrl?: string;
}

/** Finds the bundled OCR files. They live in dist/ocr/ (see build.mjs). */
function defaultAssetBaseUrl(): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL("ocr/");
  }
  // Not running as an extension (e.g. the demo page served from dist/):
  // use the "ocr/" folder next to the current page.
  return new URL("ocr/", document.baseURI).href;
}

/**
 * Decodes the image, applies its EXIF rotation (so it's the way the photo
 * looks on screen), and re-encodes it as PNG for Tesseract.
 * Why: Tesseract ignores EXIF rotation. Without this, boxes from a phone photo
 * could be rotated 90° compared to the preview the user sees.
 */
async function prepareImage(image: Blob): Promise<{ png: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image, { imageOrientation: "from-image" });
  } catch {
    throw new OcrError("NOT_AN_IMAGE", "This file couldn't be opened as an image. Try a JPEG or PNG.");
  }

  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) {
      throw new OcrError("NOT_AN_IMAGE", "This image is empty (0 pixels).");
    }
    if (width > OCR_LIMITS.maxImageSide || height > OCR_LIMITS.maxImageSide) {
      throw new OcrError(
        "IMAGE_TOO_LARGE",
        `This image is ${width}x${height} pixels; the limit is ${OCR_LIMITS.maxImageSide} on each side.`,
      );
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new OcrError("RECOGNITION_FAILED", "The browser couldn't prepare the image.");
    context.drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: "image/png" });
    return { png, width, height };
  } finally {
    bitmap.close(); // free the decoded pixels
  }
}

/**
 * An enlarged crop of the prepared photo, for reading small text again
 * (see zoomRegions in scene.ts). Smooth scaling keeps letter edges clean.
 */
async function zoomInto(photo: ImageBitmap, region: ZoomRegion): Promise<Blob> {
  const canvas = new OffscreenCanvas(Math.round(region.width * region.factor), Math.round(region.height * region.factor));
  const context = canvas.getContext("2d");
  if (!context) throw new OcrError("RECOGNITION_FAILED", "The browser couldn't prepare the image.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(photo, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: "image/png" });
}

/** Turns whatever Tesseract threw into an OcrError (without any image text in it). */
function toOcrError(error: unknown, code: "ENGINE_LOAD_FAILED" | "RECOGNITION_FAILED"): OcrError {
  if (error instanceof OcrError) return error;
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  const what = code === "ENGINE_LOAD_FAILED" ? "The text reader couldn't start" : "The text reader failed";
  return new OcrError(code, `${what} (${detail.slice(0, 200)}).`);
}

/**
 * Reads the text in one image, locally.
 *
 * @param image  a File (from <input type="file">) or Blob
 * @param index  1 for the first image of the post, 2 for the second, ...
 *               The result's sourceId is "image_text:<index>".
 * @returns      an OcrResult. status "no_text" means the scan WORKED and found
 *               nothing. Any failure throws an OcrError instead.
 */
export async function readImageText(image: Blob, index: number, options: ReadImageOptions = {}): Promise<OcrResult> {
  const { onProgress, signal } = options;
  let finished = false; // set when readImageText() is done, successfully or not
  const report = makeProgressReporter(onProgress, signal, () => finished);

  throwIfCancelled(signal);
  if (!(image instanceof Blob)) {
    throw new OcrError("NOT_AN_IMAGE", "No image file was given.");
  }
  if (image.size === 0) throw new OcrError("NOT_AN_IMAGE", "This file is empty.");
  if (image.size > OCR_LIMITS.maxImageBytes) {
    const mb = Math.round(OCR_LIMITS.maxImageBytes / (1024 * 1024));
    throw new OcrError("IMAGE_TOO_LARGE", `This image is bigger than ${mb} MB.`);
  }

  // 1. Decode the image here in the browser.
  report("preparing_image", 0);
  const prepared = await waitFor(prepareImage(image), signal, LOAD_TIMEOUT_MS, () =>
    new OcrError("NOT_AN_IMAGE", "Opening the image took too long."));
  report("preparing_image", 1);
  throwIfCancelled(signal);

  // 2. Start the engine from the bundled files.
  const base = (options.assetBaseUrl ?? defaultAssetBaseUrl()).replace(/\/?$/, "/");
  let worker: TesseractWorker | null = null;
  // `crashed` rejects as soon as the engine reports an error or its worker dies.
  // We race it against loading and recognizing so a failure is reported at once.
  let workerCrashed: ((error: unknown) => void) | null = null;
  const crashed = new Promise<never>((_, reject) => { workerCrashed = reject; });
  crashed.catch(() => {}); // only matters if someone is waiting on it

  // Progress of "recognizing": the two whole-photo reads are 0-35% and 35-70%, zoomed crops (if any) 70-100%.
  let readSpan: [number, number] = [0, 0.7];

  try {
    report("loading_engine", 0);
    const starting = createWorker("eng", 1 /* OEM.LSTM_ONLY, matches the *-lstm cores we bundle */, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core/`,
      langPath: `${base}lang/`,
      gzip: true,
      workerBlobURL: false,  // extension pages may not run blob: scripts
      cacheMethod: "none",   // don't keep a copy of the language file in IndexedDB
      logger: (m) => {
        if (m.status === "recognizing text") report("recognizing", readSpan[0] + (readSpan[1] - readSpan[0]) * m.progress);
        else report("loading_engine", m.progress);
      },
      // Called when any engine job fails. Without this, Tesseract.js throws the
      // error as an uncaught exception. We also need it because createWorker()
      // never settles if the LANGUAGE FILE fails to load (it swallows that
      // error), which would leave the scan stuck until the timeout.
      errorHandler: (error: unknown) => workerCrashed?.(error),
    }, {
      // Tesseract writes status notes ("Estimating resolution as 242", "Detected
      // 4 diacritics") to its error output, which Chrome lists as extension
      // "Errors". They're harmless; send them nowhere. (Init-only setting;
      // a real Tesseract variable that Tesseract.js's types don't list.)
      debug_file: "/dev/null",
    } as Parameters<typeof createWorker>[3]);
    // If we gave up (cancel or timeout) before the engine finished starting,
    // stop it as soon as it does start.
    starting.then((w) => { if (finished) void w.terminate(); }, () => {});

    try {
      worker = await waitFor(Promise.race([starting, crashed]), signal, LOAD_TIMEOUT_MS, () =>
        new OcrError("ENGINE_LOAD_FAILED", "The text reader took too long to start."));
    } catch (error) {
      throw toOcrError(error, "ENGINE_LOAD_FAILED");
    }

    // Tesseract.js doesn't notice if its worker dies in the middle of a job,
    // so listen for that ourselves.
    (worker as unknown as { worker: globalThis.Worker }).worker?.addEventListener("error", (event) => {
      workerCrashed?.(new Error(event.message || "worker crashed"));
    });
    report("loading_engine", 1);
    throwIfCancelled(signal);

    // Page layout. Neither of Tesseract's two useful layouts wins on every photo,
    // so the whole photo is read with BOTH and the results are merged (scene.ts):
    //  - SINGLE_BLOCK (Tesseract.js's default, one block of text) reads a small,
    //    clean sign in a busy photo ("WATERS RESIDENCE HALL") that AUTO garbles
    //    into low-confidence pieces;
    //  - AUTO (automatic page layout) reads tilted or scattered text (the
    //    "Maple Street Bakery" sign) that SINGLE_BLOCK misses entirely.
    // Junk from either read (brickwork, windows) is dropped by scene.ts.
    const engine = worker;
    async function setLayout(mode: PSM): Promise<void> {
      try {
        await waitFor(Promise.race([engine.setParameters({ tessedit_pageseg_mode: mode }), crashed]), signal, LOAD_TIMEOUT_MS, () =>
          new OcrError("ENGINE_LOAD_FAILED", "The text reader took too long to start."));
      } catch (error) {
        throw toOcrError(error, "ENGINE_LOAD_FAILED");
      }
    }

    // 3. Recognize. { blocks: true } is required to get words and boxes.
    async function recognize(png: Blob): Promise<RawPage> {
      try {
        const recognizing = engine.recognize(png, {}, { text: true, blocks: true });
        const result = await waitFor(Promise.race([recognizing, crashed]), signal, RECOGNIZE_TIMEOUT_MS, () =>
          new OcrError("RECOGNITION_FAILED", "Reading the text took too long."));
        const page = result.data as RawPage;
        // A broken result must never look like "no text" (same rule as convert.ts).
        if (!page || !Array.isArray(page.blocks)) throw new OcrError("RECOGNITION_FAILED", "The text reader returned no word list.");
        return page;
      } catch (error) {
        throw toOcrError(error, "RECOGNITION_FAILED");
      }
    }
    // Whole photo, both layouts (see above). SINGLE_BLOCK first: combineReads
    // trusts earlier reads, and only adds AUTO's lines and clear words that are new.
    readSpan = [0, 0.35];
    await setLayout(PSM.SINGLE_BLOCK);
    const reads: Read[] = [{ page: await recognize(prepared.png), scale: 1 }];
    readSpan = [0.35, 0.7];
    await setLayout(PSM.AUTO); // also used for the zoomed crops below
    reads.push({ page: await recognize(prepared.png), scale: 1 });
    let combined = combineReads(reads); // only the clearly readable lines (scene.ts)

    // Zoom in on small text (e.g. a sign on a building): read an enlarged crop
    // around it, which finds words the whole-photo read missed.
    const regions = zoomRegions(combined.page, prepared.width, prepared.height);
    if (regions.length > 0) {
      const photo = await createImageBitmap(prepared.png);
      try {
        for (const [i, region] of regions.entries()) {
          throwIfCancelled(signal);
          readSpan = [0.7 + (0.3 * i) / regions.length, 0.7 + (0.3 * (i + 1)) / regions.length];
          const page = await recognize(await zoomInto(photo, region));
          reads.push({ page, scale: region.factor, offset: { x: region.x, y: region.y } });
        }
      } finally {
        photo.close();
      }
      combined = combineReads(reads);
    }
    report("recognizing", 1);

    // 4. Convert. Throws RECOGNITION_FAILED if the output is unusable.
    const result = pageToOcrResult(combined.page, index, prepared.width, prepared.height, ENGINE_NAME);
    return combined.droppedWords > 0 ? { ...result, droppedWords: combined.droppedWords } : result;
  } finally {
    // Always stop the worker: frees memory and stops work after a cancel.
    finished = true;
    const w = worker as TesseractWorker | null;
    if (w) await w.terminate().catch(() => {});
  }
}
