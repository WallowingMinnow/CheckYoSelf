// Converts OCR boxes (in original image pixels) to positions on a smaller
// preview of the image, so highlights line up with the words. No DOM here.
//
// Example: the photo is 4000x3000 and the popup shows it in a 320x240 <img>.
//   const r = imageBoxToPreview(word.box, {
//     imageWidth: result.imageWidth, imageHeight: result.imageHeight,
//     previewWidth: img.clientWidth, previewHeight: img.clientHeight,
//     fit: "contain",               // must match the <img>'s CSS object-fit
//   });
//   if (r) { highlight.style.left = `${r.left}px`; ... }  // highlight is absolutely
//                                                          // positioned over the <img>
//
// The preview must show the SAME image that was scanned (same crop, same
// rotation). See src/ocr/README.md, "Limitations".
import type { OcrBox } from "./types";

/** How the image is drawn inside its preview box (CSS `object-fit`). */
export type PreviewFit = "fill" | "contain" | "cover";

export interface PreviewLayout {
  /** Size of the scanned image: OcrResult.imageWidth / imageHeight. */
  imageWidth: number;
  imageHeight: number;
  /** Size of the preview element in CSS pixels (e.g. img.clientWidth / clientHeight). */
  previewWidth: number;
  previewHeight: number;
  /** "fill" stretches, "contain" letterboxes, "cover" crops. Default "fill" (the CSS default). */
  fit?: PreviewFit;
}

/** A rectangle in preview CSS pixels, measured from the preview's top-left corner. */
export interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Converts one box from image pixels to preview pixels.
 * Returns null if the box is completely outside what the preview shows
 * (possible with fit: "cover", which crops the edges), or if a size is 0.
 * With "cover", a box that is partly cut off is trimmed to the visible part.
 */
export function imageBoxToPreview(box: OcrBox, layout: PreviewLayout): PreviewRect | null {
  const { imageWidth, imageHeight, previewWidth, previewHeight } = layout;
  if (!(imageWidth > 0 && imageHeight > 0 && previewWidth > 0 && previewHeight > 0)) return null;

  const fit = layout.fit ?? "fill";
  let scaleX: number;
  let scaleY: number;
  if (fit === "fill") {
    scaleX = previewWidth / imageWidth;
    scaleY = previewHeight / imageHeight;
  } else {
    // "contain" uses the smaller scale (whole image visible, empty bars);
    // "cover" uses the larger scale (preview filled, edges cut off).
    const pick = fit === "contain" ? Math.min : Math.max;
    scaleX = scaleY = pick(previewWidth / imageWidth, previewHeight / imageHeight);
  }

  // The image is centered in the preview (CSS default object-position: 50% 50%).
  const offsetX = (previewWidth - imageWidth * scaleX) / 2;
  const offsetY = (previewHeight - imageHeight * scaleY) / 2;

  let left = offsetX + box.x0 * scaleX;
  let top = offsetY + box.y0 * scaleY;
  let right = offsetX + box.x1 * scaleX;
  let bottom = offsetY + box.y1 * scaleY;

  // Trim to the visible preview area (only changes anything for "cover").
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(previewWidth, right);
  bottom = Math.min(previewHeight, bottom);
  if (right <= left || bottom <= top) return null;

  return { left, top, width: right - left, height: bottom - top };
}

/** Converts several boxes, dropping the ones that aren't visible. */
export function imageBoxesToPreview(boxes: OcrBox[], layout: PreviewLayout): PreviewRect[] {
  const out: PreviewRect[] = [];
  for (const box of boxes) {
    const rect = imageBoxToPreview(box, layout);
    if (rect) out.push(rect);
  }
  return out;
}
