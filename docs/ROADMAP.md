# Roadmap

Who owns each milestone, and the planned interfaces between them, are in [TEAM.md](TEAM.md).

## Milestone 2: local OCR

- Run OCR in the extension with Tesseract.js. Manifest V3 forbids remotely hosted code, so bundle its worker, WASM core and English language data inside the extension instead of loading them from a CDN.
- OCR output becomes a `TextSource` with `id: "image_text:<n>"` (one per carousel image). The image itself never leaves the browser.
- Let the user review and edit OCR text before sending it; OCR errors are common on stylized text.

## Milestone 3: history (manual import first)

1. User picks their own posts to import (start with pasted text or Instagram's "Download your information" export; check the export's real format before parsing it).
2. The import screen lists each post and the user ticks the ones to include. Nothing is imported without that approval.
3. The backend stores them in Databricks (SQL Statement Execution API or a SQL warehouse connection; still credentials on the backend only).

Proposed Delta tables, keeping observed facts and AI interpretations apart:

| Table | Columns | Notes |
|---|---|---|
| `observed_posts` | `user_id`, `source_id`, `posted_at`, `caption`, `image_text`, `imported_at`, `approval_id` | Only what the user approved. No images. |
| `ai_clues` | `clue_id`, `source_id`, `category`, `clue_text`, `evidence_quote`, `confidence`, `model`, `prompt_version`, `created_at` | Derived; can be deleted and regenerated. |
| `history_approvals` | `approval_id`, `user_id`, `approved_at`, `scope`, `revoked_at` | Lets a user revoke and delete. |

Sending history: select the relevant `observed_posts` (start with "the most recent N approved posts"), send them as `history:<source_id>` sources with `date`. The contract already supports this.

Add a "Delete my imported history" action before showing this to anyone else.

## Milestone 4: Instagram integration (in code: photo posts, single or carousel)

Supported workflow: **one photo post (a single photo or a carousel of photos) made in the "Create" dialog on desktop instagram.com, with Instagram in English.** Code: `extension/src/content/` (adapter, share flow, panel), `extension/src/background.ts` (service worker).

- At the caption step a **"CheckYo'Self: Check this post"** button is always shown (bottom-right). This manual path works even if Share interception stops working.
- Clicking **Share** is paused and a panel offers **Check this post**, **Back to editing**, or **Share without checking** / **Continue to Share**.
- The extension **never clicks Share itself**. "Continue" only lets the user's *next* real click on Share through, once (it expires after 60 s, on any edit, on "Back", or when the composer closes). While a share is in progress, more Share clicks are blocked (no double post).
- Backend calls go content script → service worker (`chrome.runtime.sendMessage`) → `api.ts` → local backend. Only text is sent; the worker re-checks this.
- Any change to the caption, the photo text, or the selected photo makes results stale. Replies for older requests or changed drafts are ignored. "Apply" only runs if the caption still matches the checked text.
- Only a share Instagram *confirms* counts as published and is passed to history (currently a stand-in that stores nothing). Closed-without-confirmation is "unknown", never "published".
- OCR: the OCR module (`extension/src/ocr/`) can't start inside a content script, so the photo is read in an offscreen extension page (`offscreen.html`, `offscreen` permission). The content script grabs the selected photo from the composer's `blob:` image (or canvas), with no upload prompt, and passes it inside the browser: content script → service worker → offscreen page (`src/ocr-relay.ts`, `src/content/offscreen-ocr.ts`). The text appears in the panel for the user to review; nothing is sent for analysis until they click "Check this post". Tested end to end with the built extension in Chrome against a local stand-in composer page, **not yet on the live Instagram site** (assumption 4 below is still unverified).
- **Photo posts on an English page get help: a single photo or a carousel.** Instagram shows one carousel slide at a time ("Right chevron" on photo 1, "Left chevron" on photo 2, verified 2026-11-15), so photos are collected as the user clicks through them (`src/content/photo-set.ts`), each read once, in order, as `image_text:1..n`; the panel asks the user to click through all slides. Carousel support is tested only on a stand-in composer page (headless Chrome, live backend), **not yet on the live site**. For video, and for pages in other languages, the extension does nothing at all: no button, Share is never paused. The manual popup still works for any text.
- If interception stops working (for example after Instagram changes its page), use the "Check this post" button, or the popup's **Use Instagram draft** button, which copies the caption into the popup.

### Adding more later (no rewrite needed)

- **Another post type** (carousel, video): check how it looks with the test kit, make `classifyPostType()` in `instagram-adapter.ts` recognise it, add it to `SUPPORTED_POST_TYPES` in `content/main.ts`, and give each extra photo its own `image_text:<n>` source.
- **Another language**: record its Share button and success/failure texts with the test kit, then add one entry to `TEXT_BY_LANGUAGE` in `instagram-adapter.ts` and a test.
- **Test kit:** `extension/dev/instagram-test-kit.js` is pasted into Chrome's Console on instagram.com. It adds Inspect / Record / Copy report buttons that read (never click) the page. Use it to re-check selectors after Instagram changes.

## Instagram's posting workflow: what has been checked

Checked by hand on the live site on 2026-11-14 (desktop Chrome, English, new test account, mock backend). Expect Instagram to change its UI without notice; re-check after any breakage. Selectors are marked VERIFIED/UNVERIFIED in `extension/src/content/instagram-adapter.ts`.

1. **Verified.** "Create" → "Select from computer" → Next (crop) → Next (edit) → caption step with a "Share" header button, inside `[role="dialog"]` labelled "Create new post".
2. **Verified (English only).** The caption box is a Lexical editor: `contenteditable`, `role="textbox"`, `aria-label="Add a caption..."`. Share is a `div[role="button"]` with the text "Share". The page's language comes from `<html lang="en">` (checked in Instagram's page source); other languages switch the extension off.
3. **Verified.** The caption text can be read, and changes are seen (the stale banner appeared after typing). Writing to it works only by selecting all, **waiting** for Lexical to notice the selection, then `execCommand("insertText")`; writing immediately was undone by Lexical.
4. **Partly verified.** At the caption step the photo is an `<img src="blob:…">` (713×713, alt "Photo for tag placement"). Reading it as a Blob for OCR, and whether it reflects crops/filters, has **not** been tested (OCR isn't built yet).
5. **Verified (2026-11-15).** A click on Share was stopped (nothing posted) and our panel opened; "Back to editing" cancels. After Check → "Continue to Share", the panel closes (it used to cover Instagram's Share button at a ~1320px-wide window) and the corner button says "ready"; the user's next Share click went through and a test post was published. Our panel works on top of Instagram's dialog (typing in it didn't close the composer).
6. **Confirmation verified; failure unverified.** After sharing, the dialog's title is "Post shared" with "Your post has been shared.", and the extension logged `Share outcome: published` (2026-11-15). The failure texts are still guesses (no failed share was seen).
7. **Unverified.** The new post's ID is not read; `postId` is sent as `null`.
8. **Multi-photo verified; video unverified.** At the caption step a 2-photo post shows only ONE `blob:` image at a time, so photo counting alone missed it; its slide arrows are labelled "Right chevron" (photo 1) and "Left chevron" (photo 2). With those labels the extension now stays out of the way on both photos (2026-11-15). Video detection (`<video>`) has not been tried. If detection misses a carousel, the extension treats it as a single photo (it checks the caption and the first photo's text); it never blocks a post without offering "continue".
9. Instagram's "Download your information" export format: not checked (milestone 3).
10. Instagram's terms for a personal, user-initiated tool: not reviewed. Read them before demoing; never scrape other accounts.
