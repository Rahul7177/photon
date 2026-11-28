// Photon Orchestration Engine — public API (Module 6).
//
// This is the single entry point every front-end (the VS Code extension today; a
// CLI or JetBrains/Neovim port later) imports. Nothing here depends on `vscode`,
// so the engine stays portable. Consumers should import from "core" (this file),
// never reach into deep module paths.

// --- Model I/O ------------------------------------------------------------
export { OllamaClient, OllamaError, type OllamaClientOptions } from "./ollama/client";
export type * from "./ollama/types";

// --- Multi-provider LLM layer ---------------------------------------------
export type {
  LLMProvider,
  LLMMessage,
  LLMChatRequest,
  LLMChatChunk,
  LLMChatOptions,
  LLMToolCall,
  ProviderModel,
} from "./llm/types";
export { ProviderManager } from "./llm/providerManager";
export { OllamaProvider } from "./llm/providers/ollamaProvider";
export { OpenAICompatProvider, type OpenAICompatConfig } from "./llm/providers/openaiCompatProvider";
export { GeminiProvider, type GeminiConfig } from "./llm/providers/geminiProvider";
export { AnthropicProvider, type AnthropicConfig } from "./llm/providers/anthropicProvider";
export {
  BLACKBOX_MODELS,
  customModel,
} from "./llm/catalogs";

// --- Adaptive orchestration + Auto Mode (M8) ------------------------------
export {
  analyzeTask,
  extractFileReferences,
  isContinuationPrompt,
  isFreshInfoRequest,
  toComplexity,
  capabilityForModel,
  shouldUseNativeToolProtocol,
  buildExecutionPolicy,
  buildVerificationPlan,
  selectToolSpecs,
  rankTools,
  inferStepPhase,
} from "./intelligence/policy";
export { buildPlan, deriveScaffoldProfile, type OrchestratorInput } from "./adaptive/orchestrator";
export { classifyComplexity, type ComplexityInput } from "./adaptive/complexity";
export {
  planRequest,
  decideModel,
  rankModels,
  selectFallbackModel,
  type AutoModeInput,
  type PlanRequest,
} from "./adaptive/autoMode";
export {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "./adaptive/tokens";
export { profileMachine, sampleHardwareMetrics } from "./adaptive/machineProfiler";
export { profileModel } from "./adaptive/modelProfiler";
export {
  MODEL_CATALOG,
  hardwareFromProfile,
  hardwareTier,
  memoryRequiredGb,
  findMatchingBenchmark,
  validatePredictionAgainstRuntime,
  assessFit,
  summarizeHardware,
  evaluateInstalledLocalModels,
  recommendModels,
  recommendModelForTask,
  evaluateBackgroundBenchGuard,
  type LiveObservation,
  type FitPredictOptions,
  type RecommendOptions,
  type TaskRecommendOptions,
  type BackgroundBenchGuardInput,
} from "./adaptive/modelAdvisor";
export {
  ReliabilityGovernor,
  countDiagnosticErrors,
  type GovernorAction,
  type GovernorInit,
} from "./adaptive/governor";
export {
  passportKey,
  updatePassport,
  passportWeight,
  blendCapabilitiesWithPassport,
  suggestedInitialRung,
  passportNativeUnreliable,
  PASSPORT_SHRINKAGE_K,
  PASSPORT_MAX_EVIDENCE_PER_TURN,
  type PassportEntry,
  type PassportIdentity,
} from "./adaptive/passport";
export { buildStepStateCard, type StateCardInput } from "./adaptive/stateCard";
export { CloudUsageTracker, estimateCloudCost, getModelPricing, computeCacheHitRate, type CloudPricing } from "./telemetry/cloudUsage";

// --- Agent turn loop (M9 repair) ------------------------------------------
export { AgentEngine, type EngineDeps, type TurnEmitter } from "./agent/engine";
export {
  classifyRuntimeError,
  formatNativeToolOutcome,
  type ClassifiedRuntimeError,
  type RuntimeErrorCategory,
} from "./agent/errorRecovery";
export { runCloudTurn, cloudHistoryFromSession, normalizeCloudToolCall, type CloudEmitter, type CloudTurnInput } from "./agent/cloudEngine";
export { cloudTools } from "./tools/cloud/cloudTools";
export { buildCloudSystemPrompt, buildCloudSystemPromptWithReport, type CloudSystemInput } from "./prompts/cloudSystem";
export { fitToWindow, type FitResult } from "./agent/contextManager";
export {
  compactSessionMessages,
  compactMidTurnLLMHistory,
  shouldAutoCompact,
  extractCompactionCandidates,
  extractStructuredCompactionData,
  buildNativeCompactionSummary,
  summarizeWithProviderModel,
  isToolResultMessage,
  isUsableProviderSummary,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  MIN_MESSAGES_FOR_COMPACTION,
  type CompactionResult,
  type CompactionOptions,
  type CompactionPressureOptions,
  type MidTurnCompactionOptions,
  type MidTurnCompactionResult,
  type CompactionCandidateSet,
  type CompactionRetainedItems,
  type StructuredCompactionData,
} from "./agent/compactor";
export {
  CheckpointManager,
  getCheckpointManager,
  type Checkpoint,
  type FileSnapshot,
  type CheckpointRollbackResult,
  type FileRollbackStatus,
  type FileRollbackResult,
  type RollbackOptions,
} from "./checkpoints/checkpointManager";
export { buildRepairPrompt, MAX_REPAIRS } from "./agent/repair";

// --- Capability profiler / Photon Bench (M7) ------------------------------
export {
  runBench,
  evaluateCodingPatchOutput,
  compareRoutingVsBaseline,
  BENCH_VERSION,
  BENCH_TOOLCALL_SAMPLES,
  type BenchOptions,
  type CodingOutcomeMetrics,
  type RoutingEvalOutcome,
  type RoutingComparisonReport,
} from "./bench/bench";

// --- Workspace indexing (M10) ---------------------------------------------
export {
  WorkspaceIndex,
  shouldIndexFile,
  evaluateRetrieval,
  MAX_INDEXABLE_FILE_BYTES,
  type RetrievalEvalCase,
  type RetrievalEvalReport,
} from "./index/indexer";
export { VectorStore } from "./index/vectorStore";
export { chunkText } from "./index/chunker";
export type { Chunk, IndexedChunk, RetrievedChunk, EmbedFn } from "./index/types";

// --- Tools + MCP (M11) -----------------------------------------------------
export { ToolRegistry } from "./tools/registry";
export { builtinTools } from "./tools/builtin";
export {
  McpManager,
  MCP_PREFIX,
  type McpServerConfig,
  type McpToolPermission,
  type McpServerPermissions,
  type McpAuditEntry,
} from "./tools/mcp/bridge";
export {
  validateRemoteEndpoint,
  isPrivateOrProhibitedIp,
  isSafeRemoteHostname,
  type EndpointValidationResult,
} from "./tools/mcp/dnsValidator";
export type { ToolContext, Tool, ToolResult } from "./tools/types";

// --- Prompt + protocol -----------------------------------------------------
export { buildSystemPrompt, buildSystemPromptWithReport, type SystemPromptInput } from "./prompts/system";
export {
  CORE_PROMPT_RULES,
  editFilePatchParamNames,
  selectDeduplicatedRules,
  toolRequiredSignature,
  type PromptRule,
  type PromptSectionId,
  type RuleRenderContext,
} from "./prompts/rulebook";
export {
  parsePhotonBlocks,
  validateAgainstSpec,
  stripToolMarkup,
} from "./protocol/parse";
export {
  renderToolInstructions,
  renderToolInstructionsWithMeta,
  renderToolResult,
  toNativeTools,
  type ToolInstructionsRenderResult,
} from "./protocol/serialize";
