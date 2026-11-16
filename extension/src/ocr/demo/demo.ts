// Script for the OCR test page (ocr-demo.html). It is also a working example
// of how the popup can use the OCR module: progress, cancel, review, the
// TextSource to send, and highlights on a resized preview.
//
// This page never calls the backend. "Sample" images are fetched from the
// extension's own files (ocr-demo-images/), not from the internet.
import {
  OcrError,
  imageBoxesToPreview,
  locateQuote,
  readImageText,
  reviewHint,
  reviewToTextSource,
  startReview,
  updateReviewedText,
  type OcrBox,
  type OcrReview,
  type PreviewRect,
} from "../index";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in ocr-demo.html`);
  return node as T;
}

const fileInput = byId<HTMLInputElement>("file");
const progressBar = byId<HTMLProgressElement>("progress");
const statusLine = byId<HTMLDivElement>("status");
const cancelButton = byId<HTMLButtonElement>("cancel");
const preview = byId<HTMLImageElement>("preview");
const previewWrap = byId<HTMLDivElement>("preview-wrap");
const hintLine = byId<HTMLParagraphElement>("hint");
const reviewBox = byId<HTMLTextAreaElement>("review");
const quoteInput = byId<HTMLInputElement>("quote");
const quoteStatus = byId<HTMLSpanElement>("quote-status");
const sourceOutput = byId<HTMLPreElement>("source");

let review: OcrReview | null = null;
let currentScan: AbortController | null = null;
let previewUrl: string | null = null;

const STAGE_LABELS = {
  preparing_image: "Opening the image",
  loading_engine: "Starting the text reader",
  recognizing: "Reading text",
};

function setStatus(text: string, isError = false): void {
  statusLine.textContent = text;
  statusLine.classList.toggle("error", isError);
}

/** Draws boxes over the preview. Uses the module's coordinate conversion. */
function drawBoxes(groups: { boxes: OcrBox[]; className: string }[]): void {
  previewWrap.querySelectorAll(".box").forEach((el) => el.remove());
  if (!review) return;
  for (const group of groups) {
    const rects: PreviewRect[] = imageBoxesToPreview(group.boxes, {
      imageWidth: review.result.imageWidth,
      imageHeight: review.result.imageHeight,
      previewWidth: preview.clientWidth,
      previewHeight: preview.clientHeight,
      fit: "contain", // matches object-fit in ocr-demo.html
    });
    for (const r of rects) {
      const box = document.createElement("div");
      box.className = `box ${group.className}`;
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      previewWrap.appendChild(box);
    }
  }
}

function redraw(): void {
  if (!review) return drawBoxes([]);
  const low = new Set(review.result.lowConfidenceWordIds);
  const groups = [
    { boxes: review.result.words.filter((w) => !low.has(w.id)).map((w) => w.box), className: "" },
    { boxes: review.result.words.filter((w) => low.has(w.id)).map((w) => w.box), className: "low" },
  ];

  quoteStatus.textContent = "";
  const quote = quoteInput.value.trim();
  if (quote) {
    const where = locateQuote(review.result, quote);
    quoteStatus.textContent = where.found
      ? `found (${where.wordIds.join(", ")})`
      : "not found in the text OCR read (no highlight)";
    groups.push({ boxes: where.boxes, className: "quote" });
  }
  drawBoxes(groups);
}

function showSource(): void {
  if (!review) {
    sourceOutput.textContent = "(nothing yet)";
    return;
  }
  const out = reviewToTextSource(review);
  sourceOutput.textContent = out.ok ? JSON.stringify(out.source, null, 2) : `(not sent: ${out.message})`;
}

async function scan(image: Blob): Promise<void> {
  currentScan?.abort(); // only one scan at a time
  const scanControl = new AbortController();
  currentScan = scanControl;

  review = null;
  reviewBox.value = "";
  reviewBox.disabled = true;
  hintLine.textContent = "";
  showSource();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(image); // local blob: URL, never uploaded
  preview.src = previewUrl;
  drawBoxes([]);

  cancelButton.disabled = false;
  progressBar.value = 0;
  const started = performance.now();
  try {
    const result = await readImageText(image, 1, {
      signal: scanControl.signal,
      onProgress: (p) => {
        progressBar.value = p.fraction;
        setStatus(`${STAGE_LABELS[p.stage]}... ${Math.round(p.fraction * 100)}%`);
      },
    });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    review = startReview(result);
    reviewBox.value = review.reviewedText;
    reviewBox.disabled = false;
    hintLine.textContent = reviewHint(result) ?? "";
    setStatus(
      result.status === "no_text"
        ? `Done in ${seconds}s: no text found.`
        : `Done in ${seconds}s: ${result.words.length} words, average confidence ${result.confidence}%. ` +
          `Image ${result.imageWidth}x${result.imageHeight}. ${result.engine}`,
    );
    progressBar.value = 1;
    showSource();
    redraw();
  } catch (error) {
    if (error instanceof OcrError) {
      setStatus(`${error.code}: ${error.message}`, error.code !== "CANCELLED");
    } else {
      setStatus(`Unexpected error: ${String(error)}`, true);
    }
  } finally {
    if (currentScan === scanControl) {
      currentScan = null;
      cancelButton.disabled = true;
    }
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void scan(file);
});

document.querySelectorAll<HTMLButtonElement>("button[data-sample]").forEach((button) => {
  button.addEventListener("click", async () => {
    const response = await fetch(`ocr-demo-images/${button.dataset.sample}`);
    void scan(await response.blob());
  });
});

cancelButton.addEventListener("click", () => currentScan?.abort());

reviewBox.addEventListener("input", () => {
  if (!review) return;
  review = updateReviewedText(review, reviewBox.value);
  showSource();
});

quoteInput.addEventListener("input", redraw);
preview.addEventListener("load", redraw);
window.addEventListener("resize", redraw);
