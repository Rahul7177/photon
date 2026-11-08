import type { HostMessage, ProviderStatus } from "../shared/protocol";
import type { ModelInfo } from "../shared/types";
import type { LLMProvider } from "../core/llm/types";
import { ProviderManager } from "../core/llm/providerManager";
import { OllamaProvider } from "../core/llm/providers/ollamaProvider";
import { ProviderCatalogService } from "./providerCatalogService";
import { scanDiskOllamaModels } from "../core/adaptive/runtimeDetector";
import { matchInstalledModelName } from "../shared/types";

export interface ProviderServiceDeps {
  providers: ProviderManager;
  ollamaProvider: OllamaProvider;
  catalog: ProviderCatalogService;
  post: (msg: HostMessage) => void;
  output: { appendLine: (line: string) => void };
  onProvidersRebuilt?: () => Promise<void>;
}

/**
 * Manages provider instance life cycle, live model fetching, catalog reconciliation,
 * and fail-safe active provider retention.
 */
export class ProviderService {
  private models: ModelInfo[] = [];

  constructor(private readonly deps: ProviderServiceDeps) {}

  getModels(): ModelInfo[] {
    return this.models;
  }

  setModels(models: ModelInfo[]): void {
    this.models = models;
  }

  async rebuildProviders(): Promise<void> {
    try {
      const cloud = await this.deps.catalog.buildCloudProviders();
      const llamacpp = await this.deps.catalog.buildLlamaCppProvider();
      const locals: LLMProvider[] = [this.deps.ollamaProvider];
      if (llamacpp) locals.push(llamacpp);
      const next = [...locals, ...cloud];
      if (next.length > 0) {
        this.deps.providers.setProviders(next);
      }
      this.deps.output.appendLine(
        `[providers] active: ${this.deps.providers.active().map((p) => p.id).join(", ") || "none"}`
      );
    } catch (err) {
      this.deps.output.appendLine(
        `[providers] Provider refresh failed: ${err}. Preserving active provider configuration.`
      );
    }
  }

  async loadModels(
    selectedModel: string,
    preferredModel?: string
  ): Promise<{ models: ModelInfo[]; selectedModel: string }> {
    try {
      const all = await this.deps.providers.listModels();
      const diskModels = scanDiskOllamaModels();
      const existingNames = all.map((m) => m.name);
      for (const dm of diskModels) {
        if (!matchInstalledModelName(dm.name, existingNames)) {
          all.push(dm);
          existingNames.push(dm.name);
        }
      }
      this.models = all;
      const stillExists = this.models.some((m) => m.name === selectedModel);
      let nextSelected = selectedModel;
      if (!stillExists) {
        nextSelected =
          this.models.find((m) => m.name === preferredModel)?.name ??
          this.models[0]?.name ??
          "";
      }
      this.deps.output.appendLine(
        `[models] loaded ${this.models.length} model(s) across ${this.deps.providers.active().length} provider(s).`
      );
      return { models: this.models, selectedModel: nextSelected };
    } catch (e) {
      this.models = scanDiskOllamaModels();
      this.deps.output.appendLine(`[models] ${(e as Error).message}`);
      return { models: this.models, selectedModel };
    }
  }

  async pushLiveModels(id: string): Promise<boolean> {
    const p = this.deps.providers.all().find((x) => x.id === id);
    if (!p || !p.fetchLiveModels || !p.isConfigured()) return false;
    try {
      const { models, autoAddedCount } = await this.deps.catalog.fetchAndCacheLiveModels(p);
      this.deps.post({ type: "providerModels", payload: { id, models } });
      this.deps.output.appendLine(`[providers] ${id}: ${models.length} model(s) available to this key.`);

      if (autoAddedCount > 0 && this.deps.onProvidersRebuilt) {
        await this.deps.onProvidersRebuilt();
        this.deps.output.appendLine(`[providers] ${id}: Auto-added ${autoAddedCount} top model(s) to picker.`);
      }
      return true;
    } catch (e) {
      this.deps.post({
        type: "providerModels",
        payload: { id, models: [], error: (e as Error).message },
      });
      this.deps.output.appendLine(`[providers] ${id} live model list failed: ${(e as Error).message}`);
      return false;
    }
  }

  async autoRefreshConfiguredProviders(): Promise<void> {
    for (const p of this.deps.providers.all()) {
      if (p.id !== "ollama" && p.isConfigured() && p.fetchLiveModels) {
        void this.pushLiveModels(p.id);
      }
    }
  }

  providerStatuses(): ProviderStatus[] {
    return this.deps.catalog.providerStatuses(this.deps.providers.all(), this.models);
  }
}
