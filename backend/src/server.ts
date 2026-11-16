// Starts the backend: builds the app from backend/.env settings and listens
// on 127.0.0.1 only. The routes themselves are in app.ts.
import { createApp } from "./app";
import { assertDatabricksConfig, config } from "./config";
import { callDatabricks, databricksInUse, getDatabricksStatus, getDefaultClient } from "./databricks";
import { DatabricksAppHistoryStore } from "./history/appStore";
import { DevMemoryHistoryStore } from "./history/memoryStore";
import type { HistoryStore } from "./history/store";
import { mockAnalyze } from "./mock";
import { parseModelOutput } from "./parse";
import { buildMessages, PROMPT_VERSION } from "./prompt";

// Report missing settings instead of guessing them.
if (databricksInUse()) assertDatabricksConfig();

const historyStore: HistoryStore =
  config.historyStore === "databricks-app" ? new DatabricksAppHistoryStore(getDefaultClient()) : new DevMemoryHistoryStore();

const app = createApp({
  mode: config.mode,
  model: config.mode === "databricks" ? config.databricksEndpoint : null,
  promptVersion: config.mode === "databricks" ? PROMPT_VERSION : null,
  // Explicit choice, made once at startup. A failed Databricks call is an
  // error for the user, never silently replaced with mock results.
  analyze:
    config.mode === "mock"
      ? async (sources, task) => mockAnalyze(sources, task)
      : async (sources, task) => parseModelOutput(await callDatabricks(buildMessages(sources, task)), sources),
  // The profile scan needs the live AI; in practice mode it is refused (never faked).
  extractFacts: config.mode === "mock" ? null : (messages) => callDatabricks(messages),
  historyStore,
  getDatabricksStatus,
  allowedExtensionId: config.allowedExtensionId,
});

// Listen on localhost only, so other machines on the hackathon Wi-Fi can't use it.
app.listen(config.port, "127.0.0.1", () => {
  console.log(`CheckYo'Self backend on http://127.0.0.1:${config.port}  (mode: ${config.mode}, history: ${historyStore.kind})`);
  if (config.mode === "mock") {
    console.log("MOCK MODE: results are keyword rules, not AI. Set ANALYSIS_MODE=databricks in backend/.env for real analysis.");
  } else {
    console.log(`Databricks: ${config.databricksHost} (auth: ${config.authType}). Connection UNVERIFIED until a call succeeds.`);
  }
  if (historyStore.kind === "dev-memory") {
    console.log("HISTORY: temporary in-memory dev storage. Not Databricks; cleared when the backend restarts.");
  } else {
    console.log("HISTORY: stored by the Databricks App (unverified until a real round trip succeeds).");
  }
});
