// End-to-end tests of the backend's HTTP routes (app.ts), with fake parts:
// a fake analyzer instead of Databricks, and the in-memory history store.
// Covers: history isolation between users, approvals, drafts vs. published
// posts, deletion/revocation, history in analysis, and "never fall back to
// mock results after a live failure".
// Run with: npm test   (in the backend folder)
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { CONTRACT_VERSION, USER_ID_HEADER, type TextSource } from "../../shared/contract";
import { createApp, type AppDeps } from "../src/app";
import { AppError } from "../src/errors";
import { DevMemoryHistoryStore } from "../src/history/memoryStore";
import { parseModelOutput } from "../src/parse";

const ALICE = "alice_user_0001";
const BOB = "bob_user_000002";
const HASH = "a".repeat(64);

// --- A test server whose analyzer we can swap per test ---------------------------

let analyzer: AppDeps["analyze"];
// The fake model used to build the profile; null = like practice mode.
let extractor: ((messages: { role: string; content: string }[]) => Promise<string>) | null = null;
let extractCalls = 0;
let lastSources: TextSource[] = [];
let lastTask: string | undefined;
let store: DevMemoryHistoryStore;
let baseUrl = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
// Resolves when the AI interpretations saved after a reply are stored.
let waitForSaves: () => Promise<unknown>;

before(async () => {
  store = new DevMemoryHistoryStore();
  const app = createApp({
    mode: "databricks",
    model: "gpt-oss-120b",
    promptVersion: "test",
    analyze: (sources, task) => {
      lastSources = sources;
      lastTask = task;
      return analyzer(sources);
    },
    get historyStore() {
      return store;
    },
    get extractFacts() {
      return extractor
        ? (messages: { role: string; content: string }[]) => {
            extractCalls++;
            return extractor!(messages);
          }
        : null;
    },
    getDatabricksStatus: () => ({ state: "configured_unverified", lastCallAt: null, lastError: null }),
  } as AppDeps);
  waitForSaves = app.locals.waitForPendingSaves;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  store = new DevMemoryHistoryStore();
  lastSources = [];
  lastTask = undefined;
  analyzer = async () => ({ summary: "ok", findings: [], droppedFindings: 0 });
});

async function call(method: string, path: string, user: string | null, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (user) headers[USER_ID_HEADER] = user;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

function post(postId: string, caption: string, publishedAt = "2026-10-01T12:00:00Z") {
  return { postId, status: "published", publishedAt, caption };
}

function importBody(posts: any[], approvedIds = posts.map((p) => p.postId)) {
  return { contractVersion: CONTRACT_VERSION, approval: { approved: true, postIds: approvedIds }, posts };
}

function analyzeBody(caption: string, historyPostIds?: string[]) {
  return {
    contractVersion: CONTRACT_VERSION,
    draftHash: HASH,
    sources: [{ id: "caption", type: "caption", text: caption }],
    ...(historyPostIds ? { historyPostIds } : {}),
  };
}

function suggestBody(caption: string) {
  return { contractVersion: CONTRACT_VERSION, sources: [{ id: "caption", type: "caption", text: caption }] };
}

// --- Approval and drafts ------------------------------------------------------------

test("imports only explicitly approved, published posts", async () => {
  const ok = await call("POST", "/api/history/import", ALICE, importBody([post("p1", "Soccer at Riverside field")]));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.imported, 1);
  assert.equal(ok.body.store, "dev-memory");
  assert.match(ok.body.approvalId, /^[a-f0-9-]{36}$/);

  const notApproved = importBody([post("p2", "x")]);
  (notApproved.approval as any).approved = false;
  assert.equal((await call("POST", "/api/history/import", ALICE, notApproved)).status, 400);

  const mismatch = importBody([post("p3", "x"), post("p4", "y")], ["p3"]);
  assert.equal((await call("POST", "/api/history/import", ALICE, mismatch)).status, 400);

  const draft = importBody([{ ...post("p5", "x"), status: "draft" }]);
  const draftRes = await call("POST", "/api/history/import", ALICE, draft);
  assert.equal(draftRes.status, 400);
  assert.match(draftRes.body.error.message, /Drafts are never stored/);

  assert.deepEqual(
    (await call("GET", "/api/history", ALICE)).body.posts.map((p: any) => p.postId),
    ["p1"],
  );
});

test("history routes require a valid user id", async () => {
  assert.equal((await call("GET", "/api/history", null)).status, 400);
  assert.equal((await call("GET", "/api/history", "short")).status, 400);
  assert.equal((await call("POST", "/api/history/import", null, importBody([post("p1", "x")]))).status, 400);
});

test("history sources cannot be sent with a draft", async () => {
  const body = analyzeBody("hello");
  (body.sources as any[]).push({ id: "history:p1", type: "history", text: "sneaky", date: "2026-01-01" });
  const res = await call("POST", "/api/analyze", ALICE, body);
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /history can't be sent with a draft/);
});

// --- Isolation -------------------------------------------------------------------------

test("one user can never see, use or delete another user's history", async () => {
  const a = await call("POST", "/api/history/import", ALICE, importBody([post("shared-id", "Alice at Maple Street")]));
  await call("POST", "/api/history/import", BOB, importBody([post("bob-1", "Bob at the lake")]));

  // Listing
  assert.deepEqual((await call("GET", "/api/history", BOB)).body.posts.map((p: any) => p.postId), ["bob-1"]);

  // Analysis: Bob can use his own post, but naming Alice's post id is refused
  await call("POST", "/api/analyze", BOB, analyzeBody("Maple Street again", ["bob-1"]));
  assert.deepEqual(lastSources.map((s) => s.id), ["caption", "history:bob-1"]);
  lastSources = [];
  const stolen = await call("POST", "/api/analyze", BOB, analyzeBody("Maple Street again", ["shared-id"]));
  assert.equal(stolen.status, 400);
  assert.match(stolen.body.error.message, /not in your approved history/);
  assert.deepEqual(lastSources, [], "nothing was analyzed");

  // Suggestions only ever list the caller's own posts
  const suggested = await call("POST", "/api/history/suggest", BOB, suggestBody("Maple Street again"));
  assert.deepEqual(suggested.body.suggestions.map((s: any) => s.postId), ["bob-1"]);

  // Deleting / revoking with Alice's ids as Bob does nothing to Alice
  assert.equal((await call("DELETE", "/api/history/posts/shared-id", BOB)).status, 404);
  assert.equal((await call("POST", `/api/history/approvals/${a.body.approvalId}/revoke`, BOB)).status, 404);
  await call("DELETE", "/api/history", BOB);
  assert.equal((await call("GET", "/api/history", ALICE)).body.posts.length, 1);
});

// --- Deletion and revocation ----------------------------------------------------------

test("revoking an approval deletes its posts and the AI interpretations derived from them", async () => {
  const first = await call("POST", "/api/history/import", ALICE, importBody([post("p1", "Lincoln Elementary pickup")]));
  await call("POST", "/api/history/import", ALICE, importBody([post("p2", "Beach day")]));

  // An AI finding that relies on a verified quote from p1 gets stored separately.
  analyzer = async (sources) =>
    parseModelOutput(
      JSON.stringify({
        summary: "s",
        findings: [
          {
            category: "children",
            severity: "high",
            exposure: "Shows a school pickup routine.",
            evidence: [
              { sourceId: "caption", quote: "pickup" },
              { sourceId: "history:p1", quote: "Lincoln Elementary" },
            ],
            confidence: "medium",
            uncertainty: "",
            suggestedEdits: [],
          },
        ],
      }),
      sources,
    );
  const analysis = await call("POST", "/api/analyze", ALICE, analyzeBody("Same pickup at Lincoln Elementary", ["p1", "p2"]));
  assert.equal(analysis.status, 200);
  assert.equal(analysis.body.findings[0].crossSource, true);
  assert.ok(analysis.body.historyUsed.some((h: any) => h.postId === "p1"));

  await waitForSaves(); // interpretations are saved after the reply
  const interpretations = await store.listInterpretations(ALICE);
  assert.equal(interpretations.length, 1);
  assert.deepEqual(interpretations[0].postIds, ["p1"]);
  // Observed posts are untouched by saving interpretations.
  assert.equal((await store.listPosts(ALICE)).length, 2);

  const revoked = await call("POST", `/api/history/approvals/${first.body.approvalId}/revoke`, ALICE);
  assert.deepEqual(
    { posts: revoked.body.deletedPosts, interpretations: revoked.body.deletedInterpretations },
    { posts: 1, interpretations: 1 },
  );
  assert.deepEqual((await call("GET", "/api/history", ALICE)).body.posts.map((p: any) => p.postId), ["p2"]);

  // A consent screen opened before the revoke still lists p1: that check is refused.
  const afterRevoke = await call("POST", "/api/analyze", ALICE, analyzeBody("Same pickup", ["p1", "p2"]));
  assert.equal(afterRevoke.status, 400);
});

test("deleting one post, then everything", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "a"), post("p2", "b")]));
  assert.equal((await call("DELETE", "/api/history/posts/p1", ALICE)).body.deletedPosts, 1);
  assert.equal((await call("DELETE", "/api/history/posts/p1", ALICE)).status, 404);
  assert.equal((await call("DELETE", "/api/history", ALICE)).body.deletedPosts, 1);
  assert.equal((await call("GET", "/api/history", ALICE)).body.posts.length, 0);
});

// --- History in analysis -------------------------------------------------------------

test("suggest ranks approved posts for pre-selection and analyzes nothing", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([
    post("old-beach", "Beach day", "2025-06-01T10:00:00Z"),
    post("soccer", "Riverside soccer practice", "2026-09-01T10:00:00Z"),
  ]));
  let analyzed = false;
  analyzer = async () => {
    analyzed = true;
    return { summary: "", findings: [], droppedFindings: 0 };
  };
  const res = await call("POST", "/api/history/suggest", ALICE, suggestBody("Riverside soccer again"));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.suggestions, [
    { postId: "soccer", publishedAt: "2026-09-01T10:00:00.000Z", sharedWords: 2 },
    { postId: "old-beach", publishedAt: "2025-06-01T10:00:00.000Z", sharedWords: 0 },
  ]);
  assert.equal(analyzed, false, "suggest must not call the model");
  assert.equal((await call("POST", "/api/history/suggest", null, suggestBody("x"))).status, 400);
});

test("analysis uses EXACTLY the chosen posts, in order, with ids and dates", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([
    post("old-beach", "Beach day", "2025-06-01T10:00:00Z"),
    post("soccer", "Riverside soccer practice", "2026-09-01T10:00:00Z"),
    post("cafe", "Coffee downtown", "2026-08-01T10:00:00Z"),
  ]));

  await call("POST", "/api/analyze", ALICE, analyzeBody("Riverside soccer again"));
  assert.deepEqual(lastSources.map((s) => s.id), ["caption"], "no history unless chosen");

  // The user kept only old-beach and soccer (not the order relevance would pick).
  const res = await call("POST", "/api/analyze", ALICE, analyzeBody("Riverside soccer again", ["old-beach", "soccer"]));
  assert.deepEqual(lastSources.map((s) => s.id), ["caption", "history:old-beach", "history:soccer"]);
  assert.equal(lastSources[2].type, "history");
  assert.equal(lastSources[2].date, "2026-09-01T10:00:00.000Z");
  assert.deepEqual(res.body.historyUsed.map((h: any) => h.postId), ["old-beach", "soccer"]);
});

test("bad history choices are refused before anything is analyzed", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "a")]));
  lastSources = [];
  assert.equal((await call("POST", "/api/analyze", null, analyzeBody("hi", ["p1"]))).status, 400, "needs a user id");
  assert.equal((await call("POST", "/api/analyze", ALICE, analyzeBody("hi", ["nope"]))).status, 400, "unknown post");
  assert.equal((await call("POST", "/api/analyze", ALICE, analyzeBody("hi", ["p1", "p1"]))).status, 400, "duplicate");
  const nine = Array.from({ length: 9 }, (_, i) => `q${i}`);
  assert.equal((await call("POST", "/api/analyze", ALICE, analyzeBody("hi", nine))).status, 400, "more than 8");
  const oldStyle = { ...analyzeBody("hi"), includeHistory: true };
  assert.equal((await call("POST", "/api/analyze", ALICE, oldStyle)).status, 400, "old includeHistory field");
  assert.deepEqual(lastSources, []);
});

// --- Live failures are errors, never mock results ------------------------------------

test("a failed Databricks call returns an error, not substitute findings", async () => {
  analyzer = async () => {
    throw new AppError("UPSTREAM_AUTH", 502, "Databricks redirected to its browser login (HTTP 302).");
  };
  const res = await call("POST", "/api/analyze", ALICE, analyzeBody("Picking up Emma at Lincoln Elementary"));
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, "UPSTREAM_AUTH");
  assert.equal(res.body.findings, undefined, "no findings of any kind on failure");
});

test("invalid model output is an error; unsupported evidence is dropped and reported", async () => {
  analyzer = async (sources) => parseModelOutput(JSON.stringify({ summary: "fine" }), sources);
  const bad = await call("POST", "/api/analyze", ALICE, analyzeBody("hello"));
  assert.equal(bad.status, 502);
  assert.equal(bad.body.error.code, "BAD_MODEL_OUTPUT");

  analyzer = async (sources) =>
    parseModelOutput(
      JSON.stringify({
        summary: "s",
        findings: [{ category: "location", severity: "high", exposure: "x", evidence: [{ sourceId: "caption", quote: "123 Fake St" }] }],
      }),
      sources,
    );
  const unsupported = await call("POST", "/api/analyze", ALICE, analyzeBody("hello there"));
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.body.findings.length, 0);
  assert.equal(unsupported.body.droppedFindings, 1);
});

test("health reports the history store and contract version", async () => {
  const res = await call("GET", "/api/health", null);
  assert.equal(res.body.contractVersion, CONTRACT_VERSION);
  assert.deepEqual(res.body.history, { store: "dev-memory" });
});

// --- Saving AI interpretations after the reply --------------------------------

/** An analyzer whose one finding quotes earlier post p1. */
function findingFromP1(): AppDeps["analyze"] {
  return async (sources) =>
    parseModelOutput(
      JSON.stringify({
        summary: "s",
        findings: [
          {
            category: "children",
            severity: "high",
            exposure: "Names a school.",
            evidence: [{ sourceId: "history:p1", quote: "Lincoln Elementary" }],
            confidence: "medium",
            uncertainty: "",
            suggestedEdits: [],
          },
        ],
      }),
      sources,
    );
}

/** Makes the store's saveInterpretations wait until release() is called. */
function holdSaves() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const realSave = store.saveInterpretations.bind(store);
  let started = 0;
  store.saveInterpretations = async (userId, items) => {
    started++;
    await gate;
    return realSave(userId, items);
  };
  return { release, started: () => started };
}

test("analysis replies without waiting for interpretations to be saved", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "Lincoln Elementary pickup")]));
  analyzer = findingFromP1();
  const saves = holdSaves();

  // The save is stuck, yet the user still gets their results.
  const analysis = await call("POST", "/api/analyze", ALICE, analyzeBody("At school", ["p1"]));
  assert.equal(analysis.status, 200);
  assert.equal(analysis.body.findings.length, 1);
  assert.equal(saves.started(), 1);
  assert.equal((await store.listInterpretations(ALICE)).length, 0);

  saves.release();
  await waitForSaves();
  assert.equal((await store.listInterpretations(ALICE)).length, 1);
});

test("deleting history waits for a pending save, so no interpretation of a deleted post is left behind", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "Lincoln Elementary pickup")]));
  analyzer = findingFromP1();
  const saves = holdSaves();
  assert.equal((await call("POST", "/api/analyze", ALICE, analyzeBody("At school", ["p1"]))).status, 200);

  // Delete while the save is still running; release the save shortly after.
  const deleting = call("DELETE", "/api/history", ALICE);
  setTimeout(saves.release, 20);
  const deleted = await deleting;
  assert.equal(deleted.status, 200);
  assert.deepEqual({ posts: deleted.body.deletedPosts, interpretations: deleted.body.deletedInterpretations }, { posts: 1, interpretations: 1 });
  await waitForSaves();
  assert.equal((await store.listInterpretations(ALICE)).length, 0);
});

test("a failed interpretation save does not affect the analysis reply", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "Lincoln Elementary pickup")]));
  analyzer = findingFromP1();
  store.saveInterpretations = async () => {
    throw new AppError("UPSTREAM_ERROR", 502, "database down");
  };
  const analysis = await call("POST", "/api/analyze", ALICE, analyzeBody("At school", ["p1"]));
  assert.equal(analysis.status, 200);
  assert.equal(analysis.body.findings.length, 1);
  await waitForSaves(); // the failure is logged, not thrown
  assert.equal((await call("GET", "/api/history", ALICE)).body.posts.length, 1);
});

// --- The profile ("portfolio") ------------------------------------------------------

/** A fake model: finds facts by looking for known words in each post. */
function fakeFactModel(messages: { role: string; content: string }[]): Promise<string> {
  const json = messages[1].content.split("<posts>\n")[1].split("\n</posts>")[0];
  const posts = JSON.parse(json) as { id: string; text: string }[];
  const facts = [];
  for (const p of posts) {
    if (p.text.includes("Sarah")) facts.push({ postId: p.id, category: "identity", severity: "medium", fact: "First name: Sarah", quote: "Sarah" });
    if (p.text.includes("Lincoln Park")) facts.push({ postId: p.id, category: "children", severity: "high", fact: "School: Lincoln Park", quote: "Lincoln Park" });
    // An invented fact (quote not in the post): must be dropped.
    if (p.text.includes("Beach")) facts.push({ postId: p.id, category: "location", severity: "low", fact: "Invented place", quote: "Not in the post" });
  }
  return Promise.resolve(JSON.stringify({ facts }));
}

const SCAN = { contractVersion: CONTRACT_VERSION };

test("profile: scanning finds verified facts, marks posts scanned, and isn't repeated", async () => {
  extractor = fakeFactModel;
  extractCalls = 0;
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "So proud of Sarah at her recital"), post("p2", "Beach day"), post("p3", "First day at Lincoln Park")]));
  const scan = await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  assert.equal(scan.status, 200);
  assert.deepEqual(
    { now: scan.body.scannedNow, done: scan.body.scannedPosts, left: scan.body.remaining, facts: scan.body.facts },
    { now: 3, done: 3, left: 0, facts: 2 },
  );
  const profile = await call("GET", "/api/history/portfolio", ALICE);
  assert.deepEqual(profile.body.facts.map((f: any) => f.fact).sort(), ["First name: Sarah", "School: Lincoln Park"], "the invented fact was dropped");
  const before = extractCalls;
  const again = await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  assert.equal(again.body.scannedNow, 0, "nothing left to scan");
  assert.equal(extractCalls, before, "no more model calls");
  extractor = null;
});

test("profile: many posts are scanned a few batches per request until none remain", async () => {
  extractor = fakeFactModel;
  const many = Array.from({ length: 20 }, (_, i) => post(`m${i}`, `Post number ${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`));
  await call("POST", "/api/history/import", ALICE, importBody(many));
  const first = await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  assert.equal(first.body.scannedNow, 16, "two batches of 8 per request");
  assert.equal(first.body.remaining, 4);
  const second = await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  assert.equal(second.body.remaining, 0);
  extractor = null;
});

test("profile: deleting a post removes its facts; the rest of its batch is scanned again", async () => {
  extractor = fakeFactModel;
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "So proud of Sarah"), post("p3", "First day at Lincoln Park")]));
  await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  await call("DELETE", "/api/history/posts/p1", ALICE);
  const after = await call("GET", "/api/history/portfolio", ALICE);
  assert.equal(after.body.facts.some((f: any) => f.fact === "First name: Sarah"), false);
  assert.equal(after.body.scannedPosts, 0, "p3 shared the batch, so it's unscanned again");
  const rescan = await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  assert.equal(rescan.body.facts, 1);
  extractor = null;
});

test("profile: users are isolated, and practice mode refuses to build one", async () => {
  extractor = fakeFactModel;
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "So proud of Sarah")]));
  await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  assert.equal((await call("GET", "/api/history/portfolio", BOB)).body.facts.length, 0);
  extractor = null;
  const refused = await call("POST", "/api/history/portfolio/scan", BOB, SCAN);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /live AI/);
});

test("checks with usePortfolio add ONE profile source with every fact and its quote", async () => {
  extractor = fakeFactModel;
  await call("POST", "/api/history/import", ALICE, importBody([post("p1", "So proud of Sarah at her recital", "2026-03-09T12:00:00Z")]));
  await call("POST", "/api/history/portfolio/scan", ALICE, SCAN);
  const res = await call("POST", "/api/analyze", ALICE, { ...analyzeBody("Go Mitchells! Big recital tonight"), usePortfolio: true });
  assert.equal(res.status, 200);
  const profile = lastSources.find((src) => src.id === "profile");
  assert.ok(profile, "profile source added");
  assert.ok(profile!.text.includes('2026-03-09 · First name: Sarah · "Sarah"'), profile!.text);
  assert.deepEqual(res.body.portfolioUsed, { facts: 1, posts: 1 });
  await call("POST", "/api/analyze", ALICE, analyzeBody("Go Mitchells!"));
  assert.equal(lastSources.some((src) => src.id === "profile"), false, "no profile without the flag");
  extractor = null;
});

test("usePortfolio needs a user id and must be true or false", async () => {
  assert.equal((await call("POST", "/api/analyze", null, { ...analyzeBody("hi"), usePortfolio: true })).status, 400);
  assert.equal((await call("POST", "/api/analyze", ALICE, { ...analyzeBody("hi"), usePortfolio: "yes" })).status, 400);
});

// --- Assessing saved posts together (POST /api/history/assess) ------------------------

function assessBody(postIds: unknown) {
  return { contractVersion: CONTRACT_VERSION, postIds };
}

test("assess: the chosen saved posts are analyzed together, as history, and cross-post findings come back", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([
    post("p1", "So proud of Mia on her first day!", "2026-09-01T08:00:00Z"),
    post("p2", "Pickup at Lincoln Elementary at 3pm", "2026-09-10T15:00:00Z"),
    post("p3", "Beach day", "2026-09-20T12:00:00Z"),
  ]));
  analyzer = async (sources) =>
    parseModelOutput(
      JSON.stringify({
        summary: "Together these posts name a child and her school pickup time.",
        findings: [{
          category: "children", severity: "high", exposure: "A child's first name, school and pickup time.",
          evidence: [{ sourceId: "history:p1", quote: "Mia" }, { sourceId: "history:p2", quote: "Lincoln Elementary at 3pm" }],
          confidence: "medium", uncertainty: "Assumes Mia goes to that school.", suggestedEdits: [],
        }],
      }),
      sources,
    );
  const res = await call("POST", "/api/history/assess", ALICE, assessBody(["p2", "p1"]));
  assert.equal(res.status, 200);
  assert.equal(lastTask, "history");
  assert.deepEqual(lastSources.map((s) => [s.id, s.type]), [["history:p2", "history"], ["history:p1", "history"]], "exactly the chosen posts, in order");
  assert.deepEqual(res.body.postsAssessed.map((p: any) => p.postId), ["p2", "p1"]);
  assert.equal(res.body.findings.length, 1);
  assert.equal(res.body.findings[0].crossSource, true);
  assert.equal(res.body.mode, "databricks");

  // The AI conclusion is kept with the posts it came from, and deleted with them.
  await waitForSaves();
  assert.equal((await store.listInterpretations(ALICE)).length, 1);
  await call("DELETE", "/api/history/posts/p1", ALICE);
  assert.equal((await store.listInterpretations(ALICE)).length, 0);
});

test("assess: refuses other users' posts, unknown ids, duplicates, too many, and a missing user id", async () => {
  await call("POST", "/api/history/import", ALICE, importBody([post("a1", "Alice at Maple Street")]));
  await call("POST", "/api/history/import", BOB, importBody([post("b1", "Bob at the lake")]));

  const stolen = await call("POST", "/api/history/assess", BOB, assessBody(["b1", "a1"]));
  assert.equal(stolen.status, 400);
  assert.match(stolen.body.error.message, /not in your saved history/);
  assert.deepEqual(lastSources, [], "nothing was analyzed");

  assert.equal((await call("POST", "/api/history/assess", BOB, assessBody([]))).status, 400);
  assert.equal((await call("POST", "/api/history/assess", BOB, assessBody(["b1", "b1"]))).status, 400);
  const many = Array.from({ length: 21 }, (_, i) => `x${i}`);
  assert.match((await call("POST", "/api/history/assess", BOB, assessBody(many))).body.error.message, /at most 20/);
  assert.equal((await call("POST", "/api/history/assess", null, assessBody(["b1"]))).status, 400);
  assert.equal((await call("POST", "/api/history/assess", BOB, { ...assessBody(["b1"]), sources: [] })).status, 400, "no extra fields");
});

test("an unknown /api route gets a JSON error saying to restart an updated backend", async () => {
  const res = await call("POST", "/api/history/no-such-thing", ALICE, { contractVersion: CONTRACT_VERSION });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "NOT_FOUND");
  assert.match(res.body.error.message, /no POST \/api\/history\/no-such-thing.*restart the backend/);
});
