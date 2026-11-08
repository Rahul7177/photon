import type { AdaptivePlan, ToolSpec } from "../../shared/types";
import { selectToolSpecs } from "../intelligence/policy";
import { BUILTIN_TOOL_NAMES, type Tool } from "./types";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private turnLocked = false;

  lockTurn(): void {
    this.turnLocked = true;
  }

  unlockTurn(): void {
    this.turnLocked = false;
  }

  isTurnLocked(): boolean {
    return this.turnLocked;
  }

  register(tool: Tool): void {
    const name = tool?.spec?.name;
    if (!name) {
      throw new Error("Cannot register a tool without a valid name.");
    }
    if (this.turnLocked && this.tools.has(name)) {
      throw new Error(`Cannot replace tool "${name}" during an active turn.`);
    }
    const isMcp = tool.spec.tags?.includes("mcp") || name.startsWith("mcp_");
    if (isMcp && BUILTIN_TOOL_NAMES.has(name)) {
      throw new Error(`Cannot register MCP tool "${name}": collides with built-in tool.`);
    }
    this.tools.set(name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  unregisterByPrefix(prefix: string): void {
    if (this.turnLocked) {
      throw new Error(`Cannot unregister tools with prefix "${prefix}" during an active turn.`);
    }
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
      }
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  specsForPlan(plan: AdaptivePlan): ToolSpec[] {
    const specs = [...this.tools.values()].map((t) => t.spec);
    return selectToolSpecs(
      specs,
      plan,
      plan.mode === "plan" ? "orient" : plan.mode === "chat" ? "final" : "orient"
    );
  }
}
