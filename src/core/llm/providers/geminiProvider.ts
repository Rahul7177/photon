import type { ModelInfo } from "../../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider, ProviderModel } from "../types";
import { fetchWithRetry, streamSse, tryJson } from "../sse";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Auth headers for the Generative Language API — key stays out of URLs. */
function geminiHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

export interface GeminiConfig {
  apiKey: string;
  enabled: boolean;
  models: ProviderModel[];
}

/**
 * Google Gemini provider (Generative Language API). Streams via SSE
 * (`streamGenerateContent?alt=sse`). Function calling is supported but Photon
 * uses the block protocol for cloud models, so tool results flow as text.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = "gemini";
  readonly label = "Google Gemini";
  enabled: boolean;
  private readonly apiKey: string;
  private readonly models: ProviderModel[];

  constructor(cfg: GeminiConfig) {
    this.apiKey = cfg.apiKey;
    this.enabled = cfg.enabled;
    this.models = cfg.models;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${GEMINI_BASE}/models`, {
        headers: geminiHeaders(this.apiKey),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models.map((m) => ({
      name: m.name,
      paramSize: m.paramSize,
      paramsB: m.paramsB,
      contextLength: m.contextLength,
      toolTrained: m.toolTrained,
      vision: m.vision,
      audio: m.audio,
      video: m.video,
      thinking: m.thinking,
      capabilities: m.capabilities,
      tier: m.tier,
      provider: this.id,
    }));
  }

  async fetchLiveModels(): Promise<ModelInfo[]> {
    const res = await fetchWithRetry(
      `${GEMINI_BASE}/models`,
      { headers: geminiHeaders(this.apiKey), signal: AbortSignal.timeout(12000) },
      { retries: 1 }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini model list failed (${res.status}). ${detail}`.trim());
    }
    const json = await res.json() as {
      models?: {
        name: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }[];
    };
    const out: ModelInfo[] = [];
    for (const m of json.models ?? []) {
      // Only include models that support text generation
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      // Strip the "models/" prefix to get the bare model id
      const rawId = m.name.replace(/^models\//, "");
      const caps = geminiCaps(rawId);
      out.push({
        name: `gemini:${rawId}`,
        provider: "gemini",
        contextLength: m.inputTokenLimit,
        toolTrained: true,
        vision: caps.includes("vision"),
        audio: caps.includes("audio"),
        video: caps.includes("video"),
        thinking: caps.includes("thinking"),
        capabilities: caps,
        tier: "large",
      });
    }
    return out;
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const contents: { role: string; parts: Record<string, unknown>[] }[] = [];
    let system = "";
    for (const m of req.messages) {
      if (m.role === "system") {
        system += (system ? "\n\n" : "") + m.content;
        continue;
      }
      // Tool results come back as functionResponse parts (matched by NAME).
      // Multiple tool results must be merged into a single user message —
      // Gemini also requires strict role alternation.
      if (m.role === "tool") {
        const fnResp = { functionResponse: { name: m.name ?? "tool", response: { output: m.content } } };
        const last = contents[contents.length - 1];
        if (last && last.role === "user") {
          last.parts.push(fnResp);
        } else {
          contents.push({ role: "user", parts: [fnResp] });
        }
        continue;
      }
      // Assistant turns that called functions echo their functionCall parts.
      if (m.role === "assistant" && m.tool_calls?.length) {
        const parts: Record<string, unknown>[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls) {
          const fnPart: Record<string, unknown> = { functionCall: { name: tc.function.name, args: tc.function.arguments ?? {} } };
          // Gemini reasoning models require thoughtSignature to be echoed back.
          if (tc.thoughtSignature) fnPart.thoughtSignature = tc.thoughtSignature;
          parts.push(fnPart);
        }
        contents.push({ role: "model", parts });
        continue;
      }
      const role = m.role === "assistant" ? "model" : "user";
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const img of m.images ?? []) {
        parts.push({ inlineData: { mimeType: "image/png", data: img } });
      }
      contents.push({ role, parts });
    }

    const body: Record<string, unknown> = { contents, generationConfig: {} };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const gc = body.generationConfig as Record<string, unknown>;
    if (req.options?.temperature !== undefined) gc.temperature = req.options.temperature;
    if (req.options?.top_p !== undefined) gc.topP = req.options.top_p;
    if (req.options?.num_predict && req.options.num_predict > 0) {
      gc.maxOutputTokens = req.options.num_predict;
    }
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: (req.tools as { function: { name: string; description?: string; parameters?: unknown } }[]).map(
            (t) => ({
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            })
          ),
        },
      ];
    }

    const url = `${GEMINI_BASE}/models/${req.model}:streamGenerateContent?alt=sse`;
    // The key travels in a header, never the URL — query strings leak into
    // proxies, access logs, and error reporters.
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...geminiHeaders(this.apiKey) },
        body: JSON.stringify(body),
        signal,
      },
      { retries: 2, signal }
    );
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini streamGenerateContent failed (${res.status}). ${detail}`.trim());
    }

    for await (const payload of streamSse(res.body, signal)) {
      const json = tryJson<{
        candidates?: {
          content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }[] };
          finishReason?: string;
        }[];
      }>(payload);
      if (!json) continue;
      const cand = json.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      let text = "";
      const toolCalls: { function: { name: string; arguments: Record<string, unknown> }; thoughtSignature?: string }[] = [];
      for (const p of parts) {
        if (p.text) text += p.text;
        if (p.functionCall) {
          toolCalls.push({
            function: { name: p.functionCall.name, arguments: p.functionCall.args ?? {} },
            // Preserve thoughtSignature for Gemini reasoning models.
            ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
          } as any);
        }
      }
      if (text) yield { message: { role: "assistant", content: text }, done: false };
      if (toolCalls.length) {
        yield { message: { role: "assistant", content: "", tool_calls: toolCalls }, done: false };
      }
      if (cand?.finishReason) {
        yield {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: cand.finishReason,
        };
        return;
      }
    }
    yield { done: true };
  }
}

function geminiCaps(id: string): string[] {
  const n = id.toLowerCase();
  const caps = ["tools", "vision"];
  if (/audio|native-audio|speech/.test(n)) caps.push("audio");
  if (/video|veo|live/.test(n)) caps.push("video");
  if (/thinking|2\.5|flash-thinking|pro/.test(n)) caps.push("thinking");
  return caps;
}