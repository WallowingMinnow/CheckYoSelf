// Two jobs, kept apart on purpose:
//  1. rankHistory(): SUGGESTS which approved earlier posts look relevant to a
//     draft, so the consent step can pre-select them. Simple and explainable:
//     posts that share meaningful words with the draft come first, then the
//     most recent ones. No AI involved.
//  2. buildHistorySources(): turns EXACTLY the posts the user chose into
//     "history:<postId>" sources. It never adds, drops or swaps a post; if the
//     choice doesn't fit the request limits, it refuses with a clear message.
import { HISTORY_LIMITS, LIMITS, type StoredHistoryPost, type TextSource } from "../../../shared/contract";
import { AppError } from "../errors";

const STOP_WORDS = new Set(
  "about after again also back been before being from have here just like more much only over same some than that their them then there these they this today tonight very want were what when where which while will with would your".split(
    " ",
  ),
);

/** Lowercase words of 4+ letters/digits, minus very common words. */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return new Set(words.filter((w) => !STOP_WORDS.has(w)));
}

/** The text of an earlier post as one source: caption plus any photo text. */
export function historySourceText(post: StoredHistoryPost): string {
  return post.imageText ? `${post.caption}\nText in photo: ${post.imageText}` : post.caption;
}

export interface RankedPost {
  post: StoredHistoryPost;
  sharedWords: number;
}

/**
 * All of the user's posts, most relevant first: most shared words with the
 * draft, ties broken by the most recent publication date.
 */
export function rankHistory(draft: TextSource[], posts: StoredHistoryPost[]): RankedPost[] {
  const draftWords = keywords(draft.map((s) => s.text).join(" "));
  return posts
    .map((post) => {
      let sharedWords = 0;
      for (const w of keywords(historySourceText(post))) if (draftWords.has(w)) sharedWords++;
      return { post, sharedWords, time: Date.parse(post.publishedAt) || 0 };
    })
    .sort((a, b) => b.sharedWords - a.sharedWords || b.time - a.time)
    .map(({ post, sharedWords }) => ({ post, sharedWords }));
}

/** The top suggestions to pre-select (at most HISTORY_LIMITS.maxPostsPerAnalysis). */
export function suggestHistory(draft: TextSource[], posts: StoredHistoryPost[]): RankedPost[] {
  return rankHistory(draft, posts).slice(0, HISTORY_LIMITS.maxPostsPerAnalysis);
}

export interface HistorySelection {
  sources: TextSource[];
  used: Array<{ sourceId: string; postId: string; publishedAt: string }>;
}

/**
 * Turns the user's chosen posts (in the order chosen) into analysis sources.
 * Throws BAD_REQUEST, instead of quietly leaving posts out, if the choice
 * would break the request limits.
 */
export function buildHistorySources(
  draft: TextSource[],
  chosen: StoredHistoryPost[],
  maxPosts: number = HISTORY_LIMITS.maxPostsPerAnalysis,
): HistorySelection {
  if (chosen.length > maxPosts) {
    throw new AppError("BAD_REQUEST", 400, `Choose at most ${maxPosts} earlier posts per check.`);
  }
  if (draft.length + chosen.length > LIMITS.maxSources) {
    throw new AppError("BAD_REQUEST", 400, `Too many pieces of text (max ${LIMITS.maxSources}). Choose fewer earlier posts.`);
  }
  let totalChars = draft.reduce((n, s) => n + s.text.length, 0);
  const result: HistorySelection = { sources: [], used: [] };
  for (const post of chosen) {
    const text = historySourceText(post);
    if (text.length > LIMITS.maxCharsPerSource) {
      throw new AppError("BAD_REQUEST", 400, `Earlier post ${post.postId} is too long to include (max ${LIMITS.maxCharsPerSource} characters).`);
    }
    totalChars += text.length;
    const sourceId = `history:${post.postId}`;
    result.sources.push({ id: sourceId, type: "history", text, date: post.publishedAt });
    result.used.push({ sourceId, postId: post.postId, publishedAt: post.publishedAt });
  }
  if (totalChars > LIMITS.maxTotalChars) {
    throw new AppError("BAD_REQUEST", 400, `The draft and chosen earlier posts are too long together (max ${LIMITS.maxTotalChars} characters). Choose fewer earlier posts.`);
  }
  return result;
}
