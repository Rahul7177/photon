import type { AdaptivePlan, SessionState, ToolCall } from "../../shared/types";
import type { LLMProvider } from "../llm/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { runUnifiedTurn } from "./unifiedEngine";

export interface TurnEmitter {
  onAssistantStart(messageId: string): void;
  onDelta(messageId: string, delta: string): void;
  onThinkingDelta?(messageId: string, delta: string): void;
  onThinkingEnd?(messageId: string, elapsedMs: number): void;
  onContent(messageId: string, content: string): void;
  onAssistantCancel(messageId: string): void;
  onPhase(phase: "thinking" | "working", detail?: string): void;
  onToolCall(messageId: string, call: ToolCall): void;
  onToolUpdate(messageId: string, call: ToolCall): void;
  onUsage(usage: import("../../shared/types").TokenUsage): void;
  onGenerationStats(stats: import("../../shared/types").GenerationStats | null): void;
  onDone(messageId: string, notice?: string): void;
  onError(message: string): void;
}

export interface EngineDeps {
  client: LLMProvider;
  registry: ToolRegistry;
  toolContext: (
    signal: AbortSignal,
    turnContext?: { sessionId?: string; messageId?: string }
  ) => ToolContext;
  workspaceName: string | undefined;
  workspaceMap: () => Promise<string | undefined>;
  retrieveContext?: (query: string, signal: AbortSignal) => Promise<string | undefined>;
  reserveOutputTokens: number;
}

/**
 * Canonical Agent Execution Architecture (P1 Item 5):
 *
 * Photon routes every user prompt through `PhotonController.runPrompt()`, which executes:
 *  1. Adaptive / Cloud Plan Resolution (`planRequest` or `cloudPlan`).
 *  2. Automatic Context Compaction check (`shouldAutoCompact` at 75% of active model's context limit).
 *  3. Checkpoint Turn Initialization (`CheckpointManager.beginTurn`).
 *  4. Engine Dispatch based on `interfaceMode`:
 *     - Local Mode (`interfaceMode === "local"`):
 *       `AgentEngine.runTurn()` -> `runUnifiedTurn()` (`./unifiedEngine.ts`).
 *       Uses `ToolPipeline` (`../../photon-core/tools/pipeline.ts`), adaptive context fitting (`fitToWindow`),
 *       dual tool protocol support (`photon-block` and `native`), bounded repair/narration nudges,
 *       and sequential tool-call draining for smaller local models.
 *     - Cloud Mode (`interfaceMode === "cloud"`):
 *       `PhotonController.runCloudTurn()` -> `runCloudTurn()` (`./cloudEngine.ts`).
 *       Purpose-built for frontier cloud APIs with native function calling, parallel read-only tool waves,
 *       industry tool-name aliasing (`normalizeCloudToolCall`), stale tool-output deduplication
 *       (`compactCloudHistory`), and exact provider token/cache accounting.
 *  5. Post-Turn Finalization:
 *     Stream state cleanup (`streaming = false`), cross-model handoff (`ProjectContextManager.recordTurnHandoff`),
 *     checkpoint commit (`CheckpointManager.commitTurn`), and session persistence.
 */
export class AgentEngine {
  constructor(private deps: EngineDeps) {}

  async runTurn(
    session: SessionState,
    plan: AdaptivePlan,
    emitter: TurnEmitter,
    signal: AbortSignal
  ): Promise<void> {
    const d = this.deps;
    const lastUserMsg = [...session.messages].reverse().find((m) => m.role === "user");
    const turnContext = { sessionId: session.id, messageId: lastUserMsg?.id || "" };
    d.registry.lockTurn();
    try {
      return await runUnifiedTurn(session, plan, emitter, signal, {
        provider: d.client,
        tools: d.registry.all(),
        workspaceName: d.workspaceName,
        workspaceMap: d.workspaceMap,
        retrieveContext: d.retrieveContext,
        buildToolContext: (sig) => d.toolContext(sig, turnContext),
        reserveOutputTokens: d.reserveOutputTokens,
      });
    } finally {
      d.registry.unlockTurn();
    }
  }
}
