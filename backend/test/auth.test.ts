// Regression tests for OAuth token handling (auth.ts) and token expiry
// during real calls (databricks.ts). Uses a fake fetch and a fake clock.
// Run with: npm test   (in the backend folder)
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { OAuthM2MTokenProvider } from "../src/auth";
import { chat, DatabricksClient } from "../src/databricks";
import { AppError } from "../src/errors";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WORKSPACE = "https://dbc-test.cloud.databricks.com";
const APP = "https://app.example.test";
const OK_BODY = JSON.stringify({ choices: [{ message: { content: "OK" } }] });

/** Fake Databricks: a token endpoint that issues tok-1, tok-2, ... and an app that accepts some tokens. */
function fakeDatabricks(opts: { expiresIn?: number; appAccepts?: (token: string) => boolean } = {}) {
  const log = { tokenRequests: 0, tokenBodies: [] as string[], tokenAuth: [] as string[], appTokens: [] as string[] };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (url === `${WORKSPACE}/oidc/v1/token`) {
      log.tokenRequests++;
      log.tokenBodies.push(String(init.body));
      log.tokenAuth.push(headers.Authorization);
      return new Response(
        JSON.stringify({ access_token: `tok-${log.tokenRequests}`, token_type: "Bearer", expires_in: opts.expiresIn ?? 3600 }),
        { status: 200 },
      );
    }
    const token = headers.Authorization.replace("Bearer ", "");
    log.appTokens.push(token);
    if (opts.appAccepts && !opts.appAccepts(token)) return new Response(null, { status: 401 });
    return new Response(OK_BODY, { status: 200 });
  }) as typeof fetch;
  return log;
}

test("requests a client-credentials token from the workspace with Basic auth", async () => {
  const log = fakeDatabricks();
  const provider = new OAuthM2MTokenProvider({ workspaceHost: WORKSPACE, clientId: "id", clientSecret: "secret" });
  assert.equal(await provider.getToken(), "tok-1");
  assert.equal(log.tokenBodies[0], "grant_type=client_credentials&scope=all-apis");
  assert.equal(log.tokenAuth[0], `Basic ${Buffer.from("id:secret").toString("base64")}`);
});

test("reuses a token until shortly before it expires, then renews it", async () => {
  const log = fakeDatabricks({ expiresIn: 3600 });
  let now = 0;
  const provider = new OAuthM2MTokenProvider({
    workspaceHost: WORKSPACE,
    clientId: "id",
    clientSecret: "secret",
    refreshMarginMs: 60_000,
    now: () => now,
  });
  assert.equal(await provider.getToken(), "tok-1");
  now = 3000 * 1000; // 50 minutes later: still valid
  assert.equal(await provider.getToken(), "tok-1");
  now = 3550 * 1000; // within the 60s margin before expiry: renew
  assert.equal(await provider.getToken(), "tok-2");
  assert.equal(log.tokenRequests, 2);
});

test("asks for only one token when many requests need one at once", async () => {
  const log = fakeDatabricks();
  const provider = new OAuthM2MTokenProvider({ workspaceHost: WORKSPACE, clientId: "id", clientSecret: "secret" });
  const tokens = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
  assert.deepEqual(tokens, ["tok-1", "tok-1", "tok-1"]);
  assert.equal(log.tokenRequests, 1);
});

test("a token revoked or expired early is replaced once and the call retried", async () => {
  // The app rejects tok-1 (as if it expired early) but accepts tok-2.
  const log = fakeDatabricks({ appAccepts: (t) => t !== "tok-1" });
  const client = new DatabricksClient({
    host: APP,
    tokenProvider: new OAuthM2MTokenProvider({ workspaceHost: WORKSPACE, clientId: "id", clientSecret: "secret" }),
  });
  assert.equal(await chat(client, "/api/v1/chat", [{ role: "user", content: "hi" }], 1000), "OK");
  assert.deepEqual(log.appTokens, ["tok-1", "tok-2"]);
  assert.equal(client.getStatus().state, "verified");
});

test("if a fresh token is also refused, it gives up with a clear auth error (no loop)", async () => {
  const log = fakeDatabricks({ appAccepts: () => false });
  const client = new DatabricksClient({
    host: APP,
    tokenProvider: new OAuthM2MTokenProvider({ workspaceHost: WORKSPACE, clientId: "id", clientSecret: "secret" }),
  });
  await assert.rejects(
    chat(client, "/api/v1/chat", [{ role: "user", content: "hi" }], 1000),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_AUTH" && /CAN USE/.test(err.message),
  );
  assert.equal(log.appTokens.length, 2);
  assert.equal(client.getStatus().state, "failing");
});

test("a refused token request is an auth error that names the settings to check", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })) as typeof fetch;
  const provider = new OAuthM2MTokenProvider({ workspaceHost: WORKSPACE, clientId: "id", clientSecret: "wrong" });
  await assert.rejects(
    provider.getToken(),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_AUTH" && /DATABRICKS_CLIENT_SECRET/.test(err.message),
  );
});

test("a token response without a token is an error, never an empty token", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 })) as typeof fetch;
  const provider = new OAuthM2MTokenProvider({ workspaceHost: WORKSPACE, clientId: "id", clientSecret: "s" });
  await assert.rejects(provider.getToken(), (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_AUTH");
});
