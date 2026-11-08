import type { LLMMessage } from "./types";

/**
 * Message normalization utilities for provider-specific constraints.
 * Different providers enforce strict invariants:
 * - Anthropic requires alternating user/assistant roles, starting with user, system in top-level, and non-empty text blocks.
 * - Gemini requires alternating user/model roles, systemInstruction, and non-empty parts.
 * - OpenAI requires tool_call_id matching on tool role messages.
 */

export interface NormalizedAnthropicMessages {
  system: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;
}

export function normalizeAnthropicMessages(
  rawMessages: LLMMessage[]
): NormalizedAnthropicMessages {
  let system = "";
  type Block = Record<string, unknown>;
  const rawList: Array<{ role: "user" | "assistant"; content: string | Block[] }> = [];

  const pushTurn = (role: "user" | "assistant", content: string | Block[]) => {
    const last = rawList[rawList.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === "string" && typeof content === "string") {
        last.content = last.content ? `${last.content}\n\n${content}` : content;
      } else {
        const lastBlocks: Block[] = typeof last.content === "string"
          ? (last.content.trim() ? [{ type: "text", text: last.content }] : [])
          : last.content;
        const newBlocks: Block[] = typeof content === "string"
          ? (content.trim() ? [{ type: "text", text: content }] : [])
          : content;
        last.content = [...lastBlocks, ...newBlocks];
      }
    } else {
      rawList.push({ role, content });
    }
  };

  for (const m of rawMessages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + m.content;
      continue;
    }

    if (m.role === "tool") {
      // In Anthropic, tool outcomes are tool_result content blocks inside a user turn
      pushTurn("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id || `call_${rawList.length}`,
          content: m.content || "(empty result)",
        },
      ]);
      continue;
    }

    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks: Block[] = [];
      if (m.content && m.content.trim()) {
        blocks.push({ type: "text", text: m.content });
      }
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id || `call_${blocks.length}`,
          name: tc.function.name,
          input: tc.function.arguments ?? {},
        });
      }
      pushTurn("assistant", blocks);
      continue;
    }

    if (m.role === "assistant") {
      pushTurn("assistant", m.content || "");
    } else {
      // User role: handle text + optional images
      if (m.images?.length) {
        const parts: Block[] = [];
        if (m.content && m.content.trim()) {
          parts.push({ type: "text", text: m.content });
        }
        for (const img of m.images) {
          parts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: img,
            },
          });
        }
        pushTurn("user", parts.length ? parts : [{ type: "text", text: "(image attachment)" }]);
      } else {
        pushTurn("user", m.content || "");
      }
    }
  }

  // Anthropic invariant 1: Messages must not start with 'assistant'
  if (rawList.length > 0 && rawList[0].role === "assistant") {
    rawList.unshift({ role: "user", content: "Continue" });
  }

  // Anthropic invariant 2: Filter out empty content
  const cleaned = rawList
    .map((turn) => {
      if (typeof turn.content === "string") {
        const text = turn.content.trim() ? turn.content : " ";
        return { role: turn.role, content: text };
      }
      if (Array.isArray(turn.content)) {
        const validBlocks = turn.content.filter((b) => {
          if (b.type === "text") {
            return typeof b.text === "string" && b.text.trim().length > 0;
          }
          return true;
        });
        return {
          role: turn.role,
          content: validBlocks.length > 0 ? validBlocks : [{ type: "text", text: " " }],
        };
      }
      return turn;
    })
    .filter((turn) => {
      if (typeof turn.content === "string") return turn.content.length > 0;
      return Array.isArray(turn.content) && turn.content.length > 0;
    });

  return { system, messages: cleaned };
}

export interface NormalizedGeminiContents {
  system: string;
  contents: Array<{
    role: "user" | "model";
    parts: Array<Record<string, unknown>>;
  }>;
}

export function normalizeGeminiMessages(
  rawMessages: LLMMessage[]
): NormalizedGeminiContents {
  let system = "";
  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];

  const pushTurn = (role: "user" | "model", parts: Array<Record<string, unknown>>) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const m of rawMessages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + m.content;
      continue;
    }

    if (m.role === "tool") {
      const fnResp = {
        functionResponse: {
          name: m.name ?? "tool",
          response: { output: m.content || "" },
        },
      };
      pushTurn("user", [fnResp]);
      continue;
    }

    if (m.role === "assistant" && m.tool_calls?.length) {
      const parts: Record<string, unknown>[] = [];
      if (m.content && m.content.trim()) {
        parts.push({ text: m.content });
      }
      for (const tc of m.tool_calls) {
        const fnPart: Record<string, unknown> = {
          functionCall: { name: tc.function.name, args: tc.function.arguments ?? {} },
        };
        if (tc.thoughtSignature) fnPart.thoughtSignature = tc.thoughtSignature;
        parts.push(fnPart);
      }
      pushTurn("model", parts);
      continue;
    }

    const role = m.role === "assistant" ? "model" : "user";
    const parts: Record<string, unknown>[] = [];
    if (m.content && m.content.trim()) {
      parts.push({ text: m.content });
    }
    for (const img of m.images ?? []) {
      parts.push({ inlineData: { mimeType: "image/png", data: img } });
    }
    if (parts.length === 0) {
      parts.push({ text: " " });
    }
    pushTurn(role, parts);
  }

  // Gemini invariant: alternating turns (already merged above), non-empty parts
  const cleaned = contents.filter((c) => c.parts.length > 0);
  return { system, contents: cleaned };
}

