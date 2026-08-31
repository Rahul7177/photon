import type { ModelInfo, ThinkingLevel, ThinkingSetting } from "../../shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "./types";

/**
 * Routes chat requests to the right provider based on a model's provider
 * prefix and injects the user's provider-neutral thinking setting.
 * The actual wire translation stays inside each concrete provider adapter.
 */
export class ProviderManager implements LLMProvider {
  readonly id = "manager";
  readonly label = "All providers";
  enabled = true;
  private thinkingLevel: ThinkingLevel | undefined;

  constructor(private providers: LLMProvider[]) {}

  setProviders(providers: LLMProvider[]): void {
    this.providers = providers;
  }

  /** Set the current user-selected reasoning level. `auto` means no override. */
  setThinkingLevel(level: ThinkingSetting | undefined): void {
    this.thinkingLevel = level && level !== "auto" ? level : undefined;
  }

  all(): LLMProvider[] {
    return this.providers;
  }

  active(): LLMProvider[] {
    return this.providers.filter((p) => p.enabled && p.isConfigured());
  }

  isConfigured(): boolean {
    return this.active().length > 0;
  }

  providerFor(model: string): LLMProvider | undefined {
    const prefix = model.split(":")[0];
    const known = this.providers.find((p) => p.id === prefix);
    if (known) return known;
    return this.providers.find((p) => p.id === "ollama") ?? this.providers.find((p) => p.id === "llamacpp");
  }

  stripPrefix(model: string): string {
    const prefix = model.split(":")[0];
    if (this.providers.some((p) => p.id === prefix)) return model.slice(prefix.length + 1);
    return model;
  }

  async ping(): Promise<boolean> {
    const results = await Promise.all(this.active().map((p) => p.ping().catch(() => false)));
    return results.some(Boolean);
  }

  async listModels(): Promise<ModelInfo[]> {
    const lists = await Promise.all(this.active().map((p) => p.listModels().catch(() => [] as ModelInfo[])));
    return lists.flat();
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const provider = this.providerFor(req.model);
    if (!provider) throw new Error(`No provider configured for model "${req.model}".`);
    const effectiveThinking = this.thinkingLevel;
    const stripped: LLMChatRequest = {
      ...req,
      model: this.stripPrefix(req.model),
      options: effectiveThinking
        ? { ...(req.options ?? {}), thinkingLevel: effectiveThinking }
        : req.options,
    };
    yield* provider.chatStream(stripped, signal);
  }
}
