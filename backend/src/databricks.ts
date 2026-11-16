// Talks to Databricks: the Databricks App (dinstagram/instagram-risk-analyzer),
// or a model serving endpoint directly. Uses Node's built-in fetch.
//
// Every request:
//  - has ONE timeout covering connect, headers AND reading the body;
//  - never follows redirects (a redirect from a Databricks App means "go log
//    in in a browser", i.e. our token wasn't accepted);
//  - on an auth failure, gets a fresh OAuth token and retries once;
//  - never logs request or response bodies (they may contain post text).
//
// It also remembers whether the most recent call worked, so /api/health can
// tell "settings are filled in" apart from "a real call actually succeeded".
import type { DatabricksStatus } from "../../shared/contract";
import { OAuthM2MTokenProvider, PatTokenProvider, type TokenProvider } from "./auth";
import { config } from "./config";
import { AppError } from "./errors";
import type { ChatMessage } from "./prompt";

export const TIMEOUT_MS = 45_000;

/**
 * Most tokens the model may WRITE per analysis (its answer, plus the hidden
 * reasoning gpt-oss does first). 2000 was too small: posts with many things to
 * flag got their JSON cut off mid-sentence ("malformed JSON"). 4000 is the
 * highest the Databricks App relay accepts (MAX_TOKENS_CAP in databricks-app/app.py).
 * The model stops as soon as it's done, so a higher limit doesn't slow short answers.
 */
export const MAX_OUTPUT_TOKENS = 4000;

export interface DatabricksClientOptions {
  /** App or workspace URL, no trailing slash. */
  host: string;
  tokenProvider: TokenProvider;
  timeoutMs?: number;
  /** Initial status shown by /api/health before any call. */
  inUse?: boolean;
}

export class DatabricksClient {
  private status: DatabricksStatus;
  readonly timeoutMs: number;

  constructor(private readonly options: DatabricksClientOptions) {
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.status = {
      state: options.inUse === false ? "not_used" : "configured_unverified",
      lastCallAt: null,
      lastError: null,
    };
  }

  getStatus(): DatabricksStatus {
    return { ...this.status };
  }

  /**
   * Sends one JSON request and returns the parsed JSON response.
   * Throws AppError with a clear, credential-free message on any failure.
   */
  async requestJson(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    try {
      let result = await this.attempt(method, path, body, timeoutMs, false);
      if (result.kind === "auth-failed" && this.options.tokenProvider.canRefresh) {
        // The token may have expired early or been revoked: get a new one, retry once.
        result = await this.attempt(method, path, body, timeoutMs, true);
      }
      if (result.kind === "auth-failed") throw authError(result.status, this.options.tokenProvider.canRefresh);
      this.recordSuccess();
      return result.data;
    } catch (err) {
      this.recordFailure(err instanceof AppError ? err.message : "Unexpected error calling Databricks.");
      throw err;
    }
  }

  private async attempt(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    forceNewToken: boolean,
  ): Promise<{ kind: "ok"; data: unknown } | { kind: "auth-failed"; status: number }> {
    const token = await this.options.tokenProvider.getToken(forceNewToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timeoutError = () =>
      new AppError("UPSTREAM_TIMEOUT", 504, `Databricks did not answer within ${timeoutMs / 1000}s.`);

    try {
      let response: Response;
      try {
        response = await fetch(`${this.options.host}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        if (controller.signal.aborted) throw timeoutError();
        throw new AppError("UPSTREAM_ERROR", 502, `Could not reach Databricks: ${(err as Error).message}`);
      }

      // Read the body while the timer is STILL running.
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (err) {
        if (controller.signal.aborted) throw timeoutError();
        throw new AppError("UPSTREAM_ERROR", 502, `Databricks response was cut off: ${(err as Error).message}`);
      }

      const status = response.status;
      // 3xx from a Databricks App = redirect to the browser login page.
      if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
        return { kind: "auth-failed", status };
      }
      if (!response.ok) {
        // Log the status only. Bodies may echo our request (and so post text).
        console.error(`Databricks ${method} ${path.split("?")[0]} -> HTTP ${status}`);
        throw statusError(status);
      }

      try {
        return { kind: "ok", data: bodyText === "" ? null : JSON.parse(bodyText) };
      } catch {
        throw new AppError("BAD_MODEL_OUTPUT", 502, "Databricks response was not valid JSON.");
      }
    } finally {
      // Only now, after the body is fully read (or we gave up), stop the timer.
      clearTimeout(timer);
    }
  }

  private recordSuccess() {
    this.status = { state: "verified", lastCallAt: new Date().toISOString(), lastError: null };
  }

  private recordFailure(message: string) {
    this.status = { state: "failing", lastCallAt: new Date().toISOString(), lastError: message.slice(0, 200) };
  }
}

function authError(status: number, usesOAuth: boolean): AppError {
  const what =
    status >= 300 && status < 400
      ? `Databricks redirected to its browser login (HTTP ${status}), so our token was not accepted.`
      : `Databricks rejected our credentials (HTTP ${status}).`;
  const hint = usesOAuth
    ? " A fresh OAuth token was also rejected: check the service principal has CAN USE on the app."
    : " The token may be invalid or expired. Databricks Apps expect OAuth tokens; try DATABRICKS_AUTH_TYPE=oauth-m2m with a service principal.";
  const route =
    status >= 300 && status < 400 ? " Token calls to a Databricks App only work on /api/ routes." : "";
  return new AppError("UPSTREAM_AUTH", 502, `${what}${hint}${route}`);
}

function statusError(status: number): AppError {
  switch (status) {
    case 404:
      return new AppError("UPSTREAM_ERROR", 502, "Databricks returned HTTP 404. Check DATABRICKS_HOST, DATABRICKS_SERVING_ENDPOINT and DATABRICKS_INVOCATIONS_PATH.");
    case 413:
      return new AppError("UPSTREAM_ERROR", 502, "The request was too large for Databricks (HTTP 413).");
    case 400:
    case 422:
      return new AppError("UPSTREAM_ERROR", 502, `Databricks rejected the request format (HTTP ${status}).`);
    case 504:
      return new AppError("UPSTREAM_TIMEOUT", 504, "The model behind Databricks did not answer in time (HTTP 504).");
    default:
      return new AppError("UPSTREAM_ERROR", 502, `Databricks returned HTTP ${status}.`);
  }
}

// ---------------------------------------------------------------------------
// Chat (analysis)
// ---------------------------------------------------------------------------

/** Path for chat requests, e.g. /serving-endpoints/gpt-oss-120b/invocations */
export function invocationsPath(template: string, endpoint: string): string {
  return template.replace("{endpoint}", encodeURIComponent(endpoint));
}

/** Sends chat messages and returns the model's text. */
export async function chat(
  client: DatabricksClient,
  path: string,
  messages: ChatMessage[],
  timeoutMs?: number,
): Promise<string> {
  const data = await client.requestJson("POST", path, { messages, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0.1 }, timeoutMs);
  const text = extractText(data);
  if (!text) throw new AppError("BAD_MODEL_OUTPUT", 502, "Databricks response had no text content.");
  return text;
}

/**
 * Chat responses look like { choices: [ { message: { content } } ] }.
 * `content` is usually a string, but some models return a list of blocks.
 */
export function extractText(data: unknown): string {
  const content = (data as any)?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// The one client the server uses, built from backend/.env
// ---------------------------------------------------------------------------

let defaultClient: DatabricksClient | null = null;

/** Whether this backend calls Databricks at all with the current settings. */
export function databricksInUse(): boolean {
  return config.mode === "databricks" || config.historyStore === "databricks-app";
}

export function getDefaultClient(): DatabricksClient {
  if (!defaultClient) {
    const tokenProvider =
      config.authType === "oauth-m2m"
        ? new OAuthM2MTokenProvider({
            workspaceHost: config.workspaceHost,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
          })
        : new PatTokenProvider(config.databricksToken);
    defaultClient = new DatabricksClient({ host: config.databricksHost, tokenProvider, inUse: databricksInUse() });
  }
  return defaultClient;
}

export function getDatabricksStatus(): DatabricksStatus {
  if (!databricksInUse()) return { state: "not_used", lastCallAt: null, lastError: null };
  return getDefaultClient().getStatus();
}

/** Analysis call used by the server and `npm run check:databricks`. */
export async function callDatabricks(messages: ChatMessage[], timeoutMs?: number): Promise<string> {
  return chat(getDefaultClient(), invocationsPath(config.invocationsPath, config.databricksEndpoint), messages, timeoutMs);
}
