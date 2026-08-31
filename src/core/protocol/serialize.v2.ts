import type { AdaptivePlan, IntelligenceLevel, JsonSchema, ToolSpec } from "../../shared/types";

/** Optional schema-aware serializer used by the v2 intelligence path. */
export function renderToolInstructionsV2(tools: ToolSpec[], plan: AdaptivePlan): string {
  if (!tools.length) return "";
  const list = tools.map((t) => renderSpec(t, plan.intelligence)).join("\n");
  const concurrency = plan.executionPolicy?.allowParallelReads && (plan.executionPolicy.maxConcurrent ?? 1) > 1
    ? "Independent read/search calls may be emitted together; mutations remain ordered."
    : "Call one tool, wait for its result, then continue.";
  return [
    "TOOLS:",
    "[TOOL tool_name]",
    "arg_name: value",
    "[/TOOL]",
    `- ${concurrency}`,
    "- Use only listed tools and exact argument names.",
    "- Read before editing; verify after changes.",
    list,
  ].join("\n");
}

function renderSpec(t: ToolSpec, level: IntelligenceLevel): string {
  const args = t.params.map((p) => `${p.name}${p.required ? "" : "?"}:${p.type}`).join(", ");
  if (level === "low") return `- ${t.name}(${args}) — ${t.summary}`;
  return `- ${t.name}: ${t.summary}${t.risk ? ` [risk=${t.risk}]` : ""}\n${t.params.map(p => `  ${p.name}: ${p.type}${p.required ? " required" : " optional"} — ${p.description}`).join("\n")}`;
}

export function toNativeToolsV2(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.example ? `${t.summary}\nExample:\n${t.example}` : t.summary,
      parameters: canonicalSchema(t),
    },
  }));
}

function canonicalSchema(t: ToolSpec): JsonSchema {
  if (t.inputSchema?.type === "object" || t.inputSchema?.properties) return t.inputSchema;
  return {
    type: "object",
    properties: Object.fromEntries(t.params.map((p) => [p.name, {
      type: p.type,
      description: p.description,
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.items ? { items: p.items } : {}),
      ...(p.properties ? { properties: p.properties } : {}),
    }])),
    required: t.params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

export function renderToolResultV2(name: string, result: string, ok: boolean, metadata?: Record<string, unknown>): string {
  return JSON.stringify({ type: ok ? "tool_result" : "tool_error", tool: name, result, metadata: metadata ?? {} });
}
