// Reads YOUR posts from Instagram's own data export ("Download your
// information", JSON format), so you can choose which past posts to save as
// history. Runs on this computer only; nothing here talks to the network.
// No DOM and no Chrome calls, so it can be tested in Node
// (test/instagram-export.test.ts).
//
// What the export looks like (UNVERIFIED against every account: Instagram
// has changed it over the years, so this accepts both known layouts and
// checks every field):
//   <export folder>/your_instagram_activity/content/posts_1.json   (newer)
//   <export folder>/content/posts_1.json                           (older)
//   <export folder>/media/posts_1.json                             (seen 2026-11, photos in posts/)
// Any posts_<N>.json in the chosen folder is read. Newer exports may have
// (also, or only) a "posts.json" in a label-based format:
//   [{ "timestamp": 1794748844, "label_values": [
//        { "label": "Media", "media": [{ "uri": "media/posts/1.jpg", ... }] },
//        { "label": "Caption", "value": "..." }, { "label": "Draft", "value": "False" }, ... ] }]
// It describes the same posts, so it's only used when there's no posts_<N>.json.
// posts_1.json is a list of posts:
//   [{ "media": [{ "uri": "media/posts/202403/123.jpg", "creation_timestamp": 1710000000, "title": "caption" }],
//      "title": "caption (posts with several photos)", "creation_timestamp": 1710000000 }]
// The "uri" is relative to the export folder. Text is UTF-8 that Instagram
// wrote byte by byte ("Ã©" instead of "é"), which fixExportText() undoes.
import { HISTORY_LIMITS } from "../../shared/contract";

export interface ExportPost {
  /** Stable id for history: "ig_<unix seconds>" (+ "_2", "_3" for posts in the same second). */
  postId: string;
  /** ISO 8601. */
  publishedAt: string;
  /** Caption, fixed encoding, cut to HISTORY_LIMITS.maxCharsPerPost. */
  caption: string;
  /** Photo files of this post, relative to the export folder (videos left out). */
  photos: string[];
  /** All media in the post (photos + videos). */
  mediaCount: number;
  hasVideo: boolean;
}

const POSTS_FILE = /(^|\/)posts_\d+\.json$/i;
const LABELLED_POSTS_FILE = /(^|\/)posts\.json$/i;
const PHOTO = /\.(jpe?g|png|webp|gif|heic)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;

/**
 * Which of the chosen files are post lists: every posts_<N>.json, or if there
 * are none, posts.json (newer label-based format). Paths use "/" (as in
 * File.webkitRelativePath).
 */
export function findPostFiles(paths: string[]): string[] {
  const norm = paths.map((p) => p.replaceAll("\\", "/"));
  const numbered = norm.filter((p) => POSTS_FILE.test(p));
  return (numbered.length > 0 ? numbered : norm.filter((p) => LABELLED_POSTS_FILE.test(p))).sort();
}

/** The .json files among the chosen ones (to tell the user what was seen when no posts are found). */
export function jsonFilesSeen(paths: string[]): string[] {
  return paths.map((p) => p.replaceAll("\\", "/")).filter((p) => /\.json$/i.test(p)).sort();
}

/**
 * Turns one entry of the label-based posts.json into the classic shape
 * ({ media, title, creation_timestamp }), or null if it's a draft, not
 * published, or has no media. Entries already in the classic shape are returned as they are.
 */
function normalizeEntry(entry: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(entry.label_values)) return entry;
  const labels = entry.label_values.filter(isObject);
  const find = (name: string) => labels.find((l) => typeof l.label === "string" && l.label.toLowerCase() === name.toLowerCase());
  const flag = (name: string) => String(find(name)?.value ?? "").trim().toLowerCase();
  if (flag("Draft") === "true" || flag("Published") === "false") return null;
  const media = find("Media")?.media;
  if (!Array.isArray(media) || media.length === 0) return null;
  const caption = find("Caption")?.value ?? find("Title")?.value;
  return {
    media,
    title: typeof caption === "string" ? caption : "",
    creation_timestamp: seconds(entry.timestamp) ?? seconds(find("Creation time")?.timestamp_value) ?? undefined,
  };
}

/**
 * Instagram writes UTF-8 text one byte per character ("Iâ\u0080\u0099m"
 * instead of "I'm"). If the text looks like that, decode it back; otherwise
 * leave it as it is.
 */
export function fixExportText(text: string): string {
  let hasHigh = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) return text; // real Unicode already: not byte-encoded
    if (c >= 0x80) hasHigh = true;
  }
  if (!hasHigh) return text;
  try {
    const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text; // not valid UTF-8 bytes after all
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function seconds(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/**
 * Turns the contents of one or more posts_N.json files into posts, newest
 * first. Entries that aren't recognizable posts are skipped (and counted).
 */
export function parsePostFiles(jsonTexts: string[]): { posts: ExportPost[]; skipped: number } {
  const raw: { ts: number; caption: string; photos: string[]; mediaCount: number; hasVideo: boolean }[] = [];
  let skipped = 0;

  for (const text of jsonTexts) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      skipped++;
      continue;
    }
    // Usually a list; some versions wrap it in an object.
    const entries: unknown[] = Array.isArray(data)
      ? data
      : isObject(data)
        ? ((Object.values(data).find(Array.isArray) as unknown[] | undefined) ?? [])
        : [];
    for (const rawEntry of entries) {
      const entry = isObject(rawEntry) ? normalizeEntry(rawEntry) : null;
      if (!entry || !Array.isArray(entry.media) || entry.media.length === 0) {
        skipped++;
        continue;
      }
      const media = entry.media.filter(isObject);
      const uris = media.map((m) => (typeof m.uri === "string" ? m.uri.replaceAll("\\", "/") : "")).filter(Boolean);
      const ts = seconds(entry.creation_timestamp) ?? seconds(media[0]?.creation_timestamp);
      if (ts === null || uris.length === 0) {
        skipped++;
        continue;
      }
      // Several photos: caption on the post. One photo: caption on the media item.
      const title = typeof entry.title === "string" && entry.title ? entry.title : typeof media[0]?.title === "string" ? media[0].title : "";
      raw.push({
        ts,
        caption: fixExportText(title).slice(0, HISTORY_LIMITS.maxCharsPerPost),
        photos: uris.filter((u) => PHOTO.test(u)),
        mediaCount: uris.length,
        hasVideo: uris.some((u) => VIDEO.test(u)),
      });
    }
  }

  // Oldest first while numbering, so ids don't change when newer posts are added.
  raw.sort((a, b) => a.ts - b.ts);
  const used = new Map<number, number>();
  const posts = raw.map((p) => {
    const n = (used.get(p.ts) ?? 0) + 1;
    used.set(p.ts, n);
    return {
      postId: n === 1 ? `ig_${p.ts}` : `ig_${p.ts}_${n}`,
      publishedAt: new Date(p.ts * 1000).toISOString(),
      caption: p.caption,
      photos: p.photos,
      mediaCount: p.mediaCount,
      hasVideo: p.hasVideo,
    };
  });
  posts.reverse(); // newest first for the list the user picks from
  return { posts, skipped };
}

/**
 * Finds the photo file for a "uri" from the JSON among the chosen files
 * (paths relative to the chosen folder, with "/"). The uri is relative to the
 * export root, but exports are laid out differently and people move folders:
 * the JSON can say "media/posts/123.jpg" while the file is at "posts/123.jpg".
 * So: the exact path, else a path that one ends with (or that ends with it),
 * else the only file with that file name. Returns undefined if not found or
 * ambiguous.
 */
export function resolvePhotoPath(uri: string, paths: string[]): string | undefined {
  const want = uri.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!want) return undefined;
  const norm = paths.map((p) => p.replaceAll("\\", "/"));
  const exact = norm.find((p) => p === want);
  if (exact !== undefined) return exact;
  const nested = norm.filter((p) => p.endsWith(`/${want}`) || want.endsWith(`/${p}`));
  if (nested.length === 1) return nested[0];
  const name = want.slice(want.lastIndexOf("/") + 1).toLowerCase();
  const sameName = norm.filter((p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase() === name);
  return sameName.length === 1 ? sameName[0] : undefined;
}

/** Joins the photo texts of one post into history's single imageText (max chars). */
export function joinPhotoTexts(texts: string[]): string | undefined {
  const joined = texts.map((t) => t.trim()).filter(Boolean).join("\n\n");
  return joined ? joined.slice(0, HISTORY_LIMITS.maxCharsPerPost) : undefined;
}
