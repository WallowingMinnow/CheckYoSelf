// Reads settings from environment variables (loaded from backend/.env).
// Secrets live ONLY here on the backend — never in the extension or in git.
import "dotenv/config";
import type { AnalysisMode, HistoryStoreKind } from "../../shared/contract.js";

/** How the backend proves who it is to Databricks. */
export type DatabricksAuthType = "oauth-m2m" | "pat";

function readChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? fallback).trim().toLowerCase();
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be one of ${allowed.map((a) => `"${a}"`).join(", ")} (got "${raw}").`);
}

function readUrl(name: string): string {
  return (process.env[name] ?? "").trim().replace(/\/+$/, "");
}

function readText(name: string): string {
  return (process.env[name] ?? "").trim();
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  mode: readChoice<AnalysisMode>("ANALYSIS_MODE", ["mock", "databricks"], "mock"),

  // --- Where to send analysis requests -----------------------------------
  // The Databricks App URL (e.g. https://<app>-<id>.aws.databricksapps.com),
  // or a workspace URL if you call a model serving endpoint directly.
  databricksHost: readUrl("DATABRICKS_HOST"),
  databricksEndpoint: readText("DATABRICKS_SERVING_ENDPOINT"),
  /**
   * Path on DATABRICKS_HOST for chat requests. "{endpoint}" is replaced with
   * DATABRICKS_SERVING_ENDPOINT. The default matches the app handoff.
   */
  invocationsPath: readText("DATABRICKS_INVOCATIONS_PATH") || "/serving-endpoints/{endpoint}/invocations",

  // --- How to authenticate ----------------------------------------------
  authType: readChoice<DatabricksAuthType>("DATABRICKS_AUTH_TYPE", ["oauth-m2m", "pat"], "oauth-m2m"),
  // oauth-m2m (service principal). Tokens come from the WORKSPACE, not the app.
  workspaceHost: readUrl("DATABRICKS_WORKSPACE_HOST"),
  clientId: readText("DATABRICKS_CLIENT_ID"),
  clientSecret: readText("DATABRICKS_CLIENT_SECRET"),
  // pat (personal access token).
  databricksToken: readText("DATABRICKS_TOKEN"),

  // --- History -----------------------------------------------------------
  historyStore: readChoice<HistoryStoreKind>("HISTORY_STORE", ["dev-memory", "databricks-app"], "dev-memory"),

  allowedExtensionId: readText("ALLOWED_EXTENSION_ID"),
};

/** Settings that are missing for calling Databricks (empty list = all present). */
export function missingDatabricksSettings(): string[] {
  const required: Array<[string, string]> = [
    ["DATABRICKS_HOST", config.databricksHost],
    ["DATABRICKS_SERVING_ENDPOINT", config.databricksEndpoint],
  ];
  if (config.authType === "oauth-m2m") {
    required.push(
      ["DATABRICKS_WORKSPACE_HOST", config.workspaceHost],
      ["DATABRICKS_CLIENT_ID", config.clientId],
      ["DATABRICKS_CLIENT_SECRET", config.clientSecret],
    );
  } else {
    required.push(["DATABRICKS_TOKEN", config.databricksToken]);
  }
  return required.filter(([, value]) => !value).map(([name]) => name);
}

/** Fail fast with a clear message instead of a confusing error later. Never guesses values. */
export function assertDatabricksConfig(): void {
  const missing = missingDatabricksSettings();
  if (missing.length > 0) {
    throw new Error(
      `Databricks is needed (ANALYSIS_MODE=databricks or HISTORY_STORE=databricks-app) but these are missing ` +
        `in backend/.env: ${missing.join(", ")} (DATABRICKS_AUTH_TYPE=${config.authType}). ` +
        `Fill them in, or use ANALYSIS_MODE=mock and HISTORY_STORE=dev-memory.`,
    );
  }
  for (const [name, url] of [
    ["DATABRICKS_HOST", config.databricksHost],
    ["DATABRICKS_WORKSPACE_HOST", config.workspaceHost],
  ] as const) {
    if (url && !url.startsWith("https://")) throw new Error(`${name} must start with https://`);
  }
  if (!config.invocationsPath.startsWith("/")) throw new Error("DATABRICKS_INVOCATIONS_PATH must start with /");
}
