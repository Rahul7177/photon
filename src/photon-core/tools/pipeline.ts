import type { Tool, ToolContext, ToolResult } from "../../core/tools/types";
import type { ToolCall } from "../../shared/types";

// Harness parity: tools/pre-execute (policy) -> tools/execute -> tools/post-execute
export type ToolPreExecuteEvent = { call: ToolCall; tool: Tool; cancel?: (reason: string) => void };
export type ToolPostExecuteEvent = { call: ToolCall; result: ToolResult };

export class ToolPipeline {
  private tools = new Map<string, Tool>();
  private preListeners: Set<(e: ToolPreExecuteEvent, next: () => Promise<void>) => Promise<void>> = new Set();
  private postListeners: Set<(e: ToolPostExecuteEvent) => void> = new Set();

  register(tool: Tool): () => void {
    this.tools.set(tool.spec.name, tool);
    return () => this.tools.delete(tool.spec.name);
  }
  registerAll(tools: Tool[]): void { for (const t of tools) this.register(t); }
  get(name: string) { return this.tools.get(name); }
  all(): Tool[] { return [...this.tools.values()]; }
  specs() { return [...this.tools.values()].map(t => t.spec); }

  onPreExecute(fn: (e: ToolPreExecuteEvent, next: () => Promise<void>) => Promise<void>): () => void {
    this.preListeners.add(fn); return () => this.preListeners.delete(fn);
  }
  onPostExecute(fn: (e: ToolPostExecuteEvent) => void): () => void {
    this.postListeners.add(fn); return () => this.postListeners.delete(fn);
  }

  specsForPlan(plan: import("../../shared/types").AdaptivePlan): import("../../shared/types").ToolSpec[] {
    if (plan.mode === "chat") return [];
    const TIER_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, max: 3 };
    let specs = this.specs();
    if (plan.mode === "plan") specs = specs.filter(s => !s.sideEffecting);
    const rank = TIER_RANK[plan.intelligence] ?? 0;
    return specs.filter(s => (TIER_RANK[s.minTier ?? "low"] ?? 0) <= rank).sort((a,b)=>a.priority-b.priority).slice(0, plan.maxTools);
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) return { ok: false, output: `Unknown tool "${call.name}".` };
    // pre-execute waterfall — must call next() to delegate (harness rule)
    let cancelled: string | undefined;
    const preEvent: ToolPreExecuteEvent = { call, tool, cancel: (r) => cancelled = r };
    for (const fn of this.preListeners) {
      let nextCalled = false;
      await fn(preEvent, async () => { nextCalled = true; });
      if (!nextCalled) { cancelled ??= "blocked by policy"; break; }
      if (cancelled) break;
    }
    if (cancelled) return { ok: false, output: cancelled };
    let result: ToolResult;
    try { result = await tool.execute(call.args, ctx); } catch (e) { result = { ok: false, output: (e as Error).message }; }
    for (const fn of this.postListeners) fn({ call, result });
    return result;
  }
}
