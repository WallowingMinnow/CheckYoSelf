// A random id for THIS install of the extension, so the backend keeps each
// person's approved post history apart (sent as the X-Second-Look-User header).
//
// It is NOT a name, email or Instagram handle: just random letters, created
// the first time it's needed and kept in chrome.storage.local (this browser
// profile only). Removing the extension deletes it.
import { USER_ID_PATTERN } from "../../shared/contract";

const STORAGE_KEY = "checkyoselfUserId";

/** Makes a new id like "u_3fK9..." (24 random characters). Pure, so it can be tested. */
export function newUserId(randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = randomBytes(24);
  let id = "u_";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === "string" && USER_ID_PATTERN.test(value);
}

/** This install's id: read from storage, or created and saved the first time. */
export async function getUserId(): Promise<string> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (isValidUserId(stored)) return stored;
  const id = newUserId();
  await chrome.storage.local.set({ [STORAGE_KEY]: id });
  return id;
}
