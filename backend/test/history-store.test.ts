// Tests for the Databricks App history store (appStore.ts) against a FAKE app,
// plus relevance selection. These check our side of the API spec in
// docs/DATABRICKS_APP_API.md; they do not prove the real app works.
// Run with: npm test   (in the backend folder)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LIMITS, type StoredHistoryPost } from "../../shared/contract";
import { PatTokenProvider } from "../src/auth";
import { DatabricksClient } from "../src/databricks";
import { AppError } from "../src/errors";
import { APP_HISTORY_PATHS, DatabricksAppHistoryStore } from "../src/history/appStore";
import { buildHistorySources, suggestHistory } from "../src/history/relevance";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function store() {
  return new DatabricksAppHistoryStore(new DatabricksClient({ host: "https://app.example.test", tokenProvider: new PatTokenProvider("t") }));
}

function stored(postId: string, caption: string, publishedAt: string): StoredHistoryPost {
  return { postId, status: "published", publishedAt, caption, approvalId: "00000000-0000-0000-0000-000000000000", importedAt: publishedAt };
}

test("app store uses POST /api/ routes with the user id in the body, never the URL", async () => {
  const seen: Array<{ url: string; method: string; body: any }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ posts: [] }), { status: 200 });
  }) as typeof fetch;
  await store().listPosts("alice_user_0001");
  assert.equal(seen[0].url, `https://app.example.test${APP_HISTORY_PATHS.list}`);
  assert.equal(seen[0].method, "POST");
  assert.ok(seen[0].url.includes("/api/"));
  assert.ok(!seen[0].url.includes("alice"));
  assert.deepEqual(seen[0].body, { userId: "alice_user_0001" });
});

test("an unexpected app response is an error, not an empty history", async () => {
  for (const body of [{}, { posts: "none" }, { posts: [{ postId: 1 }] }, { posts: [{ ...stored("p", "c", "2026-01-01"), status: "draft" }] }]) {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    await assert.rejects(store().listPosts("alice_user_0001"), (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR");
  }
});

test("app store reports a missing approval as not found and counts deletions", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ found: false }), { status: 200 })) as typeof fetch;
  assert.equal(await store().revokeApproval("alice_user_0001", "00000000-0000-0000-0000-000000000000"), null);

  globalThis.fetch = (async () => new Response(JSON.stringify({ deletedPosts: 2, deletedInterpretations: 1 }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await store().deleteAll("alice_user_0001"), { deletedPosts: 2, deletedInterpretations: 1 });
});

test("an import the app only partly stored is an error", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ imported: 1 }), { status: 200 })) as typeof fetch;
  const posts = [
    { postId: "a", status: "published" as const, publishedAt: "2026-01-01T00:00:00Z", caption: "x" },
    { postId: "b", status: "published" as const, publishedAt: "2026-01-02T00:00:00Z", caption: "y" },
  ];
  await assert.rejects(store().importPosts("alice_user_0001", "00000000-0000-0000-0000-000000000000", "2026-01-03T00:00:00Z", posts));
});

// --- Relevance (suggestions only) and building the user's exact choice ---------------

test("suggestions: shared words first, then most recent; at most 8", () => {
  const draft = [{ id: "caption", type: "caption" as const, text: "Back at Riverside soccer field" }];
  const posts = [
    stored("beach", "Beach day", "2026-09-30T00:00:00Z"),
    stored("soccer", "Riverside soccer tournament", "2025-01-01T00:00:00Z"),
    stored("cafe", "Coffee downtown", "2026-08-01T00:00:00Z"),
  ];
  const ranked = suggestHistory(draft, posts);
  assert.deepEqual(ranked.map((r) => r.post.postId), ["soccer", "beach", "cafe"]);
  assert.equal(ranked[0].sharedWords, 2);

  const many = Array.from({ length: 20 }, (_, i) => stored(`q${i}`, "short", "2026-01-01T00:00:00Z"));
  assert.equal(suggestHistory(draft, many).length, 8);
});

test("the user's chosen posts become sources in their order, with ids and dates", () => {
  const draft = [{ id: "caption", type: "caption" as const, text: "hello" }];
  const chosen = [stored("b", "Second", "2026-02-01T00:00:00Z"), stored("a", "First", "2026-01-01T00:00:00Z")];
  const { sources, used } = buildHistorySources(draft, chosen);
  assert.deepEqual(sources.map((s) => [s.id, s.type, s.date]), [
    ["history:b", "history", "2026-02-01T00:00:00Z"],
    ["history:a", "history", "2026-01-01T00:00:00Z"],
  ]);
  assert.deepEqual(used.map((u) => u.postId), ["b", "a"]);
});

test("a choice that breaks the limits is refused, never trimmed silently", () => {
  const isBadRequest = (err: unknown) => err instanceof AppError && err.code === "BAD_REQUEST";
  const draft = [{ id: "caption", type: "caption" as const, text: "x".repeat(LIMITS.maxTotalChars - 6000) }];
  const twoLong = [stored("p1", "y".repeat(4000), "2026-01-01T00:00:00Z"), stored("p2", "y".repeat(4000), "2026-01-02T00:00:00Z")];
  assert.throws(() => buildHistorySources(draft, twoLong), isBadRequest);
  assert.equal(buildHistorySources(draft, twoLong.slice(0, 1)).sources.length, 1);

  const nine = Array.from({ length: 9 }, (_, i) => stored(`q${i}`, "short", "2026-01-01T00:00:00Z"));
  assert.throws(() => buildHistorySources([{ id: "caption", type: "caption", text: "hi" }], nine), isBadRequest);
});
