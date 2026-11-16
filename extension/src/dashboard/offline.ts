// OFFLINE MODE: analyze a post with simple keyword rules, right here in the
// page. No backend, no AI, nothing is sent anywhere.
//
// It reuses the backend's practice-mode rules (backend/src/mock.ts) so both
// give the same results. That file only uses types from shared/contract.ts,
// so it can run in the browser. (If it ever imports Node-only code, this
// import breaks the extension build; copy the rules here instead.)
//
// Cross-post: earlier checks from this tab are added as "history:<id>"
// sources, the same way the backend adds approved earlier posts. A rule that
// matches both the new post and an earlier one becomes a cross-post finding.
import {
  CONTRACT_VERSION,
  HISTORY_LIMITS,
  type AnalyzeResponse,
  type Finding,
  type TextSource,
} from "../../../shared/contract";
import { mockAnalyze } from "../../../backend/src/mock";

/** An earlier check, as offline mode sees it. */
export interface EarlierPost {
  /** Used as "history:<historyId>"; must match AnalyzedPost.historyPostId. */
  historyId: string;
  text: string;
  date: string;
}

export function analyzeOffline(
  draft: TextSource[],
  earlier: EarlierPost[],
  draftHash: string,
  now: Date = new Date(),
): AnalyzeResponse {
  // Like the backend, compare with at most 8 earlier posts (the most recent).
  const recent = earlier.slice(-HISTORY_LIMITS.maxPostsPerAnalysis);
  const history: TextSource[] = recent.map((p) => ({
    id: `history:${p.historyId}`,
    type: "history",
    text: p.text,
    date: p.date,
  }));
  const raw = mockAnalyze([...draft, ...history]);
  const draftIds = new Set(draft.map((s) => s.id));

  const findings: Finding[] = [];
  for (const f of raw.findings) {
    // Only keep findings about THIS post. A match only in earlier posts was
    // already reported when those posts were checked.
    if (!f.evidence.some((ev) => draftIds.has(ev.sourceId))) continue;

    const earlierPosts = new Set(f.evidence.filter((ev) => !draftIds.has(ev.sourceId)).map((ev) => ev.sourceId));
    const exposure =
      earlierPosts.size > 0
        ? `The same kind of detail also appears in ${earlierPosts.size} earlier post${earlierPosts.size === 1 ? "" : "s"}. ` +
          `Together they make the pattern easier to spot. ${f.exposure}`
        : f.exposure;

    findings.push({
      ...f,
      id: `f${findings.length + 1}`,
      exposure,
      // Only suggest edits to the post being checked, not to old posts.
      suggestedEdits: f.suggestedEdits.filter((e) => draftIds.has(e.sourceId)),
    });
  }

  const crossCount = findings.filter((f) => f.evidence.some((ev) => !draftIds.has(ev.sourceId))).length;
  let summary =
    findings.length === 0
      ? "No keyword rules matched this post."
      : `${findings.length} keyword rule${findings.length === 1 ? "" : "s"} matched this post.`;
  if (crossCount > 0) summary += ` ${crossCount} also match${crossCount === 1 ? "es" : ""} earlier posts.`;

  return {
    contractVersion: CONTRACT_VERSION,
    requestId: `offline-${now.getTime().toString(36)}`,
    draftHash,
    mode: "mock",
    model: null,
    promptVersion: null,
    analyzedAt: now.toISOString(),
    summary,
    findings,
    droppedFindings: raw.droppedFindings,
    historyUsed: recent.map((p) => ({ sourceId: `history:${p.historyId}`, postId: p.historyId, publishedAt: p.date })),
  };
}

/** Fictional example posts for trying offline mode (they trigger the keyword rules). */
export const OFFLINE_EXAMPLES: Array<{ name: string; caption: string; imageText: string }> = [
  {
    name: "Morning run",
    caption: "Morning run down Maple St again 🏃 every weekday at 6:30am, rain or shine",
    imageText: "",
  },
  {
    name: "Coffee before class",
    caption: "Coffee at the corner shop on Maple St before my 8am class ☕",
    imageText: "MAPLE ST ROASTERS",
  },
  {
    name: "Trip!",
    caption: "Leaving for the coast Friday, out of town a whole week ✈️ Call me at 608-555-0199",
    imageText: "",
  },
];
