// Tests for the page-independent parts of src/content/instagram-adapter.ts.
// (The parts that read Instagram's page are checked by hand on the live site
// with extension/dev/instagram-test-kit.js; see docs/ROADMAP.md.)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyOutcomeText,
  classifyPostType,
  carouselArrows,
  isCarouselHintLabel,
  isShareLabel,
  normalizeCaption,
  textForLanguage,
} from "../src/content/instagram-adapter";

const english = textForLanguage("en")!;

test("caption text is normalized the way the user sees it", () => {
  assert.equal(normalizeCaption("  hi there\r\nline 2\n\n"), "hi there\nline 2");
  assert.equal(normalizeCaption("\n"), "");
});

// --- languages ------------------------------------------------------------------

test("English pages are supported, with or without a region code", () => {
  assert.notEqual(textForLanguage("en"), null);
  assert.notEqual(textForLanguage("en-US"), null);
  assert.notEqual(textForLanguage(" EN-gb "), null);
});

test("other or missing languages are not supported, so the extension stays out of the way", () => {
  assert.equal(textForLanguage("es"), null);
  assert.equal(textForLanguage(""), null);
  assert.equal(textForLanguage(null), null);
});

test("only the exact word Share counts as the Share button", () => {
  assert.equal(isShareLabel(" Share ", english), true);
  assert.equal(isShareLabel("share", english), true);
  assert.equal(isShareLabel("Share to Facebook", english), false);
  assert.equal(isShareLabel("Next", english), false);
  assert.equal(isShareLabel(null, english), false);
});

test("confirmation, failure and neither are told apart", () => {
  assert.equal(classifyOutcomeText("Post shared\nYour post has been shared.", english), "published");
  assert.equal(classifyOutcomeText("Your post couldn't be shared. Try again.", english), "failed");
  assert.equal(classifyOutcomeText("Sharing", english), null);
  assert.equal(classifyOutcomeText("Create new post", english), null);
});

// --- post types -----------------------------------------------------------------

test("one photo and nothing else is a single-photo post", () => {
  assert.equal(classifyPostType({ photoCount: 1, hasVideo: false, carouselHints: 0 }), "single-photo");
});

test("several photos, or carousel arrows, make a multi-photo post", () => {
  assert.equal(classifyPostType({ photoCount: 2, hasVideo: false, carouselHints: 0 }), "multi-photo");
  assert.equal(classifyPostType({ photoCount: 1, hasVideo: false, carouselHints: 1 }), "multi-photo");
});

// Bug found live 2026-11-15: a 2-photo post showed only ONE photo on the
// caption step, and its arrows are labelled "Right chevron" / "Left chevron",
// which the old selector missed, so it was treated as single-photo.
test("Instagram's slide arrows count as carousel hints, other chevrons don't", () => {
  assert.equal(isCarouselHintLabel("Right chevron", english), true);
  assert.equal(isCarouselHintLabel("Left chevron", english), true);
  assert.equal(isCarouselHintLabel("Down chevron icon", english), false); // on every post
  assert.equal(isCarouselHintLabel("Back", english), false);              // the composer's back arrow
  assert.equal(isCarouselHintLabel("Tag people", english), false);
  assert.equal(isCarouselHintLabel(null, english), false);
});

test("any video makes it a video post", () => {
  assert.equal(classifyPostType({ photoCount: 1, hasVideo: true, carouselHints: 0 }), "video");
});

test("no photo found is 'unknown', never guessed as single-photo", () => {
  assert.equal(classifyPostType({ photoCount: 0, hasVideo: false, carouselHints: 0 }), "unknown");
});

test("carousel arrows tell whether more photos are to the right, or this is the last one", () => {
  const english = textForLanguage("en")!;
  // Photo 1 of 2 (VERIFIED on the live site): only "Right chevron".
  assert.deepEqual(carouselArrows(["Right chevron", "Down chevron icon"], english), { hasNext: true, hasPrev: false });
  // Last photo: only "Left chevron".
  assert.deepEqual(carouselArrows(["Left chevron"], english), { hasNext: false, hasPrev: true });
  // A middle photo: both.
  assert.deepEqual(carouselArrows(["Left chevron", "Right chevron"], english), { hasNext: true, hasPrev: true });
  // A single photo: neither (other labels are ignored).
  assert.deepEqual(carouselArrows(["Back", null, "Down chevron icon"], english), { hasNext: false, hasPrev: false });
});
