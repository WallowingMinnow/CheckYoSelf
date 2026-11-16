// The Express app: all routes, with its parts passed in (so tests can build
// one with fakes). server.ts builds the real one from backend/.env and starts it.
//
//   GET    /api/health                                -> HealthResponse
//   POST   /api/analyze                               -> AnalyzeResponse
//   POST   /api/history/import                        -> HistoryImportResponse
//   GET    /api/history                               -> HistoryListResponse
//   POST   /api/history/suggest                       -> HistorySuggestResponse
//   POST   /api/history/assess                        -> HistoryAssessResponse
//   DELETE /api/history/posts/:postId                 -> HistoryDeleteResponse
//   POST   /api/history/approvals/:approvalId/revoke  -> HistoryDeleteResponse
//   DELETE /api/history                               -> HistoryDeleteResponse
import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  CONTRACT_VERSION,
  HISTORY_LIMITS,
  USER_ID_HEADER,
  type AnalysisMode,
  type AnalyzeResponse,
  type DatabricksStatus,
  type ErrorResponse,
  type HealthResponse,
  type HistoryAssessResponse,
  type HistoryDeleteResponse,
  type HistoryImportResponse,
  type HistoryListResponse,
  type HistorySuggestResponse,
  type PortfolioResponse,
  type PortfolioScanResponse,
  type StoredHistoryPost,
  type TextSource,
} from "../../shared/contract";
import { AppError } from "./errors";
import {
  batchToInterpretation,
  buildFactMessages,
  parseFacts,
  profileSource,
  readPortfolio,
  SCAN_BATCH,
  unscannedPosts,
} from "./history/portfolio";
import { buildHistorySources, suggestHistory } from "./history/relevance";
import type { AiInterpretation, HistoryStore } from "./history/store";
import type { ParsedAnalysis } from "./parse";
import type { AnalysisTask, ChatMessage } from "./prompt";
import {
  validateAnalyzeRequest,
  validateApprovalId,
  validateHistoryAssess,
  validateHistoryImport,
  validateHistorySuggest,
  validatePortfolioScan,
  validatePostId,
  validateUserId,
} from "./validate";

/** Profile batches (of SCAN_BATCH posts) scanned per request, to keep each request short. */
export const PORTFOLIO_BATCHES_PER_CALL = 2;

export interface AppDeps {
  mode: AnalysisMode;
  /** Model/endpoint name shown to the user, or null in mock mode. */
  model: string | null;
  promptVersion: string | null;
  /**
   * Runs the analysis. In "databricks" mode this calls Databricks and parses
   * the answer; errors are passed on. It must NEVER fall back to mock results.
   */
  analyze: (sources: TextSource[], task?: AnalysisTask) => Promise<ParsedAnalysis>;
  /**
   * Raw model call used to build the profile (portfolio.ts parses it).
   * Null in mock mode: the profile needs the live AI and is never faked.
   */
  extractFacts: ((messages: ChatMessage[]) => Promise<string>) | null;
  historyStore: HistoryStore;
  getDatabricksStatus: () => DatabricksStatus;
  allowedExtensionId?: string;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));

  // Every request gets an id for logs and error messages.
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    next();
  });

  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      mode: deps.mode,
      contractVersion: CONTRACT_VERSION,
      // "configured_unverified" until a real Databricks call succeeds.
      databricks: deps.getDatabricksStatus(),
      history: { store: deps.historyStore.kind },
    };
    res.json(body);
  });

  /** Optional: only accept calls from our own extension (set ALLOWED_EXTENSION_ID). */
  function checkOrigin(req: Request, _res: Response, next: NextFunction) {
    if (deps.allowedExtensionId && req.headers.origin !== `chrome-extension://${deps.allowedExtensionId}`) {
      return next(new AppError("FORBIDDEN", 403, "Requests are only accepted from the CheckYo'Self extension."));
    }
    next();
  }

  const userIdOf = (req: Request) => validateUserId(req.get(USER_ID_HEADER));

  // AI interpretations still being saved, per user (saved after the analysis
  // reply is sent). One user's saves run one after another. Deleting history
  // first waits for that user's saves, so a slow save can never store an
  // interpretation of a post the user already deleted.
  const pendingSaves = new Map<string, Promise<void>>();

  function saveInBackground(userId: string, interpretations: AiInterpretation[], requestId: string) {
    const previous = pendingSaves.get(userId) ?? Promise.resolve();
    const job: Promise<void> = previous
      .then(() => deps.historyStore.saveInterpretations(userId, interpretations))
      .catch((err) => {
        // The user already has their results; just report that saving failed.
        console.error(`[${requestId}] could not save ${interpretations.length} interpretation(s): ${(err as Error).message}`);
      })
      .then(() => {
        if (pendingSaves.get(userId) === job) pendingSaves.delete(userId);
      });
    pendingSaves.set(userId, job);
  }

  const waitForSaves = (userId: string) => pendingSaves.get(userId) ?? Promise.resolve();
  // For tests and shutdown: resolves when every background save has finished.
  app.locals.waitForPendingSaves = () => Promise.all([...pendingSaves.values()]);

  // Wraps an async route so its errors reach the error handler below.
  const route =
    (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
      handler(req, res).catch(next);

  // --- Analysis ------------------------------------------------------------

  app.post(
    "/api/analyze",
    checkOrigin,
    route(async (req, res) => {
      const requestId: string = res.locals.requestId;
      const startedAt = Date.now();
      const request = validateAnalyzeRequest(req.body);

      // Earlier posts: EXACTLY the ones the user chose on the consent step,
      // and only from THIS user's approved history. Nothing is added or swapped.
      let sources: TextSource[] = request.sources;
      let historyUsed: AnalyzeResponse["historyUsed"] = [];
      let userId: string | null = null;
      let savedPosts: StoredHistoryPost[] | null = null;
      if (request.historyPostIds) {
        userId = userIdOf(req);
        savedPosts = await deps.historyStore.listPosts(userId);
        const stored = new Map(savedPosts.map((p) => [p.postId, p]));
        const missing = request.historyPostIds.filter((id) => !stored.has(id));
        if (missing.length > 0) {
          throw new AppError(
            "BAD_REQUEST",
            400,
            `${missing.length} chosen earlier post(s) are not in your approved history (deleted or revoked?). Review the list and check again.`,
          );
        }
        const chosen = buildHistorySources(request.sources, request.historyPostIds.map((id) => stored.get(id)!));
        sources = [...request.sources, ...chosen.sources];
        historyUsed = chosen.used;
      }

      // The profile: facts from ALL saved posts, as one "profile" source (opt-in).
      let portfolioUsed: AnalyzeResponse["portfolioUsed"];
      if (request.usePortfolio) {
        userId = userIdOf(req);
        savedPosts ??= await deps.historyStore.listPosts(userId);
        const { facts } = readPortfolio(await deps.historyStore.listInterpretations(userId), savedPosts);
        const profile = profileSource(facts, savedPosts);
        if (profile) {
          sources = [...sources, profile];
          portfolioUsed = { facts: facts.length, posts: new Set(facts.map((f) => f.postId)).size };
        }
      }

      const result = await deps.analyze(sources);

      const body: AnalyzeResponse = {
        contractVersion: CONTRACT_VERSION,
        requestId,
        draftHash: request.draftHash,
        mode: deps.mode,
        model: deps.model,
        promptVersion: deps.promptVersion,
        analyzedAt: new Date().toISOString(),
        summary: result.summary,
        findings: result.findings,
        droppedFindings: result.droppedFindings,
        historyUsed,
        ...(portfolioUsed ? { portfolioUsed } : {}),
      };

      // Privacy: log ids and counts only — never the post text or the user id.
      console.log(
        `[${requestId}] mode=${deps.mode} sources=${sources.length} history=${historyUsed.length} profileFacts=${portfolioUsed?.facts ?? 0} ` +
          `findings=${body.findings.length} dropped=${body.droppedFindings} ${Date.now() - startedAt}ms`,
      );
      res.json(body);

      // Keep AI conclusions about earlier posts SEPARATE from the posts themselves.
      // Mock results are keyword rules, not AI, so they are never stored.
      // Saved AFTER replying: the Databricks App's database is slow, and the
      // user shouldn't wait for it. History deletes wait for these saves.
      if (userId && deps.mode === "databricks") {
        const interpretations = interpretationsFrom(body);
        if (interpretations.length > 0) saveInBackground(userId, interpretations, requestId);
      }
    }),
  );

  // --- History ---------------------------------------------------------------

  app.post(
    "/api/history/import",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      const request = validateHistoryImport(req.body);
      const existing = await deps.historyStore.listPosts(userId);
      const newIds = request.posts.filter((p) => !existing.some((e) => e.postId === p.postId)).length;
      if (existing.length + newIds > HISTORY_LIMITS.maxPostsPerUser) {
        throw new AppError("BAD_REQUEST", 400, `History is limited to ${HISTORY_LIMITS.maxPostsPerUser} posts per user.`);
      }
      const approvalId = randomUUID();
      const imported = await deps.historyStore.importPosts(userId, approvalId, new Date().toISOString(), request.posts);
      console.log(`[${res.locals.requestId}] history import posts=${imported} store=${deps.historyStore.kind}`);
      const body: HistoryImportResponse = { contractVersion: CONTRACT_VERSION, approvalId, imported, store: deps.historyStore.kind };
      res.json(body);
    }),
  );

  app.get(
    "/api/history",
    checkOrigin,
    route(async (req, res) => {
      const posts = await deps.historyStore.listPosts(userIdOf(req));
      const body: HistoryListResponse = { contractVersion: CONTRACT_VERSION, store: deps.historyStore.kind, posts };
      res.json(body);
    }),
  );

  // Suggests which approved posts to pre-select for a draft. Analyzes nothing
  // and calls no AI; the user still chooses on the consent step.
  app.post(
    "/api/history/suggest",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      const request = validateHistorySuggest(req.body);
      const ranked = suggestHistory(request.sources, await deps.historyStore.listPosts(userId));
      const body: HistorySuggestResponse = {
        contractVersion: CONTRACT_VERSION,
        suggestions: ranked.map((r) => ({ postId: r.post.postId, publishedAt: r.post.publishedAt, sharedWords: r.sharedWords })),
      };
      res.json(body);
    }),
  );

  // What the user's saved posts reveal TOGETHER (no draft). Only the posts the
  // user chose, only from THIS user's approved history; nothing added or swapped.
  app.post(
    "/api/history/assess",
    checkOrigin,
    route(async (req, res) => {
      const requestId: string = res.locals.requestId;
      const startedAt = Date.now();
      const userId = userIdOf(req);
      const request = validateHistoryAssess(req.body);
      const stored = new Map((await deps.historyStore.listPosts(userId)).map((p) => [p.postId, p]));
      const missing = request.postIds.filter((id) => !stored.has(id));
      if (missing.length > 0) {
        throw new AppError("BAD_REQUEST", 400, `${missing.length} chosen post(s) are not in your saved history (deleted?). Refresh the page and try again.`);
      }
      const chosen = buildHistorySources([], request.postIds.map((id) => stored.get(id)!), HISTORY_LIMITS.maxPostsPerAssessment);
      const result = await deps.analyze(chosen.sources, "history");
      const body: HistoryAssessResponse = {
        contractVersion: CONTRACT_VERSION,
        requestId,
        mode: deps.mode,
        model: deps.model,
        promptVersion: deps.promptVersion,
        analyzedAt: new Date().toISOString(),
        summary: result.summary,
        findings: result.findings,
        droppedFindings: result.droppedFindings,
        postsAssessed: chosen.used,
      };
      // Privacy: ids and counts only.
      console.log(
        `[${requestId}] history assess mode=${deps.mode} posts=${chosen.used.length} findings=${body.findings.length} ` +
          `crossPost=${body.findings.filter((f) => f.crossSource).length} dropped=${body.droppedFindings} ${Date.now() - startedAt}ms`,
      );
      res.json(body);
      // Same rule as /api/analyze: keep AI conclusions about saved posts (never mock results).
      if (deps.mode === "databricks") {
        const interpretations = interpretationsFrom(body);
        if (interpretations.length > 0) saveInBackground(userId, interpretations, requestId);
      }
    }),
  );

  app.delete(
    "/api/history/posts/:postId",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      const postId = validatePostId(req.params.postId);
      await waitForSaves(userId);
      const counts = await deps.historyStore.deletePost(userId, postId);
      if (counts.deletedPosts === 0) throw new AppError("NOT_FOUND", 404, "No such post in your history.");
      const body: HistoryDeleteResponse = { contractVersion: CONTRACT_VERSION, ...counts };
      res.json(body);
    }),
  );

  app.post(
    "/api/history/approvals/:approvalId/revoke",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      const approvalId = validateApprovalId(req.params.approvalId);
      await waitForSaves(userId);
      const counts = await deps.historyStore.revokeApproval(userId, approvalId);
      if (!counts) throw new AppError("NOT_FOUND", 404, "No such approval in your history.");
      const body: HistoryDeleteResponse = { contractVersion: CONTRACT_VERSION, ...counts };
      res.json(body);
    }),
  );

  app.delete(
    "/api/history",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      await waitForSaves(userId);
      const counts = await deps.historyStore.deleteAll(userId);
      const body: HistoryDeleteResponse = { contractVersion: CONTRACT_VERSION, ...counts };
      res.json(body);
    }),
  );

  // --- The profile ("portfolio") ---------------------------------------------

  // Scans up to PORTFOLIO_BATCHES_PER_CALL batches of not-yet-scanned saved
  // posts (a few model calls), so each request stays short; the extension calls
  // again until remaining is 0. Never runs in mock mode.
  app.post(
    "/api/history/portfolio/scan",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      validatePortfolioScan(req.body);
      if (!deps.extractFacts) {
        throw new AppError("BAD_REQUEST", 400, "Building a profile needs the live AI. The backend is in practice mode (ANALYSIS_MODE=mock).");
      }
      await waitForSaves(userId);
      const posts = await deps.historyStore.listPosts(userId);
      const { scannedPostIds } = readPortfolio(await deps.historyStore.listInterpretations(userId), posts);
      const todo = unscannedPosts(posts, scannedPostIds).slice(0, SCAN_BATCH * PORTFOLIO_BATCHES_PER_CALL);
      let factCount = 0;
      for (let i = 0; i < todo.length; i += SCAN_BATCH) {
        const batch = todo.slice(i, i + SCAN_BATCH);
        const facts = parseFacts(await deps.extractFacts(buildFactMessages(batch)), batch);
        factCount += facts.length;
        await deps.historyStore.saveInterpretations(userId, [batchToInterpretation(batch, facts, deps.model, res.locals.requestId)]);
      }
      const after = readPortfolio(await deps.historyStore.listInterpretations(userId), posts);
      console.log(`[${res.locals.requestId}] portfolio scan posts=${todo.length} facts=${factCount} remaining=${posts.length - after.scannedPostIds.size}`);
      const body: PortfolioScanResponse = {
        contractVersion: CONTRACT_VERSION,
        scannedNow: todo.length,
        scannedPosts: after.scannedPostIds.size,
        totalPosts: posts.length,
        remaining: posts.length - after.scannedPostIds.size,
        facts: after.facts.length,
      };
      res.json(body);
    }),
  );

  app.get(
    "/api/history/portfolio",
    checkOrigin,
    route(async (req, res) => {
      const userId = userIdOf(req);
      await waitForSaves(userId);
      const posts = await deps.historyStore.listPosts(userId);
      const { facts, scannedPostIds } = readPortfolio(await deps.historyStore.listInterpretations(userId), posts);
      const dateOf = new Map(posts.map((p) => [p.postId, p.publishedAt]));
      const body: PortfolioResponse = {
        contractVersion: CONTRACT_VERSION,
        totalPosts: posts.length,
        scannedPosts: scannedPostIds.size,
        facts: facts.map((f) => ({ ...f, publishedAt: dateOf.get(f.postId) ?? "" })),
      };
      res.json(body);
    }),
  );

  // --- Errors ----------------------------------------------------------------

  // Unknown /api route: say so as JSON (the extension shows it), instead of Express's HTML page.
  app.use("/api", (req, _res, next) => {
    next(new AppError("NOT_FOUND", 404, `This backend has no ${req.method} ${req.baseUrl}${req.path}. If you just updated CheckYo'Self, restart the backend.`));
  });

  // Turns any error into an ErrorResponse the extension understands.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId: string | undefined = res.locals.requestId;
    let status = 500;
    let error: ErrorResponse["error"] = { code: "INTERNAL", message: "Unexpected server error.", requestId };

    if (err instanceof AppError) {
      status = err.httpStatus;
      error = { code: err.code, message: err.message, requestId };
    } else if ((err as any)?.type === "entity.parse.failed") {
      status = 400;
      error = { code: "BAD_REQUEST", message: "Body is not valid JSON.", requestId };
    } else if ((err as any)?.type === "entity.too.large") {
      status = 413;
      error = { code: "BAD_REQUEST", message: "Request body is too large.", requestId };
    } else {
      // Log the error type and message only (no request body).
      console.error(`[${requestId ?? "-"}] ${(err as Error)?.name}: ${(err as Error)?.message}`);
    }

    const body: ErrorResponse = { contractVersion: CONTRACT_VERSION, error };
    res.status(status).json(body);
  });

  return app;
}

/** AI findings that rely on verified quotes from earlier posts. */
export function interpretationsFrom(
  response: Pick<AnalyzeResponse, "findings" | "model" | "promptVersion" | "requestId" | "analyzedAt">,
): AiInterpretation[] {
  const result: AiInterpretation[] = [];
  for (const finding of response.findings) {
    const historyEvidence = finding.evidence.filter((e) => e.verified && e.sourceId.startsWith("history:"));
    if (historyEvidence.length === 0) continue;
    result.push({
      interpretationId: randomUUID(),
      postIds: [...new Set(historyEvidence.map((e) => e.sourceId.slice("history:".length)))],
      category: finding.category,
      severity: finding.severity,
      exposure: finding.exposure,
      evidence: finding.evidence.filter((e) => e.verified).map((e) => ({ sourceId: e.sourceId, quote: e.quote })),
      model: response.model,
      promptVersion: response.promptVersion,
      requestId: response.requestId,
      createdAt: response.analyzedAt,
    });
  }
  return result;
}
