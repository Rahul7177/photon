import type { ModelInfo } from "../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "./types";

/**
 * Routes chat requests to the right provider based on a model's provider
 * prefix (e.g. "gemini:gemini-2.5-pro" → Gemini; "llama3.1:8b" → Ollama).
 * Also aggregates the model catalog across every enabled, configured provider.
 * The engine depends on this facade as its single `LLMProvider`, so providers
 * can be added/removed at runtime without touching the agent loop.
 */
export class ProviderManager implements LLMProvider {
  readonly id = "manager";
  readonly label = "All providers";
  enabled = true;

  constructor(private providers: LLMProvider[]) {}

  /** Replace the provider set (used when settings/API keys change). */
  setProviders(providers: LLMProvider[]): void {
    this.providers = providers;
  }

  all(): LLMProvider[] {
    return this.providers;
  }

  /** Providers that are enabled AND have the credentials to run. */
  active(): LLMProvider[] {
    return this.providers.filter((p) => p.enabled && p.isConfigured());
  }

  isConfigured(): boolean {
    return this.active().length > 0;
  }

  /** The provider owning a (possibly prefixed) model name. */
  providerFor(model: string): LLMProvider | undefined {
    const prefix = model.split(":")[0];
    const known = this.providers.find((p) => p.id === prefix);
    if (known) return known;
    // No known prefix → local model (ollama first, then llamacpp).
    return this.providers.find((p) => p.id === "ollama") ?? this.providers.find((p) => p.id === "llamacpp");
  }

  /** Strip the provider prefix from a model name for the underlying API. */
  stripPrefix(model: string): string {
    const prefix = model.split(":")[0];
    if (this.providers.some((p) => p.id === prefix)) return model.slice(prefix.length + 1);
    return model;
  }

  async ping(): Promise<boolean> {
    const results = await Promise.all(
      this.active().map((p) => p.ping().catch(() => false))
    );
    return results.some(Boolean);
  }

  async listModels(): Promise<ModelInfo[]> {
    const lists = await Promise.all(
      this.active().map((p) => p.listModels().catch(() => [] as ModelInfo[]))
    );
    return lists.flat();
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const provider = this.providerFor(req.model);
    if (!provider) {
      throw new Error(`No provider configured for model "${req.model}".`);
    }
    const stripped: LLMChatRequest = { ...req, model: this.stripPrefix(req.model) };
    yield* provider.chatStream(stripped, signal);
  }
}