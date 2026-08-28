import type { ModelInfo } from "../../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider, ProviderModel } from "../types";
import { fetchWithRetry, streamSse, tryJson } from "../sse";

export interface OpenAICompatConfig {
  id: string;
  label: string;
  /** Base URL, e.g. "https://integrate.api.nvidia.com/v1". */
  baseUrl: string;
  apiKey: string;
  models: ProviderModel[];
  enabled: boolean;
  /** Extra headers, e.g. Blackbox's Agent-Id. */
  extraHeaders?: Record<string, string>;
  /** Some endpoints (Blackbox) expect the key in the body instead of a header. */
  keyInBody?: boolean;
  /** When false (e.g. local llama.cpp), no API key is required to be configured. */
  requireApiKey?: boolean;
}

/**
 * OpenAI-compatible chat-completions provider. Covers NVIDIA NIM, Blackbox,
 * OpenAI, OpenRouter, Groq, and any custom endpoint that speaks the
 * `/chat/completions` streaming protocol.
 */
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
    // Local llama.cpp: auto-discover models from the server so the picker populates without manual "Add".
    if (this.id === "llamacpp" && this.enabled && this.isConfigured()) {
      try {
        const live = await this.fetchLiveModels();
        if (live.length) {
          // Merge explicit added models (may carry user overrides like tier/ctx) over live.
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
              capabilities: m.capabilities ?? byName.get(m.name)?.capabilities,
              tier: m.tier ?? byName.get(m.name)?.tier ?? "large",
              provider: this.id,
            });
          }
          return [...byName.values()];
        }
      } catch {
        // fall back to added models if server is unreachable
      }
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
      capabilities: m.capabilities,
      tier: m.tier,
      provider: this.id,
    }));
  }

  async fetchLiveModels(): Promise<ModelInfo[]> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/models`,
      { headers: this.authHeaders(), signal: AbortSignal.timeout(12000) },
      { retries: 1 }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${this.label} model list failed (${res.status}). ${detail}`.trim());
    }
    const json = await res.json() as {
      data?: { id: string; context_length?: number; created?: number }[];
    };
    const models = json.data ?? [];
    if (models.length === 0) {
      // Some endpoints return top-level array directly
      const direct = json as unknown as { id: string }[];
      if (Array.isArray(direct)) {
        return direct.map((m) => {
          const caps = guessCapabilities(m.id);
          const trained = isToolTrainedModel(m.id);
          return {
            name: `${this.id}:${m.id}`,
            provider: this.id,
            toolTrained: trained,
            vision: caps.includes("vision"),
            audio: caps.includes("audio"),
            video: caps.includes("video"),
            thinking: caps.includes("thinking"),
            capabilities: trained ? [...caps, "tools"] : caps.filter((c) => c !== "tools"),
            tier: guessTier(m.id),
          };
        });
      }
    }
    return models.map((m) => {
      const caps = guessCapabilities(m.id);
      const trained = isToolTrainedModel(m.id);
      return {
        name: `${this.id}:${m.id}`,
        provider: this.id,
        contextLength: m.context_length,
        toolTrained: trained,
        vision: caps.includes("vision"),
        audio: caps.includes("audio"),
        video: caps.includes("video"),
        thinking: caps.includes("thinking"),
        capabilities: trained ? [...caps.filter((c) => c !== "tools"), "tools"] : caps.filter((c) => c !== "tools"),
        tier: guessTier(m.id),
      };
    });
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m, mi) => {
        // Tool results reference the call they answer (OpenAI wire format).
        if (m.role === "tool") {
          return { role: "tool", tool_call_id: m.tool_call_id ?? `call_${mi}`, name: m.name, content: m.content };
        }
        // Assistant turns that requested tools must echo them back.
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
        // Vision: OpenAI content array with text + image_url
        if (m.role === "user" && m.images?.length) {
          const parts: Record<string, unknown>[] = [{ type: "text", text: m.content || "" }];
          for (const b64 of m.images) {
            parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
          }
          return { role: "user", content: parts };
        }
        return { role: m.role, content: m.content };
      }),
      stream: true,
    };
    if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
    if (req.options?.top_p !== undefined) body.top_p = req.options.top_p;
    // OpenAI rejects max_tokens <= 0; only send a positive cap.
    if (req.options?.num_predict && req.options.num_predict > 0) {
      body.max_tokens = req.options.num_predict;
    }
    if (req.tools?.length) body.tools = req.tools;
    if (this.keyInBody) body.apiKey = this.apiKey;

    // Retry transient rate-limits/gateway errors — a single 429 must not kill
    // a multi-step agent turn.
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
      throw new Error(`${this.label} /chat/completions failed (${res.status}). ${detail}`.trim());
    }

    let text = "";
    let gotFinishReason = false;
    // Streaming tool calls arrive fragmented across chunks (OpenAI style:
    // delta.tool_calls[].function.arguments fragments keyed by index). They are
    // assembled here and emitted once on finish_reason.
    const pendingCalls = new Map<number, { id: string; name: string; args: string }>();
    for await (const payload of streamSse(res.body, signal)) {
      const json = tryJson<{
        choices?: {
          delta?: {
            content?: string;
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
      const choice = json.choices?.[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        yield { message: { role: "assistant", content: choice.delta.content }, done: false };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const idx = tc.index ?? pendingCalls.size;
        const cur = pendingCalls.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pendingCalls.set(idx, cur);
      }
      if (choice?.finish_reason) {
        gotFinishReason = true;
        const calls = [...pendingCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([idx, c]) => ({
            id: c.id || `call_${idx}`,
            function: { name: c.name, arguments: (tryJson<Record<string, unknown>>(c.args) ?? {}) },
          }))
          .filter((c) => c.function.name);
        if (calls.length) {
          yield { message: { role: "assistant", content: "", tool_calls: calls }, done: false };
        }
        yield {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: choice.finish_reason,
        };
        return;
      }
    }
    // Always emit a done signal — even if the connection dropped mid-stream
    // without a finish_reason. Without this, the cloud engine can't tell a
    // severed connection from a clean end and the turn silently terminates.
    if (!gotFinishReason) {
      yield { message: { role: "assistant", content: "" }, done: true };
    } else if (!text) {
      yield { done: true };
    }
  }

  private authHeaders(): Record<string, string> {
    if (this.keyInBody) return {};
    if (!this.apiKey) return {};
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}

/** Coarse capability guess from a model id — live lists don't advertise tiers,
 *  and stamping everything "large" skewed Auto Mode toward whatever listed. */
function guessTier(id: string): "small" | "medium" | "large" {
  const n = id.toLowerCase();
  if (/nano|mini|flash|lite|small|tiny|8b|3b|4b|7b/.test(n)) return "medium";
  if (/opus|pro|max|ultra|405b|671b|deepseek-r\d|frontier/.test(n)) return "large";
  return "large";
}

function guessCapabilities(id: string): string[] {
  const n = id.toLowerCase();
  const caps: string[] = [];
  if (/vision|visual|vl|vision|4o|gpt-4|gemini|pixtral|llava|multimodal|image|gemma.*3|gemma.*4/.test(n)) caps.push("vision");
  if (/audio|whisper|speech|voxtral|ultravox|audio/.test(n)) caps.push("audio");
  if (/video|veo/.test(n)) caps.push("video");
  if (/r1|o1|o3|thinking|reasoning|qwq|qwen3|deepseek-r|magistral|nemotron.*think/.test(n)) caps.push("thinking");
  // gemma 3 is multimodal vision, also treat plain gemma as vision
  if (/gemma/.test(n) && !caps.includes("vision")) caps.push("vision");
  return caps;
}

const TOOL_TRAINED_HINTS = ["qwen2", "qwen3", "llama3.1", "llama3.2", "llama3.3", "mistral", "mistral-nemo", "firefunction", "command-r", "hermes", "qwq", "deepseek-r", "tool"];
function isToolTrainedModel(id: string): boolean {
  const n = id.toLowerCase();
  return TOOL_TRAINED_HINTS.some((h) => n.includes(h));
}