// The one interface every history store implements. The rest of the backend
// only talks to this interface, so switching from the temporary dev store to
// the Databricks App store is a config change (HISTORY_STORE).
//
// Two kinds of records are kept SEPARATE on purpose:
//  - OBSERVED posts: exactly what the user approved importing (their text).
//  - AI interpretations: what the model concluded about those posts. These
//    are derived, can be regenerated, and are deleted with their posts.
// Every method takes a userId; a store must never return or delete another
// user's records.
import type { Category, HistoryPost, HistoryStoreKind, Level, StoredHistoryPost } from "../../../shared/contract";

/** An AI-GENERATED conclusion that involved some of the user's earlier posts. */
export interface AiInterpretation {
  interpretationId: string;
  /** Earlier posts (postIds) the conclusion is based on. */
  postIds: string[];
  category: Category;
  severity: Level;
  exposure: string;
  /** Verified quotes the model relied on (sourceId + quote). */
  evidence: Array<{ sourceId: string; quote: string }>;
  model: string | null;
  promptVersion: string | null;
  requestId: string;
  createdAt: string;
}

export interface DeleteCounts {
  deletedPosts: number;
  deletedInterpretations: number;
}

export interface HistoryStore {
  readonly kind: HistoryStoreKind;
  /** Stores approved, published posts under one approval. Re-importing a postId replaces it. */
  importPosts(userId: string, approvalId: string, approvedAt: string, posts: HistoryPost[]): Promise<number>;
  listPosts(userId: string): Promise<StoredHistoryPost[]>;
  /** Deletes one post and every interpretation that used it. */
  deletePost(userId: string, postId: string): Promise<DeleteCounts>;
  /**
   * Deletes all posts imported under the approval (and their interpretations),
   * and marks it revoked. Returns null if this user has no such approval.
   */
  revokeApproval(userId: string, approvalId: string): Promise<DeleteCounts | null>;
  /** Deletes everything stored for this user. */
  deleteAll(userId: string): Promise<DeleteCounts>;
  saveInterpretations(userId: string, items: AiInterpretation[]): Promise<void>;
  listInterpretations(userId: string): Promise<AiInterpretation[]>;
}
