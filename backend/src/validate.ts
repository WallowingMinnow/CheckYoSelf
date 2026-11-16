// Checks that a request body matches AnalyzeRequest before we use it.
// It also enforces our privacy rule: ONLY text goes to Databricks — no images,
// image URLs, base64 blobs, or unknown extra fields.
import {
  CONTRACT_VERSION,
  HISTORY_LIMITS,
  LIMITS,
  USER_ID_PATTERN,
  type AnalyzeRequest,
  type HistoryAssessRequest,
  type HistoryImportRequest,
  type HistoryPost,
  type HistorySuggestRequest,
  type SourceType,
  type TextSource,
} from "../../shared/contract";
import { AppError } from "./errors";

// The extension sends only the DRAFT. "history" sources come from approved,
// stored history and are added by the backend, never accepted from a request.
const SOURCE_TYPES: SourceType[] = ["caption", "image_text"];
const ID_PATTERN = /^(caption|image_text(:[A-Za-z0-9_.-]{1,80})?)$/;
export const POST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
const APPROVAL_ID_PATTERN = /^[a-f0-9-]{36}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

// Things that look like images or image links. We refuse them outright.
const IMAGE_DATA_URL = /data:image\//i;
const LONG_BASE64_RUN = /[A-Za-z0-9+/=]{400,}/;
const INSTAGRAM_MEDIA_URL = /https?:\/\/\S*(cdninstagram\.com|fbcdn\.net)/i;

function fail(message: string): never {
  throw new AppError("BAD_REQUEST", 400, message);
}

function checkOnlyKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`Unexpected field "${key}" in ${where}.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkContractVersion(value: unknown) {
  if (value !== CONTRACT_VERSION) {
    fail(`contractVersion must be "${CONTRACT_VERSION}". Rebuild the extension and restart the backend.`);
  }
}

export function validateAnalyzeRequest(body: unknown): AnalyzeRequest {
  if (!isPlainObject(body)) fail("Body must be a JSON object.");
  checkOnlyKeys(body, ["contractVersion", "draftHash", "sources", "historyPostIds", "usePortfolio"], "request");
  checkContractVersion(body.contractVersion);
  if (typeof body.draftHash !== "string" || !HASH_PATTERN.test(body.draftHash)) {
    fail("draftHash must be a 64-character lowercase hex SHA-256.");
  }
  const sources = validateDraftSources(body.sources);
  const request: AnalyzeRequest = { contractVersion: CONTRACT_VERSION, draftHash: body.draftHash, sources };

  // Earlier posts the user chose on the consent step. Checked for format here;
  // the server then checks each one is in THIS user's approved history.
  if (body.historyPostIds !== undefined) {
    if (!Array.isArray(body.historyPostIds)) fail("historyPostIds must be a list of post ids.");
    if (body.historyPostIds.length > HISTORY_LIMITS.maxPostsPerAnalysis) {
      fail(`Choose at most ${HISTORY_LIMITS.maxPostsPerAnalysis} earlier posts per check.`);
    }
    const ids = body.historyPostIds.map(validatePostId);
    if (new Set(ids).size !== ids.length) fail("historyPostIds lists the same post twice.");
    if (ids.length > 0) request.historyPostIds = ids;
  }
  if (body.usePortfolio !== undefined) {
    if (typeof body.usePortfolio !== "boolean") fail("usePortfolio must be true or false.");
    if (body.usePortfolio) request.usePortfolio = true;
  }
  return request;
}

/** POST /api/history/assess: the saved posts the user chose (ids only). */
export function validateHistoryAssess(body: unknown): HistoryAssessRequest {
  if (!isPlainObject(body)) fail("Body must be a JSON object.");
  checkOnlyKeys(body, ["contractVersion", "postIds"], "request");
  checkContractVersion(body.contractVersion);
  if (!Array.isArray(body.postIds) || body.postIds.length === 0) fail("postIds must be a non-empty list of saved post ids.");
  if (body.postIds.length > HISTORY_LIMITS.maxPostsPerAssessment) {
    fail(`Assess at most ${HISTORY_LIMITS.maxPostsPerAssessment} saved posts at a time.`);
  }
  const ids = body.postIds.map(validatePostId);
  if (new Set(ids).size !== ids.length) fail("postIds lists the same post twice.");
  return { contractVersion: CONTRACT_VERSION, postIds: ids };
}

/** POST /api/history/portfolio/scan: nothing but the contract version. */
export function validatePortfolioScan(body: unknown): void {
  if (!isPlainObject(body)) fail("Body must be a JSON object.");
  checkOnlyKeys(body, ["contractVersion"], "request");
  checkContractVersion(body.contractVersion);
}

/** POST /api/history/suggest: the draft only. */
export function validateHistorySuggest(body: unknown): HistorySuggestRequest {
  if (!isPlainObject(body)) fail("Body must be a JSON object.");
  checkOnlyKeys(body, ["contractVersion", "sources"], "request");
  checkContractVersion(body.contractVersion);
  return { contractVersion: CONTRACT_VERSION, sources: validateDraftSources(body.sources) };
}

/**
 * The DRAFT's sources ("caption" and "image_text" only). Also enforces the
 * privacy rule: text only, no image data or image URLs.
 */
function validateDraftSources(rawSources: unknown): TextSource[] {
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    fail("sources must be a non-empty array.");
  }
  if (rawSources.length > LIMITS.maxSources) {
    fail(`Too many sources (max ${LIMITS.maxSources}).`);
  }

  const seenIds = new Set<string>();
  let totalChars = 0;
  const sources: TextSource[] = rawSources.map((raw, i) => {
    const where = `sources[${i}]`;
    if (!isPlainObject(raw)) fail(`${where} must be an object.`);
    checkOnlyKeys(raw, ["id", "type", "text", "date"], where);

    const { id, type, text, date } = raw;
    if (type === "history") {
      fail(`${where}: history can't be sent with a draft. Import approved posts with /api/history/import and list them in historyPostIds.`);
    }
    if (typeof id !== "string" || !ID_PATTERN.test(id)) fail(`${where}.id is not a valid source id.`);
    if (seenIds.has(id)) fail(`Duplicate source id "${id}".`);
    seenIds.add(id);

    if (!SOURCE_TYPES.includes(type as SourceType)) fail(`${where}.type must be one of ${SOURCE_TYPES.join(", ")}.`);
    if (!id.startsWith(type as string)) fail(`${where}.id must start with its type ("${type}").`);

    if (typeof text !== "string") fail(`${where}.text must be a string.`);
    if (text.length > LIMITS.maxCharsPerSource) fail(`${where}.text is too long (max ${LIMITS.maxCharsPerSource}).`);
    if (IMAGE_DATA_URL.test(text) || LONG_BASE64_RUN.test(text)) fail(`${where}.text looks like image data. Send text only.`);
    if (INSTAGRAM_MEDIA_URL.test(text)) fail(`${where}.text contains an image URL. Send text only.`);
    totalChars += text.length;

    if (date !== undefined && (typeof date !== "string" || Number.isNaN(Date.parse(date)))) {
      fail(`${where}.date must be an ISO 8601 date string.`);
    }

    const source: TextSource = { id, type: type as SourceType, text };
    if (typeof date === "string") source.date = date;
    return source;
  });

  if (totalChars > LIMITS.maxTotalChars) fail(`Request text too long (max ${LIMITS.maxTotalChars} chars total).`);
  if (!sources.some((s) => s.text.trim().length > 0)) fail("All sources are empty. Type a caption first.");
  return sources;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The user id from the X-Second-Look-User header. */
export function validateUserId(value: unknown): string {
  if (typeof value !== "string" || !USER_ID_PATTERN.test(value)) {
    fail("Missing or invalid user id header (X-Second-Look-User: 8-64 letters, digits, _ or -).");
  }
  return value;
}

export function validatePostId(value: unknown): string {
  if (typeof value !== "string" || !POST_ID_PATTERN.test(value)) fail("Invalid post id.");
  return value;
}

export function validateApprovalId(value: unknown): string {
  if (typeof value !== "string" || !APPROVAL_ID_PATTERN.test(value)) fail("Invalid approval id.");
  return value;
}

function checkText(value: unknown, where: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") fail(`${where} must be text.`);
  if (value.length > HISTORY_LIMITS.maxCharsPerPost) fail(`${where} is too long (max ${HISTORY_LIMITS.maxCharsPerPost}).`);
  if (IMAGE_DATA_URL.test(value) || LONG_BASE64_RUN.test(value)) fail(`${where} looks like image data. Send text only.`);
  if (INSTAGRAM_MEDIA_URL.test(value)) fail(`${where} contains an image URL. Send text only.`);
  return value;
}

/**
 * Checks an import request. Only PUBLISHED posts the user explicitly approved:
 * approval.approved must be true and approval.postIds must list exactly the
 * posts being imported. Drafts are refused.
 */
export function validateHistoryImport(body: unknown): HistoryImportRequest {
  if (!isPlainObject(body)) fail("Body must be a JSON object.");
  checkOnlyKeys(body, ["contractVersion", "approval", "posts"], "request");
  if (body.contractVersion !== CONTRACT_VERSION) fail(`contractVersion must be "${CONTRACT_VERSION}".`);

  const { approval, posts } = body;
  if (!isPlainObject(approval)) fail("approval is required.");
  checkOnlyKeys(approval, ["approved", "postIds"], "approval");
  if (approval.approved !== true) fail("approval.approved must be true. Only import posts the user approved.");
  if (!Array.isArray(approval.postIds)) fail("approval.postIds must be a list.");

  if (!Array.isArray(posts) || posts.length === 0) fail("posts must be a non-empty list.");
  if (posts.length > HISTORY_LIMITS.maxPostsPerImport) fail(`Too many posts (max ${HISTORY_LIMITS.maxPostsPerImport} per import).`);

  const seen = new Set<string>();
  const cleanPosts: HistoryPost[] = posts.map((raw, i) => {
    const where = `posts[${i}]`;
    if (!isPlainObject(raw)) fail(`${where} must be an object.`);
    checkOnlyKeys(raw, ["postId", "status", "publishedAt", "caption", "imageText"], where);
    const postId = validatePostId(raw.postId);
    if (seen.has(postId)) fail(`Duplicate postId "${postId}".`);
    seen.add(postId);
    if (raw.status !== "published") {
      fail(`${where}.status must be "published". Drafts are never stored as history.`);
    }
    if (typeof raw.publishedAt !== "string" || Number.isNaN(Date.parse(raw.publishedAt))) {
      fail(`${where}.publishedAt must be an ISO 8601 date.`);
    }
    if (Date.parse(raw.publishedAt) > Date.now() + 5 * 60_000) fail(`${where}.publishedAt is in the future.`);
    const post: HistoryPost = {
      postId,
      status: "published",
      publishedAt: new Date(raw.publishedAt).toISOString(),
      caption: checkText(raw.caption, `${where}.caption`, true) as string,
    };
    const imageText = checkText(raw.imageText, `${where}.imageText`, false);
    if (imageText !== undefined) post.imageText = imageText;
    return post;
  });

  const approvedIds = new Set(approval.postIds);
  if (approvedIds.size !== approval.postIds.length || approvedIds.size !== seen.size || ![...seen].every((id) => approvedIds.has(id))) {
    fail("approval.postIds must list exactly the posts being imported.");
  }

  return { contractVersion: CONTRACT_VERSION, approval: { approved: true, postIds: [...seen] }, posts: cleanPosts };
}
