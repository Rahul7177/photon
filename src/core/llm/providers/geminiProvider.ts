import type { ModelInfo, ThinkingLevel } from "../../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider, ProviderModel } from "../types";
import { fetchWithRetry, streamSse, tryJson } from "../sse";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
type GeminiInputFunction = { function: { name: string; description?: string; parameters?: unknown } };
export function toGeminiFunctionDeclaration(tool: GeminiInputFunction): { name: string; description?: string; parametersJsonSchema?: unknown } {
  return { name: tool.function.name, description: tool.function.description, parametersJsonSchema: tool.function.parameters };
}
function geminiHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}
export interface GeminiConfig {
  apiKey: string;
  enabled: boolean;
  models: ProviderModel[];
}

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
      return (await fetch(`${GEMINI_BASE}/models`, { headers: geminiHeaders(this.apiKey), signal: AbortSignal.timeout(8000) })).ok;
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
      thinkingLevels: m.thinkingLevels,
      capabilities: m.capabilities,
      tier: m.tier,
      provider: this.id,
    }));
  }
  async fetchLiveModels(): Promise<ModelInfo[]> {
    const res = await fetchWithRetry(`${GEMINI_BASE}/models`, { headers: geminiHeaders(this.apiKey) }, { retries: 1, timeoutMs: 12000 });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini model list failed (${res.status}). ${detail.slice(0, 500)}`.trim());
    }
    const json = (await res.json()) as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number; outputTokenLimit?: number }[];
    };
    const out: ModelInfo[] = [];
    for (const m of json.models ?? []) {
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
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
        thinkingLevels: caps.includes("thinking") ? geminiThinkingLevels(rawId) : [],
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
      if (m.role === "tool") {
        const fnResp = { functionResponse: { name: m.name ?? "tool", response: { output: m.content } } };
        const last = contents[contents.length - 1];
        if (last && last.role === "user") last.parts.push(fnResp);
        else contents.push({ role: "user", parts: [fnResp] });
        continue;
      }
      if (m.role === "assistant" && m.tool_calls?.length) {
        const parts: Record<string, unknown>[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls) {
          const fnPart: Record<string, unknown> = { functionCall: { name: tc.function.name, args: tc.function.arguments ?? {} } };
          if (tc.thoughtSignature) fnPart.thoughtSignature = tc.thoughtSignature;
          parts.push(fnPart);
        }
        contents.push({ role: "model", parts });
        continue;
      }
      const role = m.role === "assistant" ? "model" : "user";
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: "image/png", data: img } });
      contents.push({ role, parts });
    }
    const body: Record<string, unknown> = { contents, generationConfig: {} };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const gc = body.generationConfig as Record<string, unknown>;
    if (req.options?.temperature !== undefined) gc.temperature = req.options.temperature;
    if (req.options?.top_p !== undefined) gc.topP = req.options.top_p;
    if (req.options?.num_predict && req.options.num_predict > 0) gc.maxOutputTokens = req.options.num_predict;
    applyGeminiThinking(gc, req.model, req.options?.thinkingLevel);
    if (req.tools?.length) body.tools = [{ functionDeclarations: (req.tools as GeminiInputFunction[]).map(toGeminiFunctionDeclaration) }];
    const url = `${GEMINI_BASE}/models/${req.model}:streamGenerateContent?alt=sse`;
    const res = await fetchWithRetry(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", ...geminiHeaders(this.apiKey) }, body: JSON.stringify(body), signal },
      { retries: 2, signal }
    );
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini streamGenerateContent failed (${res.status}). ${detail.slice(0, 500)}`.trim());
    }
    let gotTerminal = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    for await (const payload of streamSse(res.body, signal)) {
      const json = tryJson<{
        promptFeedback?: { blockReason?: string };
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
        candidates?: {
          content?: {
            parts?: {
              text?: string;
              thought?: boolean;
              functionCall?: { name: string; args?: Record<string, unknown> };
              thoughtSignature?: string;
            }[];
          };
          finishReason?: string;
        }[];
      }>(payload);
      if (!json) continue;
      if (json.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${json.promptFeedback.blockReason}).`);
      if (json.usageMetadata) {
        if (json.usageMetadata.promptTokenCount !== undefined) inputTokens = json.usageMetadata.promptTokenCount;
        if (json.usageMetadata.candidatesTokenCount !== undefined) outputTokens = json.usageMetadata.candidatesTokenCount;
        if (json.usageMetadata.cachedContentTokenCount !== undefined) cachedTokens = json.usageMetadata.cachedContentTokenCount;
      }
      const cand = json.candidates?.[0];
      const parts = cand?.content?.parts ?? [];
      let text = "";
      let thinking = "";
      const toolCalls: { function: { name: string; arguments: Record<string, unknown> }; thoughtSignature?: string }[] = [];
      for (const p of parts) {
        if (p.text) {
          if (p.thought) thinking += p.text;
          else text += p.text;
        }
        if (p.functionCall) {
          toolCalls.push({
            function: { name: p.functionCall.name, arguments: p.functionCall.args ?? {} },
            ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
          });
        }
      }
      if (thinking) yield { message: { role: "assistant", content: "", thinking }, done: false };
      if (text) yield { message: { role: "assistant", content: text }, done: false };
      if (toolCalls.length) yield { message: { role: "assistant", content: "", tool_calls: toolCalls }, done: false };
      if (cand?.finishReason) {
        gotTerminal = true;
        yield {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: cand.finishReason,
          prompt_eval_count: inputTokens || undefined,
          eval_count: outputTokens || undefined,
          cached_tokens: cachedTokens || undefined,
        };
        return;
      }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!gotTerminal) {
      yield {
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: inputTokens || undefined,
        eval_count: outputTokens || undefined,
        cached_tokens: cachedTokens || undefined,
      };
    }
  }
}

function applyGeminiThinking(gc: Record<string, unknown>, model: string, level: ThinkingLevel | undefined): void {
  if (!level || (level === "off" && !/gemini-(?:2\.5|3)/i.test(model))) return;
  const n = model.toLowerCase();
  if (/gemini-2\.5/.test(n)) {
    const budgets: Record<ThinkingLevel, number> = { off: 0, low: 512, medium: 1536, high: 4096, xtrahigh: 8192 };
    gc.thinkingConfig = { thinkingBudget: budgets[level] };
    return;
  }
  if (/gemini-3/.test(n)) {
    const mapped =
      /gemini-3\.1-pro/i.test(n) && level === "off"
        ? "low"
        : level === "off"
          ? "minimal"
          : level === "xtrahigh"
            ? "high"
            : level;
    gc.thinkingConfig = { thinkingLevel: mapped };
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
function geminiThinkingLevels(id: string): import("../../../shared/types").ThinkingLevel[] {
  return /gemini-3/i.test(id) ? ["off", "low", "medium", "high"] : ["off", "low", "medium", "high", "xtrahigh"];
}
