import type { TokenUsage } from "../../shared/types";
import type { LLMMessage } from "../llm/types";
import { estimateTokensForModel } from "../adaptive/tokens";

export interface FitResult {
  messages: LLMMessage[];
  droppedCount: number;
  usage: TokenUsage;
}

/**
 * Fit a conversation into the model's context window. The system message is
 * always kept; older turns are dropped from the front until the estimated
 * token count fits `budgetTokens`. The NEWEST message (the user's current
 * request) is kept unconditionally — on a very small window with a large
 * system prompt it must never be the thing that gets trimmed. Returns a usage
 * breakdown for the UI meter.
 *
 * Phase 1.2: When `model` is provided, a model-specific tokenizer is used
 * for more accurate estimation (within ~10% of eval_count).
 */
export function fitToWindow(
  system: LLMMessage,
  history: LLMMessage[],
  budgetTokens: number,
  window: number,
  model?: string
): FitResult {
  const systemTokens = tokensOf(system, model);
  const available = Math.max(0, budgetTokens - systemTokens);

  // Walk from newest to oldest, keeping what fits. The newest message is
  // always admitted so the model at least sees what it's responding to.
  const kept: LLMMessage[] = [];
  let historyTokens = 0;
  let dropped = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = tokensOf(history[i], model);
    if (i === history.length - 1 || historyTokens + t <= available) {
      kept.unshift(history[i]);
      historyTokens += t;
    } else {
      dropped = i + 1; // everything from 0..i couldn't be kept
      break;
    }
  }

  const usage: TokenUsage = {
    used: systemTokens + historyTokens,
    window: budgetTokens,
    breakdown: [
      { label: "System + tools", tokens: systemTokens },
      { label: "Conversation", tokens: historyTokens },
    ],
  };

  return { messages: [system, ...kept], droppedCount: dropped, usage };
}

function tokensOf(msg: LLMMessage, model?: string): number {
  let t = 4 + estimateTokensForModel(msg.content, model);
  for (const call of msg.tool_calls ?? []) {
    t += estimateTokensForModel(call.function.name, model) + estimateTokensForModel(JSON.stringify(call.function.arguments), model);
  }
  return t;
}
