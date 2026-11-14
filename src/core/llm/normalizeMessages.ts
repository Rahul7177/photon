import type { LLMMessage } from "./types";

/**
 * Parse an optional `data:<mime>;base64,...` URI and infer the image MIME type
 * from its base64-encoded magic bytes (JPEG, PNG, GIF, WebP), defaulting to `image/png`.
 */
export function normalizeImageData(raw: string): { mimeType: string; data: string } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/is.exec(raw);
  if (match) {
    return { mimeType: match[1].toLowerCase(), data: match[2] };
  }
  let mimeType = "image/png";
  try {
    const clean = raw.replace(/\s+/g, "").slice(0, 24);
    const pad = clean.slice(0, Math.floor(clean.length / 4) * 4);
    if (pad.length >= 4 && typeof atob === "function") {
      const bin = atob(pad);
      const b0 = bin.charCodeAt(0);
      const b1 = bin.charCodeAt(1);
      const b2 = bin.charCodeAt(2);
      const b3 = bin.charCodeAt(3);
      if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) mimeType = "image/jpeg";
      else if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) mimeType = "image/png";
      else if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) mimeType = "image/gif";
      else if (bin.length >= 12 && bin.slice(0, 4) === "RIFF" && bin.slice(8, 12) === "WEBP") {
        mimeType = "image/webp";
      }
    }
  } catch {
    // Fallback to image/png if header cannot be base64-decoded.
  }
  return { mimeType, data: raw };
}

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
          const { mimeType, data } = normalizeImageData(img);
          parts.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data,
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
      const { mimeType, data } = normalizeImageData(img);
      parts.push({ inlineData: { mimeType, data } });
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

