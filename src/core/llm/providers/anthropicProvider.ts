import { randomUUID } from "node:crypto";
import type { ModelInfo } from "../../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider, ProviderModel } from "../types";
import { fetchWithRetry, streamSse, tryJson } from "../sse";
import { classifyHttpError } from "../errors";
import { normalizeAnthropicMessages } from "../normalizeMessages";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic requires a positive max_tokens; used when the engine sends no cap. */
const DEFAULT_MAX_TOKENS = 8192;

export interface AnthropicConfig {
  apiKey: string;
  enabled: boolean;
  models: ProviderModel[];
}

/**
 * Anthropic Claude provider. Streams SSE events from /v1/messages with
 * automatic ephemeral prompt caching on system instructions and tool definitions
 * to cut multi-step input token costs by up to 90%.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "claude";
  readonly label = "Anthropic Claude";
  enabled: boolean;
  private readonly apiKey: string;
  private readonly models: ProviderModel[];

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.apiKey;
    this.enabled = cfg.enabled;
    this.models = cfg.models;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION },
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
    const out: ModelInfo[] = [];
    let afterCursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "100");
      if (afterCursor) url.searchParams.set("after_id", afterCursor);
      const res = await fetchWithRetry(
        url.toString(),
        {
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
        },
        { retries: 1, timeoutMs: 12000 }
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw classifyHttpError(this.label, res.status, detail, res.headers, [this.apiKey]);
      }
      const json = (await res.json()) as {
        data?: { id: string; display_name?: string; created_at?: string }[];
        has_more?: boolean;
        last_id?: string;
      };
      for (const m of json.data ?? []) {
        const thinking = /opus|sonnet.*4|3-7-sonnet|thinking/i.test(m.id);
        out.push({
          name: `claude:${m.id}`,
          provider: "claude",
          contextLength: 200_000,
          toolTrained: true,
          vision: true,
          thinking,
          thinkingLevels: thinking ? ["off", "low", "medium", "high"] : [],
          capabilities: thinking ? ["tools", "vision", "thinking"] : ["tools", "vision"],
          tier: "large",
        });
      }
      if (!json.has_more || !json.last_id) break;
      afterCursor = json.last_id;
    }
    return out;
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const { system, messages } = normalizeAnthropicMessages(req.messages);

    const wireModel = req.model.startsWith("claude:") ? req.model.slice("claude:".length) : req.model;
    const body: Record<string, unknown> = {
      model: wireModel,
      max_tokens:
        req.options?.num_predict && req.options.num_predict > 0
          ? req.options.num_predict
          : DEFAULT_MAX_TOKENS,
      messages,
      stream: true,
    };
    if (system) {
      // Ephemeral prompt caching on system block saves up to 90% on input tokens across turns
      body.system = [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ];
    }
    if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
    if (req.options?.top_p !== undefined) body.top_p = req.options.top_p;
    if (req.tools?.length) {
      const mappedTools = (
        req.tools as { function: { name: string; description?: string; parameters?: unknown } }[]
      ).map((t, idx, arr) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
        ...(idx === arr.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
      body.tools = mappedTools;
    }

    const res = await fetchWithRetry(
      ANTHROPIC_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
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

    const pendingCalls = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

    for await (const payload of streamSse(res.body, signal, 90_000)) {
      const json = tryJson<{
        type?: string;
        error?: { type?: string; message?: string };
        index?: number;
        message?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        };
        content_block?: { type?: string; id?: string; name?: string };
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
          stop_reason?: string;
        };
      }>(payload);
      if (!json) continue;
      if (json.type === "error" || json.error) {
        const msg = json.error?.message ?? payload;
        throw classifyHttpError(this.label, 400, msg, undefined, [this.apiKey]);
      }
      if (json.type === "message_start" && json.message?.usage) {
        const u = json.message.usage;
        inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        cachedTokens += u.cache_read_input_tokens ?? 0;
        outputTokens += u.output_tokens ?? 0;
      }
      if (json.type === "content_block_start" && json.content_block?.type === "tool_use") {
        pendingCalls.set(json.index ?? pendingCalls.size, {
          id: json.content_block.id || `call_${json.index ?? pendingCalls.size}`,
          name: json.content_block.name ?? "",
          json: "",
        });
      } else if (json.type === "content_block_delta") {
        if (json.delta?.type === "text_delta" && json.delta.text) {
          yield { message: { role: "assistant", content: json.delta.text }, done: false };
        } else if (json.delta?.type === "thinking_delta" && json.delta.thinking) {
          yield { message: { role: "assistant", content: "", thinking: json.delta.thinking }, done: false };
        } else if (json.delta?.type === "input_json_delta" && json.delta.partial_json) {
          const cur = pendingCalls.get(json.index ?? [...pendingCalls.keys()].pop() ?? 0);
          if (cur) cur.json += json.delta.partial_json;
        }
      } else if (json.type === "message_delta") {
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
        if (json.usage?.output_tokens !== undefined) outputTokens = json.usage.output_tokens;
      } else if (json.type === "message_stop") {
        const calls = [...pendingCalls.values()]
          .filter((c) => c.name)
          .map((c) => {
            const parsed = tryJson<Record<string, unknown>>(c.json);
            if (c.json && c.json.trim() && parsed === undefined) return null;
            return { id: c.id, function: { name: c.name, arguments: parsed ?? {} } };
          })
          .filter((c): c is NonNullable<typeof c> => !!c);
        if (calls.length) {
          yield { message: { role: "assistant", content: "", tool_calls: calls }, done: false };
        }
        yield {
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: stopReason ?? (calls.length ? "tool_use" : "end_turn"),
          prompt_eval_count: inputTokens || undefined,
          eval_count: outputTokens || undefined,
          cached_tokens: cachedTokens || undefined,
        };
        return;
      }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    yield {
      message: { role: "assistant", content: "" },
      done: true,
      prompt_eval_count: inputTokens || undefined,
      eval_count: outputTokens || undefined,
      cached_tokens: cachedTokens || undefined,
    };
  }
}
