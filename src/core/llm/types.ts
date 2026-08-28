import type { ModelInfo } from "../../shared/types";

/**
 * Provider-neutral chat types. Every provider (local Ollama or a cloud API)
 * speaks these normalized shapes; the engine never sees provider-specific wire
 * formats. Structurally compatible with the Ollama wire types so the existing
 * Ollama client plugs in without conversion.
 */

export interface LLMToolCall {
  /** Provider-assigned call id (echoed back in tool results). Optional —
   *  engines assign one when the provider doesn't (e.g. Gemini). */
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: LLMToolCall[];
  /** For role === "tool": which call this result answers (provider id). */
  tool_call_id?: string;
  /** For role === "tool": the tool's name (Gemini functionResponse needs it). */
  name?: string;
  /** Base64-encoded images (no data: prefix) for vision models. */
  images?: string[];
}

export interface LLMChatOptions {
  num_ctx?: number;
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  stop?: string[];
  seed?: number;
}

export interface LLMChatRequest {
  model: string;
  messages: LLMMessage[];
  options?: LLMChatOptions;
  /** OpenAI-compatible function-tool schema (converted per provider). */
  tools?: unknown[];
}

export interface LLMChatChunk {
  message?: LLMMessage;
  done: boolean;
  done_reason?: string;
  /** Ollama-only timing metadata (nanoseconds) — used by Photon Bench. */
  eval_count?: number;
  eval_duration?: number;
}

/**
 * A model source. Ollama is one provider; Gemini, Claude, NVIDIA, Blackbox and
 * arbitrary OpenAI-compatible endpoints are others. The engine depends only on
 * this interface, so adding a provider never touches the agent loop.
 */
export interface LLMProvider {
  /** Stable id used for routing + settings, e.g. "ollama" | "gemini" | "claude". */
  id: string;
  /** Human-readable name for the UI. */
  label: string;
  /** Whether the user has enabled this provider. */
  enabled: boolean;
  /** Whether the provider has what it needs to run (API key, base URL). */
  isConfigured(): boolean;
  /** Cheap reachability probe. */
  ping(): Promise<boolean>;
  /** Enriched model catalog (already profiled into ModelInfo). */
  listModels(): Promise<ModelInfo[]>;
  /**
   * Optional: fetch the live model list directly from the provider's API.
   * Returns undefined when the provider doesn't support live listing (e.g. Blackbox).
   */
  fetchLiveModels?(): Promise<ModelInfo[]>;
  /** Stream a chat completion. Yields normalized chunks until done. */
  chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk>;
}

/** A static catalog entry for a cloud model. */
export interface ProviderModel {
  /** The model id sent to the provider's API (no provider prefix). */
  id: string;
  /** Display name shown in the picker (includes the provider prefix). */
  name: string;
  paramSize?: string;
  paramsB?: number;
  contextLength?: number;
  toolTrained?: boolean;
  vision?: boolean;
  audio?: boolean;
  video?: boolean;
  thinking?: boolean;
  capabilities?: string[];
  tier?: ModelInfo["tier"];
}