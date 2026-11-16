// Tests for "What your posts reveal together" (src/history-assess.ts). Fictional data only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, type Finding, type HistoryAssessResponse, type StoredHistoryPost } from "../../shared/contract";
import { assessmentView, pickPostsToAssess } from "../src/history-assess";

function saved(postId: string, publishedAt: string, caption: string, imageText?: string): StoredHistoryPost {
  return { postId, status: "published", publishedAt, caption, ...(imageText ? { imageText } : {}), approvalId: "x", importedAt: publishedAt };
}

test("assesses the most recent saved posts, up to 20, within the backend's text limits", () => {
  const posts = Array.from({ length: 25 }, (_, i) => saved(`p${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, "hi"));
  const { postIds, left } = pickPostsToAssess(posts);
  assert.equal(postIds.length, 20);
  assert.equal(postIds[0], "p24", "newest first");
  assert.equal(left, 5);

  const long = [
    saved("big", "2026-02-01T00:00:00Z", "x".repeat(6000)),  // over 5000 per post: left out
    saved("empty", "2026-01-31T00:00:00Z", ""),             // nothing to read
    ...Array.from({ length: 10 }, (_, i) => saved(`m${i}`, `2026-01-0${(i % 9) + 1}T00:00:00Z`, "y".repeat(4900))),
  ];
  const picked = pickPostsToAssess(long);
  assert.ok(!picked.postIds.includes("big") && !picked.postIds.includes("empty"));
  assert.equal(picked.postIds.length, 8, "8 x 4900 fits in 40000, a 9th doesn't");
});

const POSTS = [
  saved("p1", "2026-09-01T08:00:00Z", "So proud of Mia on her first day!"),
  saved("p2", "2026-09-10T15:00:00Z", "Pickup at Lincoln Elementary at 3pm"),
  saved("p3", "2026-09-20T12:00:00Z", "Our new place on Maple St"),
];

function finding(id: string, severity: Finding["severity"], evidence: [string, string][], category: Finding["category"] = "children"): Finding {
  return {
    id, category, severity, exposure: `exposure ${id}`, confidence: "medium", uncertainty: "maybe",
    evidence: evidence.map(([sourceId, quote]) => ({ sourceId, quote, verified: true })),
    crossSource: new Set(evidence.map(([s]) => s)).size > 1, suggestedEdits: [],
  };
}

function response(findings: Finding[], extra: Partial<HistoryAssessResponse> = {}): HistoryAssessResponse {
  return {
    contractVersion: CONTRACT_VERSION, requestId: "r", mode: "databricks", model: "m", promptVersion: "v",
    analyzedAt: "2026-11-15T00:00:00Z", summary: "s", findings, droppedFindings: 0,
    postsAssessed: POSTS.map((p) => ({ sourceId: `history:${p.postId}`, postId: p.postId, publishedAt: p.publishedAt })),
    ...extra,
  };
}

test("findings that combine posts come first, cite each post by date, and raise the score", () => {
  const single = finding("f1", "medium", [["history:p3", "Maple St"]], "location");
  const combined = finding("f2", "high", [["history:p1", "Mia"], ["history:p2", "Lincoln Elementary at 3pm"]]);
  const view = assessmentView(response([single, combined]), POSTS, (iso) => iso.slice(0, 10));
  assert.deepEqual(view.findings.map((f) => f.finding.id), ["f2", "f1"]);
  assert.equal(view.crossPostCount, 1);
  assert.equal(view.findings[0].postCount, 2);
  assert.deepEqual(view.findings[0].evidence.map((e) => e.postLabel), [
    "2026-09-01 · “So proud of Mia on her first day…”",
    "2026-09-10 · “Pickup at Lincoln Elementary at…”",
  ]);
  assert.equal(view.headline, "1 risk only shows up when your posts are read together.");
  assert.ok(view.verdict.score >= 75, `a high child-related combination is critical: ${view.verdict.score}`);
  assert.equal(view.postsAssessed, 3);
  assert.equal(view.note, "");
});

test("no findings, incomplete checks and practice mode are each said plainly", () => {
  assert.match(assessmentView(response([]), POSTS, String).headline, /Nothing stood out across these 3 posts/);
  const incomplete = assessmentView(response([], { droppedFindings: 2 }), POSTS, String);
  assert.equal(incomplete.verdict.stamp, "INCOMPLETE");
  assert.match(incomplete.headline, /incomplete/);
  assert.match(assessmentView(response([], { mode: "mock" }), POSTS, String).note, /Practice mode/);
});

test("unverified quotes are not shown as evidence", () => {
  const f = finding("f1", "high", [["history:p1", "Mia"], ["history:p2", "made up"]]);
  f.evidence[1].verified = false;
  const view = assessmentView(response([f]), POSTS, String);
  assert.equal(view.findings[0].evidence.length, 1);
  assert.equal(view.findings[0].crossPost, false, "only one VERIFIED post");
});
