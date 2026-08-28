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
export { buildPlan, type OrchestratorInput } from "./adaptive/orchestrator";
export { classifyComplexity, type ComplexityInput } from "./adaptive/complexity";
export {
  planRequest,
  decideModel,
  rankModels,
  type AutoModeInput,
  type PlanRequest,
} from "./adaptive/autoMode";
export {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "./adaptive/tokens";
export { profileMachine } from "./adaptive/machineProfiler";
export { profileModel } from "./adaptive/modelProfiler";

// --- Agent turn loop (M9 repair) ------------------------------------------
export { AgentEngine, type EngineDeps, type TurnEmitter } from "./agent/engine";
export { runCloudTurn, cloudHistoryFromSession, type CloudEmitter, type CloudTurnInput } from "./agent/cloudEngine";
export { cloudTools } from "./tools/cloud/cloudTools";
export { buildCloudSystemPrompt, type CloudSystemInput } from "./prompts/cloudSystem";
export { fitToWindow, type FitResult } from "./agent/contextManager";
export { buildRepairPrompt, MAX_REPAIRS } from "./agent/repair";

// --- Capability profiler / Photon Bench (M7) ------------------------------
export { runBench, BENCH_VERSION, type BenchOptions } from "./bench/bench";

// --- Workspace indexing (M10) ---------------------------------------------
export { WorkspaceIndex } from "./index/indexer";
export { VectorStore } from "./index/vectorStore";
export { chunkText } from "./index/chunker";
export type { Chunk, IndexedChunk, RetrievedChunk, EmbedFn } from "./index/types";

// --- Tools + MCP (M11) -----------------------------------------------------
export { ToolRegistry } from "./tools/registry";
export { builtinTools } from "./tools/builtin";
export { McpManager, MCP_PREFIX, type McpServerConfig } from "./tools/mcp/bridge";
export type { ToolContext, Tool, ToolResult } from "./tools/types";

// --- Prompt + protocol -----------------------------------------------------
export { buildSystemPrompt, type SystemPromptInput } from "./prompts/system";
export {
  parsePhotonBlocks,
  validateAgainstSpec,
  stripToolMarkup,
} from "./protocol/parse";
export {
  renderToolInstructions,
  renderToolResult,
  toNativeTools,
} from "./protocol/serialize";
