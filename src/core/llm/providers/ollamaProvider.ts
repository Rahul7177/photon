import type { ModelInfo, ThinkingLevel } from "../../../shared/types";
import { profileModel } from "../../adaptive/modelProfiler";
import type { OllamaClient } from "../../ollama/client";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../types";

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
    const models = await Promise.all(tags.models.map((t) => profileModel(this.client, t)));
    return models.map((m) => ({ ...m, provider: "ollama" }));
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const level = req.options?.thinkingLevel;
    const ollamaReq = {
      ...req,
      think: mapOllamaThink(req.model, level),
    };
    for await (const chunk of this.client.chatStream(ollamaReq as any, signal)) {
      yield chunk;
    }
  }
}

function mapOllamaThink(model: string, level: ThinkingLevel | undefined): boolean | string | undefined {
  if (!level) return undefined;
  if (level === "off") return false;
  const n = model.toLowerCase();
  if (/gpt-oss/.test(n)) return level === "xtrahigh" ? "high" : level;
  return true;
}
