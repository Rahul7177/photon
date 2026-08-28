import type { IntelligenceLevel, ToolCall, ToolSpec } from "../../shared/types";

export interface ToolResult {
  ok: boolean;
  /** Text fed back to the model. Keep it compact — context is scarce. */
  output: string;
}

/** One VS Code problem (error/warning) surfaced to the model for verification. */
export interface DiagnosticInfo {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
}

/** One entry of the agent's task checklist (todo_write tool). */
export interface TodoItem {
  status: "pending" | "in_progress" | "done";
  text: string;
}

export interface ToolContext {
  /** Absolute fs path of the first workspace folder, or undefined if none. */
  workspaceRoot: string | undefined;
  /** Ask the user to approve a side-effecting call. */
  requestApproval: (call: ToolCall) => Promise<boolean>;
  /** Cancels when the user hits stop. */
  signal: AbortSignal;
  /** Structured logging to the Photon output channel. */
  log: (msg: string) => void;
  /** Web search provider setting. */
  webSearchProvider: "duckduckgo" | "none";
  /**
   * Fast filename search backed by the editor's native index (ripgrep). Accepts
   * either a plain substring ("button") or a glob pattern (e.g. a "**" prefix
   * with "*.test.ts"). Returns workspace-relative paths.
   */
  findFiles: (query: string, maxResults: number) => Promise<string[]>;
  /**
   * Coarse capability of the ACTIVE model. Tools scale their output budgets
   * with it: weak models get tight clamps to protect their context window,
   * strong/cloud models get generous limits so results are never needlessly
   * truncated. This is the main lever that keeps one tool set optimal for both.
   */
  capability: IntelligenceLevel;
  /** Current problems (compile/lint errors) from the editor, optionally for one file. */
  getDiagnostics: (path?: string) => Promise<DiagnosticInfo[]>;
  /** Per-turn task checklist shared across calls (mutated by todo_write). */
  todos: TodoItem[];
}

/** Character budget for tool output at each capability level. */
const OUTPUT_BUDGET: Record<IntelligenceLevel, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  max: 32000,
};

/** The clamp limit appropriate for this turn's model. */
export function outputBudget(ctx: ToolContext): number {
  return OUTPUT_BUDGET[ctx.capability] ?? 6000;
}

export interface Tool {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(output: string): ToolResult {
  return { ok: true, output };
}
export function fail(output: string): ToolResult {
  return { ok: false, output };
}

/**
 * Cap tool output so a chatty command can't blow the context window. Callers
 * should pass `outputBudget(ctx)` instead of a hardcoded number so capable
 * models see more of the world than tiny ones.
 */
export function clamp(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  return `${head}\n… [truncated ${text.length - maxChars} more characters]`;
}
