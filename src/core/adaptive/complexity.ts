import type { ComplexityAssessment, ComplexityLevel, ComplexitySignals } from "../../shared/types";
import { estimateTokens } from "./tokens";

// Task keywords that imply real, multi-step engineering work. Matching several of
// these (or referencing many files) pushes a request toward "complex", which in
// turn asks Auto Mode for a more capable model and a richer prompt tier.
// Deliberately EXCLUDES everyday words like "build"/"design"/"implement" —
// those appear in ordinary single-file requests and used to flip them to
// "complex", which auto-selected a cloud model via the context-fit gate.
const HEAVY_KEYWORDS = [
  "refactor", "migrate", "rewrite", "architect",
  "redesign", "port", "scaffold", "restructure", "throughout",
  "every file", "all files", "codebase", "end-to-end",
];

// Keywords for a focused, single-target change — "moderate".
const MODERATE_KEYWORDS = [
  "add", "fix", "update", "change", "edit", "rename", "remove", "delete", "replace",
  "write", "create", "modify", "wire", "hook up", "extend", "support",
  "implement", "build", "design", "integrate", "feature", "across",
];

// Keywords for a read/answer request that rarely needs tools — "simple".
const LIGHT_KEYWORDS = [
  "explain", "what", "why", "how", "describe", "summarize", "summary", "meaning",
  "difference", "when should", "is it", "does", "define",
];

// A path-like token: a dotted filename, optionally with directories.
const PATH_RE = /(?:[\w@./-]+\/)*[\w.-]+\.[a-z0-9]{1,6}\b/gi;
// An @-attachment / @-file mention.
const AT_MENTION_RE = /@[\w./-]+/g;

export interface ComplexityInput {
  prompt: string;
  /** Attachments the user added to the turn. */
  attachmentCount?: number;
  /** The interaction mode — chat is inherently single-shot. */
  mode?: "chat" | "plan" | "agent";
}

/**
 * Heuristically classify a request's complexity. Deliberately rule-based and
 * transparent (no ML): every signal is surfaced so the transparency panel can
 * explain the resulting model choice. The blueprint scopes Auto Mode v1 as
 * "heuristic, not ML" — this is that heuristic.
 */
export function classifyComplexity(input: ComplexityInput): ComplexityAssessment {
  const prompt = input.prompt ?? "";
  const lower = prompt.toLowerCase();
  const promptTokens = estimateTokens(prompt);

  const filesReferenced = countFileReferences(prompt) + (input.attachmentCount ?? 0);

  // Whole-word matching: substring `includes` made "design" match inside
  // "undesigned" and "what" match "whatever", skewing classification.
  const matched = (list: string[]) =>
    list.filter((k) =>
      new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)
    );
  const heavy = matched(HEAVY_KEYWORDS);
  const moderate = matched(MODERATE_KEYWORDS);
  const light = matched(LIGHT_KEYWORDS);

  // Estimate implied steps: base 1, +1 per referenced file (capped), + heavy signal.
  let estimatedSteps = 1;
  estimatedSteps += Math.min(filesReferenced, 4);
  if (heavy.length) estimatedSteps += 2;
  if (moderate.length && !heavy.length) estimatedSteps += 1;

  const keywords = [...heavy, ...moderate, ...light];

  let level: ComplexityLevel;
  if (input.mode === "chat") {
    // Chat has no tools; treat it as light unless the prompt itself is huge.
    level = promptTokens > 1500 ? "moderate" : "simple";
  } else if (heavy.length >= 1 || filesReferenced >= 3 || promptTokens > 1200) {
    level = "complex";
  } else if (moderate.length >= 1 || filesReferenced >= 1 || promptTokens > 350) {
    level = "moderate";
  } else if (light.length >= 1) {
    level = "simple";
  } else {
    // Unknown shape: default to moderate so we don't under-provision a real task.
    level = "moderate";
  }

  const minContextTokens = MIN_CONTEXT[level];

  const signals: ComplexitySignals = { filesReferenced, estimatedSteps, keywords, promptTokens };
  return { level, minContextTokens, signals };
}

const MIN_CONTEXT: Record<ComplexityLevel, number> = {
  simple: 2048,
  moderate: 6144,
  complex: 12288,
};

/** Count distinct file-path-like references in the prompt (deduplicated). */
function countFileReferences(prompt: string): number {
  const found = new Set<string>();
  for (const m of prompt.matchAll(PATH_RE)) {
    const t = m[0].toLowerCase();
    // Ignore version-y or domain-y noise like "3.11" or "vite.dev".
    if (/^\d/.test(t)) continue;
    found.add(t);
  }
  for (const m of prompt.matchAll(AT_MENTION_RE)) found.add(m[0].toLowerCase());
  return found.size;
}
