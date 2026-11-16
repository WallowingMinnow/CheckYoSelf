// Regression tests for what the popup says about the backend and about
// incomplete checks. Run with: npm test   (in the extension folder)
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACT_VERSION, type AnalyzeResponse, type HealthResponse } from "../../shared/contract";
import { describeBackendStatus } from "../src/api";
import { incompleteMessage } from "../src/render";

function health(overrides: Partial<HealthResponse>): HealthResponse {
  return {
    ok: true,
    mode: "databricks",
    contractVersion: CONTRACT_VERSION,
    databricks: { state: "configured_unverified", lastCallAt: null, lastError: null },
    history: { store: "dev-memory" },
    ...overrides,
  };
}

// --- 5. Configured is not the same as connected ------------------------------

test("configured but untested Databricks is NOT shown as connected", () => {
  const view = describeBackendStatus(health({}));
  assert.equal(view.state, "databricks-unverified");
  assert.doesNotMatch(view.label, /connected/i);
});

test("only a verified Databricks call shows 'connected'", () => {
  const view = describeBackendStatus(
    health({ databricks: { state: "verified", lastCallAt: "2026-11-14T12:00:00Z", lastError: null } }),
  );
  assert.equal(view.state, "databricks-verified");
  assert.match(view.label, /connected/i);
});

test("a failed Databricks call is shown as an error", () => {
  const view = describeBackendStatus(
    health({ databricks: { state: "failing", lastCallAt: "2026-11-14T12:00:00Z", lastError: "HTTP 401" } }),
  );
  assert.equal(view.state, "databricks-failing");
  assert.equal(view.title, "HTTP 401");
});

test("mock mode, offline, and an old backend are labeled clearly", () => {
  assert.equal(describeBackendStatus(health({ mode: "mock" })).state, "mock");
  assert.equal(describeBackendStatus(null).state, "offline");
  const old = { ok: true, mode: "databricks", contractVersion: "1" } as unknown as HealthResponse;
  assert.equal(describeBackendStatus(old).state, "mismatch");
});

// --- 2. Dropped findings are never shown as a clean result -------------------

function response(droppedFindings: number): AnalyzeResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: "r",
    draftHash: "0".repeat(64),
    mode: "databricks",
    model: "m",
    promptVersion: "p",
    analyzedAt: "2026-11-14T12:00:00Z",
    summary: "",
    findings: [],
    droppedFindings,
    historyUsed: [],
  };
}

test("a result with dropped findings is reported as incomplete", () => {
  assert.match(incompleteMessage(response(2)) ?? "", /Incomplete check: 2 possible warnings/);
  assert.match(incompleteMessage(response(1)) ?? "", /1 possible warning was/);
});

test("a result with nothing dropped is complete", () => {
  assert.equal(incompleteMessage(response(0)), null);
});
