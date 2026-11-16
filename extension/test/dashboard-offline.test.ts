// Tests for the dashboard's offline mode (src/dashboard/offline.ts):
// keyword rules in the page, no backend, no AI.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextSource } from "../../shared/contract";
import { analyzeOffline, OFFLINE_EXAMPLES } from "../src/dashboard/offline";
import { buildReport, type AnalyzedPost } from "../src/dashboard/report";

const caption = (text: string): TextSource[] => [{ id: "caption", type: "caption", text }];

test("offline results are clearly marked as not AI", () => {
  const result = analyzeOffline(caption("Running down Maple St every weekday"), [], "hash");
  assert.equal(result.mode, "mock");
  assert.equal(result.model, null);
  assert.equal(result.draftHash, "hash");
  assert.ok(result.findings.length > 0);
});

test("every offline quote really appears in the post", () => {
  for (const ex of OFFLINE_EXAMPLES) {
    const sources: TextSource[] = caption(ex.caption);
    if (ex.imageText) sources.push({ id: "image_text:1", type: "image_text", text: ex.imageText });
    const result = analyzeOffline(sources, [], "h");
    for (const f of result.findings) {
      for (const ev of f.evidence) {
        const text = sources.find((s) => s.id === ev.sourceId)!.text;
        assert.ok(ev.verified && text.includes(ev.quote), `"${ev.quote}" in ${ex.name}`);
      }
    }
  }
});

test("a post with nothing risky gives no findings (and is not an error)", () => {
  const result = analyzeOffline(caption("Lovely sunset tonight"), [], "h");
  assert.equal(result.findings.length, 0);
  assert.equal(result.droppedFindings, 0);
});

test("a rule matching an earlier check becomes a cross-post finding", () => {
  const earlier = [{ historyId: "check-1", text: "Morning run down Maple St again", date: "2026-11-01T00:00:00Z" }];
  const result = analyzeOffline(caption("Coffee on Maple St before class"), earlier, "h");
  const street = result.findings.find((f) => f.category === "location")!;
  assert.ok(street.evidence.some((ev) => ev.sourceId === "history:check-1"));
  assert.ok(street.exposure.startsWith("The same kind of detail also appears in 1 earlier post."));
  // Edits are only suggested for the post being checked, never for old posts.
  assert.ok(street.suggestedEdits.every((e) => e.sourceId === "caption"));
});

test("matches only in earlier posts are not reported again", () => {
  const earlier = [{ historyId: "check-1", text: "Call me at 608-555-0199", date: "2026-11-01T00:00:00Z" }];
  const result = analyzeOffline(caption("Lovely sunset tonight"), earlier, "h");
  assert.equal(result.findings.length, 0);
});

test("the dashboard links offline checks into cross-post patterns", () => {
  const first = caption(OFFLINE_EXAMPLES[0].caption);
  const second = caption(OFFLINE_EXAMPLES[1].caption);
  const post1: AnalyzedPost = {
    id: "check-1",
    historyPostId: "check-1",
    title: "one",
    date: "2026-11-01T00:00:00Z",
    sources: first,
    engine: "offline",
    result: analyzeOffline(first, [], "h1"),
  };
  const post2: AnalyzedPost = {
    id: "check-2",
    historyPostId: "check-2",
    title: "two",
    date: "2026-11-02T00:00:00Z",
    sources: second,
    engine: "offline",
    result: analyzeOffline(second, [{ historyId: "check-1", text: first[0].text, date: post1.date }], "h2"),
  };
  const report = buildReport([post1, post2]);
  assert.ok(report.crossPost.length >= 1);
  assert.deepEqual(report.crossPost[0].postIds, ["check-1", "check-2"]);
});

test("keyword-rule and sample results are never labeled as AI", async () => {
  // view.ts needs a DOM only when drawing, so importing it here is fine.
  const { interpretationLabel } = await import("../src/dashboard/view");
  const { SAMPLE_POSTS } = await import("../src/dashboard/sample-data");
  const offline = analyzeOffline(caption("Maple St"), [], "h");
  const base = { id: "c", title: "c", date: "2026-11-01T00:00:00Z", sources: caption("Maple St") };
  assert.equal(interpretationLabel({ ...base, result: offline, engine: "offline" }), "Keyword rule · no AI");
  assert.equal(interpretationLabel({ ...base, result: offline, engine: "backend" }), "Practice mode · keyword rules");
  assert.equal(interpretationLabel(SAMPLE_POSTS[0]), "Sample · written by hand");
  assert.equal(
    interpretationLabel({ ...base, result: { ...offline, mode: "databricks" }, engine: "backend" }),
    "AI interpretation",
  );
});
