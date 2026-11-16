// Turns a list of checked posts into the numbers and lists the dashboard shows:
// the overall score, the five risk groups, cross-post patterns and ranked
// recommendations. No DOM here, so it is tested in Node
// (test/dashboard-report.test.ts).
//
// IMPORTANT: the scores are an ESTIMATE computed here in the extension from
// the findings (severity x confidence). They are not produced by the AI and
// are not a measurement. The dashboard says so next to the score.
import type { AnalyzeResponse, Category, Finding, Level, SuggestedEdit, TextSource } from "../../../shared/contract";

// ---------------------------------------------------------------------------
// Input: the posts that were checked
// ---------------------------------------------------------------------------

/** One post that was checked, with the backend's answer for it. */
export interface AnalyzedPost {
  /** Our own id, e.g. "post-1" or "check-2". */
  id: string;
  /** Short name shown on cards, e.g. "Study spot". */
  title: string;
  /** ISO date the post was published (sample) or checked (your own checks). */
  date: string;
  /** The text that was sent: "caption" and "image_text:<n>" sources. */
  sources: TextSource[];
  /** The backend's answer for these sources. */
  result: AnalyzeResponse;
  /**
   * The id the backend knows this post by once it is published and approved
   * as history. Evidence with sourceId "history:<historyPostId>" (from a
   * LATER check) points back to this post.
   */
  historyPostId?: string;
  /** Color of the preview tile. */
  tone?: "blue" | "violet" | "teal" | "amber";
  /**
   * How it was analyzed: "offline" = keyword rules in the page (no AI, no
   * backend), "backend" = sent to the local backend. Not set for the sample.
   */
  engine?: "offline" | "backend";
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "moderate" | "high" | "critical";

/** How much one finding adds to a score, before confidence. Out of 100. */
const SEVERITY_POINTS: Record<Level, number> = { high: 30, medium: 15, low: 6 };
/** Less sure findings count for less. */
const CONFIDENCE_FACTOR: Record<Level, number> = { high: 1, medium: 0.8, low: 0.6 };
/** A pattern that needs several posts gets 20% extra: it's what this tool is for. */
const CROSS_POST_BONUS = 1.2;

/**
 * Categories where ONE leak can do serious harm on its own: ID numbers
 * (Social Security, passport, license, birthday), money (card or bank
 * numbers), health, and children (a kid's name with their school, team or
 * age can be used to find them). They weigh 1.5x and get higher minimum
 * scores (see below).
 */
export const SENSITIVE_CATEGORIES: readonly Category[] = ["identity", "financial", "health", "children"];
const SENSITIVE_BONUS = 1.5;

/** One finding's weight, between 0 and 0.95. */
export function findingWeight(finding: Finding, crossPost: boolean): number {
  let points = SEVERITY_POINTS[finding.severity] * CONFIDENCE_FACTOR[finding.confidence];
  if (SENSITIVE_CATEGORIES.includes(finding.category)) points *= SENSITIVE_BONUS;
  if (crossPost) points *= CROSS_POST_BONUS;
  return Math.min(0.95, points / 100);
}

/**
 * The lowest score a post can get because of ONE finding. Without this, a
 * single very serious finding (for example a Social Security number) could
 * only reach 30, because the formula below adds findings up.
 *   high + sensitive category   -> 75 (critical)
 *   high                        -> 50 (high)
 *   medium + sensitive category -> 50 (high)
 *   medium                      -> 25 (moderate)
 *   low                         -> 0
 * If the AI is NOT sure (low confidence), the minimum is halved.
 */
export function findingFloor(finding: Finding): number {
  const sensitive = SENSITIVE_CATEGORIES.includes(finding.category);
  let floor = 0;
  if (finding.severity === "high") floor = sensitive ? 75 : 50;
  else if (finding.severity === "medium") floor = sensitive ? 50 : 25;
  return finding.confidence === "low" ? Math.round(floor / 2) : floor;
}

/**
 * The score for a set of findings: they add up (combineScores), but never
 * below the worst single finding's minimum (findingFloor).
 */
export function scoreFindings(findings: { finding: Finding; weight: number }[]): number {
  const combined = combineScores(findings.map((f) => f.weight));
  const floor = Math.max(0, ...findings.map((f) => findingFloor(f.finding)));
  return Math.max(combined, floor);
}

/**
 * Combines weights into a 0-100 score. Each finding "uses up" part of what's
 * left, so the score rises quickly at first and never goes over 100:
 *   score = 100 x (1 - (1 - w1) x (1 - w2) x ...)
 * Example: two findings of 0.3 -> 100 x (1 - 0.7 x 0.7) = 51.
 */
export function combineScores(weights: number[]): number {
  let remaining = 1;
  for (const w of weights) remaining *= 1 - w;
  return Math.round(100 * (1 - remaining));
}

export function riskLevel(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "moderate";
  return "low";
}

// ---------------------------------------------------------------------------
// The five risk groups shown in the breakdown
// ---------------------------------------------------------------------------

export type RiskGroupKey = "location" | "personal" | "identity" | "routine" | "sensitive";

export interface RiskGroup {
  key: RiskGroupKey;
  label: string;
  /** Used in the overview sentence: "Your posts reveal <phrase>". */
  phrase: string;
  categories: Category[];
}

/** Every backend category belongs to exactly one group (checked by a test). */
export const RISK_GROUPS: RiskGroup[] = [
  { key: "location", label: "Location", phrase: "where you live and spend time", categories: ["location"] },
  {
    key: "personal",
    label: "Personal information",
    phrase: "ways to contact you and people close to you",
    categories: ["contact", "relationships"],
  },
  {
    key: "identity",
    label: "Identity",
    phrase: "your name, school or workplace",
    categories: ["identity", "workplace_school"],
  },
  {
    key: "routine",
    label: "Routine & behavior",
    phrase: "when you're predictably out or away",
    categories: ["routine_schedule", "travel_absence"],
  },
  {
    key: "sensitive",
    label: "Sensitive information",
    phrase: "sensitive details about health, money or family",
    categories: ["children", "health", "financial", "other"],
  },
];

export function groupOf(category: Category): RiskGroupKey {
  const group = RISK_GROUPS.find((g) => g.categories.includes(category));
  return group ? group.key : "sensitive";
}

export const CATEGORY_LABELS: Record<Category, string> = {
  location: "Location",
  routine_schedule: "Routine",
  travel_absence: "Time away",
  children: "Children",
  identity: "Identity",
  contact: "Contact details",
  workplace_school: "Work or school",
  financial: "Money",
  health: "Health",
  relationships: "Relationships",
  other: "Other",
};

// ---------------------------------------------------------------------------
// Which post does a piece of evidence come from?
// ---------------------------------------------------------------------------

/**
 * "caption" and "image_text:<n>" belong to the post that was checked.
 * "history:<postId>" belongs to the earlier post with that historyPostId.
 * Returns null if we don't have that earlier post in the list.
 */
export function postIdForSource(owner: AnalyzedPost, sourceId: string, allPosts: AnalyzedPost[]): string | null {
  if (sourceId.startsWith("history:")) {
    const historyId = sourceId.slice("history:".length);
    const earlier = allPosts.find((p) => p.historyPostId === historyId);
    return earlier ? earlier.id : null;
  }
  return owner.id;
}

/** The text a piece of evidence was quoted from, so the evidence view can show it in context. */
export function sourceTextFor(owner: AnalyzedPost, sourceId: string, allPosts: AnalyzedPost[]): string | null {
  if (sourceId.startsWith("history:")) {
    const postId = postIdForSource(owner, sourceId, allPosts);
    const earlier = allPosts.find((p) => p.id === postId);
    // We don't know which of the earlier post's sources the backend used, so join them.
    return earlier ? earlier.sources.map((s) => s.text).join("\n") : null;
  }
  return owner.sources.find((s) => s.id === sourceId)?.text ?? null;
}

export function sourceLabel(sourceId: string): string {
  if (sourceId === "caption") return "Caption";
  if (sourceId.startsWith("image_text")) return "Text in photo";
  if (sourceId.startsWith("history")) return "Earlier post";
  return sourceId;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** A finding plus what the dashboard needs to know about it. */
export interface ReportFinding {
  /** Unique across the report: "<post id>/<finding id>", e.g. "post-3/f2". */
  key: string;
  finding: Finding;
  /** The post whose check produced this finding. */
  fromPostId: string;
  /** Posts that its VERIFIED evidence comes from, in the order of the post list. */
  postIds: string[];
  /** true when verified evidence comes from more than one post. */
  crossPost: boolean;
  group: RiskGroupKey;
  weight: number;
}

export interface GroupScore {
  key: RiskGroupKey;
  label: string;
  score: number;
  count: number;
}

export interface Recommendation {
  key: string;
  title: string;
  detail: string;
  priority: Level;
  /** Sum of the matched findings' weights, x 100. Used for ranking. */
  score: number;
  findingKeys: string[];
  postIds: string[];
  /** Concrete changes the AI suggested for these findings, as sentences. */
  edits: string[];
}

export interface DashboardReport {
  posts: AnalyzedPost[];
  findings: ReportFinding[];
  score: number;
  level: RiskLevel;
  groups: GroupScore[];
  /** Cross-post findings, highest weight first. */
  crossPost: ReportFinding[];
  recommendations: Recommendation[];
  /** Warnings the backend could not verify, summed over all checks. Above 0 = incomplete. */
  droppedFindings: number;
}

export function buildReport(posts: AnalyzedPost[]): DashboardReport {
  const findings: ReportFinding[] = [];
  let droppedFindings = 0;

  for (const post of posts) {
    droppedFindings += post.result.droppedFindings;
    for (const finding of post.result.findings) {
      // Only verified quotes decide which posts a finding is about
      // (the same rule the backend uses for crossSource).
      const ids = new Set<string>();
      for (const ev of finding.evidence) {
        if (!ev.verified) continue;
        const postId = postIdForSource(post, ev.sourceId, posts);
        if (postId) ids.add(postId);
      }
      if (ids.size === 0) ids.add(post.id);
      const postIds = posts.map((p) => p.id).filter((id) => ids.has(id));
      const crossPost = postIds.length > 1;
      findings.push({
        key: `${post.id}/${finding.id}`,
        finding,
        fromPostId: post.id,
        postIds,
        crossPost,
        group: groupOf(finding.category),
        weight: findingWeight(finding, crossPost),
      });
    }
  }

  const score = scoreFindings(findings);
  const groups: GroupScore[] = RISK_GROUPS.map((g) => {
    const inGroup = findings.filter((f) => f.group === g.key);
    return { key: g.key, label: g.label, score: scoreFindings(inGroup), count: inGroup.length };
  });
  const crossPost = findings.filter((f) => f.crossPost).sort((a, b) => b.weight - a.weight);

  return {
    posts,
    findings,
    score,
    level: riskLevel(score),
    groups,
    crossPost,
    recommendations: buildRecommendations(findings),
    droppedFindings,
  };
}

/** Score for one post: every finding whose evidence touches that post. */
export function postScore(report: DashboardReport, postId: string): number {
  return scoreFindings(report.findings.filter((f) => f.postIds.includes(postId)));
}

/** Findings that touch one post, most serious first. */
export function findingsForPost(report: DashboardReport, postId: string): ReportFinding[] {
  return report.findings.filter((f) => f.postIds.includes(postId)).sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

interface RecommendationRule {
  key: string;
  title: string;
  detail: string;
  matches: (f: ReportFinding) => boolean;
  /** Optional: which of the matched findings' suggested edits to list. Default: all. */
  editFilter?: (edit: SuggestedEdit) => boolean;
}

const hasCategory = (f: ReportFinding, ...categories: Category[]) => categories.includes(f.finding.category);
const touchesPhoto = (f: ReportFinding) =>
  f.finding.evidence.some((ev) => ev.verified && ev.sourceId.startsWith("image_text")) ||
  f.finding.suggestedEdits.some((e) => e.action === "crop_or_blur_image");

/** Fixed advice, picked by which findings were found. A finding can match several. */
const RECOMMENDATION_RULES: RecommendationRule[] = [
  {
    key: "location",
    title: "Remove real-time location details",
    detail: "Name the city or say \"nearby\" instead of streets, buildings, rooms or venues.",
    matches: (f) => hasCategory(f, "location"),
  },
  {
    key: "routine",
    title: "Avoid sharing predictable routines",
    detail: "Leave out recurring times and days, especially when other posts show where you go.",
    matches: (f) => hasCategory(f, "routine_schedule"),
  },
  {
    key: "delay",
    title: "Delay posting location-specific content",
    detail: "Share trips and places after you've left them, so posts don't show when home is empty.",
    matches: (f) => hasCategory(f, "travel_absence"),
  },
  {
    key: "photo",
    title: "Hide identifying information in images",
    detail: "Crop or blur signs, banners, name tags, jerseys and screens before posting.",
    matches: touchesPhoto,
    // Only show changes to the photo here, not caption edits of the same finding.
    editFilter: (edit) => edit.action === "crop_or_blur_image" || edit.sourceId.startsWith("image_text"),
  },
  {
    key: "identity",
    title: "Limit identifying details",
    detail: "Avoid putting your full name, school or employer next to where you live.",
    matches: (f) => hasCategory(f, "identity", "workplace_school"),
  },
  {
    key: "contact",
    title: "Keep contact details private",
    detail: "Phone numbers, emails and handles let strangers reach you or find your other accounts.",
    matches: (f) => hasCategory(f, "contact"),
  },
  {
    key: "sensitive",
    title: "Review sensitive details",
    detail: "Health, money, children and relationships are often better shared privately.",
    matches: (f) => hasCategory(f, "health", "financial", "children", "relationships", "other"),
  },
];

/** A suggested edit as one sentence, e.g. 'Change "Maple St" to "home".' */
export function describeEdit(edit: SuggestedEdit): string {
  if (edit.action === "remove" && edit.original) return `Remove "${edit.original}". ${edit.explanation}`;
  if (edit.original && edit.replacement) return `Change "${edit.original}" to "${edit.replacement}". ${edit.explanation}`;
  return edit.explanation;
}

function buildRecommendations(findings: ReportFinding[]): Recommendation[] {
  const recommendations: Recommendation[] = [];
  for (const rule of RECOMMENDATION_RULES) {
    const matched = findings.filter(rule.matches);
    if (matched.length === 0) continue;

    let total = 0;
    let worst: Level = "low";
    const postIds = new Set<string>();
    const edits: string[] = [];
    for (const f of matched) {
      total += f.weight;
      if (f.finding.severity === "high" || (f.finding.severity === "medium" && worst === "low")) {
        worst = f.finding.severity;
      }
      f.postIds.forEach((id) => postIds.add(id));
      for (const edit of f.finding.suggestedEdits) {
        if (rule.editFilter && !rule.editFilter(edit)) continue;
        const sentence = describeEdit(edit).trim();
        if (sentence && !edits.includes(sentence)) edits.push(sentence);
      }
    }
    recommendations.push({
      key: rule.key,
      title: rule.title,
      detail: rule.detail,
      priority: worst,
      score: Math.round(total * 100),
      findingKeys: matched.map((f) => f.key),
      postIds: [...postIds],
      edits: edits.slice(0, 3),
    });
  }
  // Highest score first. Ties: keep the order of the rules above.
  return recommendations.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Overview text (computed here, NOT by the AI)
// ---------------------------------------------------------------------------

export interface OverviewText {
  /** "Your posts reveal where you live and spend time and ..." */
  reveals: string;
  /** Why the patterns matter. */
  why: string;
  /** Titles of the top recommendations. */
  priorities: string[];
}

/** Joins ["a", "b", "c"] as "a; b; and c" (semicolons, because phrases can contain commas). Two items: "a and b". */
export function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join("; ")}; and ${items[items.length - 1]}`;
}

export function overviewText(report: DashboardReport): OverviewText {
  const found = report.groups.filter((g) => g.count > 0).sort((a, b) => b.score - a.score);
  const phrases = found.map((g) => RISK_GROUPS.find((r) => r.key === g.key)!.phrase);

  let reveals: string;
  if (report.posts.length === 0) reveals = "No posts have been checked yet.";
  else if (phrases.length === 0) reveals = "Nothing stood out in the posts checked so far.";
  else reveals = `Your posts reveal ${joinWithAnd(phrases.slice(0, 3))}.`;

  let why: string;
  if (report.crossPost.length > 0) {
    why =
      "Each post looks harmless on its own, but together they let a stranger predict where you'll be and when. " +
      "Patterns are harder to undo than a single detail.";
  } else if (report.findings.length > 0) {
    why = "Details like these make it easier for a stranger to find or recognize you offline.";
  } else {
    why = "Keep reviewing posts before you share them.";
  }

  return { reveals, why, priorities: report.recommendations.slice(0, 3).map((r) => r.title) };
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

export interface TextRange {
  start: number;
  end: number;
}

/**
 * Where the quotes are in `text` (first place each appears, ignoring case),
 * with overlapping ranges merged so highlights never nest.
 */
export function findHighlights(text: string, quotes: string[]): TextRange[] {
  const lower = text.toLowerCase();
  const ranges: TextRange[] = [];
  for (const quote of quotes) {
    if (!quote.trim()) continue;
    const start = lower.indexOf(quote.toLowerCase());
    if (start !== -1) ranges.push({ start, end: start + quote.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
