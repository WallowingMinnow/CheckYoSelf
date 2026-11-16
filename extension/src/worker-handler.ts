// What the service worker does with each message. Kept apart from
// background.ts (which only connects this to Chrome) so it can be tested in
// Node with fake senders and a fake backend (see test/worker-handler.test.ts).
import type {
  AnalyzeResponse,
  BackendStatusReply,
  CheckDraftReply,
  HistoryPost,
  HistorySuggestionsReply,
  SaveToHistoryReply,
  TextSource,
} from "../../shared/contract";
import { parseExtensionMessage } from "./messages";
import type { HistoryClient } from "./ports";

/** The parts of chrome.runtime.MessageSender we look at. */
export interface SenderInfo {
  id?: string;   // extension id of the sender
  url?: string;  // page or extension URL that sent the message
  tab?: unknown; // present for content scripts, absent for the popup
}

export interface WorkerDeps {
  extensionId: string;
  /** `history`: opt-in earlier posts / profile for this check (the panel's Compare section). */
  analyze: (sources: TextSource[], draftHash: string, history?: { historyPostIds: string[]; usePortfolio: boolean }) => Promise<AnalyzeResponse>;
  /** Related saved posts for a draft, plus whether a profile exists (no AI call). */
  historySuggestions: (sources: TextSource[]) => Promise<Omit<Extract<HistorySuggestionsReply, { kind: "history-suggestions" }>, "kind">>;
  openHistoryPage: () => Promise<void>;
  history: HistoryClient;
  /** The status pill's text, from GET /api/health (never calls Databricks). */
  backendStatus: () => Promise<Omit<BackendStatusReply, "kind">>;
  /** Saves one approved, published post to this user's history (text only). */
  saveToHistory: (post: HistoryPost) => Promise<void>;
}

const INSTAGRAM_PREFIX = "https://www.instagram.com/";

/** Only our own content script running on instagram.com may ask for checks. */
function isOurInstagramContentScript(sender: SenderInfo, deps: WorkerDeps): boolean {
  return sender.id === deps.extensionId && !!sender.tab && !!sender.url?.startsWith(INSTAGRAM_PREFIX);
}

/**
 * Handles one message. Returns the reply to send back, or undefined if the
 * message is not for the worker (for example "get-instagram-draft", which
 * the popup sends to the content script).
 */
export async function handleWorkerMessage(
  raw: unknown,
  sender: SenderInfo,
  deps: WorkerDeps,
): Promise<CheckDraftReply | BackendStatusReply | SaveToHistoryReply | HistorySuggestionsReply | { kind: "ok" } | { kind: "rejected"; reason: string } | undefined> {
  const parsed = parseExtensionMessage(raw);
  if (!parsed.ok) {
    // Only answer messages that came from our own extension.
    return sender.id === deps.extensionId ? { kind: "rejected", reason: parsed.reason } : undefined;
  }
  const message = parsed.value;

  switch (message.kind) {
    case "check-draft": {
      if (!isOurInstagramContentScript(sender, deps)) {
        return { kind: "rejected", reason: "Checks are only accepted from the Instagram page." };
      }
      try {
        const history =
          message.historyPostIds?.length || message.usePortfolio
            ? { historyPostIds: message.historyPostIds ?? [], usePortfolio: message.usePortfolio === true }
            : undefined;
        const result = history ? await deps.analyze(message.sources, message.draftHash, history) : await deps.analyze(message.sources, message.draftHash);
        // The backend echoes the hash. If it doesn't match, this result is
        // about some other text and must not be shown.
        if (result.draftHash !== message.draftHash) {
          return { kind: "check-error", requestId: message.requestId, message: "The backend answered about different text. Check again." };
        }
        return { kind: "check-result", requestId: message.requestId, result };
      } catch (err) {
        return { kind: "check-error", requestId: message.requestId, message: (err as Error).message };
      }
    }

    case "post-published": {
      if (!isOurInstagramContentScript(sender, deps)) {
        return { kind: "rejected", reason: "Only the Instagram page can report a published post." };
      }
      try {
        await deps.history.recordPublished({
          draftHash: message.draftHash,
          postId: message.postId,
          publishedAt: message.publishedAt,
        });
      } catch {
        // History is optional; a failure here must not affect the post.
      }
      return { kind: "ok" };
    }

    case "get-backend-status": {
      if (!isOurInstagramContentScript(sender, deps)) {
        return { kind: "rejected", reason: "Status is only reported to the Instagram page." };
      }
      try {
        return { kind: "backend-status", ...(await deps.backendStatus()) };
      } catch {
        return { kind: "backend-status", state: "offline", label: "Backend offline", title: "Couldn't reach the CheckYo'Self backend." };
      }
    }
    case "save-to-history": {
      if (!isOurInstagramContentScript(sender, deps)) {
        return { kind: "rejected", reason: "Only the Instagram page can save a shared post." };
      }
      // Instagram's own post id isn't read (UNVERIFIED where it appears), so
      // the id is the publish time: unique per user, stable for this post.
      const postId = `posted_${Date.parse(message.publishedAt)}`;
      const post: HistoryPost = {
        postId,
        status: "published",
        publishedAt: new Date(message.publishedAt).toISOString(),
        caption: message.caption,
        ...(message.imageText.trim() ? { imageText: message.imageText } : {}),
      };
      try {
        await deps.saveToHistory(post);
        return { kind: "history-saved", postId };
      } catch (err) {
        return { kind: "history-error", message: (err as Error).message };
      }
    }
    case "get-history-suggestions": {
      if (!isOurInstagramContentScript(sender, deps)) {
        return { kind: "rejected", reason: "Only the Instagram page can ask for history suggestions." };
      }
      try {
        return { kind: "history-suggestions", ...(await deps.historySuggestions(message.sources)) };
      } catch (err) {
        return { kind: "history-error", message: (err as Error).message };
      }
    }
    case "open-history-page": {
      if (!isOurInstagramContentScript(sender, deps)) return { kind: "rejected", reason: "Not allowed." };
      await deps.openHistoryPage();
      return { kind: "ok" };
    }
    case "get-instagram-draft":
      return undefined; // meant for the content script, not the worker
  }
}
