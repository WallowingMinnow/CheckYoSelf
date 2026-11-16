// Regression tests for databricks.ts, using a fake fetch() so no real
// Databricks workspace or credentials are needed.
// Run with: npm test   (in the backend folder)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PatTokenProvider, type TokenProvider } from "../src/auth";
import { chat, DatabricksClient, invocationsPath, MAX_OUTPUT_TOKENS } from "../src/databricks";
import { AppError } from "../src/errors";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MESSAGES = [{ role: "user" as const, content: "Reply with OK." }];
const PATH = invocationsPath("/serving-endpoints/{endpoint}/invocations", "gpt-oss-120b");
const OK_BODY = JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }], model: "system.ai.gpt-oss-120b" });

function client(tokenProvider: TokenProvider = new PatTokenProvider("test-token")) {
  return new DatabricksClient({ host: "https://app.example.test", tokenProvider });
}

function isCode(code: string) {
  return (err: unknown) => err instanceof AppError && err.code === code;
}

/**
 * A fake fetch that answers headers right away, then sends the body slowly.
 * Like a real fetch, the body stream fails when the request is aborted.
 */
function fakeFetchWithSlowBody(bodyDelayMs: number, body: string, status = 200): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        }, bodyDelayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
    });
    return new Response(stream, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

// --- Request shape (matches the app handoff) ------------------------------------

test("sends the handoff's request: path, bearer token, messages, no redirect following", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(OK_BODY, { status: 200 });
  }) as typeof fetch;
  assert.equal(await chat(client(), PATH, MESSAGES, 1000), "OK");
  assert.equal(seen!.url, "https://app.example.test/serving-endpoints/gpt-oss-120b/invocations");
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, "Bearer test-token");
  assert.equal(seen!.init.redirect, "manual");
  assert.deepEqual(JSON.parse(seen!.init.body as string), { messages: MESSAGES, max_tokens: 4000, temperature: 0.1 });
});

test("the model may write up to 4000 tokens, the relay's maximum (2000 cut long answers mid-JSON)", () => {
  // Regression: with 2000, posts with many things to flag came back cut off
  // and were shown as "malformed JSON". The relay caps requests at 4000.
  assert.equal(MAX_OUTPUT_TOKENS, 4000);
});

// --- Timeouts cover the response body -------------------------------------------

test("times out when the body stalls after the headers arrive", { timeout: 5000 }, async () => {
  globalThis.fetch = fakeFetchWithSlowBody(60_000, OK_BODY);
  await assert.rejects(chat(client(), PATH, MESSAGES, 100), isCode("UPSTREAM_TIMEOUT"));
});

test("succeeds when the body arrives before the timeout", { timeout: 5000 }, async () => {
  globalThis.fetch = fakeFetchWithSlowBody(20, OK_BODY);
  assert.equal(await chat(client(), PATH, MESSAGES, 1000), "OK");
});

// --- Service failures ---------------------------------------------------------------

test("a non-JSON body is reported as bad model output", async () => {
  globalThis.fetch = fakeFetchWithSlowBody(0, "<html>gateway error</html>");
  await assert.rejects(chat(client(), PATH, MESSAGES, 1000), isCode("BAD_MODEL_OUTPUT"));
});

test("a reply with no text content is bad model output", async () => {
  globalThis.fetch = fakeFetchWithSlowBody(0, JSON.stringify({ choices: [] }));
  await assert.rejects(chat(client(), PATH, MESSAGES, 1000), isCode("BAD_MODEL_OUTPUT"));
});

test("app error statuses map to clear errors", async () => {
  const cases: Array<[number, string, RegExp]> = [
    [404, "UPSTREAM_ERROR", /DATABRICKS_SERVING_ENDPOINT/],
    [413, "UPSTREAM_ERROR", /too large/],
    [422, "UPSTREAM_ERROR", /request format/],
    [502, "UPSTREAM_ERROR", /HTTP 502/],
    [504, "UPSTREAM_TIMEOUT", /did not answer/],
  ];
  for (const [status, code, message] of cases) {
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "x" }), { status })) as typeof fetch;
    await assert.rejects(
      chat(client(), PATH, MESSAGES, 1000),
      (err: unknown) => isCode(code)(err) && message.test((err as Error).message),
      `HTTP ${status}`,
    );
  }
});

test("a network failure is an upstream error", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(chat(client(), PATH, MESSAGES, 1000), isCode("UPSTREAM_ERROR"));
});

// --- Auth failures, including the app's browser-login redirect ---------------------

test("a 302 to the login page is an auth error, not an empty answer", async () => {
  globalThis.fetch = (async () =>
    new Response(null, { status: 302, headers: { Location: "https://dbc.example/oidc/oauth2/v2.0/authorize" } })) as typeof fetch;
  await assert.rejects(
    chat(client(), PATH, MESSAGES, 1000),
    (err: unknown) => isCode("UPSTREAM_AUTH")(err) && /browser login/.test((err as Error).message),
  );
});

test("a 401 with a fixed PAT is reported without retrying", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ detail: "bad token" }), { status: 401 });
  }) as typeof fetch;
  await assert.rejects(chat(client(), PATH, MESSAGES, 1000), isCode("UPSTREAM_AUTH"));
  assert.equal(calls, 1);
});

// --- "Configured" vs. "verified" ----------------------------------------------------

test("status starts unverified, becomes verified after success and failing after a failure", async () => {
  const c = client();
  assert.equal(c.getStatus().state, "configured_unverified");

  globalThis.fetch = fakeFetchWithSlowBody(0, OK_BODY);
  await chat(c, PATH, MESSAGES, 1000);
  assert.equal(c.getStatus().state, "verified");
  assert.equal(c.getStatus().lastError, null);

  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await assert.rejects(chat(c, PATH, MESSAGES, 1000));
  assert.equal(c.getStatus().state, "failing");
  assert.match(c.getStatus().lastError ?? "", /HTTP 401/);
});
