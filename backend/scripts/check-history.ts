// Run with: npm run check:history
// Proves the Databricks App's history storage really works: imports ONE
// made-up post for a throwaway test user, reads it back, revokes it, and
// checks it is gone. Uses no real post text. Requires HISTORY_STORE=databricks-app.
import { randomUUID } from "node:crypto";
import { config, missingDatabricksSettings } from "../src/config";
import { getDefaultClient } from "../src/databricks";
import { DatabricksAppHistoryStore } from "../src/history/appStore";

try {
  if (config.historyStore !== "databricks-app") {
    console.error("Failed: set HISTORY_STORE=databricks-app in backend/.env first (dev-memory is not Databricks).");
    process.exit(1);
  }
  const missing = missingDatabricksSettings();
  if (missing.length > 0) {
    console.error(`Failed: missing in backend/.env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const store = new DatabricksAppHistoryStore(getDefaultClient());
  const userId = `check_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const approvalId = randomUUID();
  const post = {
    postId: "check-post-1",
    status: "published" as const,
    publishedAt: "2026-01-01T00:00:00.000Z",
    caption: "CheckYo'Self storage check. Synthetic text, safe to delete.",
  };

  console.log("- importing 1 synthetic post for a throwaway test user ...");
  await store.importPosts(userId, approvalId, new Date().toISOString(), [post]);
  const listed = await store.listPosts(userId);
  if (listed.length !== 1 || listed[0].caption !== post.caption) throw new Error("the post did not read back correctly.");
  console.log("- read back OK. Revoking the approval ...");
  const counts = await store.revokeApproval(userId, approvalId);
  if (!counts || counts.deletedPosts !== 1) throw new Error("revoking did not delete the post.");
  if ((await store.listPosts(userId)).length !== 0) throw new Error("the post is still listed after revoking.");
  console.log("Success. History storage verified (import, read, revoke, delete).");
} catch (err) {
  console.error(`Failed: ${(err as Error).message}`);
  process.exit(1);
}
