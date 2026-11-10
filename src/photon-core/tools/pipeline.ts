import { BUILTIN_TOOL_NAMES, clampToolResult, type Tool, type ToolContext, type ToolResult, type ToolStatus } from "../../core/tools/types";
import type { AdaptivePlan, IntelligenceLevel, ToolCall, ToolSpec } from "../../shared/types";
import { canRunInParallel, recoveryDirective, selectToolSpecs } from "../../core/intelligence/policy";

export type ToolPreExecuteEvent = { call: ToolCall; tool: Tool; cancel?: (reason: string) => void };
export type ToolPostExecuteEvent = { call: ToolCall; result: ToolResult };

const TIER_ORDER: Record<IntelligenceLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

const ALLOWED_CHAT_TOOLS = new Set([
  "read_file",
  "list_dir",
  "find_files",
  "search_code",
  "code_outline",
  "get_diagnostics",
  "query_project_context",
  "web_search",
  "web_fetch",
  "think",
]);
const MAX_TOOL_OUTPUT_CHARS = 100_000;

function validateCallStructure(call: ToolCall): { valid: boolean; error?: string } {
  if (!call || typeof call !== "object") {
    return { valid: false, error: "Invalid tool call: expected an object." };
  }
  if (!call.id || typeof call.id !== "string" || !call.id.trim()) {
    return { valid: false, error: "Invalid tool call: missing or empty tool call id." };
  }
  if (!call.name || typeof call.name !== "string" || !call.name.trim()) {
    return { valid: false, error: "Invalid tool call: missing or empty tool name." };
  }
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
    return { valid: false, error: `Invalid arguments for tool "${call.name}": expected a JSON object.` };
  }
  return { valid: true };
}

function validateToolArgs(tool: Tool, args: Record<string, unknown>): { valid: boolean; error?: string } {
  const params = tool.spec.params ?? [];
  const requiredFromSchema = new Set(tool.spec.inputSchema?.required ?? []);

  // Check required parameters
  for (const p of params) {
    if (p.required || requiredFromSchema.has(p.name)) {
      if (args[p.name] === undefined || args[p.name] === null || args[p.name] === "") {
        return { valid: false, error: `Missing required parameter "${p.name}".` };
      }
    }
  }
  for (const req of requiredFromSchema) {
    if (args[req] === undefined || args[req] === null || args[req] === "") {
      return { valid: false, error: `Missing required parameter "${req}".` };
    }
  }

  // Check parameter types and enum constraints if value is provided
  for (const p of params) {
    const val = args[p.name];
    if (val !== undefined && val !== null) {
      switch (p.type) {
        case "string":
          if (typeof val !== "string") {
            return { valid: false, error: `Parameter "${p.name}" must be a string, got ${typeof val}.` };
          }
          break;
        case "number":
          if (typeof val !== "number" || isNaN(val)) {
            return { valid: false, error: `Parameter "${p.name}" must be a valid number.` };
          }
          break;
        case "integer":
          if (typeof val !== "number" || !Number.isInteger(val)) {
            return { valid: false, error: `Parameter "${p.name}" must be an integer.` };
          }
          break;
        case "boolean":
          if (typeof val !== "boolean") {
            return { valid: false, error: `Parameter "${p.name}" must be a boolean.` };
          }
          break;
        case "array":
          if (!Array.isArray(val)) {
            return { valid: false, error: `Parameter "${p.name}" must be an array.` };
          }
          break;
        case "object":
          if (typeof val !== "object" || Array.isArray(val)) {
            return { valid: false, error: `Parameter "${p.name}" must be an object.` };
          }
          break;
      }

      if (p.enum && p.enum.length > 0) {
        if (!p.enum.includes(val)) {
          return {
            valid: false,
            error: `Parameter "${p.name}" must be one of: ${p.enum.join(", ")}, got "${val}".`,
          };
        }
      }
    }
  }

  return { valid: true };
}

export class ToolPipeline {
  private tools = new Map<string, Tool>();
  private turnLocked = false;
  private preListeners = new Set<(e: ToolPreExecuteEvent, next: () => Promise<void>) => Promise<void>>();
  private postListeners = new Set<(e: ToolPostExecuteEvent) => void>();

  lockTurn(): void {
    this.turnLocked = true;
  }

  unlockTurn(): void {
    this.turnLocked = false;
  }

  isTurnLocked(): boolean {
    return this.turnLocked;
  }

  register(tool: Tool): () => void {
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
    return () => {
      if (this.turnLocked) {
        throw new Error(`Cannot unregister tool "${name}" during an active turn.`);
      }
      this.tools.delete(name);
    };
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  onPreExecute(fn: (e: ToolPreExecuteEvent, next: () => Promise<void>) => Promise<void>): () => void {
    this.preListeners.add(fn);
    return () => this.preListeners.delete(fn);
  }

  onPostExecute(fn: (e: ToolPostExecuteEvent) => void): () => void {
    this.postListeners.add(fn);
    return () => this.postListeners.delete(fn);
  }

  specsForPlan(plan: AdaptivePlan): ToolSpec[] {
    const phase = plan.mode === "plan" ? "orient" : plan.mode === "chat" ? "final" : "orient";
    return selectToolSpecs(this.specs(), plan, phase);
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    // 1. Validate tool call structure (schema & non-empty ID)
    const structCheck = validateCallStructure(call);
    if (!structCheck.valid) {
      return {
        ok: false,
        status: "invalid_args",
        retryable: false,
        recovery: { action: "repair" },
        output: structCheck.error!,
      };
    }

    // 2. Validate tool existence
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        ok: false,
        status: "not_found",
        retryable: false,
        recovery: { action: "repair" },
        output: `Unknown tool "${call.name}". Available tools: ${this.specs().map((s) => s.name).join(", ")}`,
      };
    }

    // 3. Execution-layer permissions enforcement
    if (tool.spec.minTier && ctx.capability) {
      const toolTier = TIER_ORDER[tool.spec.minTier] ?? 0;
      const currentTier = TIER_ORDER[ctx.capability] ?? 0;
      if (currentTier < toolTier) {
        return {
          ok: false,
          status: "permission_denied",
          retryable: false,
          recovery: { action: "ask_user" },
          output: `Tool "${call.name}" requires minimum capability "${tool.spec.minTier}", but current capability is "${ctx.capability}".`,
        };
      }
    }

    const isSideEffecting =
      tool.spec.sideEffecting ||
      tool.spec.risk === "destructive" ||
      tool.spec.risk === "execute" ||
      tool.spec.risk === "workspace_write";

    if (ctx.mode === "plan" && isSideEffecting) {
      return {
        ok: false,
        status: "permission_denied",
        retryable: false,
        recovery: { action: "ask_user" },
        output: `Side-effecting tool "${call.name}" is forbidden in "plan" mode.`,
      };
    }

    if (ctx.mode === "chat" && (isSideEffecting || !ALLOWED_CHAT_TOOLS.has(call.name))) {
      return {
        ok: false,
        status: "permission_denied",
        retryable: false,
        recovery: { action: "ask_user" },
        output: `Tool "${call.name}" is not permitted in "chat" mode.`,
      };
    }

    if (ctx.allowedTools && !ctx.allowedTools.includes(call.name)) {
      return {
        ok: false,
        status: "permission_denied",
        retryable: false,
        recovery: { action: "ask_user" },
        output: `Tool "${call.name}" is not permitted by current execution policy.`,
      };
    }

    if (ctx.executionPolicy?.blockTerminalCommands && (call.name === "run_command" || tool.spec.risk === "execute")) {
      return {
        ok: false,
        status: "permission_denied",
        retryable: false,
        recovery: { action: "ask_user" },
        output: `Terminal command execution is disabled by current execution policy.`,
      };
    }

    // 4. Validate arguments against tool schema
    const argCheck = validateToolArgs(tool, call.args);
    if (!argCheck.valid) {
      return {
        ok: false,
        status: "invalid_args",
        retryable: false,
        recovery: { action: "repair" },
        output: argCheck.error!,
      };
    }

    // 5. Run pre-execution listeners
    let cancelled: string | undefined;
    const preEvent: ToolPreExecuteEvent = { call, tool, cancel: (r) => (cancelled = r) };
    for (const fn of this.preListeners) {
      let nextCalled = false;
      await fn(preEvent, async () => {
        nextCalled = true;
      });
      if (!nextCalled) {
        cancelled ??= "blocked by policy";
        break;
      }
      if (cancelled) break;
    }
    if (cancelled) {
      return { ok: false, status: "permission_denied", retryable: false, output: cancelled };
    }

    // 6. Check cancellation before side effect / execution
    if (ctx.signal?.aborted) {
      return { ok: false, status: "cancelled", retryable: false, output: "Operation cancelled." };
    }

    // 7. Check approval immediately before side effect
    if (isSideEffecting && ctx.requestApproval) {
      const toolRisk = tool.spec.risk ?? "workspace_write";
      const effectiveRisk = ctx.executionPolicy?.requireExplicitApproval ? "destructive" : toolRisk;
      const approved = await ctx.requestApproval({
        id: call.id,
        name: call.name,
        args: call.args,
        status: "proposed",
        sideEffecting: true,
        risk: effectiveRisk,
      });
      if (!approved) {
        return {
          ok: false,
          status: "permission_denied",
          retryable: false,
          recovery: { action: "ask_user" },
          output: `Execution of side-effecting tool "${call.name}" was declined by user or policy.`,
        };
      }
    }

    // Double check cancellation after approval wait
    if (ctx.signal?.aborted) {
      return { ok: false, status: "cancelled", retryable: false, output: "Operation cancelled." };
    }

    // 8. Execute tool racing against cancellation and timeout so no pending promise survives
    const execCtx: ToolContext = {
      ...ctx,
      pendingCallId: call.id,
    };

    let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const timeoutMs = (call as any).timeoutMs ?? ctx.timeoutMs ?? 120_000;

    let result: ToolResult;
    try {
      result = await new Promise<ToolResult>((resolve) => {
        if (ctx.signal) {
          if (ctx.signal.aborted) {
            resolve({
              ok: false,
              status: "cancelled",
              retryable: false,
              output: "Operation cancelled.",
            });
            return;
          }
          abortHandler = () => {
            resolve({
              ok: false,
              status: "cancelled",
              retryable: false,
              output: "Operation cancelled.",
            });
          };
          ctx.signal.addEventListener("abort", abortHandler, { once: true });
        }

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            resolve({
              ok: false,
              status: "timeout",
              retryable: true,
              recovery: { action: "retry" },
              output: `Tool "${call.name}" timed out after ${timeoutMs}ms.`,
            });
          }, timeoutMs);
        }

        tool
          .execute(call.args, execCtx)
          .then((res) => resolve(res))
          .catch((e) =>
            resolve({
              ok: false,
              status: "execution_error",
              retryable: true,
              recovery: { action: "retry" },
              output: (e as Error).message || String(e),
            })
          );
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler && ctx.signal) {
        ctx.signal.removeEventListener("abort", abortHandler);
      }
    }

    // 9. Guarantee deterministic terminal status
    if (!result.status) {
      result.status = (result.ok ? "success" : "execution_error") as ToolStatus;
    }

    // 10. Bound and escape tool output
    if (typeof result.output === "string") {
      result.output = result.output.replace(/\0/g, "");
      if (result.output.length > MAX_TOOL_OUTPUT_CHARS) {
        result.output = clampToolResult(result.output, MAX_TOOL_OUTPUT_CHARS);
      }
    }

    // 11. Mark untrusted external / user data
    const isUntrusted =
      tool.spec.risk === "network" ||
      tool.spec.tags?.includes("untrusted") ||
      tool.spec.tags?.includes("mcp") ||
      tool.spec.name.startsWith("mcp_") ||
      tool.spec.name === "web_search" ||
      tool.spec.name === "web_fetch" ||
      tool.spec.name === "run_command" ||
      tool.spec.name === "execute_command";

    if (isUntrusted) {
      result.metadata = {
        ...result.metadata,
        untrusted: true,
      };
    }

    if (!result.ok && !result.recovery) {
      result.recovery = { action: result.retryable ? "retry" : "ask_user" };
    }

    for (const fn of this.postListeners) {
      fn({ call, result });
    }

    return result;
  }

  async executeMany(
    calls: ToolCall[],
    ctx: ToolContext,
    maxConcurrent = 4
  ): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>();
    const pending = [...calls];

    if (ctx.signal?.aborted) {
      for (const call of calls) {
        results.set(call.id, {
          ok: false,
          status: "cancelled",
          retryable: false,
          output: "Operation cancelled.",
        });
      }
      return results;
    }

    while (pending.length) {
      if (ctx.signal?.aborted) {
        for (const call of pending) {
          results.set(call.id, {
            ok: false,
            status: "cancelled",
            retryable: false,
            output: "Operation cancelled.",
          });
        }
        break;
      }

      const wave: ToolCall[] = [];
      const first = pending.shift()!;
      wave.push(first);
      const firstSpec = this.tools.get(first.name)?.spec;

      if (firstSpec) {
        for (let i = 0; i < pending.length && wave.length < maxConcurrent; ) {
          const candidate = pending[i];
          const spec = this.tools.get(candidate.name)?.spec;
          if (
            spec &&
            canRunInParallel(firstSpec, spec) &&
            wave.every((c) => {
              const s = this.tools.get(c.name)?.spec;
              return !!s && canRunInParallel(s, spec);
            })
          ) {
            wave.push(candidate);
            pending.splice(i, 1);
          } else {
            i++;
          }
        }
      }

      const waveResults = await Promise.all(wave.map((c) => this.execute(c, ctx)));
      wave.forEach((c, i) => results.set(c.id, waveResults[i]));

      if (wave.length > 1 && waveResults.some((r) => !r.ok)) {
        break;
      }
    }

    return results;
  }

  recoveryHint(result: ToolResult): string | undefined {
    return result.recovery ? recoveryDirective(result) : undefined;
  }
}
