import { isLocalModel, type ModelInfo, type ThinkingLevel, type ThinkingSetting } from "../../shared/types";
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
    if (!providers || providers.length === 0) {
      // Never wipe out active working providers on an empty or failed refresh
      return;
    }
    this.providers = [...providers];
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
    // 1. Check for registered providers (e.g. "gemini", "claude", "openrouter", "openai", "nvidia", "custom", etc.)
    // Matches if the provider ID is a clean prefix followed by a colon (e.g. "openrouter:meta-llama/...").
    const direct = this.providers.find(
      (p) => p.id !== "manager" && model.startsWith(`${p.id}:`)
    );
    if (direct) return direct;

    // 2. Check if the model starts with a colon prefix that matches any provider by exact ID
    const prefix = model.split(":")[0];
    const known = this.providers.find((p) => p.id === prefix);
    if (known) return known;

    // 3. If the model carries a recognized cloud/custom provider prefix that isn't currently registered
    // (for instance a removed custom provider), never silently route it to local Ollama.
    if (!isLocalModel({ name: model })) {
      return undefined;
    }

    // Unknown prefix is an Ollama name:tag (e.g. "gemma4:e4b", "llama3:8b", "my-org/model:latest") —
    // Ollama tags always carry a colon, so this IS the normal local path.
    // Fall back to ollama, never throw here.
    return this.providers.find((p) => p.id === "ollama") ?? this.providers.find((p) => p.id === "llamacpp");
  }

  stripPrefix(model: string): string {
    // Match against registered provider IDs that are prefixes
    const direct = this.providers.find(
      (p) => p.id !== "manager" && model.startsWith(`${p.id}:`)
    );
    if (direct) {
      return model.slice(direct.id.length + 1);
    }

    const prefix = model.split(":")[0];
    if (this.providers.some((p) => p.id === prefix)) {
      return model.slice(prefix.length + 1);
    }
    return model;
  }

  async ping(): Promise<boolean> {
    // Bound aggregation: one hung provider must not hang the whole check.
    const results = await Promise.all(
      this.active().map((p) =>
        Promise.race([
          p.ping().catch(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), 15000)),
        ])
      )
    );
    return results.some(Boolean);
  }

  async listModels(): Promise<ModelInfo[]> {
    const lists = await Promise.all(
      this.active().map((p) =>
        Promise.race([
          p.listModels().catch(() => [] as ModelInfo[]),
          new Promise<ModelInfo[]>((r) => setTimeout(() => r([]), 20000)),
        ])
      )
    );
    return lists.flat();
  }

  async *chatStream(req: LLMChatRequest, signal?: AbortSignal): AsyncGenerator<LLMChatChunk> {
    const provider = this.providerFor(req.model);
    if (!provider) throw new Error(`No provider configured for model "${req.model}".`);
    if (provider.id !== "ollama" && !provider.enabled) {
      throw new Error(`${provider.label} is currently disabled. Enable it in Settings → Providers.`);
    }
    if (!provider.isConfigured()) {
      throw new Error(`${provider.label} is not configured. Add an API key or endpoint URL in Settings → Providers.`);
    }
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
