// History stored by the Databricks App. Selected with HISTORY_STORE=databricks-app.
//
// STATUS: import, list and revoke passed a live round trip (npm run check:history,
// 2026-11-14). A live analysis with history also saved and
// deleted interpretations through the app (see docs/TEST_RESULTS.md). Spec: docs/DATABRICKS_APP_API.md.
//
// Design notes:
//  - All routes are under /api/ (Databricks Apps only accept token calls there).
//  - All calls are POST with a JSON body, so the user id and post text never
//    appear in URLs (which end up in logs).
//  - Every response is checked; anything unexpected is an error, not "empty".
import type { HistoryPost, StoredHistoryPost } from "../../../shared/contract";
import type { DatabricksClient } from "../databricks";
import { AppError } from "../errors";
import type { AiInterpretation, DeleteCounts, HistoryStore } from "./store";

export const APP_HISTORY_PATHS = {
  import: "/api/v1/history/import",
  list: "/api/v1/history/list",
  deletePost: "/api/v1/history/delete-post",
  revokeApproval: "/api/v1/history/revoke-approval",
  deleteAll: "/api/v1/history/delete-all",
  saveInterpretations: "/api/v1/history/interpretations/save",
  listInterpretations: "/api/v1/history/interpretations/list",
} as const;

function badResponse(what: string): never {
  throw new AppError("UPSTREAM_ERROR", 502, `The Databricks App returned an unexpected ${what} response.`);
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readCounts(data: unknown, what: string): DeleteCounts {
  if (!isObject(data) || !Number.isInteger(data.deletedPosts) || !Number.isInteger(data.deletedInterpretations)) {
    badResponse(what);
  }
  return { deletedPosts: data.deletedPosts, deletedInterpretations: data.deletedInterpretations };
}

function readPost(p: unknown): StoredHistoryPost {
  if (
    !isObject(p) ||
    typeof p.postId !== "string" ||
    p.status !== "published" ||
    typeof p.publishedAt !== "string" ||
    typeof p.caption !== "string" ||
    typeof p.approvalId !== "string" ||
    typeof p.importedAt !== "string" ||
    (p.imageText !== undefined && p.imageText !== null && typeof p.imageText !== "string")
  ) {
    badResponse("history list");
  }
  const post: StoredHistoryPost = {
    postId: p.postId,
    status: "published",
    publishedAt: p.publishedAt,
    caption: p.caption,
    approvalId: p.approvalId,
    importedAt: p.importedAt,
  };
  if (typeof p.imageText === "string") post.imageText = p.imageText;
  return post;
}

export class DatabricksAppHistoryStore implements HistoryStore {
  readonly kind = "databricks-app" as const;
  constructor(private readonly client: DatabricksClient) {}

  async importPosts(userId: string, approvalId: string, approvedAt: string, posts: HistoryPost[]): Promise<number> {
    const data = await this.client.requestJson("POST", APP_HISTORY_PATHS.import, { userId, approvalId, approvedAt, posts });
    if (!isObject(data) || data.imported !== posts.length) badResponse("history import");
    return data.imported;
  }

  async listPosts(userId: string): Promise<StoredHistoryPost[]> {
    const data = await this.client.requestJson("POST", APP_HISTORY_PATHS.list, { userId });
    if (!isObject(data) || !Array.isArray(data.posts)) badResponse("history list");
    return data.posts.map(readPost);
  }

  async deletePost(userId: string, postId: string): Promise<DeleteCounts> {
    return readCounts(await this.client.requestJson("POST", APP_HISTORY_PATHS.deletePost, { userId, postId }), "delete");
  }

  async revokeApproval(userId: string, approvalId: string): Promise<DeleteCounts | null> {
    const data = await this.client.requestJson("POST", APP_HISTORY_PATHS.revokeApproval, { userId, approvalId });
    if (isObject(data) && data.found === false) return null;
    return readCounts(data, "revoke");
  }

  async deleteAll(userId: string): Promise<DeleteCounts> {
    return readCounts(await this.client.requestJson("POST", APP_HISTORY_PATHS.deleteAll, { userId }), "delete-all");
  }

  async saveInterpretations(userId: string, items: AiInterpretation[]): Promise<void> {
    if (items.length === 0) return;
    const data = await this.client.requestJson("POST", APP_HISTORY_PATHS.saveInterpretations, { userId, interpretations: items });
    if (!isObject(data) || !Number.isInteger(data.saved)) badResponse("interpretations save");
  }

  async listInterpretations(userId: string): Promise<AiInterpretation[]> {
    const data = await this.client.requestJson("POST", APP_HISTORY_PATHS.listInterpretations, { userId });
    if (!isObject(data) || !Array.isArray(data.interpretations)) badResponse("interpretations list");
    return data.interpretations as AiInterpretation[];
  }
}
