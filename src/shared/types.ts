// Domain types shared between the extension host and the webview UI.
// Keep this file dependency-free (no vscode / node imports) so the webview can import it directly.
export type Mode="chat"|"plan"|"agent";export type Role="system"|"user"|"assistant"|"tool";
export interface ChatMessage{id:string;role:Role;content:string;toolCalls?:ToolCall[];attachments?:Attachment[];toolCallId?:string;createdAt:number;streaming?:boolean;notice?:string;hidden?:boolean;/** Model reasoning trace (display-only, collapsed once the answer streams). */thinking?:string;/** Ms spent reasoning, set when the trace completes. */thinkingElapsedMs?:number;/** Indicates this message is a context compaction digest. */isCompacted?:boolean;compactStats?:{messagesCount:number;tokensSaved:number;pctSaved:number;strategy?:string};/** Checkpoint created during this turn, allowing 1-click rollback of file changes. */checkpointId?:string;checkpointFiles?:string[];checkpointNumber?:number;}
export interface Attachment{id:string;kind:"image"|"text";name:string;mime:string;size:number;dataBase64?:string;text?:string;}
export interface ToolCall{id:string;name:string;args:Record<string,unknown>;status:"proposed"|"running"|"done"|"error"|"denied";result?:string;error?:string;statusDetail?:string;sideEffecting?:boolean;thoughtSignature?:string;risk?:ToolRisk|"critical";}
export interface ModelCapabilityProfile{reasoning:number;coding:number;toolCalling:number;schemaAdherence:number;contextRetention:number;editFidelity:number;recovery:number;verification:number;speed:number;}
export interface ModelInfo{name:string;provider?:string;paramSize?:string;paramsB?:number;quantization?:string;family?:string;contextLength?:number;sizeBytes?:number;toolTrained?:boolean;vision?:boolean;audio?:boolean;video?:boolean;thinking?:boolean;thinkingLevels?:ThinkingLevel[];capabilities?:string[];tier?:ModelTier;capabilityProfile?:ModelCapabilityProfile;}
export interface GenerationStats{tps:number;totalTokens:number;elapsedMs:number;avg?:boolean;}
export interface LlamaCppSettings{ctx?:number;ngl?:number|"all";fit?:boolean;np?:number;fa?:boolean;ctk?:string;ctv?:string;extraArgs?:string;}
export interface PerModelConfig{numCtx?:number;llamacpp?:LlamaCppSettings;sampling?:{temp?:number;topP?:number;seed?:number};note?:string;}
export type ModelTier="tiny"|"small"|"medium"|"large";export type IntelligenceLevel="low"|"medium"|"high"|"max";export type IntelligenceSetting="auto"|IntelligenceLevel;
/** User-facing reasoning control. Auto leaves the model/provider's default policy in place. */
export type ThinkingLevel="off"|"low"|"medium"|"high"|"xtrahigh";export type ThinkingSetting="auto"|ThinkingLevel;
export interface MachineProfile{totalRamBytes:number;freeRamBytes:number;cpuCores:number;cpuModel:string;platform:string;arch:string;gpu?:{name:string;vramBytes?:number;vendor?:string};tier:"low"|"mid"|"high";}
export type ToolRisk="read"|"workspace_write"|"execute"|"network"|"destructive";export type ToolConcurrency="safe_parallel"|"serial";export type ToolIdempotency="idempotent"|"stateful"|"non_idempotent";export type VerificationKind="diagnostics"|"tests"|"build"|"lint"|"runtime";
export interface JsonSchema{type?:"object"|"array"|"string"|"number"|"integer"|"boolean"|"null";description?:string;enum?:unknown[];const?:unknown;default?:unknown;properties?:Record<string,JsonSchema>;required?:string[];additionalProperties?:boolean|JsonSchema;items?:JsonSchema;anyOf?:JsonSchema[];oneOf?:JsonSchema[];nullable?:boolean;}
export interface ToolSpec{name:string;summary:string;params:ToolParam[];inputSchema?:JsonSchema;sideEffecting:boolean;priority:number;minTier?:IntelligenceLevel;tags?:string[];example?:string;risk?:ToolRisk;concurrency?:ToolConcurrency;idempotency?:ToolIdempotency;verifyAfter?:VerificationKind[];}
export interface ToolParam{name:string;type:"string"|"number"|"boolean"|"integer"|"array"|"object"|"null";required:boolean;description:string;enum?:unknown[];items?:JsonSchema;properties?:Record<string,JsonSchema>;}
export interface ExecutionPolicy{maxConcurrent:number;allowParallelReads:boolean;serializeMutations:boolean;generationBudgetTokens:number;stepBudget:number;}
export interface VerificationPlan{required:VerificationKind[];completed:VerificationKind[];evidence:string[];}
export interface TaskAnalysis{scope:"single_file"|"multi_file"|"codebase";reasoning:"low"|"medium"|"high";risk:"low"|"medium"|"high"|"destructive";verification:VerificationKind[];ambiguity:"low"|"medium"|"high";estimatedSteps:number;}
export interface AdaptivePlan{model:string;mode:Mode;contextWindow:number;numCtx:number;temperature:number;topP:number;seed?:number;maxOutputTokens:number;toolProtocol:ToolProtocol;maxTools:number;allowParallelTools:boolean;intelligence:IntelligenceLevel;intelligenceAuto:boolean;rationale:string[];task?:TaskAnalysis;modelCapabilities?:ModelCapabilityProfile;executionPolicy?:ExecutionPolicy;verification?:VerificationPlan;}
export type ToolProtocol="native"|"photon-block";
export interface SessionState{id:string;title:string;mode:Mode;model:string;messages:ChatMessage[];createdAt:number;updatedAt:number;usage?:TokenUsage;}
export interface SessionSummary{id:string;title:string;mode:Mode;model:string;updatedAt:number;messageCount:number;}
export interface TokenUsage{used:number;window:number;breakdown:{label:string;tokens:number}[];}
export type ComplexityLevel="simple"|"moderate"|"complex";
export interface ComplexitySignals{filesReferenced:number;estimatedSteps:number;keywords:string[];promptTokens:number;scope?:TaskAnalysis["scope"];reasoning?:TaskAnalysis["reasoning"];risk?:TaskAnalysis["risk"];verification?:VerificationKind[];ambiguity?:TaskAnalysis["ambiguity"];}
export interface ComplexityAssessment{level:ComplexityLevel;minContextTokens:number;signals:ComplexitySignals;task?:TaskAnalysis;}
export interface ModelScore{model:string;score:number;fits:boolean;reasons:string[];}
export interface AutoDecision{chosenModel:string;auto:boolean;pinned:boolean;complexity:ComplexityAssessment;scores:ModelScore[];reason:string;}
export type BenchTaskId="throughput"|"toolcall"|"schema"|"tool_selection"|"recovery"|"edit"|"verification"|"context"|"reasoning";
export interface BenchTaskOutcome{id:BenchTaskId;passed:boolean;detail:string;}
export interface BenchResult{model:string;quantization?:string;hardwareClass:string;methodologyVersion:number;tokensPerSec:number;firstTokenMs:number;toolCallReliability:number;reasoningPass:boolean;tasks:BenchTaskOutcome[];ranAt:number;capabilityProfile?:ModelCapabilityProfile;}
export type BenchPhase="idle"|"running"|"done"|"error";
export type IndexPhase="idle"|"indexing"|"ready"|"unavailable"|"error";
export interface IndexStatus{phase:IndexPhase;filesIndexed:number;chunks:number;pending:number;embeddingModel?:string;message?:string;}
export type McpTransport="http"|"stdio";export type McpServerStatus="pending"|"approved"|"connected"|"error"|"revoked";export interface McpServerInfo{id:string;transport:McpTransport;target:string;status:McpServerStatus;toolCount:number;message?:string;}

export interface OllamaRuntimeModel{name:string;sizeBytes:number;vramBytes:number;gpuPercent:number;contextLength:number;expiresAt?:string;}
export interface PullProgress{model:string;phase:"pulling"|"done"|"error";status:string;percent?:number;error?:string;
  /** Aggregate bytes across all layers (when known). */
  completedBytes?:number;totalBytes?:number;
  /** Rolling 1 s download rate and estimated seconds remaining. */
  bytesPerSec?:number;etaSeconds?:number;
  /** Short phase label: "Pulling manifest", "Downloading layer <id>", "Verifying sha256", … */
  stage?:string;
  /** True when clicking retry will resume from Ollama's layer cache. */
  resumable?:boolean;}

export interface HardwareMetrics{gpuName?:string;gpuUtilPercent?:number;vramUsedBytes?:number;vramTotalBytes?:number;vramFreeBytes?:number;gpuTempC?:number;ramUsedBytes:number;ramTotalBytes:number;ramFreeBytes:number;ramUsedPercent:number;updatedAt:number;}
export interface CloudModelUsage{model:string;turns:number;inputTokens:number;outputTokens:number;cachedTokens:number;savedTokens:number;estimatedCostUsd:number;}
export interface CloudUsageSummary{sessionInputTokens:number;sessionOutputTokens:number;sessionCachedTokens:number;sessionSavedTokens:number;sessionEstimatedCostUsd:number;totalInputTokens:number;totalOutputTokens:number;totalCachedTokens:number;totalSavedTokens:number;totalEstimatedCostUsd:number;byModel:CloudModelUsage[];}
export interface ProjectMemoryNote{id:string;category:"architecture"|"convention"|"decision"|"task"|"gotcha";title:string;content:string;relatedFiles?:string[];createdBy:string;updatedAt:number;}
export interface ModelHandoffRecord{fromModel:string;toModel?:string;timestamp:number;taskSummary:string;activeFiles:string[];recentEdits:{path:string;summary:string;timestamp:number}[];pendingTodos:string[];keyFindings:string[];}
export interface ProjectContextSummary{workspaceName:string;totalFiles:number;totalSymbols:number;totalLines:number;lastUpdatedAt:number;languages:string[];frameworks:string[];scripts:Record<string,string>;entryPoints:string[];topDirectories:{path:string;fileCount:number;purpose:string}[];recentFiles:{path:string;summary:string;lineCount:number;symbolCount:number;lastAction:"read"|"edited"|"indexed";timestamp:number}[];notes:ProjectMemoryNote[];latestHandoff:ModelHandoffRecord|null;estimatedTokensSaved:number;queryHits:number;}

/* ---------------- Local LLM lifecycle (detection + process control) ---------------- */
export type LocalRuntimeId = "ollama" | "llamacpp" | "lmstudio" | "vllm";
export type LocalRuntimeState = "running" | "installed_stopped" | "not_installed" | "port_conflict";
export interface PortOwner { pid: number; processName?: string; }
export interface LocalRuntimeInfo {
  id: LocalRuntimeId;
  label: string;
  state: LocalRuntimeState;
  port: number;
  baseUrl: string;
  /** Absolute path to the detected binary / app, if any. */
  binaryPath?: string;
  /** Version reported by the daemon (Ollama only), if running. */
  version?: string;
  /** Process holding the port when state === "port_conflict". */
  portOwner?: PortOwner;
  /** Human-readable explanation for the UI. */
  message?: string;
  /** One-click install choices when state === "not_installed". */
  installOptions?: InstallOption[];
}
/** Lifecycle state of a provider daemon Photon is (or was asked to be) managing. */
export type ProviderLifecyclePhase = "stopped" | "starting" | "running" | "stopping" | "error";
export interface ProviderLifecycleState {
  id: LocalRuntimeId;
  phase: ProviderLifecyclePhase;
  message?: string;
  /** Last stdout/stderr lines of the spawned daemon (for the troubleshooting UI). */
  logs?: string[];
  /** True when Photon spawned the daemon and can stop it. */
  managed?: boolean;
  pid?: number;
}
export interface InstallOption {
  label: string;
  kind: "terminal" | "url";
  /** Shell command (kind=terminal) or URL (kind=url). */
  value: string;
}

/* ---------------- Hardware-aware model advisor ---------------- */
export type ModelCapability = "coding" | "reasoning" | "multimodal" | "autocomplete";
export interface FitAssessment {
  mode: "gpu" | "hybrid" | "cpu" | "exceeds";
  badge: "green" | "yellow" | "red";
  /** Weights + KV cache at the assessed context, GB. */
  memRequiredGb: number;
  gpuGb: number;
  ramGb: number;
  tokPerSec?: number;
  /** Human-readable badge text (no emoji). */
  label: string;
}
export interface HardwareSummary {
  totalRamGb: number;
  freeRamGb: number;
  ramBufferGb: number;
  vramGb: number;
  gpuName?: string;
  gpuVendor?: string;
  cpuCores: number;
  tier: "light" | "sweet" | "high";
  label: string;
}
export interface ModelRecommendation {
  name: string;
  label: string;
  sizeGb: number;
  blurb: string;
  capabilities: ModelCapability[];
  tier: "light" | "sweet" | "high";
  fit: FitAssessment;
  installed: boolean;
  recommended: boolean;
  quality: number;
}
export interface RecommendationSet {
  hardware: HardwareSummary;
  goal: ModelCapability;
  ctxTokens: number;
  models: ModelRecommendation[];
  recommendedName?: string;
  headline: string;
}
