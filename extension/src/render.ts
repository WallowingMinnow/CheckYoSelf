// Draws results on the page. SAFETY: text from the backend/LLM is only ever set
// with textContent (never innerHTML), so a malicious caption can't inject HTML.
import type { AnalyzeResponse, Finding, Level, SuggestedEdit, TextSource } from "../../shared/contract";
import { canApplyEdit } from "./edits";

/** Small helper: create an element with a class and optional text. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A source's name on screen. With several photos (a carousel), each photo's
 * text is numbered ("Photo 2 text") so you can tell where a quote came from.
 */
export function sourceLabel(source: TextSource | undefined, sourceId: string, photoCount = 1): string {
  if (sourceId === "caption") return "Caption";
  if (sourceId === "profile") return "Your past posts (profile)";
  if (sourceId.startsWith("image_text")) {
    const n = sourceId.split(":")[1];
    return photoCount > 1 && n ? `Photo ${n} text` : "Photo text";
  }
  if (sourceId.startsWith("history")) return source?.date ? `Earlier post, ${source.date.slice(0, 10)}` : "Earlier post";
  return sourceId;
}

/** How many photo-text sources a draft has (several = a carousel). */
function countPhotos(sources: Iterable<TextSource>): number {
  let n = 0;
  for (const s of sources) if (s.type === "image_text") n++;
  return n;
}

const CATEGORY_LABELS: Record<string, string> = {
  location: "Location",
  routine_schedule: "Routine",
  travel_absence: "Time away",
  children: "Children",
  identity: "Identity",
  contact: "Contact details",
  workplace_school: "Work or school",
  financial: "Money",
  health: "Health",
  relationships: "Relationships",
  other: "Other",
};

const SEVERITY_RANK: Record<Level, number> = { high: 3, medium: 2, low: 1 };

// ---------------------------------------------------------------------------
// Marked-up draft: the user's text with highlighted evidence
// ---------------------------------------------------------------------------

interface Range {
  start: number;
  end: number;
  keys: string[];   // "f1:0" = finding f1, evidence #0
  severity: Level;
}

/**
 * Lower-cases `text` and squeezes every run of whitespace (spaces, tabs, line
 * breaks) into one space, remembering where each kept character came from.
 */
function normalizeWithMap(text: string): { normalized: string; originalIndex: number[] } {
  let normalized = "";
  const originalIndex: number[] = [];
  let lastWasSpace = true; // true at the start = drop leading whitespace
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (!lastWasSpace) {
        normalized += " ";
        originalIndex.push(i);
      }
      lastWasSpace = true;
    } else {
      normalized += text[i].toLowerCase();
      originalIndex.push(i);
      lastWasSpace = false;
    }
  }
  return { normalized, originalIndex };
}

/**
 * Where `quote` is in `text`, ignoring upper/lower case and differences in
 * spaces and line breaks: the SAME rule the backend uses to mark a quote
 * verified (quoteAppearsIn in backend/src/parse.ts). So a verified quote that
 * runs across a line break (common in photo text) is highlighted too.
 * Returns positions in the ORIGINAL text, or null if it isn't there.
 */
export function findQuoteRange(text: string, quote: string): { start: number; end: number } | null {
  const q = normalizeWithMap(quote).normalized.trimEnd();
  if (!q) return null;
  const { normalized, originalIndex } = normalizeWithMap(text);
  const at = normalized.indexOf(q);
  if (at === -1) return null;
  return { start: originalIndex[at], end: originalIndex[at + q.length - 1] + 1 };
}

function findRanges(source: TextSource, findings: Finding[]): Range[] {
  const ranges: Range[] = [];
  for (const finding of findings) {
    finding.evidence.forEach((ev, i) => {
      if (ev.sourceId !== source.id || !ev.verified) return;
      const where = findQuoteRange(source.text, ev.quote);
      if (!where) return;
      ranges.push({ ...where, keys: [`${finding.id}:${i}`], severity: finding.severity });
    });
  }
  // Merge overlapping highlights so we never nest <mark> tags.
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) {
      last.end = Math.max(last.end, r.end);
      last.keys.push(...r.keys);
      if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[last.severity]) last.severity = r.severity;
    } else {
      merged.push({ ...r, keys: [...r.keys] });
    }
  }
  return merged;
}

function renderMarkedText(source: TextSource, findings: Finding[], onMarkClick: (findingId: string) => void) {
  const p = el("p");
  let cursor = 0;
  for (const range of findRanges(source, findings)) {
    p.append(source.text.slice(cursor, range.start));
    const mark = el("mark", `sev-${range.severity}`, source.text.slice(range.start, range.end));
    mark.dataset.evidenceKeys = range.keys.join(" ");
    mark.tabIndex = 0;
    const firstFinding = range.keys[0].split(":")[0];
    mark.title = "Show the warning for this text";
    mark.addEventListener("click", () => onMarkClick(firstFinding));
    mark.addEventListener("keydown", (e) => e.key === "Enter" && onMarkClick(firstFinding));
    p.append(mark);
    cursor = range.end;
  }
  p.append(source.text.slice(cursor));
  return p;
}

// ---------------------------------------------------------------------------
// Finding cards
// ---------------------------------------------------------------------------

function flash(node: Element | null) {
  if (!node) return;
  node.scrollIntoView({ block: "nearest", behavior: "smooth" });
  node.classList.remove("flash");
  void (node as HTMLElement).offsetWidth; // restart the animation
  node.classList.add("flash");
}

/** Show "Apply" only for complete edits that match the analyzed caption (see edits.ts). */
function canApply(edit: SuggestedEdit, sourcesById: Map<string, TextSource>): boolean {
  const source = sourcesById.get(edit.sourceId);
  return !!source && canApplyEdit(edit, source.text);
}

function describeEdit(edit: SuggestedEdit): string {
  if (edit.action === "remove" && edit.original) return `Remove "${edit.original}". ${edit.explanation}`;
  if (edit.original && edit.replacement) return `Change "${edit.original}" to "${edit.replacement}". ${edit.explanation}`;
  return edit.explanation;
}

function renderFinding(
  finding: Finding,
  sourcesById: Map<string, TextSource>,
  root: HTMLElement,
  onApplyEdit: (edit: SuggestedEdit) => void,
) {
  const li = el("li", `finding sev-${finding.severity}`);
  li.id = `finding-${finding.id}`;

  const head = el("div", "finding-head");
  head.append(el("span", "severity", `${finding.severity[0].toUpperCase()}${finding.severity.slice(1)} risk`));
  head.append(el("span", undefined, CATEGORY_LABELS[finding.category] ?? finding.category));
  if (finding.crossSource) head.append(el("span", undefined, "Combines several sources"));
  li.append(head);

  // AI interpretation
  li.append(el("p", "exposure", finding.exposure));

  // Observed evidence, linked to the highlighted text above
  li.append(el("h4", undefined, "Based on"));
  const evList = el("ul", "evidence");
  finding.evidence.forEach((ev, i) => {
    const item = el("li");
    const btn = el("button");
    btn.type = "button";
    btn.append(el("span", "source-tag", sourceLabel(sourcesById.get(ev.sourceId), ev.sourceId, countPhotos(sourcesById.values()))));
    btn.append(el("span", "quote", `“${ev.quote}”`));
    if (!ev.verified) btn.append(el("span", "unverified", "not found in your text"));
    btn.addEventListener("click", () =>
      flash(root.querySelector(`mark[data-evidence-keys~="${finding.id}:${i}"]`)),
    );
    item.append(btn);
    evList.append(item);
  });
  li.append(evList);

  if (finding.suggestedEdits.length > 0) {
    li.append(el("h4", undefined, "Suggested changes"));
    const edits = el("ul", "edits");
    for (const edit of finding.suggestedEdits) {
      const item = el("li", undefined, describeEdit(edit));
      if (canApply(edit, sourcesById)) {
        const apply = el("button", "secondary small apply", "Apply");
        apply.type = "button";
        apply.addEventListener("click", () => onApplyEdit(edit));
        item.append(apply);
      }
      edits.append(item);
    }
    li.append(edits);
  }

  const sureWord = { high: "Fairly sure", medium: "Somewhat sure", low: "Not very sure" }[finding.confidence];
  li.append(el("p", "uncertainty", `${sureWord}. ${finding.uncertainty}`.trim()));
  return li;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ResultElements {
  root: HTMLElement;
  summary: HTMLElement;
  markedDraft: HTMLElement;
  findings: HTMLElement;
  meta: HTMLElement;
  mockBanner: HTMLElement;
  incompleteBanner: HTMLElement;
}

/** Text for the "this check is incomplete" banner, or null if it is complete. */
export function incompleteMessage(result: AnalyzeResponse): string | null {
  const n = result.droppedFindings;
  if (!n || n <= 0) return null;
  return (
    `Incomplete check: ${n} possible warning${n === 1 ? " was" : "s were"} not shown because ` +
    `${n === 1 ? "it" : "they"} could not be checked against your text. Check again, or review the post yourself.`
  );
}

export function renderResults(
  els: ResultElements,
  result: AnalyzeResponse,
  sources: TextSource[],
  onApplyEdit: (edit: SuggestedEdit) => void,
) {
  const sourcesById = new Map(sources.map((s) => [s.id, s]));
  els.root.hidden = false;
  els.mockBanner.hidden = result.mode !== "mock";
  const incomplete = incompleteMessage(result);
  els.incompleteBanner.hidden = incomplete === null;
  els.incompleteBanner.textContent = incomplete ?? "";
  els.summary.textContent = result.summary;

  // Marked-up draft
  els.markedDraft.replaceChildren();
  const showFinding = (id: string) => flash(els.root.querySelector(`#finding-${id}`));
  for (const source of sources) {
    if (!source.text.trim()) continue;
    els.markedDraft.append(el("h3", undefined, sourceLabel(source, source.id, countPhotos(sources))));
    els.markedDraft.append(renderMarkedText(source, result.findings, showFinding));
  }

  // Finding cards
  els.findings.replaceChildren();
  // "Nothing stood out" only when the check is COMPLETE. If findings were
  // dropped, the banner above explains that instead.
  if (result.findings.length === 0 && incomplete === null) {
    els.findings.append(el("li", "empty", "Nothing stood out. You can still review the post yourself before sharing."));
  }
  for (const finding of result.findings) {
    els.findings.append(renderFinding(finding, sourcesById, els.root, onApplyEdit));
  }

  const when = new Date(result.analyzedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  els.meta.textContent =
    result.mode === "mock"
      ? `Checked at ${when} in practice mode. Request ${result.requestId.slice(0, 8)}.`
      : `Checked at ${when} with ${result.model} (prompt ${result.promptVersion}). Request ${result.requestId.slice(0, 8)}.`;
}
