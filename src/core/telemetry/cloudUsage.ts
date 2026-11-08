import type { CloudModelUsage, CloudUsageSummary } from "../../shared/types";

export type PricingSource = "current" | "estimated" | "user-configured";

export interface CloudPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  source: PricingSource;
}

const MODEL_PRICING: Record<string, Omit<CloudPricing, "source">> = {
  // Anthropic
  "claude-3-7-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0, cachedInputPerMillion: 0.3 },
  "claude-3-5-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0, cachedInputPerMillion: 0.3 },
  "claude-3-5-haiku": { inputPerMillion: 0.8, outputPerMillion: 4.0, cachedInputPerMillion: 0.08 },
  "claude-3-opus": { inputPerMillion: 15.0, outputPerMillion: 75.0, cachedInputPerMillion: 1.5 },
  // OpenAI
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0, cachedInputPerMillion: 1.25 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 },
  "o1": { inputPerMillion: 15.0, outputPerMillion: 60.0, cachedInputPerMillion: 7.5 },
  "o3-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.55 },
  // Google Gemini
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4, cachedInputPerMillion: 0.025 },
  "gemini-1.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5.0, cachedInputPerMillion: 0.3125 },
  "gemini-1.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3, cachedInputPerMillion: 0.01875 },
  // DeepSeek
  "deepseek-chat": { inputPerMillion: 0.14, outputPerMillion: 0.28, cachedInputPerMillion: 0.014 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19, cachedInputPerMillion: 0.14 },
};

const USER_PRICING_OVERRIDES = new Map<string, CloudPricing>();

export function setUserModelPricing(modelName: string, pricing: Omit<CloudPricing, "source">): void {
  const norm = (modelName ?? "").toLowerCase().replace(/^(openai|anthropic|gemini|openrouter|custom):/, "");
  USER_PRICING_OVERRIDES.set(norm, { ...pricing, source: "user-configured" });
}

export function clearUserModelPricing(modelName?: string): void {
  if (modelName) {
    const norm = (modelName ?? "").toLowerCase().replace(/^(openai|anthropic|gemini|openrouter|custom):/, "");
    USER_PRICING_OVERRIDES.delete(norm);
  } else {
    USER_PRICING_OVERRIDES.clear();
  }
}

export function getModelPricing(modelName: string): CloudPricing {
  const norm = (modelName ?? "").toLowerCase().replace(/^(openai|anthropic|gemini|openrouter|custom):/, "");

  const userOverride = USER_PRICING_OVERRIDES.get(norm);
  if (userOverride) return userOverride;

  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (norm.includes(key)) return { ...pricing, source: "current" };
  }
  // Default cloud pricing fallback: $2.00/M in, $8.00/M out, $0.50/M cached (estimated)
  return { inputPerMillion: 2.0, outputPerMillion: 8.0, cachedInputPerMillion: 0.5, source: "estimated" };
}

export function estimateCloudCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number {
  const pricing = getModelPricing(model);
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion * 0.25;
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const cost =
    (uncachedInput * pricing.inputPerMillion +
      cachedTokens * cachedRate +
      outputTokens * pricing.outputPerMillion) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export class CloudUsageTracker {
  private sessionInput = 0;
  private sessionOutput = 0;
  private sessionCached = 0;
  private sessionSaved = 0;
  private sessionCost = 0;

  private totalInput = 0;
  private totalOutput = 0;
  private totalCached = 0;
  private totalSaved = 0;
  private totalCost = 0;

  private modelUsage = new Map<string, CloudModelUsage>();

  constructor(persisted?: Partial<CloudUsageSummary>) {
    if (persisted) {
      this.totalInput = persisted.totalInputTokens ?? 0;
      this.totalOutput = persisted.totalOutputTokens ?? 0;
      this.totalCached = persisted.totalCachedTokens ?? 0;
      this.totalSaved = persisted.totalSavedTokens ?? 0;
      this.totalCost = persisted.totalEstimatedCostUsd ?? 0;
      for (const m of persisted.byModel ?? []) {
        this.modelUsage.set(m.model, { ...m });
      }
    }
  }

  recordStep(event: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    savedTokens?: number;
  }): void {
    const cached = event.cachedTokens ?? 0;
    const saved = event.savedTokens ?? 0;
    const cost = estimateCloudCost(event.model, event.inputTokens, event.outputTokens, cached);

    this.sessionInput += event.inputTokens;
    this.sessionOutput += event.outputTokens;
    this.sessionCached += cached;
    this.sessionSaved += saved;
    this.sessionCost += cost;

    this.totalInput += event.inputTokens;
    this.totalOutput += event.outputTokens;
    this.totalCached += cached;
    this.totalSaved += saved;
    this.totalCost += cost;

    const existing = this.modelUsage.get(event.model) ?? {
      model: event.model,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      savedTokens: 0,
      estimatedCostUsd: 0,
    };

    existing.turns += 1;
    existing.inputTokens += event.inputTokens;
    existing.outputTokens += event.outputTokens;
    existing.cachedTokens += cached;
    existing.savedTokens += saved;
    existing.estimatedCostUsd = Math.round((existing.estimatedCostUsd + cost) * 1_000_000) / 1_000_000;

    this.modelUsage.set(event.model, existing);
  }

  getSummary(): CloudUsageSummary {
    return {
      sessionInputTokens: this.sessionInput,
      sessionOutputTokens: this.sessionOutput,
      sessionCachedTokens: this.sessionCached,
      sessionSavedTokens: this.sessionSaved,
      sessionEstimatedCostUsd: Math.round(this.sessionCost * 1_000_000) / 1_000_000,
      totalInputTokens: this.totalInput,
      totalOutputTokens: this.totalOutput,
      totalCachedTokens: this.totalCached,
      totalSavedTokens: this.totalSaved,
      totalEstimatedCostUsd: Math.round(this.totalCost * 1_000_000) / 1_000_000,
      byModel: Array.from(this.modelUsage.values()).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd),
    };
  }

  resetSession(): void {
    this.sessionInput = 0;
    this.sessionOutput = 0;
    this.sessionCached = 0;
    this.sessionSaved = 0;
    this.sessionCost = 0;
  }

  reset(): void {
    this.sessionInput = 0;
    this.sessionOutput = 0;
    this.sessionCached = 0;
    this.sessionSaved = 0;
    this.sessionCost = 0;

    this.totalInput = 0;
    this.totalOutput = 0;
    this.totalCached = 0;
    this.totalSaved = 0;
    this.totalCost = 0;

    this.modelUsage.clear();
  }
}

