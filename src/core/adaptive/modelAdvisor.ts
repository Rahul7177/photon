import {
  isLocalModel,
  matchInstalledModelName,
  type FitAssessment,
  type HardwareSummary,
  type InstalledModelEvaluation,
  type MachineProfile,
  type ModelCapability,
  type ModelInfo,
  type ModelRecommendation,
  type RecommendationSet,
} from "../../shared/types";

/** Fraction of total RAM kept free for the OS / editor. */
export const RAM_SAFETY_FRACTION = 0.225;
/** VRAM kept free for the display + CUDA context. */
export const VRAM_RESERVE_GB = 0.5;
/** Default context used for fit calculations. */
export const DEFAULT_CONTEXT_TOKENS = 8192;

export type HardwareTier = "light" | "sweet" | "high";

export interface CatalogModel {
  name: string;
  label: string;
  /** Quantized weight size on disk / in memory, GB. */
  sizeGb: number;
  /** KV-cache cost per 1K context tokens, GB. */
  kvGbPer1k: number;
  tier: HardwareTier;
  capabilities: ModelCapability[];
  /** Per-capability quality rank, higher = better. */
  rank: Partial<Record<ModelCapability, number>>;
  blurb: string;
}

/** Curated, tested local models (checklist 3.2). */
export const MODEL_CATALOG: CatalogModel[] = [
  { name: "qwen2.5-coder:1.5b", label: "Qwen2.5 Coder 1.5B", sizeGb: 1.0, kvGbPer1k: 0.03, tier: "light", capabilities: ["coding", "autocomplete"], rank: { coding: 30, autocomplete: 80 }, blurb: "Fast autocompletions & small edits." },
  { name: "qwen2.5-coder:3b", label: "Qwen2.5 Coder 3B", sizeGb: 1.9, kvGbPer1k: 0.04, tier: "light", capabilities: ["coding", "autocomplete"], rank: { coding: 45, autocomplete: 70 }, blurb: "Solid syntax and single-file code assistant." },
  { name: "gemma4:e2b", label: "Gemma 4 E2B", sizeGb: 2.2, kvGbPer1k: 0.04, tier: "light", capabilities: ["coding", "reasoning", "multimodal"], rank: { coding: 40, reasoning: 40, multimodal: 55 }, blurb: "Compact reasoning & multimodal understanding." },
  { name: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", sizeGb: 4.7, kvGbPer1k: 0.06, tier: "sweet", capabilities: ["coding", "autocomplete"], rank: { coding: 70, autocomplete: 50 }, blurb: "State-of-the-art coding, reliable native tool calling, fast on consumer GPUs." },
  { name: "gemma4:e4b", label: "Gemma 4 E4B", sizeGb: 3.5, kvGbPer1k: 0.05, tier: "sweet", capabilities: ["coding", "reasoning", "multimodal"], rank: { coding: 55, reasoning: 55, multimodal: 70 }, blurb: "Multimodal, fast reasoning, fits comfortably in 4–6GB VRAM." },
  { name: "deepseek-r1:8b", label: "DeepSeek R1 8B", sizeGb: 4.9, kvGbPer1k: 0.07, tier: "sweet", capabilities: ["reasoning", "coding"], rank: { reasoning: 75, coding: 62 }, blurb: "Deep reasoning and complex bug diagnosis." },
  { name: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", sizeGb: 9.0, kvGbPer1k: 0.12, tier: "high", capabilities: ["coding"], rank: { coding: 80 }, blurb: "Near frontier-level coding accuracy." },
  { name: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", sizeGb: 20.0, kvGbPer1k: 0.25, tier: "high", capabilities: ["coding"], rank: { coding: 90 }, blurb: "Full codebase architecture refactoring." },
  { name: "command-r:35b", label: "Command R 35B", sizeGb: 21.0, kvGbPer1k: 0.25, tier: "high", capabilities: ["coding", "reasoning"], rank: { coding: 65, reasoning: 70 }, blurb: "128k-context agentic powerhouse." },
];

export interface HardwareInput {
  totalRamGb: number;
  freeRamGb: number;
  ramBufferGb: number;
  vramGb: number;
  gpuName?: string;
  gpuVendor?: string;
  cpuCores: number;
  /** True when GPU memory is the same pool as system RAM (Apple silicon). */
  unifiedMemory: boolean;
}

const GB = 1024 ** 3;

export function hardwareFromProfile(m: MachineProfile | null | undefined): HardwareInput {
  const totalRamGb = m ? m.totalRamBytes / GB : 8;
  const freeRamGb = m ? m.freeRamBytes / GB : totalRamGb / 2;
  const vendor = m?.gpu?.vendor;
  const unifiedMemory = vendor === "apple" || (m?.platform === "darwin" && m?.arch === "arm64");
  let vramGb = m?.gpu?.vramBytes ? m.gpu.vramBytes / GB : 0;
  // Apple silicon exposes ~65% of unified memory to the GPU.
  if (unifiedMemory) vramGb = totalRamGb * 0.65;
  return {
    totalRamGb,
    freeRamGb,
    ramBufferGb: totalRamGb * RAM_SAFETY_FRACTION,
    vramGb,
    gpuName: m?.gpu?.name,
    gpuVendor: vendor,
    cpuCores: m?.cpuCores ?? 4,
    unifiedMemory,
  };
}

/** Checklist 3.2 tiers: <4GB VRAM / ≤8GB RAM → light; 6–8GB VRAM / 16GB RAM → sweet; 12+/32+ → high. */
export function hardwareTier(hw: HardwareInput): HardwareTier {
  if (hw.vramGb >= 12 || hw.totalRamGb >= 32) return "high";
  if (hw.vramGb >= 6 || hw.totalRamGb >= 16) return "sweet";
  return "light";
}

/** Memory Required = weights + (ctx / 1024) × KV GB per 1K. */
export function memoryRequiredGb(m: Pick<CatalogModel, "sizeGb" | "kvGbPer1k">, ctxTokens: number): number {
  return m.sizeGb + (ctxTokens / 1024) * m.kvGbPer1k;
}

const GPU_BW = 260; // GB/s effective, mid-range consumer GPU (RTX 4060 class)
const APPLE_BW = 150;
const RAM_BW = 45; // GB/s dual-channel DDR5-ish

function round(n: number): number {
  return Math.max(1, Math.round(n));
}

function shortGpuName(name?: string): string {
  if (!name) return "GPU";
  return name.replace(/^NVIDIA\s+/i, "").replace(/GeForce\s+/i, "").replace(/\s+with Max-Q Design$/i, "").replace(/\s+(Laptop GPU|Max-Q)$/i, "").trim() || "GPU";
}

const fmtGb = (n: number) => (Math.round(n * 10) / 10).toString();

export function assessFit(
  model: Pick<CatalogModel, "sizeGb" | "kvGbPer1k">,
  hw: HardwareInput,
  ctxTokens = DEFAULT_CONTEXT_TOKENS
): FitAssessment {
  const required = memoryRequiredGb(model, ctxTokens);
  const usableRam = Math.max(0, hw.totalRamGb - hw.ramBufferGb);
  const usableVram = Math.max(0, hw.vramGb - VRAM_RESERVE_GB);
  const hasGpu = usableVram > 0;
  const gpuBw = hw.unifiedMemory ? APPLE_BW : GPU_BW;
  const base = { memRequiredGb: round1(required) };

  // 100% GPU resident.
  if (hasGpu && required <= usableVram) {
    const tok = Math.min(120, round(gpuBw / model.sizeGb));
    return {
      ...base,
      mode: "gpu",
      badge: "green",
      gpuGb: round1(required),
      ramGb: 0,
      tokPerSec: tok,
      label: `Fits 100% in your ${shortGpuName(hw.gpuName)} ${hw.unifiedMemory ? "unified memory" : "VRAM"} (~${tok} tok/s)`,
    };
  }

  // Hybrid GPU+RAM (weights spill into RAM but stay out of the OS buffer).
  if (hasGpu && required <= usableVram + usableRam) {
    const gpuPart = usableVram;
    const ramPart = required - gpuPart;
    const frac = Math.min(1, gpuPart / required);
    const secPerToken = (frac * model.sizeGb) / gpuBw + ((1 - frac) * model.sizeGb) / RAM_BW;
    const tok = round(1 / secPerToken);
    return {
      ...base,
      mode: "hybrid",
      badge: "yellow",
      gpuGb: round1(gpuPart),
      ramGb: round1(ramPart),
      tokPerSec: tok,
      label: `Hybrid GPU+RAM: ${fmtGb(gpuPart)}GB in VRAM, ${fmtGb(ramPart)}GB in RAM (~${tok} tok/s)`,
    };
  }

  // CPU only.
  if (!hasGpu && required <= usableRam) {
    const scale = Math.min(1, hw.cpuCores / 8);
    const tok = round((RAM_BW / model.sizeGb) * Math.max(0.4, scale));
    return {
      ...base,
      mode: "cpu",
      badge: "yellow",
      gpuGb: 0,
      ramGb: round1(required),
      tokPerSec: tok,
      label: `CPU-only: runs in system RAM (~${tok} tok/s)`,
    };
  }

  return {
    ...base,
    mode: "exceeds",
    badge: "red",
    gpuGb: 0,
    ramGb: 0,
    label: "Exceeds safe memory: heavy disk swap risk",
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const MODE_SCORE: Record<FitAssessment["mode"], number> = { gpu: 3, hybrid: 2, cpu: 1, exceeds: 0 };

export function summarizeHardware(hw: HardwareInput): HardwareSummary {
  const tier = hardwareTier(hw);
  const gpuLabel = hw.vramGb > 0
    ? `${Math.round(hw.vramGb)}GB ${hw.unifiedMemory ? "unified memory" : shortGpuName(hw.gpuName)}`
    : "no dedicated GPU";
  return {
    totalRamGb: round1(hw.totalRamGb),
    freeRamGb: round1(hw.freeRamGb),
    ramBufferGb: round1(hw.ramBufferGb),
    vramGb: round1(hw.vramGb),
    gpuName: hw.gpuName,
    gpuVendor: hw.gpuVendor,
    cpuCores: hw.cpuCores,
    tier,
    label: `${gpuLabel}, ${Math.round(hw.totalRamGb)}GB RAM`,
  };
}

export interface RecommendOptions {
  ctxTokens?: number;
  goal?: ModelCapability;
  /** Names already installed locally, flagged in the result. */
  installed?: string[];
  /** Full ModelInfo list for installed models to evaluate arbitrary local models. */
  installedModels?: ModelInfo[];
}

function inferModelMetadata(m: ModelInfo): {
  label: string;
  sizeGb: number;
  kvGbPer1k: number;
  capabilities: ModelCapability[];
  rank: Record<ModelCapability, number>;
} {
  const catalogMatch = MODEL_CATALOG.find((c) => matchInstalledModelName(c.name, [m.name]) !== undefined);
  const actualSizeGb =
    m.sizeBytes && m.sizeBytes > 0
      ? round1(m.sizeBytes / GB)
      : undefined;

  if (catalogMatch) {
    const sizeGb = actualSizeGb ?? catalogMatch.sizeGb;
    return {
      label: catalogMatch.label,
      sizeGb,
      kvGbPer1k: catalogMatch.kvGbPer1k,
      capabilities: catalogMatch.capabilities,
      rank: {
        coding: catalogMatch.rank.coding ?? 50,
        reasoning: catalogMatch.rank.reasoning ?? 45,
        multimodal: catalogMatch.rank.multimodal ?? 30,
        autocomplete: catalogMatch.rank.autocomplete ?? 40,
      },
    };
  }

  const lower = m.name.toLowerCase();
  const paramMatch = lower.match(/[:\-_]([a-z]?\d+(?:\.\d+)?)b\b/i) ?? lower.match(/(\d+(?:\.\d+)?)b/i);
  const paramB = paramMatch ? parseFloat(paramMatch[1].replace(/^[a-z]/i, "")) : 7;
  const sizeGb = actualSizeGb ?? round1(Math.max(0.8, paramB * 0.65));
  const kvGbPer1k = round1(Math.max(0.03, sizeGb * 0.013));

  const isCoder = /coder|codellama|starcoder|codestral|devstral|qwen2\.5-coder/i.test(lower);
  const isReasoning = /deepseek-r1|qwq|reason|think|o1|r1/i.test(lower);
  const isVision = Boolean(m.vision) || /vl|vision|llava|moondream|minicpm-v|gemma3|gemma4|pixtral/i.test(lower);
  const isSmallFast = paramB <= 3.5;

  const capabilities: ModelCapability[] = ["coding"];
  if (isReasoning || !isCoder) capabilities.push("reasoning");
  if (isVision) capabilities.push("multimodal");
  if (isCoder || isSmallFast) capabilities.push("autocomplete");

  const baseQuality = Math.min(92, Math.round(35 + Math.log2(Math.max(1, paramB)) * 14));
  const rank: Record<ModelCapability, number> = {
    coding: isCoder ? Math.min(95, baseQuality + 12) : baseQuality,
    reasoning: isReasoning ? Math.min(95, baseQuality + 15) : baseQuality - 4,
    multimodal: isVision ? Math.min(90, baseQuality + 10) : 10,
    autocomplete: isSmallFast ? 82 : isCoder ? 65 : 45,
  };

  return {
    label: m.name.replace(/^(ollama|llamacpp):/i, ""),
    sizeGb,
    kvGbPer1k,
    capabilities,
    rank,
  };
}

/**
 * Evaluate all currently installed local models on the machine (whether in MODEL_CATALOG or not)
 * and identify the best suitable installed model for the user's hardware and target capability.
 */
export function evaluateInstalledLocalModels(
  models: ModelInfo[],
  machine: MachineProfile | null | undefined,
  goal: ModelCapability = "coding",
  ctxTokens = DEFAULT_CONTEXT_TOKENS
): InstalledModelEvaluation[] {
  const hw = hardwareFromProfile(machine);
  const localModels = models.filter((m) => isLocalModel(m));
  if (localModels.length === 0) return [];

  const evals: InstalledModelEvaluation[] = localModels.map((m) => {
    const meta = inferModelMetadata(m);
    const fit = assessFit({ sizeGb: meta.sizeGb, kvGbPer1k: meta.kvGbPer1k }, hw, ctxTokens);
    const quality = meta.rank[goal] ?? 50;
    return {
      name: m.name,
      label: meta.label,
      sizeGb: meta.sizeGb,
      capabilities: meta.capabilities,
      fit,
      recommended: false,
      quality,
      reason: fit.label,
    };
  });

  const headroomOk = (r: InstalledModelEvaluation) =>
    r.fit.mode !== "gpu" || hw.vramGb - VRAM_RESERVE_GB - r.fit.memRequiredGb >= 0.2;

  let pick: InstalledModelEvaluation | undefined;
  for (const mode of ["gpu", "hybrid", "cpu"] as const) {
    const pool = evals
      .filter((r) => r.fit.mode === mode && headroomOk(r))
      .filter((r) => mode === "gpu" || (r.fit.tokPerSec ?? 0) >= 5)
      .sort(
        (a, b) =>
          Number(b.capabilities.includes(goal)) - Number(a.capabilities.includes(goal)) ||
          b.quality - a.quality
      );
    if (pool.length) {
      pick = pool[0];
      break;
    }
  }
  if (!pick && evals.length > 0) {
    pick = [...evals].sort((a, b) => MODE_SCORE[b.fit.mode] - MODE_SCORE[a.fit.mode] || b.quality - a.quality)[0];
  }

  if (pick) {
    pick.recommended = true;
    const capLabel =
      goal === "coding"
        ? "coding & tool use"
        : goal === "reasoning"
          ? "deep reasoning"
          : goal === "multimodal"
            ? "vision & multimodal"
            : "fast autocomplete";
    pick.reason = `Best installed model for ${capLabel} on your hardware (${pick.fit.label})`;
  }

  evals.sort(
    (a, b) =>
      Number(b.recommended) - Number(a.recommended) ||
      Number(b.capabilities.includes(goal)) - Number(a.capabilities.includes(goal)) ||
      MODE_SCORE[b.fit.mode] - MODE_SCORE[a.fit.mode] ||
      b.quality - a.quality
  );

  return evals;
}

/**
 * Rank the curated catalog for this machine. `recommended` is the best-quality
 * model that fits entirely on GPU (with 0.25 GB headroom); failing that, the best
 * hybrid, then the best CPU-only model.
 */
export function recommendModels(
  machine: MachineProfile | null | undefined,
  opts: RecommendOptions = {}
): RecommendationSet {
  const hw = hardwareFromProfile(machine);
  const ctx = opts.ctxTokens ?? DEFAULT_CONTEXT_TOKENS;
  const goal = opts.goal ?? "coding";
  const installedList = opts.installed ?? (opts.installedModels ? opts.installedModels.map((m) => m.name) : []);

  const rows: ModelRecommendation[] = MODEL_CATALOG.map((m) => {
    const fit = assessFit(m, hw, ctx);
    const matchedName = matchInstalledModelName(m.name, installedList);
    return {
      name: m.name,
      label: m.label,
      sizeGb: m.sizeGb,
      blurb: m.blurb,
      capabilities: m.capabilities,
      tier: m.tier,
      fit,
      installed: matchedName !== undefined,
      installedName: matchedName,
      recommended: false,
      quality: m.rank[goal] ?? 0,
    };
  });

  const relevant = rows.filter((r) => r.capabilities.includes(goal));
  const headroomOk = (r: ModelRecommendation) =>
    r.fit.mode !== "gpu" || hw.vramGb - VRAM_RESERVE_GB - r.fit.memRequiredGb >= 0.25;
  let pick: ModelRecommendation | undefined;
  for (const mode of ["gpu", "hybrid", "cpu"] as const) {
    const pool = relevant
      .filter((r) => r.fit.mode === mode && headroomOk(r))
      // Hybrid/CPU are slow: don't recommend a model slower than ~6 tok/s.
      .filter((r) => mode === "gpu" || (r.fit.tokPerSec ?? 0) >= 6)
      .sort((a, b) => b.quality - a.quality);
    if (pool.length) {
      pick = pool[0];
      break;
    }
  }
  if (pick) pick.recommended = true;

  rows.sort(
    (a, b) =>
      Number(b.recommended) - Number(a.recommended) ||
      Number(b.capabilities.includes(goal)) - Number(a.capabilities.includes(goal)) ||
      MODE_SCORE[b.fit.mode] - MODE_SCORE[a.fit.mode] ||
      b.quality - a.quality
  );

  const syntheticModels: ModelInfo[] =
    opts.installedModels ?? installedList.map((name) => ({ name, provider: "ollama" }));
  const evaluatedInstalled = evaluateInstalledLocalModels(syntheticModels, machine, goal, ctx);
  const bestInstalled = evaluatedInstalled.find((e) => e.recommended);

  const best = pick;
  return {
    hardware: summarizeHardware(hw),
    goal,
    ctxTokens: ctx,
    models: rows,
    recommendedName: best?.name,
    headline: best
      ? `${best.name} — Recommended for your ${summarizeHardware(hw).label}`
      : "No catalog model fits safely; try a smaller model or free up memory.",
    evaluatedInstalled,
    bestInstalledName: bestInstalled?.name,
  };
}
