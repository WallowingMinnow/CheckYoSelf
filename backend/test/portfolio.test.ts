// Tests for the profile ("portfolio") rules in src/history/portfolio.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredHistoryPost } from "../../shared/contract";
import { batchToInterpretation, parseFacts, PORTFOLIO_VERSION, profileSource, readPortfolio, unscannedPosts } from "../src/history/portfolio";

function post(postId: string, caption: string, imageText?: string, publishedAt = "2026-03-09T12:00:00.000Z"): StoredHistoryPost {
  return { postId, status: "published", publishedAt, caption, ...(imageText ? { imageText } : {}), approvalId: "a", importedAt: "x" };
}
const P1 = post("p1", "So proud of Sarah at her recital!", "Lincoln Park Elementary");
const P2 = post("p2", "Beach day", undefined, "2026-01-01T12:00:00.000Z");

test("facts are kept only when their quote is really in that post (including its photo text)", () => {
  const raw = JSON.stringify({
    facts: [
      { postId: "p1", category: "identity", severity: "medium", fact: "First name: Sarah", quote: "Sarah" },
      { postId: "p1", category: "children", severity: "high", fact: "School: Lincoln Park Elementary", quote: "lincoln park elementary" },
      { postId: "p1", category: "identity", severity: "high", fact: "Last name: Mitchell", quote: "Mitchell" }, // not in p1
      { postId: "p2", category: "location", severity: "low", fact: "Beach", quote: "Sarah" }, // quote from another post
      { postId: "nope", category: "other", severity: "low", fact: "x", quote: "x" }, // unknown post
      "junk",
    ],
  });
  const facts = parseFacts(raw, [P1, P2]);
  assert.deepEqual(facts.map((f) => f.fact), ["First name: Sarah", "School: Lincoln Park Elementary"]);
});

test("an answer without a facts list is rejected; odd values are normalized", () => {
  assert.throws(() => parseFacts(JSON.stringify({ findings: [] }), [P1]));
  const [f] = parseFacts(JSON.stringify({ facts: [{ postId: "p1", category: "made-up", severity: "extreme", fact: "  First name: Sarah  ", quote: "Sarah" }] }), [P1]);
  assert.deepEqual({ category: f.category, severity: f.severity, fact: f.fact }, { category: "other", severity: "low", fact: "First name: Sarah" });
});

test("one stored row per batch marks every post in it scanned, even posts with no facts", () => {
  const facts = parseFacts(JSON.stringify({ facts: [{ postId: "p1", category: "identity", severity: "high", fact: "First name: Sarah", quote: "Sarah" }] }), [P1, P2]);
  const row = batchToInterpretation([P1, P2], facts, "m", "r");
  assert.equal(row.promptVersion, PORTFOLIO_VERSION);
  assert.deepEqual(row.postIds, ["p1", "p2"]);
  assert.equal(row.severity, "high");
  const back = readPortfolio([row], [P1, P2]);
  assert.deepEqual([...back.scannedPostIds].sort(), ["p1", "p2"]);
  assert.deepEqual(back.facts.map((f) => f.fact), ["First name: Sarah"]);
  // A batch with no facts still stores a row (with one quote, as the store requires).
  const empty = batchToInterpretation([P2], [], "m", "r");
  assert.equal(empty.evidence.length, 1);
  assert.deepEqual(readPortfolio([empty], [P2]).facts, []);
});

test("if a post of a batch is gone, the batch counts as unscanned (and its facts are dropped)", () => {
  const facts = parseFacts(JSON.stringify({ facts: [{ postId: "p2", category: "location", severity: "low", fact: "Place: beach", quote: "Beach" }] }), [P1, P2]);
  const row = batchToInterpretation([P1, P2], facts, "m", "r");
  const back = readPortfolio([row], [P2]); // p1 deleted
  assert.equal(back.scannedPostIds.size, 0);
  assert.deepEqual(back.facts, []);
  assert.deepEqual(unscannedPosts([P1, P2], back.scannedPostIds).map((p) => p.postId), ["p2", "p1"], "oldest first");
});

test("analysis interpretations (not the profile) are ignored", () => {
  const other = { ...batchToInterpretation([P1], [], "m", "r"), promptVersion: "2026-11-14.2" };
  assert.equal(readPortfolio([other], [P1]).scannedPostIds.size, 0);
});

test("the profile source lists date, fact and exact quote, oldest first; none without facts", () => {
  const facts = [
    { postId: "p1", category: "identity" as const, severity: "medium" as const, fact: "First name: Sarah", quote: "Sarah" },
    { postId: "p2", category: "location" as const, severity: "low" as const, fact: "Place: beach", quote: "Beach" },
  ];
  const src = profileSource(facts, [P1, P2])!;
  assert.equal(src.id, "profile");
  assert.equal(src.type, "history");
  assert.equal(src.text.split("\n").slice(1).join("\n"), '- 2026-01-01 · Place: beach · "Beach"\n- 2026-03-09 · First name: Sarah · "Sarah"');
  assert.equal(profileSource([], [P1]), null);
});
