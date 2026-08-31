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
  ThinkingSetting,
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
  | { type: "decision"; payload: AutoDecision }
  | { type: "benchStatus"; payload: { model: string; phase: BenchPhase; message?: string } }
  | { type: "benchResults"; payload: BenchResult[] }
  | { type: "indexStatus"; payload: IndexStatus }
  | { type: "mcpServers"; payload: McpServerInfo[] }
  | { type: "tools"; payload: ToolSummary[] }
  | { type: "providerModels"; payload: { id: string; models: ModelInfo[]; error?: string } }
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
  autoSelectModel: boolean;
  indexingEnabled: boolean;
  embeddingModel: string;
  providers: ProviderStatus[];
  interfaceMode: "local" | "cloud";
  /** Auto or explicit Photon reasoning control for the selected model. */
  thinkingLevel: ThinkingSetting;
}

export interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  modelCount: number;
}
export interface ToolSummary { name: string; summary: string; sideEffecting: boolean; }
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
  | { type: "setProviderEnabled"; payload: { id: string; enabled: boolean } }
  | { type: "setProviderApiKey"; payload: { id: string; apiKey: string } }
  | { type: "setInterfaceMode"; payload: { mode: "local" | "cloud" } }
  | { type: "setAutoSelect"; payload: { enabled: boolean } }
  | { type: "pinModel"; payload: { model: string } }
  | { type: "runBench"; payload: { model?: string } }
  | { type: "setIndexingEnabled"; payload: { enabled: boolean } }
  | { type: "reindex" }
  | { type: "approveMcpServer"; payload: { id: string } }
  | { type: "revokeMcpServer"; payload: { id: string } }
  | { type: "fetchProviderModels"; payload: { id: string } }
  | { type: "testModel"; payload: { providerId: string; model: ModelInfo } }
  | { type: "addAvailableModel"; payload: { providerId: string; model: ModelInfo } }
  | { type: "removeAvailableModel"; payload: { name: string } }
  | { type: "addCustomProvider"; payload: { label: string; baseUrl: string; apiKey?: string } }
  | { type: "removeCustomProvider"; payload: { id: string } }
  | { type: "openDiagnostics" }
  | { type: "setPerModelConfig"; payload: { model: string; config: import("./types").PerModelConfig } }
  | { type: "removePerModelConfig"; payload: { model: string } }
  | { type: "setThinkingEnabled"; payload: { enabled: boolean } }
  | { type: "setThinkingLevel"; payload: { level: ThinkingSetting } };
