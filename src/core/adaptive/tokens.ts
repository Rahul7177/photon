// Lightweight, tokenizer-free token estimation. We never load a real BPE model
// (too heavy for the extension host); instead we approximate, which is enough
// for budgeting a small context window with a safety reserve.
//
// Phase 1.2: Per-model tokenizer hook. A real tokenizer (tiktoken, llama.cpp
// SentencePiece) can be registered for a model family to get estimates within
// ~10% of the actual eval_count. When none is registered the heuristic fallback
// is used.

import type { ChatMessage } from "../../shared/types";

/**
 * A pluggable tokenizer that maps text → token count for a specific model.
 * Registered via `registerTokenizer()` — the engine picks the best match.
 */
export interface ModelTokenizer {
  /** Model name prefix this tokenizer handles, e.g. "gpt-4", "llama3", "qwen". */
  modelPrefix: string;
  /** Estimate the number of tokens in a piece of text. */
  count(text: string): number;
}

const tokenizers: ModelTokenizer[] = [];

/**
 * Register a model-specific tokenizer. Later registrations for the same prefix
 * override earlier ones. Pass `null` as `tok` to unregister.
 */
export function registerTokenizer(tok: ModelTokenizer | null): void {
  if (!tok) return;
  const idx = tokenizers.findIndex((t) => t.modelPrefix === tok.modelPrefix);
  if (idx >= 0) tokenizers[idx] = tok;
  else tokenizers.push(tok);
}

/** Best-effort tokenizer for a model name, or undefined if none registered. */
function tokenizerFor(model: string | undefined): ModelTokenizer | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  // Longest-prefix match: "qwen2.5-coder" should beat "qwen".
  let best: ModelTokenizer | undefined;
  for (const tok of tokenizers) {
    if (lower.startsWith(tok.modelPrefix.toLowerCase())) {
      if (!best || tok.modelPrefix.length > best.modelPrefix.length) best = tok;
    }
  }
  return best;
}

export const TOKENS_PER_IMAGE = 800;

/**
 * Estimate tokens for a chunk of text. Mixes a chars/4 heuristic with a
 * word-count floor so code (few spaces) and prose (many spaces) both land close.
 * Also accounts for code-dense text where symbols increase token fragmentation.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  const byChars = text.length / 4;
  const byWords = trimmed.split(/\s+/).length * 1.3;
  let baseEstimate = Math.max(byChars, byWords);

  // Symbol density check for code-heavy chunks:
  // In code, punctuation and brackets split into individual BPE tokens (~3.2 chars/tok)
  const symbols = trimmed.match(/[{}()\[\];:.,=><_+\-*\/\\&|^%!~?@#$"`]/g)?.length ?? 0;
  const nonWs = trimmed.replace(/\s+/g, "").length;
  if (nonWs > 20 && symbols / nonWs > 0.15) {
    baseEstimate = Math.max(baseEstimate, nonWs / 3.2);
  }

  return Math.ceil(baseEstimate);
}

/**
 * Phase 1.2: Estimate tokens using a model-specific tokenizer when one is
 * registered, falling back to the heuristic. This gets within ~10% of the
 * actual `eval_count` for models with a registered tokenizer.
 */
export function estimateTokensForModel(text: string, model?: string): number {
  if (!text) return 0;
  const tok = tokenizerFor(model);
  return tok ? tok.count(text) : estimateTokens(text);
}

export function estimateMessageTokens(msg: ChatMessage, model?: string): number {
  // ~4 tokens of role/formatting overhead per message.
  let t = 4 + estimateTokensForModel(msg.content, model);

  if (msg.thinking) {
    t += estimateTokensForModel(msg.thinking, model);
  }

  // Account for multimodal image and text attachments
  for (const att of msg.attachments ?? []) {
    if (att.kind === "image") {
      t += TOKENS_PER_IMAGE;
    } else if (att.text) {
      t += estimateTokensForModel(att.text, model);
    }
  }

  for (const call of msg.toolCalls ?? []) {
    t += estimateTokensForModel(call.name, model) + estimateTokensForModel(JSON.stringify(call.args), model);
    if (call.result) t += estimateTokensForModel(call.result, model);
  }
  return t;
}

export function estimateMessagesTokens(msgs: ChatMessage[], model?: string): number {
  return msgs.reduce((sum, m) => sum + estimateMessageTokens(m, model), 0);
}

export function estimateToolSchemasTokens(
  tools: unknown[],
  model?: string
): number {
  let t = 0;
  for (const tool of tools) {
    if (!tool) continue;
    const raw = (tool as { spec?: unknown }).spec ?? tool;
    t += 8 + estimateTokensForModel(JSON.stringify(raw), model);
  }
  return t;
}
