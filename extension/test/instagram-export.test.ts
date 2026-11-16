// Tests for reading posts from Instagram's data export (src/instagram-export.ts)
// and for the per-install user id (src/user-id.ts). Fictional data only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_LIMITS, USER_ID_PATTERN } from "../../shared/contract";
import { findPostFiles, fixExportText, joinPhotoTexts, jsonFilesSeen, parsePostFiles, resolvePhotoPath } from "../src/instagram-export";
import { isValidUserId, newUserId } from "../src/user-id";

// Instagram writes "I’m at the café" as UTF-8 bytes, one per character:
const MOJIBAKE_IM = "Iâ\u0080\u0099m at the cafÃ©";

const EXPORT = JSON.stringify([
  // Newer single-photo post: caption on the media item.
  { media: [{ uri: "media/posts/202403/111.jpg", creation_timestamp: 1710000000, title: MOJIBAKE_IM }] },
  // Carousel: caption on the post, two photos and a video.
  {
    title: "First day at Lincoln Park Elementary!",
    creation_timestamp: 1700000000,
    media: [
      { uri: "media/posts/202311/a.jpg", creation_timestamp: 1700000000, title: "" },
      { uri: "media/posts/202311/b.png", creation_timestamp: 1700000000, title: "" },
      { uri: "media/posts/202311/c.mp4", creation_timestamp: 1700000000, title: "" },
    ],
  },
  // Same second as the first post: must still get its own id.
  { media: [{ uri: "media/posts/202403/112.jpg", creation_timestamp: 1710000000, title: "Second one" }] },
  // Not a post: skipped.
  { note: "something else" },
]);

test("finds post files in both known export layouts, and nothing else", () => {
  const files = findPostFiles([
    "instagram-me-2026/your_instagram_activity/content/posts_1.json",
    "instagram-me-2026/content/posts_2.json",
    "instagram-me-2026/your_instagram_activity/content/stories.json",
    "instagram-me-2026/media/posts/202403/111.jpg",
    "instagram-me-2026/personal_information/personal_information.json",
  ]);
  assert.deepEqual(files, ["instagram-me-2026/content/posts_2.json", "instagram-me-2026/your_instagram_activity/content/posts_1.json"]);
});

test("finds posts_1.json in a media folder too (a real 2026 export), but not posts.json or similar names", () => {
  const files = findPostFiles([
    "Instagram_folder/media/posts_1.json",
    "Instagram_folder/media/posts.json",          // different, label-based format
    "Instagram_folder/media/archived_posts_1.json",
    "Instagram_folder/posts/17963947307997283.jpg",
  ]);
  assert.deepEqual(files, ["Instagram_folder/media/posts_1.json"]);
});

test("an export with only the newer posts.json is read; with both, posts_N.json wins (no duplicates)", () => {
  assert.deepEqual(findPostFiles(["ig/media/posts.json", "ig/posts/1.jpg"]), ["ig/media/posts.json"]);
  assert.deepEqual(findPostFiles(["ig/media/posts.json", "ig/media/posts_1.json"]), ["ig/media/posts_1.json"]);
  assert.deepEqual(findPostFiles(["ig/media/stories.json", "ig/a.jpg"]), []);
  assert.deepEqual(jsonFilesSeen(["ig/media/stories.json", "ig/a.jpg", "ig\\x\\Y.JSON"]), ["ig/media/stories.json", "ig/x/Y.JSON"]);
});

test("the newer label-based posts.json format is parsed; drafts and unpublished posts are skipped", () => {
  const label = (name: string, rest: object) => ({ label: name, ...rest });
  const labelled = JSON.stringify([
    { timestamp: 1794748844, fbid: "1", media: [], label_values: [
      label("Media", { media: [{ uri: "media/posts/1.jpg", creation_timestamp: 1794748843, title: "" }] }),
      label("Caption", { value: "Back home on Maple St" }), label("Draft", { value: "False" }), label("Published", { value: "True" }),
    ] },
    { timestamp: 1794748900, fbid: "2", media: [], label_values: [
      label("Media", { media: [{ uri: "media/posts/2.jpg", creation_timestamp: 1794748900, title: "" }] }),
      label("Caption", { value: "a draft" }), label("Draft", { value: "True" }),
    ] },
    { timestamp: 1794749000, fbid: "3", media: [], label_values: [label("Caption", { value: "no media" })] },
  ]);
  const { posts, skipped } = parsePostFiles([labelled]);
  assert.equal(skipped, 2);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], {
    postId: "ig_1794748844", publishedAt: new Date(1794748844 * 1000).toISOString(), caption: "Back home on Maple St",
    photos: ["media/posts/1.jpg"], mediaCount: 1, hasVideo: false,
  });
});

test("photo files are found even when the folder layout differs from the uri in the JSON", () => {
  const chosen = ["media/posts_1.json", "posts/17963947307997283.jpg", "posts/18112292417363585.jpg"];
  // The JSON says media/posts/<id>.jpg; the photo is at posts/<id>.jpg.
  assert.equal(resolvePhotoPath("media/posts/17963947307997283.jpg", chosen), "posts/17963947307997283.jpg");
  // Exact path wins.
  assert.equal(resolvePhotoPath("media/posts/202403/111.jpg", ["media/posts/202403/111.jpg", "other/111.jpg"]), "media/posts/202403/111.jpg");
  // Export picked one level too high: the uri is inside a subfolder.
  assert.equal(resolvePhotoPath("media/posts/a.jpg", ["instagram-me/media/posts/a.jpg"]), "instagram-me/media/posts/a.jpg");
  // Missing, or two files with the same name and no better match: not guessed.
  assert.equal(resolvePhotoPath("media/posts/nope.jpg", chosen), undefined);
  assert.equal(resolvePhotoPath("media/posts/x.jpg", ["a/x.jpg", "b/x.jpg"]), undefined);
});

test("fixes Instagram's byte-by-byte UTF-8, and leaves normal text alone", () => {
  assert.equal(fixExportText(MOJIBAKE_IM), "I’m at the café");
  assert.equal(fixExportText("plain text"), "plain text");
  assert.equal(fixExportText("already fine: café 🙃"), "already fine: café 🙃");
  assert.equal(fixExportText("é alone is not UTF-8"), "é alone is not UTF-8");
});

test("reads captions, dates, photos and videos; newest first; skips non-posts", () => {
  const { posts, skipped } = parsePostFiles([EXPORT]);
  assert.equal(skipped, 1);
  assert.equal(posts.length, 3);
  // Newest first.
  assert.deepEqual(posts.map((p) => p.publishedAt.slice(0, 10)), ["2024-03-09", "2024-03-09", "2023-11-14"]);
  const carousel = posts[2];
  assert.equal(carousel.caption, "First day at Lincoln Park Elementary!");
  assert.deepEqual(carousel.photos, ["media/posts/202311/a.jpg", "media/posts/202311/b.png"]);
  assert.equal(carousel.mediaCount, 3);
  assert.equal(carousel.hasVideo, true);
  assert.ok(posts.some((p) => p.caption === "I’m at the café"), "encoding fixed");
});

test("post ids are valid for the backend, unique, and stable when re-read", () => {
  const first = parsePostFiles([EXPORT]).posts.map((p) => p.postId);
  const again = parsePostFiles([EXPORT]).posts.map((p) => p.postId);
  assert.deepEqual(first, again);
  assert.equal(new Set(first).size, first.length);
  for (const id of first) assert.match(id, /^[A-Za-z0-9_.-]{1,80}$/);
  assert.ok(first.includes("ig_1710000000") && first.includes("ig_1710000000_2"));
});

test("broken JSON or odd shapes never throw; they're skipped", () => {
  const { posts, skipped } = parsePostFiles(["{not json", JSON.stringify({ wrapped: [{ media: [{ uri: "x.jpg", creation_timestamp: 5 }] }] }), "42"]);
  assert.equal(posts.length, 1, "a list wrapped in an object is still read");
  assert.equal(skipped, 1);
});

test("captions and joined photo text are cut to the backend's per-post limit", () => {
  const long = JSON.stringify([{ media: [{ uri: "p.jpg", creation_timestamp: 9, title: "x".repeat(9000) }] }]);
  assert.equal(parsePostFiles([long]).posts[0].caption.length, HISTORY_LIMITS.maxCharsPerPost);
  assert.equal(joinPhotoTexts(["a".repeat(4000), "b".repeat(4000)])!.length, HISTORY_LIMITS.maxCharsPerPost);
  assert.equal(joinPhotoTexts(["", "  "]), undefined);
  assert.equal(joinPhotoTexts(["Coach Dana", "Room 12"]), "Coach Dana\n\nRoom 12");
});

test("the install id is random, valid for the backend, and not personal", () => {
  const a = newUserId();
  const b = newUserId();
  assert.notEqual(a, b);
  assert.match(a, USER_ID_PATTERN);
  assert.ok(isValidUserId(a));
  assert.equal(isValidUserId("short"), false);
  assert.equal(isValidUserId("has spaces in it"), false);
});
