// "What your posts reveal together": choosing which saved posts to assess,
// and turning the backend's answer into what the History page shows.
// No DOM and no Chrome calls, so it can be tested in Node
// (test/history-assess.test.ts). history-page.ts does the drawing.
import {
  HISTORY_LIMITS,
  LIMITS,
  type AnalyzeResponse,
  type Finding,
  type HistoryAssessResponse,
  type StoredHistoryPost,
} from "../../shared/contract";
import { verdictFor, type Verdict } from "./verdict";

/** Same text the backend builds for a saved post (backend/src/history/relevance.ts historySourceText). */
function sourceLength(post: StoredHistoryPost): number {
  return post.imageText ? post.caption.length + "\nText in photo: ".length + post.imageText.length : post.caption.length;
}

/**
 * The saved posts to assess: the most recent ones, up to
 * HISTORY_LIMITS.maxPostsPerAssessment and the backend's text limits.
 * `left` = saved posts not included (older, or too long).
 */
export function pickPostsToAssess(saved: StoredHistoryPost[]): { postIds: string[]; left: number } {
  const newest = [...saved].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const postIds: string[] = [];
  let total = 0;
  for (const post of newest) {
    if (postIds.length >= HISTORY_LIMITS.maxPostsPerAssessment) break;
    const length = sourceLength(post);
    if (length === 0 || length > LIMITS.maxCharsPerSource || total + length > LIMITS.maxTotalChars) continue;
    postIds.push(post.postId);
    total += length;
  }
  return { postIds, left: saved.length - postIds.length };
}

export interface AssessedEvidence {
  postId: string;
  /** e.g. "Sep 1, 2026 · “So proud of Mia on her…”", or "Unknown post" if it isn't in the list. */
  postLabel: string;
  quote: string;
}

/** The start of a caption, to tell posts from the same day apart. */
export function captionSnippet(caption: string, max = 32): string {
  const flat = caption.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= max ? `“${flat}”` : `“${flat.slice(0, max).trimEnd()}…”`;
}

export interface AssessedFinding {
  finding: Finding;
  /** Combines two or more posts. */
  crossPost: boolean;
  /** How many different posts it quotes. */
  postCount: number;
  evidence: AssessedEvidence[];
}

export interface AssessmentView {
  verdict: Verdict;
  /** Cross-post findings first, then the rest (each group in the backend's order). */
  findings: AssessedFinding[];
  crossPostCount: number;
  postsAssessed: number;
  /** One line under the score. */
  headline: string;
  /** Practice-mode / incomplete note, or "". */
  note: string;
}

/** Builds what the page shows. `formatDate` turns an ISO date into a label. */
export function assessmentView(
  response: HistoryAssessResponse,
  saved: StoredHistoryPost[],
  formatDate: (iso: string) => string,
): AssessmentView {
  // Same scoring as the panel and popup (verdict.ts -> dashboard/report.ts).
  const asAnalyze: AnalyzeResponse = { ...response, draftHash: "", historyUsed: response.postsAssessed };
  const verdict = verdictFor(asAnalyze, []);
  const dateOf = new Map(saved.map((p) => [p.postId, p.publishedAt]));
  for (const p of response.postsAssessed) if (!dateOf.has(p.postId)) dateOf.set(p.postId, p.publishedAt);
  const snippetOf = new Map(saved.map((p) => [p.postId, captionSnippet(p.caption)]));

  const findings: AssessedFinding[] = response.findings.map((finding) => {
    const evidence = finding.evidence
      .filter((e) => e.verified && e.sourceId.startsWith("history:"))
      .map((e) => {
        const postId = e.sourceId.slice("history:".length);
        const date = dateOf.get(postId);
        const snippet = snippetOf.get(postId);
        const postLabel = date ? `${formatDate(date)}${snippet ? ` · ${snippet}` : ""}` : "Unknown post";
        return { postId, postLabel, quote: e.quote };
      });
    const postCount = new Set(evidence.map((e) => e.postId)).size;
    return { finding, crossPost: postCount > 1, postCount, evidence };
  });
  const ordered = [...findings.filter((f) => f.crossPost), ...findings.filter((f) => !f.crossPost)];
  const crossPostCount = ordered.filter((f) => f.crossPost).length;

  let headline: string;
  if (!verdict.complete) headline = "Assessment incomplete: some findings couldn't be checked. Review your posts yourself.";
  else if (ordered.length === 0) headline = `Nothing stood out across these ${response.postsAssessed.length} posts.`;
  else if (crossPostCount > 0) {
    headline = `${crossPostCount} ${crossPostCount === 1 ? "risk only shows" : "risks only show"} up when your posts are read together.`;
  }
  else headline = "Each risk below comes from a single post; none needed several posts.";

  const note =
    response.mode === "mock"
      ? "Practice mode: keyword rules, not AI. Real combinations (e.g. a name in one post and a school in another) need the live AI."
      : "";
  return { verdict, findings: ordered, crossPostCount, postsAssessed: response.postsAssessed.length, headline, note };
}
