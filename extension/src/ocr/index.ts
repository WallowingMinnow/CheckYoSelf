// Public interface of the OCR module. Import from "./ocr" (not the individual
// files) so the inside of this folder can change without breaking callers.
// How to use it from the popup: see src/ocr/README.md.
export { readImageText, ENGINE_NAME, type ReadImageOptions } from "./engine";
export { imageSourceId, toTextSource, type ToSourceResult } from "./convert";
export {
  startReview,
  updateReviewedText,
  isEdited,
  reviewToTextSource,
  reviewHint,
  locateQuote,
  type OcrReview,
  type QuoteLocation,
} from "./review";
export { imageBoxToPreview, imageBoxesToPreview, type PreviewFit, type PreviewLayout, type PreviewRect } from "./coords";
export {
  OcrError,
  LOW_CONFIDENCE,
  OCR_LIMITS,
  type OcrBox,
  type OcrErrorCode,
  type OcrLine,
  type OcrProgress,
  type OcrResult,
  type OcrWord,
} from "./types";
