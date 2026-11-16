// MOCK MODE: fake findings from simple keyword rules — NOT an AI model.
// Lets you build and test the extension without Databricks credentials.
// The response is labeled mode: "mock" so the UI can say so clearly.
import type { Category, Evidence, Finding, Level, TextSource } from "../../shared/contract";

interface Rule {
  pattern: RegExp; // must have the "g" flag
  category: Category;
  severity: Level;
  exposure: string;
  uncertainty: string;
  replacement: string;
}

const RULES: Rule[] = [
  {
    pattern: /\b[A-Z][a-z]+(?: [A-Z][a-z]+)* (?:Elementary|Middle School|High School|Academy|Preschool|Daycare)\b/g,
    category: "children",
    severity: "high",
    exposure: "Names a school, which can show where a child is on weekdays.",
    uncertainty: "Keyword match only; the school may not be connected to a child you know.",
    replacement: "school",
  },
  {
    pattern: /\b\d{0,5} ?[A-Z][a-z]+ (?:St|Street|Ave|Avenue|Rd|Road|Blvd|Ln|Lane|Dr|Drive)\b\.?/g,
    category: "location",
    severity: "high",
    exposure: "Mentions a street, which can narrow down where you live or spend time.",
    uncertainty: "Keyword match only; this may be a public place rather than your home.",
    replacement: "home",
  },
  {
    pattern: /\b(?:every (?:day|weekday|morning|night|week|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)days|weekdays)\b/gi,
    category: "routine_schedule",
    severity: "medium",
    exposure: "Describes a repeating schedule, which makes it easier to predict where you will be.",
    uncertainty: "Keyword match only; the routine may be vague or no longer accurate.",
    replacement: "sometimes",
  },
  {
    pattern: /\b(?:[01]?\d(?::[0-5]\d)? ?(?:am|pm)|[01]?\d:[0-5]\d)\b/gi,
    category: "routine_schedule",
    severity: "medium",
    exposure: "Gives an exact time, which can combine with places to reveal a routine.",
    uncertainty: "Keyword match only; a one-off time is less revealing than a habit.",
    replacement: "later",
  },
  {
    pattern: /\b(?:leaving for|flying to|out of town|away (?:for|until)|(?:a )?whole week|vacation)\b/gi,
    category: "travel_absence",
    severity: "high",
    exposure: "Signals that you will be away, which can suggest your home is empty.",
    uncertainty: "Keyword match only; others may still be at home. Posting after you're back avoids this.",
    replacement: "",
  },
  {
    pattern: /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g,
    category: "contact",
    severity: "high",
    exposure: "Shows a phone number that anyone can copy.",
    uncertainty: "Keyword match only; it may be a public business number.",
    replacement: "",
  },
];

/** `task` "history": the sources are saved posts (no draft); only the summary wording changes. */
export function mockAnalyze(sources: TextSource[], task: "draft" | "history" = "draft"): { summary: string; findings: Finding[]; droppedFindings: number } {
  const what = task === "history" ? "your saved posts" : "your draft";
  const findings: Finding[] = [];

  for (const rule of RULES) {
    const evidence: Evidence[] = [];
    for (const source of sources) {
      const matches = [...source.text.matchAll(rule.pattern)].slice(0, 2);
      for (const match of matches) {
        evidence.push({ sourceId: source.id, quote: match[0].trim(), verified: true });
      }
    }
    if (evidence.length === 0) continue;

    findings.push({
      id: `f${findings.length + 1}`,
      category: rule.category,
      severity: rule.severity,
      exposure: rule.exposure,
      evidence,
      crossSource: new Set(evidence.map((e) => e.sourceId)).size > 1,
      confidence: "low",
      uncertainty: rule.uncertainty,
      suggestedEdits: evidence.map((e) =>
        e.sourceId === "caption"
          ? {
              sourceId: e.sourceId,
              action: rule.replacement ? "generalize" : "remove",
              original: e.quote,
              ...(rule.replacement ? { replacement: rule.replacement } : {}),
              explanation: rule.replacement ? "Use a vaguer word." : "Remove it from the caption.",
            }
          : {
              sourceId: e.sourceId,
              action: "crop_or_blur_image",
              original: e.quote,
              explanation: "This text is in the photo. Crop or blur it before posting.",
            },
      ),
    });
  }

  const order: Record<Level, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  findings.forEach((f, i) => (f.id = `f${i + 1}`));

  return {
    summary:
      findings.length > 0
        ? `${findings.length} keyword rule(s) matched ${what}.`
        : `No keyword rules matched ${what}.`,
    findings: findings.slice(0, 8),
    // Rules beyond the limit of 8 are not shown, so count them as dropped.
    droppedFindings: Math.max(0, findings.length - 8),
  };
}
