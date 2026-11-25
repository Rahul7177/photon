// Typed message protocol between the extension host and the webview.
// `Host*` messages flow host -> webview; `View*` messages flow webview -> host.

export const PROTOCOL_VERSION = "1.0.0";

export interface ProtocolMetadata {
  version?: string;
  requestId?: string;
  timestamp?: number;
}

import type {
  AdaptivePlan,
  Attachment,
  AutoDecision,
  BenchPhase,
  BenchResult,
  ChatMessage,
  CloudUsageSummary,
  CustomizationsSnapshot,
  CustomizationScope,
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
  LocalRuntimeId,
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
  | { type: "queuedTools"; payload: ToolCall[] }
  | { type: "toolApprovalRequest"; payload: { messageId: string; call: ToolCall } }
  | { type: "tokenUsage"; payload: TokenUsage }
  | { type: "generationStats"; payload: GenerationStats | null }
  | { type: "planUpdated"; payload: AdaptivePlan }
  | { type: "config"; payload: PhotonConfig }
  | { type: "status"; payload: { kind: "idle" | "thinking" | "running" | "error"; detail?: string } }
  | { type: "decision"; payload: AutoDecision | null }
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
  | { type: "onboardingStatus"; payload: { show: boolean } }
  | { type: "customizations"; payload: CustomizationsSnapshot }
  | { type: "error"; payload: { message: string } };

export interface CheckpointSummary {
  id: string;
  checkpointNumber: number;
  timestamp: number;
  label: string;
  filesCount: number;
  files: string[];
  messageId: string;
  hasUnrestorableFiles?: boolean;
  unrestorableFiles?: string[];
}

export interface ProjectConfigStatus {
  loaded: boolean;
  path?: string;
  relativePath?: string;
  error?: string;
  fields: string[];
  modelConfigKeys: string[];
  autoApproveIgnored?: boolean;
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
  /** Optional checked-in `.photon/config.*` summary & validation status. */
  projectConfig?: ProjectConfigStatus;
  /** Model names currently overridden by `.photon/config.json`. */
  fileModelConfigKeys?: string[];
}

export interface ProviderStatus {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  modelCount: number;
  isCustom?: boolean;
  isLocal?: boolean;
  baseUrl?: string;
  requireApiKey?: boolean;
  supportsLiveModels?: boolean;
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
  customizations?: CustomizationsSnapshot;
  showOnboarding?: boolean;
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
  | { type: "togglePinSession"; payload: { id: string } }
  | { type: "renameSession"; payload: { id: string; title: string } }
  | { type: "refreshModels" }
  | { type: "toolApproval"; payload: { callId: string; approved: boolean; remember?: boolean; toolName?: string } }
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
  | {
      type: "approveMcpServer";
      payload: {
        id: string;
        expectedFingerprint?: string;
        scope?: "persistent" | "session" | "one_time";
      };
    }
  | { type: "revokeMcpServer"; payload: { id: string } }
  | { type: "fetchProviderModels"; payload: { id: string } }
  | { type: "testModel"; payload: { providerId: string; model: ModelInfo } }
  | { type: "addAvailableModel"; payload: { providerId: string; model: ModelInfo } }
  | { type: "removeAvailableModel"; payload: { name: string } }
  | { type: "addCustomProvider"; payload: { label: string; baseUrl: string; apiKey?: string; requireApiKey?: boolean } }
  | { type: "updateCustomProvider"; payload: { id: string; label: string; baseUrl: string; apiKey?: string; clearApiKey?: boolean; requireApiKey?: boolean } }
  | { type: "removeCustomProvider"; payload: { id: string } }
  | { type: "openDiagnostics" }
  | { type: "openProjectConfig" }
  | { type: "createProjectConfig" }
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
  | {
      type: "requestRecommendations";
      payload?: {
        goal?: ModelCapability;
        ctxTokens?: number;
        taskPrompt?: string;
        runtime?: LocalRuntimeId;
        quantization?: string;
      };
    }
  | { type: "startProvider"; payload: { id: "ollama" | "llamacpp"; modelPath?: string } }
  | { type: "stopProvider"; payload: { id: "ollama" | "llamacpp" } }
  | { type: "restartProvider"; payload: { id: "ollama" | "llamacpp" } }
  | { type: "installProvider"; payload: { id: LocalRuntimeInfo["id"]; optionIndex: number } }
  | { type: "requestHardwareMetrics" }
  | { type: "resetCloudUsage" }
  | { type: "setEmbeddingModel"; payload: { model: string } }
  | { type: "requestProjectContext" }
  | { type: "refreshProjectContext" }
  | { type: "addProjectNote"; payload: { category: ProjectMemoryNote["category"]; title: string; content: string; relatedFiles?: string[] } }
  | { type: "deleteProjectNote"; payload: { id: string } }
  | { type: "clearWorkingMemory" }
  | { type: "compactContext"; payload?: { focus?: string } }
  | { type: "rollbackCheckpoint"; payload: { checkpointId: string; rewindChat?: boolean } }
  | { type: "getCheckpoints"; payload?: { sessionId?: string } }
  | { type: "revertToNumber"; payload: { checkpointNumber: number } }
  | { type: "openFile"; payload: { path: string; line?: number } }
  | { type: "completeOnboarding" }
  | { type: "openOnboarding" }
  | {
      type: "addMcpServer";
      payload: {
        scope: CustomizationScope;
        id: string;
        transport: "stdio" | "http";
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
        allowLocalNetwork?: boolean;
        connectNow?: boolean;
      };
    }
  | { type: "removeMcpServer"; payload: { id: string; scope?: CustomizationScope } }
  | { type: "openMcpConfig"; payload: { scope: CustomizationScope } }
  | {
      type: "saveSkill";
      payload: { scope: CustomizationScope; slug?: string; name: string; description: string; content: string };
    }
  | { type: "toggleSkill"; payload: { id: string; enabled: boolean } }
  | { type: "deleteSkill"; payload: { id: string } }
  | {
      type: "saveInstruction";
      payload: {
        scope: CustomizationScope;
        slug?: string;
        name: string;
        applyTo?: string;
        description?: string;
        content: string;
      };
    }
  | { type: "toggleInstruction"; payload: { id: string; enabled: boolean } }
  | { type: "deleteInstruction"; payload: { id: string } }
  | {
      type: "saveCustomAgent";
      payload: {
        scope: CustomizationScope;
        slug?: string;
        name: string;
        description: string;
        instructions: string;
        preferredMode?: Mode;
      };
    }
  | { type: "toggleCustomAgent"; payload: { id: string; enabled: boolean } }
  | { type: "deleteCustomAgent"; payload: { id: string } }
  | { type: "setActiveCustomAgent"; payload: { id: string | null } }
  | { type: "openCustomizationFile"; payload: { filePath: string } };
