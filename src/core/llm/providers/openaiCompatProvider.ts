import { parseEffectiveParams, classifyModel } from "../../adaptive/modelProfiler";
import type { ModelInfo, ThinkingLevel } from "../../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider, ProviderModel } from "../types";
import { fetchWithRetry, parseStreamedToolArgs, streamSse, tryJson } from "../sse";
import { classifyHttpError, redactSecrets } from "../errors";
import { normalizeImageData } from "../normalizeMessages";

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

/**
 * Normalize an OpenAI-compatible base URL so users can paste either the root
 * `/v1` base URL or a full `/chat/completions` / `/models` endpoint URL.
 */
export function normalizeOpenAICompatBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|completions|models)$/i, "")
    .replace(/\/+$/, "");
}

/** Providers confirmed to support OpenAI `stream_options.include_usage` without rejecting it. */
const STREAM_USAGE_PROVIDERS = new Set([
  "openai",
  "openrouter",
  "groq",
  "deepseek",
  "together",
  "fireworks",
  "xai",
  "cerebras",
  "llamacpp",
  "sambanova",
  "deepinfra",
  "siliconflow",
]);

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  readonly label: string;
  enabled: boolean;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: ProviderModel[];
  private readonly extraHeaders: Record<string, string>;
  private readonly keyInBody: boolean;
  readonly requireApiKey: boolean;
  private readonly idleTimeoutMs: number | undefined;

  constructor(cfg: OpenAICompatConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.enabled = cfg.enabled;
    this.baseUrl = normalizeOpenAICompatBaseUrl(cfg.baseUrl);
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
      thinkingLevels:
        m.thinkingLevels && m.thinkingLevels.length > 0
          ? m.thinkingLevels
          : m.thinking
            ? reasoningLevels(m.name, ["thinking"])
            : [],
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
    type RawOpenAIModel = {
      id: string;
      context_length?: number;
      created?: number;
      supported_parameters?: string[];
      architecture?: { input_modalities?: string[]; modality?: string };
    };
    const json = (await res.json()) as { data?: RawOpenAIModel[] };
    const list = Array.isArray(json.data)
      ? json.data
      : Array.isArray(json)
        ? (json as unknown as RawOpenAIModel[])
        : [];
    return list
      .filter((m) => typeof m?.id === "string" && m.id.trim().length > 0)
      .map((m) => {
        const caps = guessCapabilities(m.id);
        const inputMods = m.architecture?.input_modalities;
        if (inputMods?.includes("image") && !caps.includes("vision")) caps.push("vision");
        if (inputMods?.includes("audio") && !caps.includes("audio")) caps.push("audio");
        if (inputMods?.includes("video") && !caps.includes("video")) caps.push("video");
        if (m.supported_parameters?.includes("reasoning") && !caps.includes("thinking")) {
          caps.push("thinking");
        }
        const trained =
          m.supported_parameters?.includes("tools") || isToolTrainedModel(m.id);
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
            const { mimeType, data } = normalizeImageData(b64);
            parts.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${data}` },
            });
          }
          return { role: "user", content: parts };
        }
        return { role: m.role, content: m.content };
      }),
      stream: true,
    };
    const isOpenAIReasoning =
      this.id === "openai" && /(?:^|[:/])(?:gpt-5(?:\.[0-9]+)?|o[1-9]\b)/i.test(wireModel);
    const suppressSamplingForReasoning =
      isOpenAIReasoning &&
      (/(?:^|[:/])o[1-9]\b/i.test(wireModel) ||
        (req.options?.thinkingLevel !== undefined && req.options.thinkingLevel !== "off"));
    if (!suppressSamplingForReasoning) {
      if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
      if (req.options?.top_p !== undefined) body.top_p = req.options.top_p;
    }
    if (req.options?.num_predict && req.options.num_predict > 0) {
      if (isOpenAIReasoning) {
        body.max_completion_tokens = req.options.num_predict;
      } else {
        body.max_tokens = req.options.num_predict;
      }
    }
    if (req.tools?.length) body.tools = req.tools;
    if (this.keyInBody) body.apiKey = this.apiKey;
    if (STREAM_USAGE_PROVIDERS.has(this.id)) {
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
      { retries: 2, timeoutMs: 60_000, signal }
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
    const resolveCallIndex = (tc: { index?: number; id?: string }): number => {
      if (typeof tc.index === "number") return tc.index;
      if (tc.id) {
        for (const [k, v] of pendingCalls.entries()) {
          if (v.id === tc.id) return k;
        }
        return nextIndex();
      }
      return pendingCalls.size ? Math.max(...pendingCalls.keys()) : 0;
    };

    for await (const payload of streamSse(res.body, signal, this.idleTimeoutMs ?? 90_000)) {
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
        const idx = resolveCallIndex(tc);
        const cur = pendingCalls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) {
          if (!cur.name) cur.name = tc.function.name;
          else if (tc.function.name !== cur.name) cur.name += tc.function.name;
        }
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pendingCalls.set(idx, cur);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const calls = [...pendingCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => !!c.name)
      .map(([idx, c]) => ({
        id: c.id || `call_${idx}`,
        function: { name: c.name, arguments: parseStreamedToolArgs(c.args) },
      }));
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
    return;
  }

  if (provider === "openrouter") {
    if (level === "off") {
      body.reasoning = { enabled: false };
    } else {
      body.reasoning = { effort: level === "xtrahigh" ? "high" : level };
    }
  }
}

function guessTier(id: string): "tiny" | "small" | "medium" | "large" {
  const pb = parseEffectiveParams(id);
  if (pb !== undefined) return classifyModel(pb);
  const n = id.toLowerCase();
  if (/nano|tiny|1b|2b|3b|4b|e2b|e4b/.test(n)) return "tiny";
  if (/mini|flash-lite|haiku|small|7b|8b|9b/.test(n)) return "small";
  if (/opus|sonnet|pro|max|ultra|70b|72b|120b|235b|405b|671b|deepseek-r\d|deepseek-chat|deepseek-v3|gpt-5|gpt-4\.1|frontier/.test(n)) return "large";
  return "medium";
}
function guessCapabilities(id: string): string[] {
  const n = id.toLowerCase();
  const caps: string[] = [];
  if (/vision|visual|-vl\b|vl-|4o|gpt-4|gpt-5|claude-3|claude-4|sonnet|opus|gemini|pixtral|llava|multimodal|image|gemma.*3|qwen2\.5-vl|qwen3-vl|llama-4/.test(n)) caps.push("vision");
  if (/audio|whisper|speech|voxtral|ultravox/.test(n)) caps.push("audio");
  if (/video|veo|live/.test(n)) caps.push("video");
  if (/r1|o1|o3|o4|gpt-5|thinking|reasoning|reasoner|qwq|qwen3|deepseek-r|magistral|nemotron.*think|nemotron-3.*lightning|claude-(?:sonnet|opus)-4|3-7-sonnet|grok-3-mini|grok-4/.test(n)) caps.push("thinking");
  if (/gemma/.test(n) && !caps.includes("vision")) caps.push("vision");
  return caps;
}
function reasoningLevels(id: string, caps: string[]): import("../../../shared/types").ThinkingLevel[] {
  if (!caps.includes("thinking")) return [];
  return /xtrahigh|o1|o3|o4|gpt-5|reasoning/i.test(id)
    ? ["off", "low", "medium", "high", "xtrahigh"]
    : ["off", "low", "medium", "high"];
}
const TOOL_TRAINED_HINTS = [
  "qwen2",
  "qwen3",
  "llama3",
  "llama-3",
  "llama4",
  "llama-4",
  "mistral",
  "mistral-nemo",
  "devstral",
  "codestral",
  "firefunction",
  "command-r",
  "command-a",
  "hermes",
  "qwq",
  "deepseek",
  "gpt-",
  "claude",
  "sonnet",
  "opus",
  "haiku",
  "gemini",
  "grok",
  "kimi",
  "glm-",
  "o1",
  "o3",
  "o4",
  "tool",
];
function isToolTrainedModel(id: string): boolean {
  const n = id.toLowerCase();
  return TOOL_TRAINED_HINTS.some((h) => n.includes(h));
}
