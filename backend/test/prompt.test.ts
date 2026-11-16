// Tests for the prompt builder (src/prompt.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMessages } from "../src/prompt";

const SOURCES = [{ id: "history:p1", type: "history" as const, text: "Mia's first day", date: "2026-09-01T08:00:00Z" }];

test("a draft check has no 'already published' instructions", () => {
  const [, user] = buildMessages(SOURCES);
  assert.doesNotMatch(user.content, /NO new draft/);
  assert.match(user.content, /<sources>/);
});

test("assessing saved posts tells the model there's no draft and to combine posts", () => {
  const [system, user] = buildMessages(SOURCES, "history");
  assert.match(user.content, /NO new draft/);
  assert.match(user.content, /combinations ACROSS posts/);
  assert.ok(user.content.indexOf("NO new draft") < user.content.indexOf("<sources>"), "instructions come before the data");
  assert.match(system.content, /untrusted DATA/, "same safety rules");
});
