import type { ModelInfo, ThinkingLevel } from "../../shared/types";

/**
 * Provider-neutral chat types. Every provider (local Ollama or a cloud API)
 * speaks these normalized shapes; the engine never sees provider-specific wire
 * formats. Structurally compatible with the Ollama wire types so the existing
 * Ollama client plugs in without conversion.
 */

export interface LLMToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
  thoughtSignature?: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Provider-native reasoning trace for this chunk (Ollama `thinking`,
   *  DeepSeek-style `reasoning_content`, Anthropic thinking blocks, Gemini
   *  thought parts). Display-only: never fed back into model context. */
  thinking?: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
  images?: string[];
}

export interface LLMChatOptions {
  num_ctx?: number;
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  stop?: string[];
  seed?: number;
  /** Explicit Photon reasoning level after Auto has been resolved by the host/provider layer. */
  thinkingLevel?: ThinkingLevel;
}

export interface LLMChatRequest {
  model: string;
  messages: LLMMessage[];
  options?: LLMChatOptions;
  tools?: unknown[];
}

export interface LLMChatChunk {
  message?: LLMMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  /** Cached input tokens reported by cloud providers (Anthropic, Gemini, OpenAI). */
  cached_tokens?: number;
}

export interface LLMProvider {
  id: string;
  label: string;
  enabled: boolean;
  isConfigured(): boolean;
  ping(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  fetchLiveModels?(): Promise<ModelInfo[]>;
  chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk>;
}

export interface ProviderModel {
  id: string;
  name: string;
  paramSize?: string;
  paramsB?: number;
  contextLength?: number;
  toolTrained?: boolean;
  vision?: boolean;
  audio?: boolean;
  video?: boolean;
  thinking?: boolean;
  thinkingLevels?: ModelInfo["thinkingLevels"];
  capabilities?: string[];
  tier?: ModelInfo["tier"];
}
