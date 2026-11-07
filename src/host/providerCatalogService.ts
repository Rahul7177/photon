import type { ModelInfo } from "../shared/types";
import type { LLMProvider, ProviderModel } from "../core/llm/types";
import {
  OpenAICompatProvider,
  type OpenAICompatConfig,
} from "../core/llm/providers/openaiCompatProvider";
import { GeminiProvider } from "../core/llm/providers/geminiProvider";
import { AnthropicProvider } from "../core/llm/providers/anthropicProvider";
import {
  BLACKBOX_MODELS,
  customModel,
  isRecommendedModel,
} from "../core/llm/catalogs";

export interface ProviderStatusInfo {
  id: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  modelCount: number;
}

export interface ProviderCatalogStorage {
  getAddedModels(): ModelInfo[];
  setAddedModels(models: ModelInfo[]): Promise<void>;
  getCachedLiveModels(): Record<string, ModelInfo[]>;
  setCachedLiveModels(cache: Record<string, ModelInfo[]>): Promise<void>;
  getProviderEnabled(id: string): boolean;
  setProviderEnabled(id: string, enabled: boolean): Promise<void>;
  getSecretApiKey(id: string): Promise<string>;
  setSecretApiKey(id: string, apiKey: string): Promise<void>;
  deleteSecretApiKey(id: string): Promise<void>;
  getLlamaCppBaseUrl(): string;
  getCustomProviders(): OpenAICompatConfig[];
  setCustomProviders(providers: OpenAICompatConfig[]): Promise<void>;
}

/**
 * Convert user-added ModelInfo entries for a specific provider into ProviderModel records.
 */
export function toProviderModels(added: ModelInfo[], providerId: string): ProviderModel[] {
  return added
    .filter((m) => m.provider === providerId)
    .map((m) => ({
      id: m.name.startsWith(`${providerId}:`) ? m.name.slice(providerId.length + 1) : m.name,
      name: m.name,
      paramsB: m.paramsB,
      contextLength: m.contextLength,
      toolTrained: m.toolTrained,
      vision: m.vision,
      audio: m.audio,
      video: m.video,
      thinking: m.thinking,
      capabilities: m.capabilities,
      tier: m.tier,
    }));
}

/**
 * Choose up to `maxCount` recommended flagship models (or fallback to first 2)
 * when a cloud provider is connected for the first time and has no models in the picker yet.
 */
export function selectInitialPickerModels(
  providerId: string,
  liveModels: ModelInfo[],
  maxCount = 4
): ModelInfo[] {
  if (liveModels.length === 0) return [];
  const toAdd: ModelInfo[] = [];
  for (const m of liveModels) {
    const bare = m.name.startsWith(`${providerId}:`) ? m.name.slice(providerId.length + 1) : m.name;
    if (isRecommendedModel(providerId, bare)) {
      toAdd.push({
        ...customModel(bare, providerId),
        ...m,
        name: m.name.startsWith(`${providerId}:`) ? m.name : `${providerId}:${m.name}`,
        provider: providerId,
      });
      if (toAdd.length >= maxCount) break;
    }
  }
  if (toAdd.length === 0) {
    for (const m of liveModels.slice(0, 2)) {
      const bare = m.name.startsWith(`${providerId}:`) ? m.name.slice(providerId.length + 1) : m.name;
      toAdd.push({
        ...customModel(bare, providerId),
        ...m,
        name: m.name.startsWith(`${providerId}:`) ? m.name : `${providerId}:${m.name}`,
        provider: providerId,
      });
    }
  }
  return toAdd;
}

/**
 * Derive a unique slug ID for a custom OpenAI-compatible provider.
 */
export function deriveCustomProviderId(label: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let id =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "custom";
  while (taken.has(id)) {
    id = `${id}-2`;
  }
  return id;
}

/**
 * Coordinates cloud and local secondary provider configurations, custom model picker catalogs,
 * live model caching, and connection testing outside of PhotonController.
 */
export class ProviderCatalogService {
  readonly liveModelCache = new Map<string, ModelInfo[]>();

  constructor(private readonly storage: ProviderCatalogStorage) {}

  /** Restore cached live provider model lists from persistent storage into memory. */
  restoreLiveModelCache(): void {
    const cached = this.storage.getCachedLiveModels();
    for (const [id, mList] of Object.entries(cached)) {
      if (Array.isArray(mList) && mList.length > 0) {
        this.liveModelCache.set(id, mList);
      }
    }
  }

  addedModels(): ModelInfo[] {
    return this.storage.getAddedModels();
  }

  async setAddedModels(models: ModelInfo[]): Promise<void> {
    await this.storage.setAddedModels(models);
  }

  /** Add a model to a provider's active picker list and ensure the provider is enabled. */
  async addModelToPicker(providerId: string, model: ModelInfo): Promise<{ bare: string; prefixed: string }> {
    const bare = model.name.startsWith(`${providerId}:`)
      ? model.name.slice(providerId.length + 1)
      : model.name;
    const prefixed = `${providerId}:${bare}`;
    const added = this.addedModels();
    if (!added.some((m) => m.name === prefixed)) {
      added.push({
        ...customModel(bare, providerId),
        ...model,
        name: prefixed,
        provider: providerId,
      });
      await this.setAddedModels(added);
    }
    await this.storage.setProviderEnabled(providerId, true);
    return { bare, prefixed };
  }

  /** Remove a model from the custom picker catalog. Returns true if a model was removed. */
  async removeModelFromPicker(name: string): Promise<boolean> {
    const added = this.addedModels();
    const next = added.filter((m) => m.name !== name);
    if (next.length === added.length) return false;
    await this.setAddedModels(next);
    return true;
  }

  /** Build local llama.cpp OpenAI-compatible provider instance. */
  async buildLlamaCppProvider(): Promise<LLMProvider> {
    const baseUrl = this.storage.getLlamaCppBaseUrl() || "http://localhost:8080";
    const normalized = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
    const enabled = this.storage.getProviderEnabled("llamacpp");
    const apiKey = await this.storage.getSecretApiKey("llamacpp");
    const models = toProviderModels(this.addedModels(), "llamacpp");
    return new OpenAICompatProvider({
      id: "llamacpp",
      label: "llama.cpp",
      baseUrl: normalized,
      apiKey,
      enabled,
      models,
      requireApiKey: false,
    });
  }

  /** Build all cloud provider instances from settings + stored secrets + added picker models. */
  async buildCloudProviders(): Promise<LLMProvider[]> {
    const out: LLMProvider[] = [];
    const added = this.addedModels();
    const enabled = (id: string) => this.storage.getProviderEnabled(id);
    const apiKey = (id: string) => this.storage.getSecretApiKey(id);
    const addedFor = (id: string) => toProviderModels(added, id);

    out.push(
      new GeminiProvider({
        apiKey: await apiKey("gemini"),
        enabled: enabled("gemini"),
        models: addedFor("gemini"),
      })
    );

    out.push(
      new AnthropicProvider({
        apiKey: await apiKey("claude"),
        enabled: enabled("claude"),
        models: addedFor("claude"),
      })
    );

    out.push(
      new OpenAICompatProvider({
        id: "nvidia",
        label: "NVIDIA NIM",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: await apiKey("nvidia"),
        enabled: enabled("nvidia"),
        models: addedFor("nvidia"),
      })
    );

    out.push(
      new OpenAICompatProvider({
        id: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiKey: await apiKey("openai"),
        enabled: enabled("openai"),
        models: addedFor("openai"),
      })
    );

    out.push(
      new OpenAICompatProvider({
        id: "openrouter",
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: await apiKey("openrouter"),
        enabled: enabled("openrouter"),
        models: addedFor("openrouter"),
        extraHeaders: { "HTTP-Referer": "https://github.com/photon-vscode", "X-Title": "Photon" },
      })
    );

    out.push(
      new OpenAICompatProvider({
        id: "opencode",
        label: "OpenCode Zen",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: await apiKey("opencode"),
        enabled: enabled("opencode"),
        models: addedFor("opencode"),
      })
    );

    out.push(
      new OpenAICompatProvider({
        id: "blackbox",
        label: "Blackbox AI",
        baseUrl: "https://api.blackbox.ai",
        apiKey: await apiKey("blackbox"),
        enabled: enabled("blackbox"),
        keyInBody: true,
        extraHeaders: { "Agent-Id": "photon" },
        models: [
          ...BLACKBOX_MODELS,
          ...addedFor("blackbox").filter((m) => !BLACKBOX_MODELS.some((b) => b.id === m.id)),
        ],
      })
    );

    const custom = this.storage.getCustomProviders();
    for (const c of custom) {
      if (!c.id || !c.baseUrl) continue;
      out.push(
        new OpenAICompatProvider({
          id: c.id,
          label: c.label || c.id,
          baseUrl: c.baseUrl,
          apiKey: c.apiKey || (await apiKey(c.id)),
          enabled: c.enabled !== false,
          models: addedFor(c.id),
          extraHeaders: c.extraHeaders,
          keyInBody: c.keyInBody,
        })
      );
    }

    return out;
  }

  /** Compute status summary of every registered provider for the settings UI. */
  providerStatuses(providers: LLMProvider[], allLoadedModels: ModelInfo[]): ProviderStatusInfo[] {
    return providers.map((p) => ({
      id: p.id,
      label: p.label,
      enabled: p.enabled,
      configured: p.isConfigured(),
      modelCount:
        p.enabled && p.isConfigured()
          ? allLoadedModels.filter((m) => m.provider === p.id).length
          : 0,
    }));
  }

  /**
   * Fetch live models from a provider, cache them in memory + persistent storage,
   * and auto-populate initial flagship models if the provider had none in the picker yet.
   */
  async fetchAndCacheLiveModels(
    provider: LLMProvider
  ): Promise<{ models: ModelInfo[]; autoAddedCount: number }> {
    if (!provider.fetchLiveModels) {
      throw new Error("This provider does not support live model listing.");
    }
    const models = await provider.fetchLiveModels();
    this.liveModelCache.set(provider.id, models);

    try {
      const cached = { ...this.storage.getCachedLiveModels() };
      cached[provider.id] = models;
      await this.storage.setCachedLiveModels(cached);
    } catch {
      // non-blocking persistence
    }

    let autoAddedCount = 0;
    const added = this.addedModels();
    const existingForProv = added.filter((m) => m.provider === provider.id);
    if (existingForProv.length === 0 && models.length > 0) {
      const toAdd = selectInitialPickerModels(provider.id, models, 4);
      if (toAdd.length > 0) {
        added.push(...toAdd);
        await this.setAddedModels(added);
        autoAddedCount = toAdd.length;
      }
    }

    return { models, autoAddedCount };
  }

  /** Test a specific model on a provider with a lightweight ping prompt. */
  async testProviderModel(
    provider: LLMProvider | undefined,
    providerId: string,
    model: ModelInfo,
    timeoutMs = 20_000
  ): Promise<{
    providerId: string;
    model: ModelInfo;
    ok: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    const bare = model.name.startsWith(`${providerId}:`)
      ? model.name.slice(providerId.length + 1)
      : model.name;
    const resultModel: ModelInfo = {
      ...model,
      name: `${providerId}:${bare}`,
      provider: providerId,
    };

    if (!provider) {
      return {
        providerId,
        model: resultModel,
        ok: false,
        error: `Provider ${providerId} not found`,
      };
    }
    if (!provider.isConfigured()) {
      return {
        providerId,
        model: resultModel,
        ok: false,
        error: `${provider.label} has no API key set`,
      };
    }

    try {
      const start = Date.now();
      const stream = provider.chatStream(
        { model: bare, messages: [{ role: "user", content: "Reply with exactly: ok" }] },
        AbortSignal.timeout(timeoutMs)
      );
      let responded = false;
      for await (const chunk of stream) {
        if (chunk.message?.content || chunk.done) {
          responded = true;
          break;
        }
      }
      if (!responded) throw new Error("The model returned an empty response.");
      return {
        providerId,
        model: resultModel,
        ok: true,
        latencyMs: Date.now() - start,
      };
    } catch (e) {
      return {
        providerId,
        model: resultModel,
        ok: false,
        error: (e as Error).message,
      };
    }
  }
}

