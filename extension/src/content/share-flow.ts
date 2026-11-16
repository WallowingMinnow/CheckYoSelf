// The rules for checking a post before it is shared on Instagram.
//
// This file has NO DOM and NO Chrome calls, so every rule can be tested in
// Node (see test/share-flow.test.ts). The Instagram page code (main.ts) tells
// this class what happened ("the draft changed", "the user clicked Share") and
// asks it what to do.
//
// SAFETY RULES enforced here:
//  1. Only the newest check counts. A reply for an older request, or for a
//     draft that has changed since, is ignored ("outdated").
//  2. Any change to the caption, the photo text or the photo itself makes the
//     current result stale.
//  3. The extension never clicks Share itself. When the user chooses to
//     continue, the NEXT real click on Share is let through, once. That
//     permission ends after one use, after a draft change, or after a timeout.
//  4. While a share is in progress, further Share clicks are blocked so the
//     post cannot be submitted twice.
//  5. "Published" is only reported when the page confirmed it. A closed dialog
//     without confirmation is "unknown", never "published".
import type { AnalyzeResponse, TextSource } from "../../../shared/contract";

/** How long the "let the next Share click through" permission lasts. */
export const SHARE_PERMISSION_MS = 60_000;

/** How long we wait for Instagram to confirm or reject a share. */
export const PUBLISH_TIMEOUT_MS = 90_000;

export type PublishOutcome = "published" | "failed" | "cancelled" | "unknown";

/** What to do with a click on Instagram's Share button. */
export type ShareDecision =
  | "allow"      // the user already chose to continue: let this click through
  | "intercept"  // stop the click and show our choice (check / back / continue)
  | "block";     // a share is already in progress: stop the click, show nothing new

/** What happened to an analysis reply. */
export type ReplyStatus = "accepted" | "outdated";

/**
 * A text key for everything that affects the analysis: the text of every
 * source AND which photo is selected. Two drafts with the same key would get
 * the same analysis. (The photo key matters even when OCR found no text: a
 * different photo is a different post.)
 */
export function draftKey(sources: TextSource[], imageKey: string | null): string {
  return JSON.stringify([imageKey ?? "", sources.map((s) => [s.id, s.text])]);
}

export class ShareFlow {
  /** Key of the draft currently on screen, or null when no composer is open. */
  private currentKey: string | null = null;

  /** The check that is waiting for a reply, if any. */
  private pending: { requestId: number; key: string } | null = null;
  private nextRequestId = 1;

  /** The last accepted result and the draft key it was about. */
  private checked: { key: string; result: AnalyzeResponse } | null = null;

  /** Time (ms) until which the next Share click is allowed. 0 = not allowed. */
  private shareAllowedUntil = 0;

  /** True between a Share click we let through and Instagram's answer. */
  private publishing = false;
  private publishingSince = 0;

  // -------------------------------------------------------------------------
  // Draft changes
  // -------------------------------------------------------------------------

  /**
   * Call on every change to the caption, photo text or photo.
   * Returns true if this change made a shown result stale.
   */
  updateDraft(key: string): boolean {
    if (key === this.currentKey) return false;
    const wasCurrent = this.hasCurrentResult();
    this.currentKey = key;
    // The user is no longer continuing with the draft they decided about.
    this.shareAllowedUntil = 0;
    return wasCurrent && !this.hasCurrentResult();
  }

  /** The composer closed (or left the caption step): forget everything except a running share. */
  composerClosed(): void {
    this.currentKey = null;
    this.pending = null;
    this.checked = null;
    this.shareAllowedUntil = 0;
  }

  // -------------------------------------------------------------------------
  // Analysis requests and replies
  // -------------------------------------------------------------------------

  /**
   * Start a check of the current draft. Returns the request id to send, or
   * null if there is nothing to check or the same draft is already being
   * checked (no duplicate requests).
   */
  startCheck(): number | null {
    if (this.currentKey === null) return null;
    if (this.pending && this.pending.key === this.currentKey) return null;
    const requestId = this.nextRequestId++;
    this.pending = { requestId, key: this.currentKey };
    return requestId;
  }

  isChecking(): boolean {
    return this.pending !== null && this.pending.key === this.currentKey;
  }

  /** A reply arrived. Only the newest request for the draft still on screen is accepted. */
  receiveResult(requestId: number, result: AnalyzeResponse): ReplyStatus {
    if (!this.isNewestForCurrentDraft(requestId)) return "outdated";
    this.checked = { key: this.pending!.key, result };
    this.pending = null;
    return "accepted";
  }

  /** An error arrived. Same rule: errors for old requests are ignored. */
  receiveError(requestId: number): ReplyStatus {
    if (!this.isNewestForCurrentDraft(requestId)) return "outdated";
    this.pending = null;
    return "accepted";
  }

  private isNewestForCurrentDraft(requestId: number): boolean {
    return this.pending !== null && this.pending.requestId === requestId && this.pending.key === this.currentKey;
  }

  /** The last result, or null. Use hasCurrentResult() to know if it still matches the draft. */
  lastResult(): AnalyzeResponse | null {
    return this.checked?.result ?? null;
  }

  /** True only if there is a result AND it is about exactly the draft on screen. */
  hasCurrentResult(): boolean {
    return this.checked !== null && this.checked.key === this.currentKey;
  }

  /**
   * May a suggested edit be applied? Only when the result matches the draft
   * on screen right now. `keyNow` must be read from the page just before
   * applying, so an edit is never applied to text the user has since changed.
   */
  canApplyEdit(keyNow: string): boolean {
    return this.checked !== null && this.checked.key === keyNow && keyNow === this.currentKey;
  }

  // -------------------------------------------------------------------------
  // Share button
  // -------------------------------------------------------------------------

  /** The user clicked Instagram's Share button. Decide what to do with the click. */
  onShareClick(now: number): ShareDecision {
    if (this.publishing) {
      // Don't allow a second submission while the first one is still going.
      if (now - this.publishingSince < PUBLISH_TIMEOUT_MS) return "block";
      this.publishing = false; // Instagram never answered; let the user try again (with our choice first)
    }
    if (this.shareAllowedUntil > 0 && now <= this.shareAllowedUntil) {
      this.shareAllowedUntil = 0; // one use only
      this.publishing = true;
      this.publishingSince = now;
      return "allow";
    }
    this.shareAllowedUntil = 0;
    return "intercept";
  }

  /**
   * The user chose "Continue to Share" (with or without a check). This does
   * NOT share anything: it only lets the user's NEXT click on Share through.
   */
  allowNextShare(now: number): void {
    if (this.currentKey === null || this.publishing) return;
    this.shareAllowedUntil = now + SHARE_PERMISSION_MS;
  }

  /** The user chose "Back to editing", or closed our panel. */
  cancelShare(): void {
    this.shareAllowedUntil = 0;
  }

  isShareAllowed(now: number): boolean {
    return this.shareAllowedUntil > 0 && now <= this.shareAllowedUntil;
  }

  isPublishing(): boolean {
    return this.publishing;
  }

  /**
   * Instagram answered (or the dialog closed). Returns the outcome to report,
   * or null if no share was in progress (nothing to report).
   */
  finishPublishing(outcome: PublishOutcome): PublishOutcome | null {
    if (!this.publishing) return null;
    this.publishing = false;
    return outcome;
  }

  /** The share has been waiting too long for an answer. */
  publishTimedOut(now: number): boolean {
    return this.publishing && now - this.publishingSince >= PUBLISH_TIMEOUT_MS;
  }
}
