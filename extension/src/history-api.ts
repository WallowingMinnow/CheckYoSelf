// The backend's /api/history routes, from the extension. Every call carries
// this install's random user id (user-id.ts), so nobody sees anyone else's
// history. Only TEXT is sent (captions and photo text the user approved).
// See shared/contract.ts for the request/response shapes.
import {
  CONTRACT_VERSION,
  USER_ID_HEADER,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type ErrorResponse,
  type HistoryAssessRequest,
  type HistoryAssessResponse,
  type HistoryDeleteResponse,
  type HistoryImportRequest,
  type HistoryImportResponse,
  type HistoryListResponse,
  type HistoryPost,
  type HistorySuggestResponse,
  type PortfolioResponse,
  type PortfolioScanResponse,
  type TextSource,
} from "../../shared/contract";
import { BACKEND_URL } from "./api";
import { getUserId } from "./user-id";

/** Shown when the backend doesn't have a route the extension uses. */
export const OUTDATED_BACKEND =
  "The backend running on this computer is older than the extension (it doesn't know this feature). " +
  "Update it and restart it: pull the latest code, run scripts\\windows\\stop-backend.cmd, then start-backend.cmd " +
  "(or stop and rerun `npm run dev` in backend/).";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [USER_ID_HEADER]: await getUserId() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach the backend. Start it (scripts\\windows\\start-backend.cmd or `npm run dev` in backend/).");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as ErrorResponse | null)?.error?.message;
    if (message) throw new Error(message);
    // No JSON error at all: the backend doesn't know this route, i.e. it runs older code than the extension.
    if (res.status === 404) throw new Error(OUTDATED_BACKEND);
    throw new Error(`Backend returned HTTP ${res.status}.`);
  }
  return data as T;
}

/**
 * Saves posts the user explicitly approved. `posts` must be exactly the
 * approved ones: the backend refuses anything else.
 */
export function importHistory(posts: HistoryPost[]): Promise<HistoryImportResponse> {
  const body: HistoryImportRequest = {
    contractVersion: CONTRACT_VERSION,
    approval: { approved: true, postIds: posts.map((p) => p.postId) },
    posts,
  };
  return call("POST", "/api/history/import", body);
}

export function listHistory(): Promise<HistoryListResponse> {
  return call("GET", "/api/history");
}

/** Which saved posts look related to a draft (no AI call). */
export function suggestHistory(sources: TextSource[]): Promise<HistorySuggestResponse> {
  return call("POST", "/api/history/suggest", { contractVersion: CONTRACT_VERSION, sources });
}

export function deleteHistoryPost(postId: string): Promise<HistoryDeleteResponse> {
  return call("DELETE", `/api/history/posts/${encodeURIComponent(postId)}`);
}

export function revokeApproval(approvalId: string): Promise<HistoryDeleteResponse> {
  return call("POST", `/api/history/approvals/${encodeURIComponent(approvalId)}/revoke`);
}

/** Deletes ALL of this user's saved posts and the AI interpretations made from them. */
export function deleteAllHistory(): Promise<HistoryDeleteResponse> {
  return call("DELETE", "/api/history");
}

/**
 * Checks a draft TOGETHER WITH earlier posts the user chose (by postId).
 * The backend adds exactly those posts as "history:<postId>" sources and
 * refuses unknown ones. Only used when the user opted in for this check.
 */
export function analyzeWithHistory(sources: TextSource[], draftHash: string, historyPostIds: string[], usePortfolio = false): Promise<AnalyzeResponse> {
  const body: AnalyzeRequest = { contractVersion: CONTRACT_VERSION, draftHash, sources };
  if (historyPostIds.length) body.historyPostIds = historyPostIds;
  if (usePortfolio) body.usePortfolio = true;
  return call("POST", "/api/analyze", body);
}

/**
 * What these saved posts reveal TOGETHER (no draft). Sends only the post ids;
 * the backend reads exactly those posts from this user's history.
 */
export function assessHistory(postIds: string[]): Promise<HistoryAssessResponse> {
  const body: HistoryAssessRequest = { contractVersion: CONTRACT_VERSION, postIds };
  return call("POST", "/api/history/assess", body);
}

/** Scans a few not-yet-scanned saved posts into the profile (live AI). Call again until remaining is 0. */
export function scanPortfolio(): Promise<PortfolioScanResponse> {
  return call("POST", "/api/history/portfolio/scan", { contractVersion: CONTRACT_VERSION });
}

/** The profile: facts found in the saved posts, each with its exact quote. */
export function getPortfolio(): Promise<PortfolioResponse> {
  return call("GET", "/api/history/portfolio");
}
