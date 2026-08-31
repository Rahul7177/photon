import type { StreamChunk } from "../llm/types.v2";

export interface AssembledToolCall {
  id: string;
  name?: string;
  argumentsText: string;
  index: number;
}

/** Buffers streamed function-call fragments until the provider finishes the turn. */
export class ToolCallAssembler {
  private calls = new Map<string, AssembledToolCall>();

  accept(chunk: Extract<StreamChunk, { type: "tool-call-delta" }>): void {
    const key = chunk.id || `index:${chunk.index}`;
    const existing = this.calls.get(key);
    if (!existing) {
      this.calls.set(key, { id: chunk.id || `photon-call-${chunk.index}`, name: chunk.name, argumentsText: chunk.argumentsDelta || "", index: chunk.index });
      return;
    }
    if (chunk.name && !existing.name) existing.name = chunk.name;
    existing.argumentsText += chunk.argumentsDelta || "";
  }

  addCompleted(block: { id?: string; name?: string; arguments?: string; index?: number }): void {
    const key = block.id || `index:${block.index ?? this.calls.size}`;
    this.calls.set(key, { id: block.id || `photon-call-${block.index ?? this.calls.size}`, name: block.name, argumentsText: block.arguments || "", index: block.index ?? this.calls.size });
  }

  finalize(): AssembledToolCall[] {
    return [...this.calls.values()].sort((a,b)=>a.index-b.index);
  }
}

export function parseToolArguments(text: string): { args: Record<string, unknown>; error?: string } {
  const source = text.trim();
  if (!source) return { args: {} };
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { args: {}, error: "Tool arguments must be a JSON object." };
    return { args: value as Record<string, unknown> };
  } catch (e) {
    return { args: {}, error: `Malformed tool arguments: ${(e as Error).message}` };
  }
}
