import type { ModelInfo, ThinkingLevel } from "../../../shared/types";
import { profileModel } from "../../adaptive/modelProfiler";
import type { OllamaClient } from "../../ollama/client";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../types";
import { LLMProviderError } from "../errors";

export class OllamaProvider implements LLMProvider {
  readonly id = "ollama";
  readonly label = "Ollama (local)";
  enabled: boolean;

  constructor(
    private readonly client: OllamaClient,
    enabled = true
  ) {
    this.enabled = enabled;
  }

  isConfigured(): boolean {
    return true;
  }

  async ping(): Promise<boolean> {
    return this.client.ping();
  }

  async listModels(): Promise<ModelInfo[]> {
    const tags = await this.client.listModels();
    // Bound concurrency + tolerate single-model profile failures: one bad
    // /api/show must not fail the whole model list.
    const CONCURRENCY = 4;
    const out: ModelInfo[] = [];
    for (let i = 0; i < tags.models.length; i += CONCURRENCY) {
      const batch = tags.models.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((t) => profileModel(this.client, t)));
      for (const r of results) {
        if (r.status === "fulfilled") out.push({ ...r.value, provider: "ollama" });
      }
    }
    return out;
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const level = req.options?.thinkingLevel;
    const ollamaReq = {
      ...req,
      think: mapOllamaThink(req.model, level, req.messages),
    };
    try {
      for await (const chunk of this.client.chatStream(ollamaReq as any, signal)) {
        yield chunk;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      const msg = (err as Error).message || String(err);
      if (
        msg.includes("ECONNREFUSED") ||
        msg.includes("Failed to fetch") ||
        msg.includes("fetch failed") ||
        msg.includes("ENOTFOUND")
      ) {
        throw new LLMProviderError({
          message: `Ollama is not reachable (${msg}). Check that the Ollama service is running.`,
          code: "network_error",
          provider: "ollama",
          retryable: true,
        });
      }
      throw err;
    }
  }
}

/**
 * Smart Thinking Control for Local Reasoning Models (`gemma4`, `qwen3`, `deepseek-r1`, `gpt-oss`):
 *  - When `level === "off"`, disables thinking (`false`) so the model replies immediately.
 *  - When `level === undefined` (Auto mode), disables thinking on trivial greetings or
 *    single-line quick factual queries so a 4B local model doesn't spend 45 seconds
 *    "thinking" before saying "Hello!" or calling `web_search`. Enables thinking on
 *    coding, multi-step, debugging, or reasoning prompts.
 *  - For `gpt-oss`, passes the string level (`"low" | "medium" | "high"`).
 */
function mapOllamaThink(
  model: string,
  level: ThinkingLevel | undefined,
  messages?: LLMChatRequest["messages"]
): boolean | string | undefined {
  const n = model.toLowerCase();
  const isThinkingFamily = /gemma4|qwen3|deepseek-r|qwq|magistral|nemotron|gpt-oss|thinking|reasoning/.test(n);

  if (level === "off") return isThinkingFamily ? false : undefined;

  if (!level) {
    // Auto mode: for known local thinking models, skip heavy reasoning on greetings
    // or short non-code questions so replies feel instant (2s instead of 40s).
    if (!isThinkingFamily) return undefined;
    const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    const trimmed = lastUser.trim();
    const isTrivial =
      trimmed.length < 90 &&
      !/\b(debug|why|how|refactor|implement|fix|error|bug|design|architect|optimize|analyze|compare|explain in detail|step by step)\b/i.test(trimmed) &&
      !/```/.test(trimmed);
    if (isTrivial) return false;
    return /gpt-oss/.test(n) ? "medium" : true;
  }

  if (/gpt-oss/.test(n)) return level === "xtrahigh" ? "high" : level;
  return true;
}
