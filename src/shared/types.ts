// Domain types shared between the extension host and the webview UI.
// Keep this file dependency-free (no vscode / node imports) so the webview
// can import it directly.

export type Mode = "chat" | "plan" | "agent";

export type Role = "system" | "user" | "assistant" | "tool";

/** A single chat message as shown in the UI and sent to the model. */
export interface ChatMessage {
  id: string;
  role: Role;
  /** Rendered markdown / plain text content. */
  content: string;
  /** Tool invocations the assistant requested on this turn. */
  toolCalls?: ToolCall[];
  /** Files the user attached to this turn (images, text docs). */
  attachments?: Attachment[];
  /** For role === "tool": which call this result answers. */
  toolCallId?: string;
  createdAt: number;
  /** True while the assistant message is still streaming. */
  streaming?: boolean;
  /** Non-fatal note attached to a message (e.g. "truncated to fit window"). */
  notice?: string;
}

/** A user-attached file. Images go to vision models; text is inlined as context. */
export interface Attachment {
  id: string;
  kind: "image" | "text";
  name: string;
  mime: string;
  /** Bytes, for the UI. */
  size: number;
  /** For kind === "image": base64 payload WITHOUT the data: URL prefix. */
  dataBase64?: string;
  /** For kind === "text": extracted UTF-8 text. */
  text?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments. */
  args: Record<string, unknown>;
  /** Lifecycle for the UI tool-card. */
  status: "proposed" | "running" | "done" | "error" | "denied";
  result?: string;
  error?: string;
  /** Whether this call mutates the workspace / runs commands. */
  sideEffecting?: boolean;
  /** Gemini reasoning models require this signature on function call parts. */
  thoughtSignature?: string;
}

/** A model as reported by a provider, enriched with Photon's profile. */
export interface ModelInfo {
  name: string;
  /** Which provider owns this model: "ollama" | "gemini" | "claude" | "nvidia" | "blackbox" | custom id. */
  provider?: string;
  /** Parameter size string from Ollama, e.g. "8B", "3.8B". */
  paramSize?: string;
  /** Parsed parameter count in billions. */
  paramsB?: number;
  /** Quantization level, e.g. "Q4_K_M". */
  quantization?: string;
  family?: string;
  /** Max context length the model advertises. */
  contextLength?: number;
  /** On-disk size in bytes. */
  sizeBytes?: number;
  /** Whether the model was trained for native tool/function calling. */
  toolTrained?: boolean;
  /** Whether the model accepts image input (vision / multimodal). */
  vision?: boolean;
  /** Whether the model accepts audio input. */
  audio?: boolean;
  /** Whether the model accepts video input. */
  video?: boolean;
  /** Whether the model supports thinking / extended reasoning (e.g. deepseek-r1, gpt-o1, gemini-thinking). */
  thinking?: boolean;
  /** Raw capabilities as advertised by the provider (e.g. Ollama capabilities array). */
  capabilities?: string[];
  tier?: ModelTier;
}

/** Live generation throughput, streamed during a turn for the tok/s meter. */
export interface GenerationStats {
  /** Estimated tokens per second since generation started. */
  tps: number;
  /** Estimated tokens generated so far this turn. */
  totalTokens: number;
  /** Wall-clock ms since generation started. */
  elapsedMs: number;
}

/** Per-model overrides — context + llama.cpp server flags, edited in Settings. */
export interface LlamaCppSettings {
  /** Context size (-c), e.g. 32768 */
  ctx?: number;
  /** GPU layers: "all" or a number (-ngl) */
  ngl?: number | "all";
  /** Fit KV cache (--fit / --no-fit) */
  fit?: boolean;
  /** Parallel slots (-np) */
  np?: number;
  /** Flash attention (-fa on/off) */
  fa?: boolean;
  /** Cache type K (-ctk), e.g. q8_0, q4_0 */
  ctk?: string;
  /** Cache type V (-ctv), e.g. q8_0 */
  ctv?: string;
  /** Extra raw args appended to the launch command */
  extraArgs?: string;
}

export interface PerModelConfig {
  /** Override effective context window for this model (tokens). */
  numCtx?: number;
  /** llama.cpp-specific flags — only meaningful for provider === "llamacpp" */
  llamacpp?: LlamaCppSettings;
  /** Sampling overrides — per-model temperature / top_p / seed. */
  sampling?: {
    temp?: number;
    topP?: number;
    seed?: number;
  };
  /** Human note, e.g. "8B Q8 for coding" */
  note?: string;
}

/** Coarse capability tier that drives the adaptive strategy. */
export type ModelTier = "tiny" | "small" | "medium" | "large";

/** How much prompt/tool machinery Photon gives the model. */
export type IntelligenceLevel = "low" | "medium" | "high" | "max";

/** The user-facing setting: "auto" lets the orchestrator pick per model. */
export type IntelligenceSetting = "auto" | IntelligenceLevel;

export interface MachineProfile {
  totalRamBytes: number;
  freeRamBytes: number;
  cpuCores: number;
  cpuModel: string;
  platform: string;
  arch: string;
  /** Best-effort GPU detection. */
  gpu?: { name: string; vramBytes?: number; vendor?: string };
  /** Rough class used for defaults. */
  tier: "low" | "mid" | "high";
}

/** The concrete plan the orchestrator produces for a (machine, model, mode). */
export interface AdaptivePlan {
  model: string;
  mode: Mode;
  /** Effective context window Photon will budget against. */
  contextWindow: number;
  /** num_ctx passed to Ollama. */
  numCtx: number;
  temperature: number;
  topP: number;
  /** Max tokens Photon will let the model generate per turn. */
  maxOutputTokens: number;
  /** How tools are presented to this model. */
  toolProtocol: ToolProtocol;
  /** Max tools exposed at once (weak models get fewer). */
  maxTools: number;
  /** Allow more than one tool call per assistant turn. */
  allowParallelTools: boolean;
  /** Resolved intelligence level driving prompt/tool detail. */
  intelligence: IntelligenceLevel;
  /** True when the level was auto-derived rather than user-pinned. */
  intelligenceAuto: boolean;
  /** Human-readable reasons, shown in diagnostics / UI tooltip. */
  rationale: string[];
}

export type ToolProtocol = "native" | "photon-block";

/** Declarative tool description used for prompting + validation. */
export interface ToolSpec {
  name: string;
  /** One short line the model reads. */
  summary: string;
  /** Ordered parameters — kept minimal for weak models. */
  params: ToolParam[];
  /** Mutates the workspace / runs commands → requires user confirmation. */
  sideEffecting: boolean;
  /** Lower = more likely to be included when trimming for tiny models. */
  priority: number;
  /**
   * Minimum capability tier a model must have for this tool to be exposed at all.
   * Hard gate (independent of the tool-count cap): a `high`-tier tool is never
   * shown to a `low` model even if there's room. Defaults to "low" (all models).
   */
  minTier?: IntelligenceLevel;
  /** Free-form capability tags, e.g. ["fs","read"] / ["exec","write"] / ["mcp"]. */
  tags?: string[];
  /**
   * A concrete, correct example invocation. NOT shown in the baseline prompt
   * (that would waste scarce context) — instead it is injected exactly when the
   * model struggles: after repeated failures of this tool, and in repair
   * prompts for malformed calls. Also folded into native tool descriptions for
   * structured-calling models.
   */
  example?: string;
}

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
}

export interface SessionState {
  id: string;
  title: string;
  mode: Mode;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Lightweight session metadata for the history list — no message bodies. */
export interface SessionSummary {
  id: string;
  title: string;
  mode: Mode;
  model: string;
  updatedAt: number;
  messageCount: number;
}

export interface TokenUsage {
  used: number;
  window: number;
  /** Breakdown for the context meter. */
  breakdown: { label: string; tokens: number }[];
}

/* ------------------------- Auto Mode (Module 8/12) ------------------------ */

/** Coarse task complexity, derived heuristically from the prompt + workspace. */
export type ComplexityLevel = "simple" | "moderate" | "complex";

/** The raw signals behind a complexity assessment — shown in the transparency panel. */
export interface ComplexitySignals {
  /** Files the prompt appears to reference (paths, @attachments). */
  filesReferenced: number;
  /** Rough number of steps implied (1 = single-shot, >1 = multi-step). */
  estimatedSteps: number;
  /** Task keywords matched, e.g. "refactor", "explain". */
  keywords: string[];
  /** Estimated tokens in the user's prompt. */
  promptTokens: number;
}

export interface ComplexityAssessment {
  level: ComplexityLevel;
  /** Minimum context window a candidate model needs to be considered. */
  minContextTokens: number;
  signals: ComplexitySignals;
}

/** One model's fitness for the current request, with a human-readable why. */
export interface ModelScore {
  model: string;
  score: number;
  /** True when the model meets the task's minimum context requirement. */
  fits: boolean;
  reasons: string[];
}

/** The full, explainable record of how Auto Mode chose a model for a turn. */
export interface AutoDecision {
  chosenModel: string;
  /** True when Photon auto-selected; false when the user pinned the model. */
  auto: boolean;
  pinned: boolean;
  complexity: ComplexityAssessment;
  /** Every candidate, ranked — the transparency panel renders this. */
  scores: ModelScore[];
  reason: string;
}

/* ------------------- Capability Profiler / Photon Bench (M7) ------------------- */

export type BenchTaskId = "throughput" | "toolcall" | "reasoning";

export interface BenchTaskOutcome {
  id: BenchTaskId;
  passed: boolean;
  detail: string;
}

/** Result of benchmarking one model on this machine. Versioned so a rubric
 *  change never silently corrupts cross-version comparisons. */
export interface BenchResult {
  model: string;
  quantization?: string;
  /** Machine tier the bench ran on (low/mid/high) — part of the comparison key. */
  hardwareClass: string;
  methodologyVersion: number;
  /** Measured generation throughput (tokens/second). */
  tokensPerSec: number;
  /** Latency to first token (ms) — reflects prompt-eval cost on this machine. */
  firstTokenMs: number;
  /** 0..1 share of structured tool-call attempts that parsed correctly. */
  toolCallReliability: number;
  reasoningPass: boolean;
  tasks: BenchTaskOutcome[];
  ranAt: number;
}

export type BenchPhase = "idle" | "running" | "done" | "error";

/* ----------------------- Workspace Indexing (Module 10) ---------------------- */

export type IndexPhase = "idle" | "indexing" | "ready" | "unavailable" | "error";

export interface IndexStatus {
  phase: IndexPhase;
  filesIndexed: number;
  chunks: number;
  /** Files changed but not yet re-embedded. */
  pending: number;
  /** The local embedding model in use, if any. */
  embeddingModel?: string;
  message?: string;
}

/* --------------------------- MCP servers (Module 11) -------------------------- */

export type McpTransport = "http" | "stdio";
export type McpServerStatus = "pending" | "approved" | "connected" | "error" | "revoked";

export interface McpServerInfo {
  id: string;
  transport: McpTransport;
  /** URL (http) or command line (stdio). */
  target: string;
  status: McpServerStatus;
  toolCount: number;
  message?: string;
}
