import { parseEffectiveParams, classifyModel } from "../../adaptive/modelProfiler";
import type { ModelInfo, ThinkingLevel } from "../../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider, ProviderModel } from "../types";
import { fetchWithRetry, streamSse, tryJson } from "../sse";
import { classifyHttpError, redactSecrets } from "../errors";

export interface OpenAICompatConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: ProviderModel[];
  enabled: boolean;
  extraHeaders?: Record<string, string>;
  keyInBody?: boolean;
  requireApiKey?: boolean;
  idleTimeoutMs?: number;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  enabled: boolean;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: ProviderModel[];
  private readonly extraHeaders: Record<string, string>;
  private readonly keyInBody: boolean;
  private readonly requireApiKey: boolean;
  private readonly idleTimeoutMs: number | undefined;

  constructor(cfg: OpenAICompatConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.enabled = cfg.enabled;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.models = cfg.models;
    this.extraHeaders = cfg.extraHeaders ?? {};
    this.keyInBody = cfg.keyInBody ?? false;
    this.requireApiKey = cfg.requireApiKey ?? true;
    this.idleTimeoutMs = cfg.idleTimeoutMs;
  }

  isConfigured(): boolean {
    if (!this.baseUrl) return false;
    if (this.requireApiKey) return !!this.apiKey;
    return true;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.id === "llamacpp" && this.enabled && this.isConfigured()) {
      try {
        const live = await this.fetchLiveModels();
        if (live.length) {
          const byName = new Map(live.map((m) => [m.name, m] as const));
          for (const m of this.models) {
            byName.set(m.name, {
              name: m.name,
              paramSize: m.paramSize,
              paramsB: m.paramsB,
              contextLength: m.contextLength ?? byName.get(m.name)?.contextLength,
              toolTrained: m.toolTrained ?? true,
              vision: m.vision ?? byName.get(m.name)?.vision,
              audio: m.audio ?? byName.get(m.name)?.audio,
              video: m.video ?? byName.get(m.name)?.video,
              thinking: m.thinking ?? byName.get(m.name)?.thinking,
              thinkingLevels: m.thinkingLevels ?? byName.get(m.name)?.thinkingLevels,
              capabilities: m.capabilities ?? byName.get(m.name)?.capabilities,
              tier: m.tier ?? byName.get(m.name)?.tier ?? "large",
              provider: this.id,
            });
          }
          return [...byName.values()];
        }
      } catch {}
    }
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
    const res = await fetchWithRetry(
      `${this.baseUrl}/models`,
      { headers: this.authHeaders() },
      { retries: 1, timeoutMs: 12000 }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw classifyHttpError(this.label, res.status, detail, res.headers, [this.apiKey]);
    }
    const json = (await res.json()) as { data?: { id: string; context_length?: number; created?: number }[] };
    const models = json.data ?? [];
    if (!models.length) {
      const direct = json as unknown as { id: string }[];
      if (Array.isArray(direct)) {
        return direct.map((m) => {
          const caps = guessCapabilities(m.id);
          const trained = isToolTrainedModel(m.id);
          const pb = parseEffectiveParams(m.id);
          return {
            name: `${this.id}:${m.id}`,
            provider: this.id,
            paramsB: pb,
            toolTrained: trained,
            vision: caps.includes("vision"),
            audio: caps.includes("audio"),
            video: caps.includes("video"),
            thinking: caps.includes("thinking"),
            thinkingLevels: reasoningLevels(m.id, caps),
            capabilities: trained ? [...caps, "tools"] : caps,
            tier: guessTier(m.id),
          };
        });
      }
    }
    return models.map((m) => {
      const caps = guessCapabilities(m.id);
      const trained = isToolTrainedModel(m.id);
      const pb = parseEffectiveParams(m.id);
      return {
        name: `${this.id}:${m.id}`,
        provider: this.id,
        paramsB: pb,
        contextLength: m.context_length,
        toolTrained: trained,
        vision: caps.includes("vision"),
        audio: caps.includes("audio"),
        video: caps.includes("video"),
        thinking: caps.includes("thinking"),
        thinkingLevels: reasoningLevels(m.id, caps),
        capabilities: trained
          ? [...caps.filter((c) => c !== "tools"), "tools"]
          : caps.filter((c) => c !== "tools"),
        tier: guessTier(m.id),
      };
    });
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const wireModel = req.model.startsWith(`${this.id}:`)
      ? req.model.slice(this.id.length + 1)
      : req.model;
    const body: Record<string, unknown> = {
      model: wireModel,
      messages: req.messages.map((m, mi) => {
        if (m.role === "tool") {
          return {
            role: "tool",
            tool_call_id: m.tool_call_id ?? `call_${mi}`,
            name: m.name,
            content: m.content,
          };
        }
        if (m.role === "assistant" && m.tool_calls?.length) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.tool_calls.map((tc, ti) => ({
              id: tc.id ?? `call_${mi}_${ti}`,
              type: "function",
              function: {
                name: tc.function.name,
                arguments: JSON.stringify(tc.function.arguments ?? {}),
              },
            })),
          };
        }
        if (m.role === "user" && m.images?.length) {
          const parts: Record<string, unknown>[] = [{ type: "text", text: m.content || "" }];
          for (const b64 of m.images) {
            parts.push({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}` },
            });
          }
          return { role: "user", content: parts };
        }
        return { role: m.role, content: m.content };
      }),
      stream: true,
    };
    if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
    if (req.options?.top_p !== undefined) body.top_p = req.options.top_p;
    if (req.options?.num_predict && req.options.num_predict > 0) body.max_tokens = req.options.num_predict;
    if (req.tools?.length) body.tools = req.tools;
    if (this.keyInBody) body.apiKey = this.apiKey;
    if (this.id === "openai") {
      body.stream_options = { include_usage: true };
    }

    applyReasoningControls(body, this.id, req.model, req.options?.thinkingLevel);

    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      },
      { retries: 2, signal }
    );
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw classifyHttpError(this.label, res.status, detail, res.headers, [this.apiKey]);
    }

    let finishReason: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    const pendingCalls = new Map<number, { id: string; name: string; args: string }>();
    const nextIndex = () => (pendingCalls.size ? Math.max(...pendingCalls.keys()) + 1 : 0);

    for await (const payload of streamSse(res.body, signal, this.idleTimeoutMs)) {
      const json = tryJson<{
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
        choices?: {
          delta?: {
            content?: string;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
      }>(payload);
      if (!json) continue;
      if ((json as any).error) {
        const errObj = (json as any).error;
        const msg = typeof errObj === "string" ? errObj : (errObj.message || JSON.stringify(errObj));
        throw classifyHttpError(this.label, 400, msg, undefined, [this.apiKey]);
      }
      if (json.usage) {
        if (json.usage.prompt_tokens !== undefined) inputTokens = json.usage.prompt_tokens;
        if (json.usage.completion_tokens !== undefined) outputTokens = json.usage.completion_tokens;
        const cached =
          json.usage.prompt_tokens_details?.cached_tokens ??
          json.usage.prompt_cache_hit_tokens;
        if (cached !== undefined) cachedTokens = cached;
      }
      const choice = json.choices?.[0];
      if (choice?.delta?.content) {
        yield { message: { role: "assistant", content: choice.delta.content }, done: false };
      }
      const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (reasoning) {
        yield { message: { role: "assistant", content: "", thinking: reasoning }, done: false };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const idx = tc.index ?? nextIndex();
        const cur = pendingCalls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pendingCalls.set(idx, cur);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
        // Return immediately on finish_reason for gateways that do not send a trailing OpenAI usage event
        if (this.id !== "openai") break;
      }
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const calls = [...pendingCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, c]) => {
        if (!c.name) return null;
        const parsed = tryJson<Record<string, unknown>>(c.args);
        if (c.args && c.args.trim() && parsed === undefined) return null;
        return { id: c.id || `call_${idx}`, function: { name: c.name, arguments: parsed ?? {} } };
      })
      .filter((c): c is NonNullable<typeof c> => !!c && !!c.function.name);
    if (calls.length) {
      yield { message: { role: "assistant", content: "", tool_calls: calls }, done: false };
    }
    yield {
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: finishReason,
      prompt_eval_count: inputTokens || undefined,
      eval_count: outputTokens || undefined,
      cached_tokens: cachedTokens || undefined,
    };
  }

  private authHeaders(): Record<string, string> {
    if (this.keyInBody || !this.apiKey) return {};
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}

function applyReasoningControls(
  body: Record<string, unknown>,
  provider: string,
  model: string,
  level: ThinkingLevel | undefined
): void {
  if (!level) return;
  const n = model.toLowerCase();

  if (provider === "nvidia" || /nemotron-3(?:\.5)?[-_ ]lightning/i.test(n)) {
    const enabled = level !== "off";
    body.chat_template_kwargs = { enable_thinking: enabled };
    if (enabled) {
      const budget = level === "low" ? 256 : level === "medium" ? 1024 : level === "high" ? 4096 : 8192;
      body.thinking_token_budget = budget;
    }
    return;
  }

  if (provider === "openai" && /(?:^|[:/])(?:gpt-5(?:\.[0-9]+)?|o[1-9]\b)/i.test(model)) {
    if (level === "off") {
      if (/gpt-5/i.test(model)) body.reasoning_effort = "none";
    } else {
      body.reasoning_effort = level === "xtrahigh" ? "xhigh" : level;
    }
  }
}

function guessTier(id: string): "tiny" | "small" | "medium" | "large" {
  const pb = parseEffectiveParams(id);
  if (pb !== undefined) return classifyModel(pb);
  const n = id.toLowerCase();
  if (/nano|tiny|1b|2b|3b|4b|e2b|e4b/.test(n)) return "tiny";
  if (/mini|flash|lite|small|7b|8b/.test(n)) return "small";
  if (/opus|pro|max|ultra|70b|405b|671b|deepseek-r\d|frontier/.test(n)) return "large";
  return "medium";
}
function guessCapabilities(id: string): string[] {
  const n = id.toLowerCase();
  const caps: string[] = [];
  if (/vision|visual|vl|4o|gpt-4|gemini|pixtral|llava|multimodal|image|gemma.*3/.test(n)) caps.push("vision");
  if (/audio|whisper|speech|voxtral|ultravox/.test(n)) caps.push("audio");
  if (/video|veo|live/.test(n)) caps.push("video");
  if (/r1|o1|o3|o4|thinking|reasoning|qwq|qwen3|deepseek-r|magistral|nemotron.*think|nemotron-3.*lightning/.test(n)) caps.push("thinking");
  if (/gemma/.test(n) && !caps.includes("vision")) caps.push("vision");
  return caps;
}
function reasoningLevels(id: string, caps: string[]): import("../../../shared/types").ThinkingLevel[] {
  if (!caps.includes("thinking")) return [];
  return /xtrahigh|o1|o3|o4|reasoning/i.test(id)
    ? ["off", "low", "medium", "high", "xtrahigh"]
    : ["off", "low", "medium", "high"];
}
const TOOL_TRAINED_HINTS = [
  "qwen2",
  "qwen3",
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "mistral",
  "mistral-nemo",
  "firefunction",
  "command-r",
  "hermes",
  "qwq",
  "deepseek",
  "gpt-",
  "claude",
  "gemini",
  "o1",
  "o3",
  "o4",
  "tool",
];
function isToolTrainedModel(id: string): boolean {
  const n = id.toLowerCase();
  return TOOL_TRAINED_HINTS.some((h) => n.includes(h));
}
