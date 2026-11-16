// Tests for the post's photos and their text (src/content/photo-set.ts):
// carousel photos are numbered as they appear, each gets its own
// "image_text:<n>" source, and the user's typing is never overwritten.
import assert from "node:assert/strict";
import { test } from "node:test";
import { carouselProgress, PhotoSet } from "../src/content/photo-set";
import { sourceLabel } from "../src/render";

test("photos are numbered in the order they first appear (carousel slides one by one)", () => {
  const set = new PhotoSet();
  assert.deepEqual(set.sync(["img:a"]).map((p) => p.index), [1]);
  // Next slide shown: a new photo. The first keeps its number.
  assert.deepEqual(set.sync(["img:b"]).map((p) => p.index), [2]);
  // Going back to slide 1, or both on screen at once: nothing new.
  assert.deepEqual(set.sync(["img:a", "img:b"]), []);
  assert.deepEqual(set.sync(["img:c", "img:a"]).map((p) => [p.key, p.index]), [["img:c", 3]]);
  assert.deepEqual(set.all().map((p) => p.key), ["img:a", "img:b", "img:c"]);
});

test("each photo with text becomes its own image_text:<n> source, in photo order", () => {
  const set = new PhotoSet();
  set.sync(["a", "b", "c"]);
  set.finishReading("a", "Riverside Youth Soccer", "Read.");
  set.finishReading("b", "", "No readable text found.");
  set.finishReading("c", "Coach Dana 608-555-0142", "Read.");
  assert.deepEqual(set.sources(), [
    { id: "image_text:1", type: "image_text", text: "Riverside Youth Soccer" },
    { id: "image_text:3", type: "image_text", text: "Coach Dana 608-555-0142" },
  ]);
});

test("checking waits while any photo is still being read, unless the user typed its text", () => {
  const set = new PhotoSet();
  set.sync(["a", "b"]);
  set.finishReading("a", "x", "Read.");
  assert.equal(set.isReading(), true, "photo 2 is still being read");
  set.setTyped(2, "I typed this");
  assert.equal(set.isReading(), false);
});

test("text the user typed is never overwritten by a later read", () => {
  const set = new PhotoSet();
  set.sync(["a"]);
  set.setTyped(1, "my own text");
  set.finishReading("a", "OCR guess", "Read from the photo.");
  assert.equal(set.get(1)!.text, "my own text");
  assert.match(set.get(1)!.hint, /yours was kept/);
});

test("a read for a photo of a closed post is ignored; reset starts over at 1", () => {
  const set = new PhotoSet();
  set.sync(["a", "b"]);
  set.reset();
  set.finishReading("a", "late result", "Read.");
  assert.deepEqual(set.sources(), []);
  assert.equal(set.key(), null);
  assert.deepEqual(set.sync(["z"]).map((p) => p.index), [1]);
});

test("the draft key changes when a photo is added", () => {
  const set = new PhotoSet();
  set.sync(["a"]);
  const one = set.key();
  set.sync(["b"]);
  assert.notEqual(set.key(), one);
});

test("the popup gets one text: a single photo as is, several labeled by number", () => {
  const set = new PhotoSet();
  set.sync(["a"]);
  set.finishReading("a", "Only one", "Read.");
  assert.equal(set.joinedText(), "Only one");
  set.sync(["b"]);
  set.finishReading("b", "Second", "Read.");
  assert.equal(set.joinedText(), "Photo 1: Only one\n\nPhoto 2: Second");
});

test("findings name the photo a quote came from when a post has several", () => {
  assert.equal(sourceLabel(undefined, "image_text:1"), "Photo text");
  assert.equal(sourceLabel(undefined, "image_text:1", 2), "Photo 1 text");
  assert.equal(sourceLabel(undefined, "image_text:2", 2), "Photo 2 text");
  assert.equal(sourceLabel(undefined, "caption", 2), "Caption");
});

test("carousel prompt: asks to click through until the last photo is shown and read", () => {
  const start = carouselProgress(1, false, true);
  assert.equal(start.complete, false);
  assert.ok(start.launcher.includes("click › to show each photo (1 read)"), start.launcher);
  assert.match(start.banner, /several photos.*Click the › arrow/);
  // Last photo reached but still reading: not complete yet.
  assert.equal(carouselProgress(3, true, true).complete, false);
  const done = carouselProgress(3, true, false);
  assert.equal(done.complete, true);
  assert.match(done.launcher, /all 3 photos read/);
  assert.match(done.banner, /All 3 photos read ✓/);
});

test("the profile is labeled as such in findings", () => {
  assert.equal(sourceLabel(undefined, "profile"), "Your past posts (profile)");
});
