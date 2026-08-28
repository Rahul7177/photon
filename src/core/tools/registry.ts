import type { AdaptivePlan, IntelligenceLevel, ToolSpec } from "../../shared/types";
import type { Tool } from "./types";

const TIER_RANK: Record<IntelligenceLevel, number> = { low: 0, medium: 1, high: 2, max: 3 };

/**
 * Holds every available tool (built-in + MCP) and, crucially, selects a
 * model-appropriate subset. Weak models get the highest-priority tools only,
 * so their tiny context isn't buried under schemas they can't use.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.spec.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  /** Remove all tools from a given source prefix (used to refresh MCP tools). */
  unregisterByPrefix(prefix: string): void {
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) this.tools.delete(name);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** The specs exposed to the model for this plan, trimmed and mode-filtered. */
  specsForPlan(plan: AdaptivePlan): ToolSpec[] {
    // Chat mode exposes no tools — it's a pure conversation.
    if (plan.mode === "chat") return [];

    let specs = [...this.tools.values()].map((t) => t.spec);

    // Plan mode is read-only: hide side-effecting tools entirely.
    if (plan.mode === "plan") {
      specs = specs.filter((s) => !s.sideEffecting);
    }

    // Hard capability gate: never expose a tool above the model's tier, even if
    // the count cap would allow it (M4 — small models degrade on tools they
    // can't drive). Then order by priority and cap the count.
    const modelRank = TIER_RANK[plan.intelligence];
    return specs
      .filter((s) => TIER_RANK[s.minTier ?? "low"] <= modelRank)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, plan.maxTools);
  }
}
