// Lightweight, tokenizer-free token estimation. We never load a real BPE model
// (too heavy for the extension host); instead we approximate, which is enough
// for budgeting a small context window with a safety reserve.

import type { ChatMessage } from "../../shared/types";

/**
 * Estimate tokens for a chunk of text. Mixes a chars/4 heuristic with a
 * word-count floor so code (few spaces) and prose (many spaces) both land close.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChars = text.length / 4;
  const byWords = text.trim().split(/\s+/).length * 1.3;
  return Math.ceil(Math.max(byChars, byWords));
}

export function estimateMessageTokens(msg: ChatMessage): number {
  // ~4 tokens of role/formatting overhead per message.
  let t = 4 + estimateTokens(msg.content);
  for (const call of msg.toolCalls ?? []) {
    t += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args));
    if (call.result) t += estimateTokens(call.result);
  }
  return t;
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  return msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
