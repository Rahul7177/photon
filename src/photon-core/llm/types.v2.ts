// Harness-shaped LLM seam, adapter-friendly.
// Re-exports existing LLMProvider for compat — new drivers use GenerateOptions/StreamChunk
// but adapters may still implement chatStream() and be bridged.

import type { LLMChatChunk, LLMChatRequest, LLMMessage } from "../../core/llm/types";

export interface GenerateOptions {
  provider: string;
  model: string;
  messages: LLMMessage[];
  system?: string;
  tools?: unknown[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  signal?: AbortSignal;
  sessionId?: string;
  purpose?: "compaction" | "session-title";
}

export type StreamChunk =
  | { type: "text-delta"; text: string; index: number }
  | { type: "tool-call-delta"; id: string; name?: string; argumentsDelta: string; index: number }
  | { type: "block-end"; block: { type: string; text?: string; id?: string; name?: string; arguments?: string } }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "finish"; reason: "stop" | "tool-calls" | "max-tokens" | "aborted" | "error"; failure?: { message: string; code: string } };

export interface LlmAdapter {
  id: string;
  label: string;
  enabled: boolean;
  isConfigured(): boolean;
  ping(): Promise<boolean>;
  listModels(): Promise<import("../../shared/types").ModelInfo[]>;
  stream(opts: GenerateOptions): AsyncGenerator<StreamChunk>;
}

// Bridge: wrap a legacy LLMProvider (chatStream) as an LlmAdapter
export function bridgeLegacyProvider(p: import("../../core/llm/types").LLMProvider): LlmAdapter {
  return {
    id: p.id,
    label: p.label,
    enabled: p.enabled,
    isConfigured: () => p.isConfigured(),
    ping: () => p.ping(),
    listModels: () => p.listModels(),
    async *stream(opts: GenerateOptions): AsyncGenerator<StreamChunk> {
      const req: LLMChatRequest = {
        model: opts.model,
        messages: [
          ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
          ...opts.messages,
        ],
        options: { temperature: opts.temperature, num_predict: opts.maxTokens ?? -1, stop: opts.stop },
        tools: opts.tools,
      };
      for await (const chunk of p.chatStream(req, opts.signal)) {
        if (chunk.message?.content) yield { type: "text-delta", text: chunk.message.content, index: 0 };
        for (const tc of chunk.message?.tool_calls ?? []) {
          yield { type: "tool-call-delta", id: tc.id ?? "", name: tc.function.name, argumentsDelta: JSON.stringify(tc.function.arguments), index: 0 };
          yield { type: "block-end", block: { type: "tool-call", id: tc.id, name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) } };
        }
        if (chunk.done) {
          const r = (chunk.done_reason ?? "stop").toLowerCase();
          const reason = r === "length" || r === "max_tokens" ? "max-tokens" : r === "tool-calls" ? "tool-calls" : "stop";
          yield { type: "finish", reason: reason as any };
        }
      }
    },
  };
}
