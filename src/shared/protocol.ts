// Typed message protocol between the extension host and the webview.
// `Host*` messages flow host -> webview; `View*` messages flow webview -> host.

import type {
  AdaptivePlan,
  Attachment,
  AutoDecision,
  BenchPhase,
  BenchResult,
  ChatMessage,
  GenerationStats,
  IndexStatus,
  IntelligenceSetting,
  MachineProfile,
  McpServerInfo,
  Mode,
  ModelInfo,
  PerModelConfig,
  SessionState,
  SessionSummary,
  TokenUsage,
  ToolCall,
} from "./types";

/* ------------------------------ host -> webview ------------------------------ */

export type HostMessage =
  | { type: "init"; payload: InitPayload }
  | { type: "models"; payload: { models: ModelInfo[]; selected: string; ollamaReachable: boolean } }
  | { type: "sessionLoaded"; payload: SessionState }
  | { type: "sessionList"; payload: { sessions: SessionSummary[]; activeId: string } }
  | { type: "messageAppended"; payload: ChatMessage }
  | { type: "messageDelta"; payload: { id: string; delta: string } }
  | { type: "messageDone"; payload: { id: string } }
  | { type: "messageRemoved"; payload: { id: string } }
  | { type: "toolUpdate"; payload: { messageId: string; call: ToolCall } }
  | { type: "toolApprovalRequest"; payload: { messageId: string; call: ToolCall } }
  | { type: "tokenUsage"; payload: TokenUsage }
  | { type: "generationStats"; payload: GenerationStats | null }
  | { type: "planUpdated"; payload: AdaptivePlan }
  | { type: "config"; payload: PhotonConfig }
  | { type: "status"; payload: { kind: "idle" | "thinking" | "running" | "error"; detail?: string } }
  // Auto Mode transparency (M8/M12): why this model was chosen for the last turn.
  | { type: "decision"; payload: AutoDecision }
  // Capability Profiler / Photon Bench (M7).
  | { type: "benchStatus"; payload: { model: string; phase: BenchPhase; message?: string } }
  | { type: "benchResults"; payload: BenchResult[] }
  // Workspace indexing (M10).
  | { type: "indexStatus"; payload: IndexStatus }
  // MCP server registry (M11).
  | { type: "mcpServers"; payload: McpServerInfo[] }
  // Tool list refresh (e.g. after an MCP server connects/disconnects).
  | { type: "tools"; payload: ToolSummary[] }
  // Dynamic provider model fetch results (M-cloud).
  | { type: "providerModels"; payload: { id: string; models: ModelInfo[]; error?: string } }
  // Model connectivity test result.
  | { type: "modelTestResult"; payload: { providerId: string; model: ModelInfo; ok: boolean; latencyMs?: number; error?: string } }
  | { type: "modelConfigs"; payload: Record<string, PerModelConfig> }
  | { type: "error"; payload: { message: string } };

export interface PhotonConfig {
  autoApprove: boolean;
  adaptiveEnabled: boolean;
  webSearchProvider: "duckduckgo" | "none";
  ollamaBaseUrl: string;
  llamacppBaseUrl: string;
  numCtxOverride: number;
  intelligence: IntelligenceSetting;
  /** Auto Mode: Photon selects the model per request (M8). When false a model is pinned. */
  autoSelectModel: boolean;
  /** Workspace indexing on/off (M10). */
  indexingEnabled: boolean;
  /** Local embedding model used for indexing, if any. */
  embeddingModel: string;
  /** Status of every model provider (Ollama + cloud) for the settings UI. */
  providers: ProviderStatus[];
  /** Which engine stack is active: local (Ollama + adaptive) or cloud
   *  (direct native tool-calling, no adaptive limits, no Ollama models). */
  interfaceMode: "local" | "cloud";
}

export interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  modelCount: number;
}

export interface ToolSummary {
  name: string;
  summary: string;
  sideEffecting: boolean;
}

export interface InitPayload {
  session: SessionState;
  sessions: SessionSummary[];
  models: ModelInfo[];
  selectedModel: string;
  mode: Mode;
  machine: MachineProfile | null;
  plan: AdaptivePlan | null;
  ollamaReachable: boolean;
  config: PhotonConfig;
  tools: ToolSummary[];
  benchResults: BenchResult[];
  indexStatus: IndexStatus;
  mcpServers: McpServerInfo[];
  modelConfigs: Record<string, PerModelConfig>;
}

/* ------------------------------ webview -> host ------------------------------ */

export type ViewMessage =
  | { type: "ready" }
  | { type: "sendPrompt"; payload: { text: string; attachments?: Attachment[] } }
  | { type: "cancel" }
  | { type: "setModel"; payload: { model: string } }
  | { type: "setMode"; payload: { mode: Mode } }
  | { type: "newSession" }
  | { type: "switchSession"; payload: { id: string } }
  | { type: "deleteSession"; payload: { id: string } }
  | { type: "refreshModels" }
  | { type: "toolApproval"; payload: { callId: string; approved: boolean; remember?: boolean } }
  | { type: "setContextWindow"; payload: { numCtx: number } }
  | { type: "setAutoApprove"; payload: { enabled: boolean } }
  | { type: "setAdaptiveEnabled"; payload: { enabled: boolean } }
  | { type: "setIntelligence"; payload: { level: IntelligenceSetting } }
  | { type: "setWebSearchProvider"; payload: { provider: "duckduckgo" | "none" } }
  // Cloud model providers: toggle enable / store an API key.
  | { type: "setProviderEnabled"; payload: { id: string; enabled: boolean } }
  | { type: "setProviderApiKey"; payload: { id: string; apiKey: string } }
  // Switch between the local (Ollama) and cloud (direct API) engine stacks.
  | { type: "setInterfaceMode"; payload: { mode: "local" | "cloud" } }
  // Auto Mode (M8/M12): turn per-request model selection on, or pin a model for the project.
  | { type: "setAutoSelect"; payload: { enabled: boolean } }
  | { type: "pinModel"; payload: { model: string } }
  // Photon Bench (M7): (re)run the benchmark for one model or all detected models.
  | { type: "runBench"; payload: { model?: string } }
  // Workspace indexing (M10).
  | { type: "setIndexingEnabled"; payload: { enabled: boolean } }
  | { type: "reindex" }
  // MCP server management (M11).
  | { type: "approveMcpServer"; payload: { id: string } }
  | { type: "revokeMcpServer"; payload: { id: string } }
  // Dynamic cloud provider model listing.
  | { type: "fetchProviderModels"; payload: { id: string } }
  // Model connectivity test (sends a minimal completion request).
  | { type: "testModel"; payload: { providerId: string; model: ModelInfo } }
  // Add a tested/validated cloud model to the header model picker.
  | { type: "addAvailableModel"; payload: { providerId: string; model: ModelInfo } }
  // Remove a previously added cloud model from the picker.
  | { type: "removeAvailableModel"; payload: { name: string } }
  // Register a custom OpenAI-compatible endpoint from the settings UI.
  | { type: "addCustomProvider"; payload: { label: string; baseUrl: string; apiKey?: string } }
  | { type: "removeCustomProvider"; payload: { id: string } }
  | { type: "openDiagnostics" }
  | { type: "setPerModelConfig"; payload: { model: string; config: import("./types").PerModelConfig } }
  | { type: "removePerModelConfig"; payload: { model: string } };
