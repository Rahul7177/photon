import type { ModelInfo } from "../../../shared/types";
import { profileModel } from "../../adaptive/modelProfiler";
import type { OllamaClient } from "../../ollama/client";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../types";

/**
 * Adapter that presents the existing local Ollama client as an LLMProvider.
 * The Ollama wire types are structurally compatible with the normalized LLM
 * types, so this is a thin pass-through.
 */
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
    for await (const chunk of this.client.chatStream(req, signal)) {
      yield chunk;
    }
  }
}