import type { ComplexityAssessment, ComplexityLevel, ComplexitySignals } from "../../shared/types";
import { analyzeTask, toComplexity } from "../intelligence/policy";
import { estimateTokens } from "./tokens";

export interface ComplexityInput {
  prompt: string;
  attachmentCount?: number;
  mode?: "chat" | "plan" | "agent";
}

/** Backward-compatible complexity API, now backed by the multidimensional intelligence policy. */
export function classifyComplexity(input: ComplexityInput): ComplexityAssessment {
  const prompt = input.prompt ?? "";
  const mode = input.mode ?? "agent";
  const task = analyzeTask(prompt, mode, input.attachmentCount ?? 0);
  const result = toComplexity(task, estimateTokens(prompt));
  const keywords = prompt.toLowerCase().match(/\b(refactor|migrate|rewrite|debug|architect|test|build|fix|implement|update|rename|delete|remove|create|integrate|security)\b/g) ?? [];
  const signals: ComplexitySignals = {
    ...result.signals,
    filesReferenced: result.signals.filesReferenced ?? 0,
    keywords: [...new Set(keywords)],
  };
  const level: ComplexityLevel = result.level;
  return { ...result, level, signals };
}

export { analyzeTask } from "../intelligence/policy";
