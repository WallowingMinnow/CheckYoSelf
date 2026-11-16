// Tests for "Compare with my past posts" (src/compare.ts): what's pre-ticked,
// and how the earlier posts used by a check are shown next to the draft.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, HISTORY_LIMITS, type AnalyzeResponse, type StoredHistoryPost } from "../../shared/contract";
import { historySourcesFor, preselect, suggestionMeta } from "../src/compare";

const s = (postId: string, sharedWords: number) => ({ postId, publishedAt: "2024-03-09T12:00:00.000Z", sharedWords });

test("only posts sharing words with the draft are pre-ticked, at most the analysis limit", () => {
  assert.deepEqual(preselect([s("a", 3), s("b", 0), s("c", 1)]), ["a", "c"]);
  const many = Array.from({ length: 12 }, (_, i) => s(`p${i}`, 2));
  assert.equal(preselect(many).length, HISTORY_LIMITS.maxPostsPerAnalysis);
  assert.deepEqual(preselect([s("x", 0)]), [], "nothing related: nothing pre-ticked");
});

test("suggestion line says how related a post is", () => {
  const fmt = () => "Mar 9, 2024";
  assert.equal(suggestionMeta(s("a", 3), fmt), "Mar 9, 2024 · shares 3 words");
  assert.equal(suggestionMeta(s("a", 1), fmt), "Mar 9, 2024 · shares 1 word");
  assert.equal(suggestionMeta(s("a", 0), fmt), "Mar 9, 2024 · recent");
});

test("earlier posts used by a check are shown with the same text the backend checked", () => {
  const saved: StoredHistoryPost[] = [
    { postId: "p1", status: "published", publishedAt: "2024-03-09T12:00:00.000Z", caption: "First day at Lincoln Park Elementary!", imageText: "Room 12", approvalId: "a", importedAt: "x" },
    { postId: "p2", status: "published", publishedAt: "2024-01-01T12:00:00.000Z", caption: "Beach", approvalId: "a", importedAt: "x" },
  ];
  const result = {
    contractVersion: CONTRACT_VERSION, requestId: "r", draftHash: "h", mode: "databricks", model: "m", promptVersion: "v",
    analyzedAt: "t", summary: "", findings: [], droppedFindings: 0,
    historyUsed: [{ sourceId: "history:p1", postId: "p1", publishedAt: "2024-03-09T12:00:00.000Z" }, { sourceId: "history:gone", postId: "gone", publishedAt: "2024-01-01T00:00:00.000Z" }],
  } as AnalyzeResponse;
  assert.deepEqual(historySourcesFor(result, saved), [
    // Same format as backend/src/history/relevance.ts historySourceText().
    { id: "history:p1", type: "history", text: "First day at Lincoln Park Elementary!\nText in photo: Room 12", date: "2024-03-09T12:00:00.000Z" },
  ]);
});
