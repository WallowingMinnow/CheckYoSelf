// Turns the LLM's raw text into safe, well-shaped Finding objects.
// Never trust the model's output shape:
//  - If the overall answer is malformed (no JSON, no "findings" array, wrong
//    types), we REJECT it with BAD_MODEL_OUTPUT. A broken answer must never
//    look like "nothing found".
//  - If a single finding is malformed or has no VERIFIED evidence, we drop it
//    and count it in `droppedFindings`, so the extension can say the check is
//    incomplete instead of pretending it is clean.
import {
  CATEGORIES,
  EDIT_ACTIONS,
  LEVELS,
  type Category,
  type EditAction,
  type Evidence,
  type Finding,
  type Level,
  type SuggestedEdit,
  type TextSource,
} from "../../shared/contract";
import { AppError } from "./errors";

export const MAX_FINDINGS = 8;
const MAX_EVIDENCE = 6;
const MAX_EDITS = 4;

export interface ParsedAnalysis {
  summary: string;
  findings: Finding[];
  /** Findings the model returned that we did not show (see contract.ts). */
  droppedFindings: number;
}

function badOutput(message: string): never {
  throw new AppError("BAD_MODEL_OUTPUT", 502, message);
}

export function parseModelOutput(raw: string, sources: TextSource[]): ParsedAnalysis {
  const json = extractJsonObject(raw);
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  // "findings" is REQUIRED and must be an array. A missing or wrongly typed
  // list is a broken answer, not an empty (clean) one.
  if (!("findings" in json)) badOutput("The model's answer had no \"findings\" list. Try again.");
  if (!Array.isArray(json.findings)) badOutput("The model's \"findings\" was not a list. Try again.");

  // "summary" is optional, but if present it must be text.
  if (json.summary !== undefined && typeof json.summary !== "string") {
    badOutput("The model's \"summary\" was not text. Try again.");
  }
  const summary = typeof json.summary === "string" ? json.summary.trim().slice(0, 500) : "";

  const rawFindings: unknown[] = json.findings;
  const valid = rawFindings
    .map((f) => normalizeFinding(f, sourceById))
    .filter((f): f is Omit<Finding, "id"> => f !== null);

  const shown = valid.slice(0, MAX_FINDINGS).map((f, i) => ({ id: `f${i + 1}`, ...f }));

  return {
    summary,
    findings: shown,
    // Everything the model sent that the user will not see: invalid ones plus
    // any over the limit.
    droppedFindings: rawFindings.length - shown.length,
  };
}

/** Models sometimes wrap JSON in ```json fences or add a sentence. Find the object. */
export function extractJsonObject(raw: string): Record<string, any> {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    badOutput("The model did not return JSON. Try again.");
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  badOutput("The model returned malformed JSON. Try again.");
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Case- and whitespace-insensitive "does the source really contain this quote?" */
export function quoteAppearsIn(sourceText: string, quote: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(quote);
  return q.length > 0 && norm(sourceText).includes(q);
}

/** Returns null if the finding must be dropped. */
function normalizeFinding(raw: unknown, sourceById: Map<string, TextSource>): Omit<Finding, "id"> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;

  const exposure = str(f.exposure, 400);
  if (!exposure) return null;
  if (!Array.isArray(f.evidence)) return null;
  if (f.suggestedEdits !== undefined && !Array.isArray(f.suggestedEdits)) return null;

  // Evidence = OBSERVED text. We check every quote against the real source text.
  const evidence: Evidence[] = f.evidence
    .map((e: any): Evidence | null => {
      const source = typeof e?.sourceId === "string" ? sourceById.get(e.sourceId) : undefined;
      const quote = str(e?.quote, 200);
      if (!source || !quote) return null;
      return { sourceId: source.id, quote, verified: quoteAppearsIn(source.text, quote) };
    })
    .filter((e): e is Evidence => e !== null);

  // A warning must be backed by at least one quote we found in the user's text.
  // Otherwise the model may have made it up, so we don't show it.
  const verified = evidence.filter((e) => e.verified);
  if (verified.length === 0) return null;

  // Show verified quotes first, then unverified ones (labeled in the UI).
  const ordered = [...verified, ...evidence.filter((e) => !e.verified)].slice(0, MAX_EVIDENCE);

  const rawEdits: unknown[] = Array.isArray(f.suggestedEdits) ? f.suggestedEdits : [];
  const suggestedEdits = rawEdits
    .map((s) => normalizeEdit(s, sourceById))
    .filter((s): s is SuggestedEdit => s !== null)
    .slice(0, MAX_EDITS);

  return {
    category: pick<Category>(f.category, CATEGORIES, "other"),
    severity: pick<Level>(f.severity, LEVELS, "medium"),
    exposure,
    evidence: ordered,
    // Computed by us, not the model, and only from VERIFIED evidence:
    // a made-up quote must not make a finding look "cross-source".
    crossSource: new Set(verified.map((e) => e.sourceId)).size > 1,
    confidence: pick<Level>(f.confidence, LEVELS, "low"),
    uncertainty: str(f.uncertainty, 400),
    suggestedEdits,
  };
}

/**
 * Makes a suggested edit safe to show. Text-changing actions ("replace",
 * "generalize", "remove") need an `original` that really appears in the source,
 * and "replace"/"generalize" also need non-blank replacement text. If those
 * are missing, the edit is kept as advice only (action "other"), so the
 * extension never offers an Apply button that would delete text by accident.
 */
export function normalizeEdit(raw: unknown, sourceById: Map<string, TextSource>): SuggestedEdit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const source = typeof s.sourceId === "string" ? sourceById.get(s.sourceId) : undefined;
  if (!source) return null;
  const explanation = str(s.explanation, 300);
  if (!explanation) return null;

  let action = pick<EditAction>(s.action, EDIT_ACTIONS, "other");
  const original = str(s.original, 200);
  const replacement = typeof s.replacement === "string" ? s.replacement.trim().slice(0, 200) : "";

  const changesText = action === "replace" || action === "generalize" || action === "remove";
  if (changesText) {
    const originalOk = original !== "" && quoteAppearsIn(source.text, original);
    const replacementOk = action === "remove" || replacement !== "";
    if (!originalOk || !replacementOk) action = "other";
  }

  const edit: SuggestedEdit = { sourceId: source.id, action, explanation };
  if (original) edit.original = original;
  if (replacement && action !== "remove") edit.replacement = replacement;
  return edit;
}
