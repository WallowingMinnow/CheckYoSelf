// Tests for the popup's verdict (src/verdict.ts): score, LOW/MEDIUM/HIGH stamp
// and advice. Display only, so these check it never misrepresents a result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, type AnalyzeResponse, type Finding, type TextSource } from "../../shared/contract";
import { verdictFor, verdictLevel } from "../src/verdict";

const sources: TextSource[] = [{ id: "caption", type: "caption", text: "Home on Maple St every weekday at 6pm" }];

function response(findings: Finding[], droppedFindings = 0): AnalyzeResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: "r1",
    draftHash: "h",
    mode: "mock",
    model: null,
    promptVersion: null,
    analyzedAt: "2026-11-15T00:00:00Z",
    summary: "",
    findings,
    droppedFindings,
    historyUsed: [],
  };
}

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

test("score bands map to LOW / MEDIUM / HIGH", () => {
  assert.equal(verdictLevel(0), "low");
  assert.equal(verdictLevel(24), "low");
  assert.equal(verdictLevel(25), "medium");
  assert.equal(verdictLevel(49), "medium");
  assert.equal(verdictLevel(50), "high");
  assert.equal(verdictLevel(100), "high");
});

test("no findings in a complete check is LOW with score 0", () => {
  const v = verdictFor(response([]), sources);
  assert.equal(v.score, 0);
  assert.equal(v.stamp, "LOW");
  assert.equal(v.complete, true);
  assert.equal(v.advice.length, 0);
});

test("an incomplete check is never stamped as a clean LOW", () => {
  const v = verdictFor(response([], 2), sources);
  assert.equal(v.complete, false);
  assert.equal(v.stamp, "INCOMPLETE");
  assert.match(v.headline, /incomplete/i);
});

test("several serious findings give HIGH and ranked advice", () => {
  const v = verdictFor(
    response([
      finding({ id: "f1", category: "location" }),
      finding({ id: "f2", category: "routine_schedule", evidence: [{ sourceId: "caption", quote: "every weekday", verified: true }] }),
      finding({ id: "f3", category: "routine_schedule", severity: "medium", evidence: [{ sourceId: "caption", quote: "6pm", verified: true }] }),
    ]),
    sources,
  );
  assert.equal(v.stamp, "HIGH");
  assert.ok(v.score >= 50);
  assert.ok(v.advice.length >= 2);
  assert.ok(v.advice.length <= 4);
});

// --- one serious finding is enough (risk score update) ------------------------------

test("a post whose only problem is a Social Security number is HIGH, not MEDIUM", () => {
  // Reported case: one high-severity identity finding used to score 30 / MEDIUM.
  const ssn = finding({ category: "identity", severity: "high", confidence: "high", evidence: [{ sourceId: "caption", quote: "676-76-6969", verified: true }] });
  const v = verdictFor(response([ssn]), [{ id: "caption", type: "caption", text: "My social security number is: 676-76-6969" }]);
  assert.ok(v.score >= 75, `score was ${v.score}`);
  assert.equal(v.stamp, "HIGH");
});

test("any single high-severity finding reaches HIGH", () => {
  const v = verdictFor(response([finding({ category: "location", severity: "high" })]), sources);
  assert.ok(v.score >= 50, `score was ${v.score}`);
  assert.equal(v.stamp, "HIGH");
});

test("card numbers, health details and children count as sensitive too", () => {
  for (const category of ["financial", "health", "children"] as const) {
    const v = verdictFor(response([finding({ category, severity: "high" })]), sources);
    assert.ok(v.score >= 75, `${category}: score was ${v.score}`);
  }
});

test("a single medium finding is MEDIUM; a single low one stays LOW", () => {
  assert.equal(verdictFor(response([finding({ severity: "medium" })]), sources).stamp, "MEDIUM");
  assert.equal(verdictFor(response([finding({ severity: "low" })]), sources).stamp, "LOW");
});

test("when the AI isn't sure, the minimum is halved (no scare from a guess)", () => {
  const unsure = verdictFor(response([finding({ category: "identity", severity: "high", confidence: "low" })]), sources);
  assert.ok(unsure.score < 75, `score was ${unsure.score}`);
  assert.ok(unsure.score >= 37);
});

test("an incomplete check is still stamped INCOMPLETE, even with a severe finding", () => {
  const v = verdictFor(response([finding({ category: "identity", severity: "high" })], 1), sources);
  assert.equal(v.stamp, "INCOMPLETE");
});
