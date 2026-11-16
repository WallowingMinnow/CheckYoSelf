// =============================================================================
// TEMPORARY DEVELOPMENT STORAGE — NOT DATABRICKS.
// Keeps history in this backend process's memory. Everything is lost when the
// backend restarts, and nothing is written to disk. Use it to build and test
// the history flow until the Databricks App's history endpoints exist
// (see docs/DATABRICKS_APP_API.md). Selected with HISTORY_STORE=dev-memory.
// =============================================================================
import type { HistoryPost, StoredHistoryPost } from "../../../shared/contract";
import type { AiInterpretation, DeleteCounts, HistoryStore } from "./store";

interface Approval {
  approvedAt: string;
  postIds: string[];
  revokedAt: string | null;
}

/** Everything for ONE user. Users are kept in separate buckets. */
interface UserBucket {
  posts: Map<string, StoredHistoryPost>; // OBSERVED, by postId
  approvals: Map<string, Approval>;
  interpretations: AiInterpretation[]; // AI-GENERATED, kept apart from posts
}

export class DevMemoryHistoryStore implements HistoryStore {
  readonly kind = "dev-memory" as const;
  private readonly users = new Map<string, UserBucket>();

  private bucket(userId: string): UserBucket {
    let b = this.users.get(userId);
    if (!b) {
      b = { posts: new Map(), approvals: new Map(), interpretations: [] };
      this.users.set(userId, b);
    }
    return b;
  }

  async importPosts(userId: string, approvalId: string, approvedAt: string, posts: HistoryPost[]): Promise<number> {
    const b = this.bucket(userId);
    b.approvals.set(approvalId, { approvedAt, postIds: posts.map((p) => p.postId), revokedAt: null });
    for (const post of posts) {
      // Copy only the known fields, so nothing unexpected is stored.
      const stored: StoredHistoryPost = {
        postId: post.postId,
        status: "published",
        publishedAt: post.publishedAt,
        caption: post.caption,
        approvalId,
        importedAt: approvedAt,
      };
      if (post.imageText !== undefined) stored.imageText = post.imageText;
      b.posts.set(post.postId, stored);
    }
    return posts.length;
  }

  async listPosts(userId: string): Promise<StoredHistoryPost[]> {
    const b = this.users.get(userId);
    return b ? [...b.posts.values()].map((p) => ({ ...p })) : [];
  }

  /** Removes posts, plus every interpretation that used any of them. */
  private removePosts(b: UserBucket, postIds: string[]): DeleteCounts {
    const gone = new Set(postIds.filter((id) => b.posts.has(id)));
    for (const id of gone) b.posts.delete(id);
    const before = b.interpretations.length;
    b.interpretations = b.interpretations.filter((i) => !i.postIds.some((id) => gone.has(id)));
    return { deletedPosts: gone.size, deletedInterpretations: before - b.interpretations.length };
  }

  async deletePost(userId: string, postId: string): Promise<DeleteCounts> {
    const b = this.users.get(userId);
    return b ? this.removePosts(b, [postId]) : { deletedPosts: 0, deletedInterpretations: 0 };
  }

  async revokeApproval(userId: string, approvalId: string): Promise<DeleteCounts | null> {
    const b = this.users.get(userId);
    const approval = b?.approvals.get(approvalId);
    if (!b || !approval) return null;
    approval.revokedAt = new Date().toISOString();
    // Only posts that still belong to THIS approval (a later re-import moves a post to the new approval).
    const owned = [...b.posts.values()].filter((p) => p.approvalId === approvalId).map((p) => p.postId);
    return this.removePosts(b, owned);
  }

  async deleteAll(userId: string): Promise<DeleteCounts> {
    const b = this.users.get(userId);
    if (!b) return { deletedPosts: 0, deletedInterpretations: 0 };
    const counts = { deletedPosts: b.posts.size, deletedInterpretations: b.interpretations.length };
    this.users.delete(userId);
    return counts;
  }

  async saveInterpretations(userId: string, items: AiInterpretation[]): Promise<void> {
    const b = this.bucket(userId);
    // Only keep interpretations whose posts still exist (a post may have been deleted meanwhile).
    b.interpretations.push(...items.filter((i) => i.postIds.every((id) => b.posts.has(id))).map((i) => ({ ...i })));
  }

  async listInterpretations(userId: string): Promise<AiInterpretation[]> {
    return (this.users.get(userId)?.interpretations ?? []).map((i) => ({ ...i }));
  }
}
