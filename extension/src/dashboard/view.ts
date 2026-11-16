// Draws the dashboard. SAFETY: text from posts and from the AI is only ever set
// with textContent (never innerHTML), so a malicious caption can't inject HTML.
//
// The numbers and lists come from report.ts; this file only turns them into
// elements. Labels say which text is OBSERVED (quotes from the post) and which
// is AI INTERPRETATION (exposure, uncertainty, suggestions).
import type { Level } from "../../../shared/contract";
import { GROUP_ICONS, icon, type IconName } from "./icons";
import {
  CATEGORY_LABELS,
  describeEdit,
  findHighlights,
  findingsForPost,
  overviewText,
  postIdForSource,
  postScore,
  riskLevel,
  sourceLabel,
  sourceTextFor,
  type AnalyzedPost,
  type DashboardReport,
  type Recommendation,
  type ReportFinding,
  type RiskLevel,
} from "./report";

export type ViewName = "overview" | "cross-post" | "posts" | "actions";

/** What the views can ask main.ts to do. */
export interface ViewActions {
  openEvidence: (findingKey: string) => void;
  openAnalyze: () => void;
  goTo: (view: ViewName) => void;
}

/** "sample" = the fictional sample report; "live" = the user's own checks. */
export type ReportKind = "sample" | "live";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, iconName?: IconName) {
  const b = el("button", className);
  b.type = "button";
  if (iconName) b.append(icon(iconName, 16));
  b.append(el("span", undefined, label));
  b.addEventListener("click", onClick);
  return b;
}

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Runs `fn` on the next frame, so CSS transitions start from the old value. */
function nextFrame(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const LEVEL_LABELS: Record<RiskLevel, string> = { low: "Low", moderate: "Moderate", high: "High", critical: "Critical" };
const SEVERITY_LABELS: Record<Level, string> = { high: "High", medium: "Medium", low: "Low" };
const CONFIDENCE_LABELS: Record<Level, string> = { high: "Fairly sure", medium: "Somewhat sure", low: "Not very sure" };

function severityBadge(level: Level, suffix = "risk") {
  return el("span", `badge sev-${level}`, `${SEVERITY_LABELS[level]} ${suffix}`);
}

function levelBadge(level: RiskLevel) {
  return el("span", `badge lvl-${level}`, LEVEL_LABELS[level]);
}

/** Three small bars, filled by confidence. */
function confidenceMeter(level: Level) {
  const wrap = el("span", `confidence conf-${level}`);
  wrap.title = "How sure the analysis is";
  const bars = el("span", "conf-bars");
  for (let i = 0; i < 3; i++) bars.append(el("span", "conf-bar"));
  wrap.append(bars, el("span", undefined, CONFIDENCE_LABELS[level]));
  return wrap;
}

/** A card with an icon + title header. Returns the card; append content to it. */
function card(title: string, iconName: IconName, className = "") {
  const node = el("article", `card reveal ${className}`.trim());
  const head = el("header", "card-head");
  const h = el("h2", "card-title");
  const ic = el("span", "card-icon");
  ic.append(icon(iconName, 16));
  h.append(ic, el("span", undefined, title));
  head.append(h);
  node.append(head);
  return node;
}

/** Gives cards a staggered fade-in. */
function stagger(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(".reveal").forEach((node, i) => node.style.setProperty("--i", String(i)));
}

/** Text with <mark> highlights for the given quotes. */
function markedText(text: string, quotes: string[], className = "") {
  const p = el("p", `marked ${className}`.trim());
  let cursor = 0;
  for (const r of findHighlights(text, quotes)) {
    p.append(text.slice(cursor, r.start));
    p.append(el("mark", undefined, text.slice(r.start, r.end)));
    cursor = r.end;
  }
  p.append(text.slice(cursor));
  return p;
}

function postById(report: DashboardReport, id: string): AnalyzedPost | undefined {
  return report.posts.find((p) => p.id === id);
}

/** Verified quotes of a finding that come from one post. */
/**
 * Who wrote a finding's explanation, so we never call keyword rules "AI":
 * the AI model (backend with Databricks), keyword rules (offline mode or the
 * backend's practice mode), or the hand-written sample.
 */
export function interpretationLabel(post: AnalyzedPost | undefined): string {
  if (!post) return "Interpretation";
  if (post.result.mode === "databricks") return "AI interpretation";
  if (post.engine === "offline") return "Keyword rule · no AI";
  if (post.engine === "backend") return "Practice mode · keyword rules";
  return "Sample · written by hand";
}

function quotesFromPost(report: DashboardReport, rf: ReportFinding, postId: string): string[] {
  const owner = postById(report, rf.fromPostId);
  if (!owner) return [];
  return rf.finding.evidence
    .filter((ev) => ev.verified && postIdForSource(owner, ev.sourceId, report.posts) === postId)
    .map((ev) => ev.quote);
}

function emptyState(title: string, text: string, actions?: ViewActions) {
  const box = el("div", "card empty-state reveal");
  const badge = el("span", "empty-icon");
  badge.append(icon("shield", 26));
  box.append(badge, el("h2", undefined, title), el("p", undefined, text));
  if (actions) box.append(button("Analyze a post", "btn btn-primary", actions.openAnalyze, "plus"));
  return box;
}

// ---------------------------------------------------------------------------
// Score gauge
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const GAUGE_R = 80;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_R;
const GAUGE_ARC = GAUGE_CIRCUMFERENCE * 0.75; // a 270° arc, open at the bottom

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Counts a number up from 0, for the score. */
function countUp(node: HTMLElement, to: number) {
  if (reducedMotion()) {
    node.textContent = String(to);
    return;
  }
  const start = performance.now();
  const duration = 900;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = String(Math.round(to * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function gauge(score: number, level: RiskLevel) {
  const wrap = el("div", `gauge lvl-${level}`);
  const s = svg("svg", { viewBox: "0 0 200 200", class: "gauge-svg", role: "img" });
  s.setAttribute("aria-label", `Privacy risk score ${score} out of 100, ${LEVEL_LABELS[level]}`);

  const defs = svg("defs", {});
  const grad = svg("linearGradient", { id: "gauge-gradient", x1: "0", y1: "1", x2: "1", y2: "0" });
  grad.append(svg("stop", { offset: "0%", class: "gauge-stop-start" }));
  grad.append(svg("stop", { offset: "100%", class: "gauge-stop-end" }));
  defs.append(grad);
  s.append(defs);

  const common = { cx: "100", cy: "100", r: String(GAUGE_R), fill: "none", transform: "rotate(135 100 100)" };
  s.append(svg("circle", { ...common, class: "gauge-track", "stroke-dasharray": `${GAUGE_ARC} ${GAUGE_CIRCUMFERENCE}` }));
  const value = svg("circle", {
    ...common,
    class: "gauge-value",
    stroke: "url(#gauge-gradient)",
    "stroke-dasharray": `0 ${GAUGE_CIRCUMFERENCE}`,
  });
  s.append(value);
  wrap.append(s);

  const center = el("div", "gauge-center");
  const number = el("span", "gauge-number", "0");
  center.append(number, el("span", "gauge-max", "/ 100"));
  wrap.append(center);

  const filled = (GAUGE_ARC * score) / 100;
  nextFrame(() => value.setAttribute("stroke-dasharray", `${filled} ${GAUGE_CIRCUMFERENCE}`));
  countUp(number, score);
  return wrap;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function scoreCard(report: DashboardReport) {
  const node = card("Privacy risk score", "shield", "score-card");
  const body = el("div", "score-body");
  body.append(gauge(report.score, report.level));

  const side = el("div", "score-side");
  const levelRow = el("div", "score-level");
  levelRow.append(levelBadge(report.level));
  side.append(levelRow);
  const headline: Record<RiskLevel, string> = {
    low: "Little that stands out. Keep checking before you post.",
    moderate: "Some details could help a stranger find or recognize you.",
    high: "Several details make you easier to find or predict.",
    critical: "Together, your posts make it easy to find you and predict where you'll be.",
  };
  side.append(el("p", "score-headline", report.posts.length ? headline[report.level] : "No posts checked yet."));
  if (report.droppedFindings > 0) {
    const warn = el("p", "score-warning");
    warn.append(icon("alert", 14));
    warn.append(
      el(
        "span",
        undefined,
        `Incomplete: ${plural(report.droppedFindings, "warning")} could not be checked against your text and ${report.droppedFindings === 1 ? "is" : "are"} not counted.`,
      ),
    );
    side.append(warn);
  }
  body.append(side);
  node.append(body);

  const stats = el("div", "stats");
  const stat = (value: number, label: string, iconName: IconName, accent = false) => {
    const s = el("div", `stat${accent ? " stat-accent" : ""}`);
    const top = el("div", "stat-top");
    top.append(icon(iconName, 15), el("span", "stat-label", label));
    s.append(top, el("span", "stat-value", String(value)));
    return s;
  };
  stats.append(
    stat(report.posts.length, "Posts analyzed", "image"),
    stat(report.findings.length, "Exposures found", "eye"),
    stat(report.crossPost.length, "Cross-post risks", "layers", true),
  );
  node.append(stats);
  return node;
}

function breakdownCard(report: DashboardReport) {
  const node = card("Risk breakdown", "grid", "breakdown-card");
  const list = el("ul", "bars");
  for (const g of report.groups) {
    const level = riskLevel(g.score);
    const row = el("li", `bar-row lvl-${g.count ? level : "none"}`);
    const label = el("div", "bar-label");
    const ic = el("span", "bar-icon");
    ic.append(icon(GROUP_ICONS[g.key], 15));
    label.append(ic, el("span", "bar-name", g.label));
    label.append(el("span", "bar-count", g.count ? plural(g.count, "finding") : "None found"));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    track.append(fill);
    const value = el("span", "bar-value", String(g.score));
    row.append(label, track, value);
    row.title = `${g.label}: ${g.score} / 100 (${LEVEL_LABELS[level]})`;
    list.append(row);
    nextFrame(() => (fill.style.width = `${g.score}%`));
  }
  node.append(list);
  node.append(el("p", "card-note", "Scores are estimates from the findings' severity and confidence."));
  return node;
}

function aiOverviewCard(report: DashboardReport, kind: ReportKind) {
  const node = card("Overview", "sparkle", "ai-card");
  const head = node.querySelector(".card-head")!;
  const usesAi = report.posts.some((p) => p.result.mode === "databricks");
  const usesOffline = report.posts.some((p) => p.engine === "offline");
  let tag = "Practice mode";
  if (kind === "sample") tag = "Sample text";
  else if (usesAi && usesOffline) tag = "AI + keyword rules";
  else if (usesAi) tag = "AI analysis";
  else if (usesOffline) tag = "Keyword rules · no AI";
  head.append(el("span", `source-tag ${usesAi && kind === "live" ? "tag-ai" : ""}`.trim(), tag));

  const text = overviewText(report);
  node.append(el("p", "ai-lead", text.reveals));

  const patterns = el("div", "ai-block");
  patterns.append(el("h3", undefined, "Patterns across posts"));
  if (report.crossPost.length === 0) {
    patterns.append(el("p", "muted", "No patterns that need several posts were found."));
  } else {
    const ul = el("ul", "ai-list");
    for (const rf of report.crossPost.slice(0, 2)) ul.append(el("li", undefined, rf.finding.exposure));
    patterns.append(ul);
  }
  node.append(patterns);

  const why = el("div", "ai-block");
  why.append(el("h3", undefined, "Why it matters"), el("p", undefined, text.why));
  node.append(why);

  if (text.priorities.length) {
    const focus = el("div", "ai-block");
    focus.append(el("h3", undefined, "Focus first"));
    const ol = el("ol", "ai-priorities");
    for (const p of text.priorities) ol.append(el("li", undefined, p));
    focus.append(ol);
    node.append(focus);
  }

  // The AI's own one-line summary of each post.
  const summaries = el("details", "summaries");
  summaries.append(el("summary", undefined, "Summary of each post"));
  const ul = el("ul");
  for (const post of report.posts) {
    const li = el("li");
    li.append(el("strong", undefined, `${post.title}: `), document.createTextNode(post.result.summary));
    ul.append(li);
  }
  summaries.append(ul);
  node.append(summaries);
  return node;
}

function topActionsCard(report: DashboardReport, actions: ViewActions) {
  const node = card("Top actions", "list", "actions-card");
  const ol = el("ol", "mini-recs");
  for (const [i, rec] of report.recommendations.slice(0, 3).entries()) {
    const li = el("li", "mini-rec");
    li.append(el("span", "rank", String(i + 1)));
    const text = el("div", "mini-rec-text");
    text.append(el("span", "mini-rec-title", rec.title));
    text.append(el("span", "mini-rec-meta", `Affects ${plural(rec.postIds.length, "post")}`));
    li.append(text, severityBadge(rec.priority, "priority"));
    ol.append(li);
  }
  if (report.recommendations.length === 0) ol.append(el("li", "muted", "Nothing to change right now."));
  node.append(ol);
  node.append(button("All actions", "link-btn", () => actions.goTo("actions"), "arrowRight"));
  return node;
}

export function renderOverview(root: HTMLElement, report: DashboardReport, kind: ReportKind, actions: ViewActions) {
  root.replaceChildren();
  if (report.posts.length === 0) {
    root.append(
      emptyState(
        "No checks yet",
        "Analyze a post to build your own report. Offline mode works without the backend or AI. " +
          "Your results stay in this tab and are gone when you close it.",
        actions,
      ),
    );
    stagger(root);
    return;
  }
  const grid = el("div", "overview-grid");
  grid.append(scoreCard(report), breakdownCard(report), aiOverviewCard(report, kind), topActionsCard(report, actions));
  root.append(grid);

  const spot = el("div", "spotlight");
  const head = el("div", "section-head");
  head.append(el("h2", undefined, "Cross-post intelligence"));
  if (report.crossPost.length > 1) {
    head.append(button(`See all ${report.crossPost.length}`, "link-btn", () => actions.goTo("cross-post"), "arrowRight"));
  }
  spot.append(head);
  if (report.crossPost.length > 0) spot.append(insightCard(report.crossPost[0], report, actions));
  else spot.append(noCrossPost(kind));
  root.append(spot);
  stagger(root);
}

// ---------------------------------------------------------------------------
// Cross-post insights
// ---------------------------------------------------------------------------

function noCrossPost(kind: ReportKind) {
  return emptyState(
    "No cross-post patterns found",
    kind === "live"
      ? "Offline checks compare each new post with your earlier checks in this tab, so check two or more posts that share details. " +
          "Backend checks look at one post at a time, because the extension doesn't send earlier posts yet."
      : "None of these posts combine into a pattern.",
  );
}

function insightCard(rf: ReportFinding, report: DashboardReport, actions: ViewActions) {
  const node = el("article", "card insight reveal");
  const head = el("header", "insight-head");
  const title = el("div", "insight-title");
  const ic = el("span", "card-icon");
  ic.append(icon("layers", 16));
  title.append(ic, el("span", undefined, "Combined inference"));
  head.append(title);
  const tags = el("div", "insight-tags");
  tags.append(severityBadge(rf.finding.severity), confidenceMeter(rf.finding.confidence));
  head.append(tags);
  node.append(head);

  // Related posts, each with the quote(s) that tie it in.
  const chain = el("div", "chain");
  rf.postIds.forEach((postId, i) => {
    const post = postById(report, postId);
    if (!post) return;
    if (i > 0) chain.append(el("span", "chain-join", "+"));
    const chip = el("div", `chain-post tone-${post.tone ?? "blue"}`);
    const top = el("div", "chain-post-top");
    top.append(el("span", "chain-dot"), el("span", "chain-post-title", post.title));
    top.append(el("span", "chain-post-date", formatDate(post.date)));
    chip.append(top);
    for (const q of quotesFromPost(report, rf, postId).slice(0, 2)) chip.append(el("span", "chain-quote", `“${q}”`));
    chain.append(chip);
  });
  node.append(chain);

  const inference = el("div", "inference");
  const label = el("span", "inference-label");
  label.append(icon("sparkle", 14), el("span", undefined, `What they reveal together · ${interpretationLabel(postById(report, rf.fromPostId))}`));
  inference.append(label, el("p", "inference-text", rf.finding.exposure));
  node.append(inference);

  const facts = el("dl", "facts");
  const fact = (term: string, value: string) => {
    const d = el("div", "fact");
    d.append(el("dt", undefined, term), el("dd", undefined, value));
    facts.append(d);
  };
  fact("Potential risk", `${SEVERITY_LABELS[rf.finding.severity]} · ${CATEGORY_LABELS[rf.finding.category]}`);
  fact("Confidence", `${CONFIDENCE_LABELS[rf.finding.confidence]}. ${rf.finding.uncertainty}`.trim());
  node.append(facts);

  const verified = rf.finding.evidence.filter((ev) => ev.verified).length;
  const foot = el("div", "insight-foot");
  foot.append(button(`View evidence (${verified})`, "btn btn-ghost btn-sm", () => actions.openEvidence(rf.key), "eye"));
  node.append(foot);
  return node;
}

export function renderCrossPost(root: HTMLElement, report: DashboardReport, kind: ReportKind, actions: ViewActions) {
  root.replaceChildren();
  const head = el("div", "view-head reveal");
  head.append(el("h1", undefined, "Cross-post intelligence"));
  head.append(
    el(
      "p",
      undefined,
      "Posts that look harmless alone can add up. These patterns only appear when several posts are read together.",
    ),
  );
  root.append(head);
  if (report.posts.length === 0) root.append(emptyState("No checks yet", "Analyze a post to get started.", actions));
  else if (report.crossPost.length === 0) root.append(noCrossPost(kind));
  else {
    const list = el("div", "insight-list");
    for (const rf of report.crossPost) list.append(insightCard(rf, report, actions));
    root.append(list);
  }
  stagger(root);
}

// ---------------------------------------------------------------------------
// Individual posts
// ---------------------------------------------------------------------------

/** A finding as an expandable row. */
function riskRow(rf: ReportFinding, report: DashboardReport, actions: ViewActions) {
  const d = el("details", `risk sev-${rf.finding.severity}`);
  const s = el("summary");
  s.append(el("span", "risk-dot"));
  s.append(el("span", "risk-cat", CATEGORY_LABELS[rf.finding.category]));
  s.append(el("span", "risk-text", rf.finding.exposure));
  if (rf.crossPost) s.append(el("span", "pill pill-violet", "Cross-post"));
  const chevron = el("span", "risk-chevron");
  chevron.append(icon("chevron", 16));
  s.append(chevron);
  d.append(s);

  const body = el("div", "risk-body");
  body.append(el("h4", undefined, `Explanation · ${interpretationLabel(postById(report, rf.fromPostId))}`));
  body.append(el("p", undefined, rf.finding.exposure));
  body.append(el("p", "muted", `${CONFIDENCE_LABELS[rf.finding.confidence]}. ${rf.finding.uncertainty}`.trim()));
  if (rf.finding.suggestedEdits.length) {
    body.append(el("h4", undefined, "Suggested improvement"));
    const ul = el("ul", "edits");
    for (const edit of rf.finding.suggestedEdits) {
      const li = el("li");
      li.append(icon("check", 14), el("span", undefined, describeEdit(edit)));
      ul.append(li);
    }
    body.append(ul);
  }
  body.append(button("View evidence", "btn btn-ghost btn-sm", () => actions.openEvidence(rf.key), "eye"));
  d.append(body);
  return d;
}

function postCard(post: AnalyzedPost, report: DashboardReport, actions: ViewActions) {
  const node = el("article", "card post reveal");
  const score = postScore(report, post.id);
  const level = riskLevel(score);
  const findings = findingsForPost(report, post.id);

  // Preview tile. We never keep the user's photo, so this is a styled stand-in.
  const thumb = el("div", `thumb tone-${post.tone ?? "blue"}`);
  const thumbIcon = el("span", "thumb-icon");
  thumbIcon.append(icon("image", 22));
  thumb.append(thumbIcon);
  const photoText = post.sources.find((s) => s.type === "image_text")?.text;
  if (photoText) thumb.append(el("span", "thumb-text", photoText));
  node.append(thumb);

  const head = el("header", "post-head");
  const titles = el("div");
  const dateRow = el("div", "post-date-row");
  dateRow.append(el("span", "post-date", formatDate(post.date)));
  if (post.engine === "offline") dateRow.append(el("span", "engine-tag", "Offline · keyword rules"));
  else if (post.engine === "backend") {
    const ai = post.result.mode === "databricks";
    dateRow.append(el("span", `engine-tag ${ai ? "tag-ai" : ""}`.trim(), ai ? "AI · backend" : "Backend · practice mode"));
  }
  titles.append(el("h3", "post-title", post.title), dateRow);
  const risk = el("div", "post-risk");
  risk.append(el("span", `post-score lvl-${level}`, String(score)), levelBadge(level));
  head.append(titles, risk);
  node.append(head);

  // Extracted text with the observed quotes highlighted.
  const quotes = findings.flatMap((rf) => quotesFromPost(report, rf, post.id));
  const extracted = el("div", "extracted");
  extracted.append(el("h4", undefined, "Extracted text · observed"));
  for (const source of post.sources) {
    if (!source.text.trim()) continue;
    const block = el("div", "extracted-block");
    block.append(el("span", "extracted-label", sourceLabel(source.id)));
    block.append(markedText(source.text, quotes, source.type === "image_text" ? "photo-text" : ""));
    extracted.append(block);
  }
  node.append(extracted);

  const risks = el("div", "risks");
  risks.append(el("h4", undefined, `Detected risks (${findings.length})`));
  if (findings.length === 0) {
    risks.append(
      el(
        "p",
        "muted",
        post.result.droppedFindings > 0
          ? "Check incomplete: some warnings could not be verified. Review this post yourself."
          : "Nothing stood out in this post.",
      ),
    );
  }
  for (const rf of findings) risks.append(riskRow(rf, report, actions));
  node.append(risks);
  return node;
}

export function renderPosts(root: HTMLElement, report: DashboardReport, actions: ViewActions) {
  root.replaceChildren();
  const head = el("div", "view-head reveal");
  head.append(el("h1", undefined, "Individual posts"));
  head.append(el("p", undefined, "Each post with the text that was read from it, what it reveals, and how to fix it."));
  root.append(head);
  if (report.posts.length === 0) {
    root.append(emptyState("No checks yet", "Analyze a post to see it here.", actions));
  } else {
    const grid = el("div", "post-grid");
    // Newest first.
    for (const post of [...report.posts].reverse()) grid.append(postCard(post, report, actions));
    root.append(grid);
  }
  stagger(root);
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function recommendationCard(rec: Recommendation, rank: number, report: DashboardReport, actions: ViewActions) {
  const node = el("li", `card rec reveal sev-${rec.priority}`);
  const head = el("div", "rec-head");
  head.append(el("span", "rank rank-lg", String(rank)));
  const titles = el("div", "rec-titles");
  titles.append(el("h3", undefined, rec.title), el("p", "muted", rec.detail));
  head.append(titles, severityBadge(rec.priority, "priority"));
  node.append(head);

  const titlesOfPosts = rec.postIds.map((id) => postById(report, id)?.title).filter(Boolean) as string[];
  node.append(
    el("p", "rec-meta", `Based on ${plural(rec.findingKeys.length, "finding")} in ${titlesOfPosts.join(", ")}.`),
  );

  if (rec.edits.length) {
    const block = el("div", "rec-edits");
    // Say "AI" only if one of these findings really came from the AI model.
    const fromAi = rec.findingKeys.some((key) => {
      const rf = report.findings.find((f) => f.key === key);
      return rf ? postById(report, rf.fromPostId)?.result.mode === "databricks" : false;
    });
    block.append(el("h4", undefined, fromAi ? "Suggested changes · AI" : "Suggested changes"));
    const ul = el("ul", "edits");
    for (const e of rec.edits) {
      const li = el("li");
      li.append(icon("check", 14), el("span", undefined, e));
      ul.append(li);
    }
    block.append(ul);
    node.append(block);
  }

  const related = el("details", "related");
  related.append(el("summary", undefined, "Related findings"));
  const ul = el("ul");
  for (const key of rec.findingKeys) {
    const rf = report.findings.find((f) => f.key === key);
    if (!rf) continue;
    const li = el("li");
    li.append(el("span", undefined, rf.finding.exposure));
    li.append(button("Evidence", "link-btn", () => actions.openEvidence(rf.key), "eye"));
    ul.append(li);
  }
  related.append(ul);
  node.append(related);
  return node;
}

export function renderActions(root: HTMLElement, report: DashboardReport, actions: ViewActions) {
  root.replaceChildren();
  const head = el("div", "view-head reveal");
  head.append(el("h1", undefined, "Recommended actions"));
  head.append(el("p", undefined, "Ranked by how much each change lowers your risk across all posts."));
  root.append(head);
  if (report.recommendations.length === 0) {
    root.append(
      report.posts.length === 0
        ? emptyState("No checks yet", "Analyze a post to get recommendations.", actions)
        : emptyState("Nothing to change", "No findings, so there's nothing to recommend right now."),
    );
  } else {
    const ol = el("ol", "rec-list");
    report.recommendations.forEach((rec, i) => ol.append(recommendationCard(rec, i + 1, report, actions)));
    root.append(ol);
  }
  stagger(root);
}

// ---------------------------------------------------------------------------
// Evidence dialog
// ---------------------------------------------------------------------------

export function renderEvidence(title: HTMLElement, body: HTMLElement, rf: ReportFinding, report: DashboardReport) {
  title.textContent = `${CATEGORY_LABELS[rf.finding.category]} · evidence`;
  body.replaceChildren();

  const meta = el("div", "evidence-meta");
  meta.append(severityBadge(rf.finding.severity), confidenceMeter(rf.finding.confidence));
  if (rf.crossPost) meta.append(el("span", "pill pill-violet", "Cross-post"));
  body.append(meta);

  const interp = el("section", "evidence-section");
  interp.append(el("h3", undefined, interpretationLabel(postById(report, rf.fromPostId))));
  interp.append(el("p", "evidence-exposure", rf.finding.exposure));
  interp.append(el("p", "muted", `Why this might be wrong: ${rf.finding.uncertainty}`));
  body.append(interp);

  const observed = el("section", "evidence-section");
  observed.append(el("h3", undefined, "Observed text"));
  observed.append(
    el("p", "muted small", "Quotes the analysis relied on. “Found” means the quote really appears in the post's text."),
  );
  const owner = postById(report, rf.fromPostId);
  const ul = el("ul", "evidence-list");
  for (const ev of rf.finding.evidence) {
    const li = el("li", "evidence-item");
    const top = el("div", "evidence-top");
    const postId = owner ? postIdForSource(owner, ev.sourceId, report.posts) : null;
    const post = postId ? postById(report, postId) : undefined;
    top.append(el("span", "evidence-post", post ? post.title : "Unknown post"));
    top.append(el("span", "evidence-source", sourceLabel(ev.sourceId)));
    const status = el("span", ev.verified ? "verified" : "unverified");
    status.append(icon(ev.verified ? "check" : "alert", 13));
    status.append(el("span", undefined, ev.verified ? "Found in text" : "Not found in your text"));
    top.append(status);
    li.append(top);

    const context = owner ? sourceTextFor(owner, ev.sourceId, report.posts) : null;
    if (ev.verified && context) li.append(markedText(context, [ev.quote], "evidence-context"));
    else li.append(el("p", "evidence-quote", `“${ev.quote}”`));
    ul.append(li);
  }
  observed.append(ul);
  body.append(observed);
}
