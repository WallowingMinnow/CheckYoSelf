// Cancel, timeout and progress helpers used by engine.ts. Kept separate (no
// DOM, no Tesseract) so the tricky timing rules can be tested in Node.
import { OcrError, type OcrProgress } from "./types";

/** Throws OcrError("CANCELLED") if the signal was aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OcrError("CANCELLED", "The photo scan was cancelled.");
}

/**
 * Waits for `promise`, but rejects early if the signal is aborted
 * (OcrError "CANCELLED") or the time runs out (the error from `onTimeout`).
 * Whichever happens first wins; later results are ignored.
 */
export function waitFor<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onTimeout: () => OcrError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(new OcrError("CANCELLED", "The photo scan was cancelled.")));
    const timer = setTimeout(() => finish(() => reject(onTimeout())), timeoutMs);

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Makes the function engine.ts calls to report progress. It:
 *  - keeps `fraction` between 0 and 1 (NaN becomes 0), and
 *  - stays silent once the scan is cancelled or `isDone()` is true.
 * The second rule matters: Tesseract's worker can send progress messages after
 * a cancel, and passing them on would overwrite the caller's "cancelled"
 * message with "Starting... 100%". (Bug found while testing the demo page.)
 */
export function makeProgressReporter(
  onProgress: ((progress: OcrProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  isDone: () => boolean,
): (stage: OcrProgress["stage"], fraction: number) => void {
  return (stage, fraction) => {
    if (!onProgress || isDone() || signal?.aborted) return;
    const value = Number(fraction);
    onProgress({ stage, fraction: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0 });
  };
}
