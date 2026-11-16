// Gets the "Authorization: Bearer <token>" value for calls to Databricks.
// All credentials stay here on the backend; they are never sent to the
// extension and never logged.
//
// Two ways to authenticate:
//  - "oauth-m2m" (recommended): a Databricks service principal's client ID +
//    secret are exchanged for a short-lived OAuth token at the WORKSPACE's
//    /oidc/v1/token endpoint. We cache the token and get a new one shortly
//    before it expires, or right away if Databricks says it's no longer valid.
//    Databricks documents OAuth tokens as the way to call a Databricks App.
//  - "pat": a fixed personal access token (what the app handoff describes).
//    Databricks' own docs list OAuth tokens, not PATs, for calling apps, so
//    this may be rejected; `npm run check:databricks` will tell you.
import { AppError } from "./errors";

export interface TokenProvider {
  /** Returns a valid access token. `forceRefresh` throws away the cached one. */
  getToken(forceRefresh?: boolean): Promise<string>;
  /** true if a refresh might fix an auth failure (false for a fixed PAT). */
  readonly canRefresh: boolean;
}

/** A fixed personal access token. Cannot be renewed automatically. */
export class PatTokenProvider implements TokenProvider {
  readonly canRefresh = false;
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

export interface OAuthM2MSettings {
  workspaceHost: string; // e.g. https://dbc-xxxx.cloud.databricks.com (no trailing slash)
  clientId: string;
  clientSecret: string;
  /** How long a token request may take. */
  timeoutMs?: number;
  /** Renew this many ms before the token expires. */
  refreshMarginMs?: number;
  /** For tests: a fake clock (milliseconds). */
  now?: () => number;
}

/** OAuth machine-to-machine (service principal) tokens, cached and renewed. */
export class OAuthM2MTokenProvider implements TokenProvider {
  readonly canRefresh = true;
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly settings: OAuthM2MSettings) {
    this.now = settings.now ?? Date.now;
    this.refreshMarginMs = settings.refreshMarginMs ?? 60_000;
    this.timeoutMs = settings.timeoutMs ?? 15_000;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (forceRefresh) this.cached = null;
    if (this.cached && this.now() < this.cached.expiresAt - this.refreshMarginMs) {
      return this.cached.token;
    }
    // If several requests need a token at once, ask Databricks only once.
    if (!this.pending) {
      this.pending = this.fetchToken().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const url = `${this.settings.workspaceHost}/oidc/v1/token`;
    const basic = Buffer.from(`${this.settings.clientId}:${this.settings.clientSecret}`).toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials&scope=all-apis",
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new AppError("UPSTREAM_TIMEOUT", 504, "Databricks did not issue an OAuth token in time.");
        }
        throw new AppError("UPSTREAM_ERROR", 502, `Could not reach the Databricks workspace for a token: ${(err as Error).message}`);
      }
      const bodyText = await response.text(); // still inside the timeout
      if (!response.ok) {
        // Don't log the body: it could echo request details. The status is enough.
        throw new AppError(
          "UPSTREAM_AUTH",
          502,
          `Databricks refused the OAuth token request (HTTP ${response.status}). ` +
            `Check DATABRICKS_WORKSPACE_HOST, DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET.`,
        );
      }
      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new AppError("UPSTREAM_AUTH", 502, "Databricks' OAuth token response was not JSON.");
      }
      const token = typeof data?.access_token === "string" ? data.access_token : "";
      const expiresIn = Number(data?.expires_in);
      if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new AppError("UPSTREAM_AUTH", 502, "Databricks' OAuth token response had no usable token.");
      }
      this.cached = { token, expiresAt: this.now() + expiresIn * 1000 };
      return token;
    } catch (err) {
      if (controller.signal.aborted && !(err instanceof AppError)) {
        throw new AppError("UPSTREAM_TIMEOUT", 504, "Databricks did not issue an OAuth token in time.");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
