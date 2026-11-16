// "Compare with my past posts" in the popup: OPTIONAL and closed by default.
// When the user opens it, it lists saved posts that look related to the draft
// (the backend's /api/history/suggest: shared words, no AI call), likely ones
// pre-ticked. The check then includes exactly the ticked posts.
//
// The rules (what to pre-tick, how past posts appear in the results) are pure
// functions at the top, tested in test/compare.test.ts.
import { HISTORY_LIMITS, type AnalyzeResponse, type HistorySuggestResponse, type StoredHistoryPost, type TextSource } from "../../shared/contract";

export type Suggestion = HistorySuggestResponse["suggestions"][number];

/** Pre-tick only posts that share words with the draft (the user still decides). */
export function preselect(suggestions: Suggestion[]): string[] {
  return suggestions.filter((s) => s.sharedWords > 0).slice(0, HISTORY_LIMITS.maxPostsPerAnalysis).map((s) => s.postId);
}

/** One line describing a suggestion, e.g. "Mar 9, 2024 · shares 3 words". */
export function suggestionMeta(s: Suggestion, formatDate: (iso: string) => string): string {
  return `${formatDate(s.publishedAt)} · ${s.sharedWords > 0 ? `shares ${s.sharedWords} word${s.sharedWords === 1 ? "" : "s"}` : "recent"}`;
}

/**
 * The earlier posts the result used, as "history:<postId>" sources, so the
 * results can show and highlight them next to the draft ("Earlier post, <date>").
 */
export function historySourcesFor(result: AnalyzeResponse, saved: StoredHistoryPost[]): TextSource[] {
  const byId = new Map(saved.map((p) => [p.postId, p]));
  return result.historyUsed.flatMap((used) => {
    const post = byId.get(used.postId);
    if (!post) return [];
    // Exactly how the backend builds it (backend/src/history/relevance.ts historySourceText),
    // so quotes from the earlier post are found and highlighted.
    const text = post.imageText ? `${post.caption}\nText in photo: ${post.imageText}` : post.caption;
    return [{ id: used.sourceId, type: "history" as const, text, date: used.publishedAt }];
  });
}
