// Wire types for the Ollama REST API (subset Photon uses).

export interface OllamaTagsResponse {
  models: OllamaTagModel[];
}

export interface OllamaTagModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    format?: string;
  };
}

export interface OllamaShowResponse {
  license?: string;
  modelfile?: string;
  parameters?: string;
  template?: string;
  details?: OllamaTagModel["details"];
  // Newer Ollama versions expose a flat map of architecture metadata,
  // e.g. "qwen2.context_length": 32768.
  model_info?: Record<string, unknown>;
  capabilities?: string[];
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** Base64-encoded images (no data: prefix) for vision models. */
  images?: string[];
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaChatOptions {
  num_ctx?: number;
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  stop?: string[];
  seed?: number;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  options?: OllamaChatOptions;
  tools?: unknown[];
  keep_alive?: string | number;
}

/** One streamed chunk from /api/chat. */
export interface OllamaChatChunk {
  model: string;
  created_at: string;
  message?: OllamaChatMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  /** Generation time in nanoseconds — used for accurate tokens/sec in Photon Bench. */
  eval_duration?: number;
}

/** Request/response for the embeddings endpoint (workspace indexing, M10). */
export interface OllamaEmbedRequest {
  model: string;
  input: string | string[];
}

export interface OllamaEmbedResponse {
  embeddings: number[][];
}
