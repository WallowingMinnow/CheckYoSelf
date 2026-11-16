// Tests for the dashboard's numbers (src/dashboard/report.ts) and its sample data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES, CONTRACT_VERSION, type AnalyzeResponse, type Finding } from "../../shared/contract";
import {
  RISK_GROUPS,
  buildReport,
  combineScores,
  findHighlights,
  findingFloor,
  findingWeight,
  overviewText,
  postIdForSource,
  postScore,
  riskLevel,
  sourceTextFor,
  type AnalyzedPost,
} from "../src/dashboard/report";
import { SAMPLE_POSTS } from "../src/dashboard/sample-data";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    category: "location",
    severity: "high",
    exposure: "x",
    evidence: [{ sourceId: "caption", quote: "Maple St", verified: true }],
    crossSource: false,
    confidence: "high",
    uncertainty: "",
    suggestedEdits: [],
    ...over,
  };
}

function post(id: string, findings: Finding[], over: Partial<AnalyzedPost> = {}, dropped = 0): AnalyzedPost {
  const result: AnalyzeResponse = {
    contractVersion: CONTRACT_VERSION,
    requestId: id,
    draftHash: id,
    mode: "mock",
    model: null,
    promptVersion: null,
    analyzedAt: "2026-11-01T00:00:00Z",
    summary: "",
    findings,
    droppedFindings: dropped,
    historyUsed: [],
  };
  return { id, title: id, date: "2026-11-01T00:00:00Z", sources: [{ id: "caption", type: "caption", text: "Home on Maple St" }], result, ...over };
}

test("every backend category belongs to exactly one risk group", () => {
  for (const category of CATEGORIES) {
    const groups = RISK_GROUPS.filter((g) => g.categories.includes(category));
    assert.equal(groups.length, 1, `category ${category}`);
  }
});

test("scores combine without going over 100", () => {
  assert.equal(combineScores([]), 0);
  assert.equal(combineScores([0.3]), 30);
  assert.equal(combineScores([0.3, 0.3]), 51);
  assert.ok(combineScores(Array(50).fill(0.95)) <= 100);
});

test("less confident findings weigh less, cross-post findings weigh more", () => {
  const f = finding();
  assert.ok(findingWeight({ ...f, confidence: "low" }, false) < findingWeight(f, false));
  assert.ok(findingWeight(f, true) > findingWeight(f, false));
});

test("risk levels follow the score bands", () => {
  assert.equal(riskLevel(0), "low");
  assert.equal(riskLevel(24), "low");
  assert.equal(riskLevel(25), "moderate");
  assert.equal(riskLevel(50), "high");
  assert.equal(riskLevel(75), "critical");
});

test("no posts gives score 0 and no recommendations", () => {
  const report = buildReport([]);
  assert.equal(report.score, 0);
  assert.equal(report.recommendations.length, 0);
  assert.equal(overviewText(report).reveals, "No posts have been checked yet.");
});

test("history evidence links a finding to the earlier post (cross-post)", () => {
  const earlier = post("p1", [], { historyPostId: "h1" });
  const later = post("p2", [
    finding({
      evidence: [
        { sourceId: "caption", quote: "Maple St", verified: true },
        { sourceId: "history:h1", quote: "Maple St", verified: true },
      ],
    }),
  ]);
  const report = buildReport([earlier, later]);
  assert.equal(report.crossPost.length, 1);
  assert.deepEqual(report.crossPost[0].postIds, ["p1", "p2"]);
  assert.equal(postIdForSource(later, "history:h1", [earlier, later]), "p1");
  assert.equal(sourceTextFor(later, "history:h1", [earlier, later]), "Home on Maple St");
  // The earlier post's own score includes the cross-post finding.
  assert.ok(postScore(report, "p1") > 0);
});

test("unverified evidence never makes a finding cross-post", () => {
  const earlier = post("p1", [], { historyPostId: "h1" });
  const later = post("p2", [
    finding({
      evidence: [
        { sourceId: "caption", quote: "Maple St", verified: true },
        { sourceId: "history:h1", quote: "made up", verified: false },
      ],
    }),
  ]);
  assert.equal(buildReport([earlier, later]).crossPost.length, 0);
});

test("dropped findings are reported, not hidden", () => {
  const report = buildReport([post("p1", [], {}, 2)]);
  assert.equal(report.droppedFindings, 2);
});

test("recommendations are ranked by score and keep concrete edits", () => {
  const report = buildReport([
    post("p1", [
      finding({
        id: "f1",
        category: "location",
        suggestedEdits: [
          { sourceId: "caption", action: "generalize", original: "Maple St", replacement: "home", explanation: "Vaguer." },
        ],
      }),
      finding({ id: "f2", category: "contact", severity: "low" }),
    ]),
  ]);
  assert.equal(report.recommendations[0].key, "location");
  assert.deepEqual(report.recommendations[0].edits, ['Change "Maple St" to "home". Vaguer.']);
  assert.ok(report.recommendations[0].score >= report.recommendations[1].score);
});

test("highlights ignore case and merge overlaps", () => {
  assert.deepEqual(findHighlights("Home on Maple St", ["maple st", "on maple"]), [{ start: 5, end: 16 }]);
  assert.deepEqual(findHighlights("abc", ["zzz", ""]), []);
});

test("sample data: every verified quote appears in the text it points to", () => {
  for (const p of SAMPLE_POSTS) {
    for (const f of p.result.findings) {
      for (const ev of f.evidence) {
        if (!ev.verified) continue;
        const text = sourceTextFor(p, ev.sourceId, SAMPLE_POSTS);
        assert.ok(text, `${p.id}/${f.id}: source ${ev.sourceId} not found`);
        assert.ok(text!.toLowerCase().includes(ev.quote.toLowerCase()), `${p.id}/${f.id}: "${ev.quote}"`);
      }
      // Suggested edits must also match the text, like the backend guarantees.
      for (const edit of f.suggestedEdits) {
        if (!edit.original) continue;
        const text = p.sources.find((s) => s.id === edit.sourceId)?.text ?? "";
        assert.ok(text.includes(edit.original), `${p.id}/${f.id}: edit "${edit.original}"`);
      }
    }
  }
});

test("sample report shows cross-post patterns and all five groups have data or zero", () => {
  const report = buildReport(SAMPLE_POSTS);
  assert.equal(report.posts.length, 4);
  assert.equal(report.crossPost.length, 2);
  assert.equal(report.groups.length, 5);
  assert.ok(report.score > 0 && report.score <= 100);
});

test("overview sentence lists phrases readably", async () => {
  const { joinWithAnd } = await import("../src/dashboard/report");
  assert.equal(joinWithAnd(["a"]), "a");
  assert.equal(joinWithAnd(["a", "b"]), "a and b");
  assert.equal(joinWithAnd(["a", "b", "c"]), "a; b; and c");
});

test("photo advice lists only photo edits; routine advice ignores time-away findings", () => {
  const report = buildReport(SAMPLE_POSTS);
  const photo = report.recommendations.find((r) => r.key === "photo")!;
  assert.deepEqual(photo.edits, ["Crop out the banner with the university name."]);
  const routine = report.recommendations.find((r) => r.key === "routine")!;
  assert.ok(!routine.postIds.includes("post-4"), "weekend-away post belongs to 'delay', not 'routine'");
});

// --- one serious finding sets a minimum (risk score update) ---------------------------

test("the worst single finding sets a minimum score, in the dashboard too", () => {
  const ssn = finding({ category: "identity", severity: "high", confidence: "high" });
  const report = buildReport([post("p1", [ssn])]);
  assert.ok(report.score >= 75, `score was ${report.score}`);
  assert.equal(report.level, "critical");
  assert.ok(postScore(report, "p1") >= 75, "the post's own score uses the same rule");
});

test("minimums: sensitive high 75, high 50, sensitive medium 50, medium 25, low 0; halved when unsure", () => {
  assert.equal(findingFloor(finding({ category: "identity", severity: "high" })), 75);
  assert.equal(findingFloor(finding({ category: "location", severity: "high" })), 50);
  assert.equal(findingFloor(finding({ category: "financial", severity: "medium" })), 50);
  assert.equal(findingFloor(finding({ category: "location", severity: "medium" })), 25);
  assert.equal(findingFloor(finding({ category: "children", severity: "medium" })), 50);
  assert.equal(findingFloor(finding({ category: "health", severity: "low" })), 0);
  assert.equal(findingFloor(finding({ category: "identity", severity: "high", confidence: "low" })), 38);
});

test("sensitive categories weigh more than everyday ones at the same severity", () => {
  const everyday = findingWeight(finding({ category: "location", severity: "high" }), false);
  const sensitive = findingWeight(finding({ category: "identity", severity: "high" }), false);
  assert.ok(sensitive > everyday);
});

test("many small findings still add up past the minimum (the formula is unchanged)", () => {
  const lows = Array.from({ length: 6 }, (_, i) => finding({ id: `f${i}`, category: "location", severity: "medium" }));
  const report = buildReport([post("p1", lows)]);
  assert.ok(report.score > 25, `score was ${report.score}`);
  assert.equal(report.score, combineScores(lows.map((f) => findingWeight(f, false))));
});
