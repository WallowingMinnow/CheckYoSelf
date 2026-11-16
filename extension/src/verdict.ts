// The popup's "verdict": a big score, a LOW / MEDIUM / HIGH stamp and the
// "Before you drop that post..." advice cards. DISPLAY ONLY: it reads the
// backend's AnalyzeResponse and reuses the dashboard's scoring
// (dashboard/report.ts). It never changes the analysis or the findings.
//
// The score is an ESTIMATE from the findings' severity and confidence, not a
// measurement, and the popup says so under it.
//
// SAFETY: everything is set with textContent (never innerHTML).
import type { AnalyzeResponse, Level, TextSource } from "../../shared/contract";
import { buildReport, type AnalyzedPost } from "./dashboard/report";

export type VerdictLevel = "low" | "medium" | "high";

export interface VerdictAdvice {
  title: string;
  detail: string;
  priority: Level;
  /** Concrete changes suggested for this post, as sentences. */
  edits: string[];
}

export interface Verdict {
  /** 0-100, from the findings. */
  score: number;
  level: VerdictLevel;
  /** Text on the stamp: LOW, MEDIUM, HIGH or INCOMPLETE. */
  stamp: string;
  /** One short line under the score. */
  headline: string;
  /** false when the backend dropped findings it couldn't check. */
  complete: boolean;
  advice: VerdictAdvice[];
}

/** Score bands for the popup's three levels. */
export function verdictLevel(score: number): VerdictLevel {
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

export function verdictFor(result: AnalyzeResponse, sources: TextSource[]): Verdict {
  const post: AnalyzedPost = { id: "draft", title: "This post", date: result.analyzedAt, sources, result };
  const report = buildReport([post]);
  const level = verdictLevel(report.score);
  const complete = result.droppedFindings <= 0;

  let headline: string;
  if (!complete) headline = "Check incomplete. Review the post yourself.";
  else if (result.findings.length === 0) headline = "Nothing stood out. Still, think before you post.";
  else if (level === "high") headline = "Don't let your data get caught slippin'.";
  else if (level === "medium") headline = "Think before you post.";
  else headline = "Mostly clean. Give it one more look.";

  return {
    score: report.score,
    level,
    // An incomplete check must never look like a clean LOW result.
    stamp: complete ? level.toUpperCase() : "INCOMPLETE",
    headline,
    complete,
    advice: report.recommendations.slice(0, 4).map((r) => ({
      title: r.title,
      detail: r.detail,
      priority: r.priority,
      edits: r.edits,
    })),
  };
}

// ---------------------------------------------------------------------------
// Drawing (popup only)
// ---------------------------------------------------------------------------

export interface VerdictElements {
  root: HTMLElement;
  score: HTMLElement;
  stamp: HTMLElement;
  headline: HTMLElement;
  note: HTMLElement;
  advice: HTMLElement;
  adviceList: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderVerdict(els: VerdictElements, result: AnalyzeResponse, sources: TextSource[]) {
  const v = verdictFor(result, sources);
  els.root.hidden = false;
  els.root.dataset.level = v.complete ? v.level : "incomplete";
  els.score.textContent = String(v.score);
  els.stamp.textContent = v.stamp;
  els.headline.textContent = v.headline;
  els.note.textContent =
    result.mode === "mock"
      ? "Estimate from the findings · practice mode (keyword rules, not AI)"
      : "Estimate from the findings' severity and confidence";

  els.adviceList.replaceChildren();
  v.advice.forEach((a, i) => {
    const li = el("li", `advice-card sev-${a.priority}`);
    li.append(el("span", "advice-num", String(i + 1).padStart(2, "0")));
    const body = el("div", "advice-body");
    const head = el("div", "advice-head");
    head.append(el("h4", undefined, a.title), el("span", `severity`, `${a.priority} priority`));
    body.append(head, el("p", "advice-detail", a.detail));
    if (a.edits.length) {
      const ul = el("ul", "advice-edits");
      for (const e of a.edits) ul.append(el("li", undefined, e));
      body.append(ul);
    }
    li.append(body);
    els.adviceList.append(li);
  });
  els.advice.hidden = v.advice.length === 0;
}
