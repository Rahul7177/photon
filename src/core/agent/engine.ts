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
  toolContext: (signal: AbortSignal) => ToolContext;
  workspaceName: string | undefined;
  workspaceMap: () => Promise<string | undefined>;
  retrieveContext?: (query: string, signal: AbortSignal) => Promise<string | undefined>;
  reserveOutputTokens: number;
}

/**
 * Local AgentEngine — delegates directly to the unified engine loop.
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
    return runUnifiedTurn(session, plan, emitter, signal, {
      provider: d.client,
      tools: d.registry.all(),
      workspaceName: d.workspaceName,
      workspaceMap: d.workspaceMap,
      retrieveContext: d.retrieveContext,
      buildToolContext: d.toolContext,
      reserveOutputTokens: d.reserveOutputTokens,
    });
  }
}
