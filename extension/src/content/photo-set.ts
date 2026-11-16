// The photos of the post being written, and the text in each one.
//
// For a carousel (several photos), Instagram may only keep the photo that's
// on screen in the page, so photos are collected AS THEY APPEAR while the
// user clicks through the slides: each new one gets the next number
// (Photo 1, 2, 3...) and its text becomes the source "image_text:<n>".
//
// No DOM and no Chrome calls here, so it can be tested in Node
// (test/photo-set.test.ts). main.ts does the reading (OCR) and drawing.
import type { TextSource } from "../../../shared/contract";

export type PhotoStatus = "reading" | "done";

export interface PhotoEntry {
  /** The page's key for this photo (instagram-adapter PreviewImage.key). */
  key: string;
  /** 1, 2, 3... in the order the photos were first seen. */
  index: number;
  status: PhotoStatus;
  /** What will be checked: from OCR, or typed/corrected by the user. */
  text: string;
  /** The user typed in this photo's box: OCR must never overwrite it. */
  typed: boolean;
  /** One line under the box: where the text came from / what to do. */
  hint: string;
  notices: { kind: "poor" | "warning"; text: string }[];
}

export class PhotoSet {
  private photos: PhotoEntry[] = [];

  /** Forget everything (the composer closed or the user went back a step). */
  reset(): void {
    this.photos = [];
  }

  /**
   * Adds the photos on screen that weren't seen before, in page order.
   * Returns the new ones (to be read). Photos already known keep their number.
   */
  sync(keys: string[]): PhotoEntry[] {
    const added: PhotoEntry[] = [];
    for (const key of keys) {
      if (this.photos.some((p) => p.key === key)) continue;
      const entry: PhotoEntry = {
        key,
        index: this.photos.length + 1,
        status: "reading",
        text: "",
        typed: false,
        hint: "Reading text from this photo on your computer… (nothing is sent yet)",
        notices: [],
      };
      this.photos.push(entry);
      added.push(entry);
    }
    return added;
  }

  all(): readonly PhotoEntry[] {
    return this.photos;
  }

  get(index: number): PhotoEntry | undefined {
    return this.photos.find((p) => p.index === index);
  }

  /** OCR finished (or failed) for one photo. Text the user typed is kept. */
  finishReading(key: string, text: string, hint: string, notices: PhotoEntry["notices"] = []): void {
    const p = this.photos.find((x) => x.key === key);
    if (!p) return; // the composer closed meanwhile
    p.status = "done";
    p.notices = notices;
    if (p.typed) {
      p.hint = `${hint} You had already typed this photo's text, so yours was kept.`;
      return;
    }
    p.text = text;
    p.hint = hint;
  }

  /** The user typed in a photo's box. */
  setTyped(index: number, text: string): void {
    const p = this.get(index);
    if (!p) return;
    p.text = text;
    p.typed = true;
  }

  /** Some photo is still being read and the user hasn't typed its text: don't check yet. */
  isReading(): boolean {
    return this.photos.some((p) => p.status === "reading" && !p.typed);
  }

  /** Changes whenever the set of photos changes (part of the draft's identity). */
  key(): string | null {
    return this.photos.length ? this.photos.map((p) => p.key).join("|") : null;
  }

  /** One "image_text:<n>" source per photo that has text, in photo order. */
  sources(): TextSource[] {
    return this.photos
      .filter((p) => p.text.trim())
      .map((p) => ({ id: `image_text:${p.index}`, type: "image_text" as const, text: p.text }));
  }

  /** All photo texts as one string (for the popup's single "Text in the photo" box). */
  joinedText(): string {
    const withText = this.photos.filter((p) => p.text.trim());
    if (withText.length <= 1) return withText[0]?.text ?? "";
    return withText.map((p) => `Photo ${p.index}: ${p.text}`).join("\n\n");
  }
}

/** What the corner button and the panel say about a carousel's photos. */
export interface CarouselProgress {
  /** The user reached the last photo and every photo has been read. */
  complete: boolean;
  /** Text for the corner button (shown before the panel is opened). */
  launcher: string;
  /** Banner at the top of the panel's photo section. */
  banner: string;
}

/**
 * `read`: photos found so far; `reachedLast`: the last photo was shown (no
 * "next" arrow); `reading`: some photo is still being read.
 */
export function carouselProgress(read: number, reachedLast: boolean, reading: boolean): CarouselProgress {
  const photos = `${read} photo${read === 1 ? "" : "s"}`;
  if (reachedLast && !reading) {
    return {
      complete: true,
      launcher: `CheckYo'Self: all ${photos} read. Check this post`,
      banner: `All ${photos} read ✓ Review each one's text below, then check.`,
    };
  }
  return {
    complete: false,
    launcher: `CheckYo'Self: click › to show each photo (${read} read)`,
    banner:
      `This post has several photos. Click the › arrow on the photo to show each one: CheckYo'Self reads every photo as it appears (${photos} ${reading ? "found, reading…" : "read so far"}).`,
  };
}
