// Typed message protocol between the extension host and the webview.
// `Host*` messages flow host -> webview; `View*` messages flow webview -> host.

import type {
  AdaptivePlan,
  Attachment,
  AutoDecision,
  BenchPhase,
  BenchResult,
  ChatMessage,
  CloudUsageSummary,
  GenerationStats,
  HardwareMetrics,
  IndexStatus,
  IntelligenceSetting,
  MachineProfile,
  McpServerInfo,
  Mode,
  ModelInfo,
  OllamaRuntimeModel,
  PullProgress,
  LocalRuntimeInfo,
  ProviderLifecycleState,
  ModelCapability,
  RecommendationSet,
  PerModelConfig,
  ProjectContextSummary,
  ProjectMemoryNote,
  SessionState,
  SessionSummary,
  ThinkingSetting,
  ThinkingLevel,
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
  | { type: "thinkingDelta"; payload: { id: string; delta: string } }
  | { type: "thinkingDone"; payload: { id: string; elapsedMs: number } }
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
  | { type: "attachmentsAdded"; payload: { attachments: Attachment[]; errors: string[] } }
  | { type: "providerModels"; payload: { id: string; models: ModelInfo[]; error?: string } }
  | { type: "modelTestResult"; payload: { providerId: string; model: ModelInfo; ok: boolean; latencyMs?: number; error?: string } }
  | { type: "modelConfigs"; payload: Record<string, PerModelConfig> }
  | { type: "ollamaRuntime"; payload: OllamaRuntimeModel[] }
  | { type: "hardwareMetrics"; payload: HardwareMetrics }
  | { type: "cloudUsage"; payload: CloudUsageSummary }
  | { type: "pullProgress"; payload: PullProgress | null }
  | { type: "providerRuntimes"; payload: LocalRuntimeInfo[] }
  | { type: "providerLifecycle"; payload: ProviderLifecycleState }
  | { type: "modelRecommendations"; payload: RecommendationSet }
  | { type: "projectContext"; payload: ProjectContextSummary }
  | { type: "contextCompacted"; payload: { tokensSaved: number; pctSaved: number; totalTokens: number; window: number } }
  | { type: "compactingStatus"; payload: { active: boolean } }
  | {
      type: "checkpointRollbackDone";
      payload: {
        checkpointId: string;
        revertedFiles: string[];
        deletedFiles: string[];
        rewindChat: boolean;
        restoredPrompt?: string;
        messages?: ChatMessage[];
        checkpoints?: CheckpointSummary[];
      };
    }
  | { type: "checkpointsList"; payload: { checkpoints: CheckpointSummary[] } }
  | { type: "openRevertModal"; payload?: { checkpoints?: CheckpointSummary[] } }
  | { type: "error"; payload: { message: string } };

export interface CheckpointSummary {
  id: string;
  checkpointNumber: number;
  timestamp: number;
  label: string;
  filesCount: number;
  files: string[];
  messageId: string;
}

export interface PhotonConfig {
  autoApprove: boolean;
  adaptiveEnabled: boolean;
  webSearchProvider: "google" | "duckduckgo" | "none";
  ollamaBaseUrl: string;
  llamacppBaseUrl: string;
  numCtxOverride: number;
  intelligence: IntelligenceSetting;
  autoSelectModel: boolean;
  indexingEnabled: boolean;
  embeddingModel: string;
  providers: ProviderStatus[];
  interfaceMode: "local" | "cloud";
  /** User-facing reasoning control. Auto leaves the model/provider default policy unchanged. */
  thinkingLevel: ThinkingSetting;
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
  ollamaRuntime?: OllamaRuntimeModel[];
  hardwareMetrics?: HardwareMetrics | null;
  cloudUsage?: CloudUsageSummary;
  projectContext?: ProjectContextSummary | null;
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
  | { type: "setWebSearchProvider"; payload: { provider: "google" | "duckduckgo" | "none" } }
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
  /** Files dragged in from VS Code's Explorer arrive as URIs, not File objects. */
  | { type: "attachPaths"; payload: { paths: string[] } }
  | { type: "setPerModelConfig"; payload: { model: string; config: PerModelConfig } }
  | { type: "removePerModelConfig"; payload: { model: string } }
  /** Legacy toggle retained for compatibility with existing settings clients. */
  | { type: "setThinkingEnabled"; payload: { enabled: boolean } }
  /** Legacy 4-level control retained for compatibility. */
  | { type: "setThinkingLevel"; payload: { level: ThinkingLevel } }
  /** Full six-state control used by the current header. */
  | { type: "setThinkingSetting"; payload: { level: ThinkingSetting } }
  | { type: "unloadModel"; payload: { model?: string } }
  | { type: "pullModel"; payload: { model: string } }
  | { type: "cancelPull" }
  | { type: "detectProviders" }
  | { type: "requestRecommendations"; payload?: { goal?: ModelCapability; ctxTokens?: number } }
  | { type: "startProvider"; payload: { id: "ollama" | "llamacpp"; modelPath?: string } }
  | { type: "stopProvider"; payload: { id: "ollama" | "llamacpp" } }
  | { type: "restartProvider"; payload: { id: "ollama" | "llamacpp" } }
  | { type: "installProvider"; payload: { id: LocalRuntimeInfo["id"]; optionIndex: number } }
  | { type: "requestHardwareMetrics" }
  | { type: "resetCloudUsage" }
  | { type: "requestProjectContext" }
  | { type: "refreshProjectContext" }
  | { type: "addProjectNote"; payload: { category: ProjectMemoryNote["category"]; title: string; content: string; relatedFiles?: string[] } }
  | { type: "deleteProjectNote"; payload: { id: string } }
  | { type: "clearWorkingMemory" }
  | { type: "compactContext"; payload?: { focus?: string } }
  | { type: "rollbackCheckpoint"; payload: { checkpointId: string; rewindChat?: boolean } }
  | { type: "getCheckpoints"; payload?: { sessionId?: string } }
  | { type: "revertToNumber"; payload: { checkpointNumber: number } };
