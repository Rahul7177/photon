import {
  isLocalModel,
  matchInstalledModelName,
  type BenchResult,
  type ComplexityLevel,
  type FitAssessment,
  type HardwareSummary,
  type InstalledModelEvaluation,
  type LocalRuntimeId,
  type MachineProfile,
  type ModelCapability,
  type ModelInfo,
  type ModelRecommendation,
  type OllamaRuntimeModel,
  type PredictionValidation,
  type RecommendationSet,
} from "../../shared/types";
import { analyzeTask, toComplexity } from "../intelligence/policy";
import { estimateTokens } from "./tokens";

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
  {
    name: "qwen2.5-coder:1.5b",
    label: "Qwen2.5 Coder 1.5B",
    sizeGb: 1.0,
    kvGbPer1k: 0.03,
    tier: "light",
    capabilities: ["coding", "autocomplete"],
    rank: { coding: 30, autocomplete: 80 },
    blurb: "Fast autocompletions & small edits.",
  },
  {
    name: "qwen2.5-coder:3b",
    label: "Qwen2.5 Coder 3B",
    sizeGb: 1.9,
    kvGbPer1k: 0.04,
    tier: "light",
    capabilities: ["coding", "autocomplete"],
    rank: { coding: 45, autocomplete: 70 },
    blurb: "Solid syntax and single-file code assistant.",
  },
  {
    name: "gemma4:e2b",
    label: "Gemma 4 E2B",
    sizeGb: 2.2,
    kvGbPer1k: 0.04,
    tier: "light",
    capabilities: ["coding", "reasoning", "multimodal"],
    rank: { coding: 40, reasoning: 40, multimodal: 55 },
    blurb: "Compact reasoning & multimodal understanding.",
  },
  {
    name: "qwen2.5-coder:7b",
    label: "Qwen2.5 Coder 7B",
    sizeGb: 4.7,
    kvGbPer1k: 0.06,
    tier: "sweet",
    capabilities: ["coding", "autocomplete"],
    rank: { coding: 70, autocomplete: 50 },
    blurb: "State-of-the-art coding, reliable native tool calling, fast on consumer GPUs.",
  },
  {
    name: "gemma4:e4b",
    label: "Gemma 4 E4B",
    sizeGb: 3.5,
    kvGbPer1k: 0.05,
    tier: "sweet",
    capabilities: ["coding", "reasoning", "multimodal"],
    rank: { coding: 55, reasoning: 55, multimodal: 70 },
    blurb: "Multimodal, fast reasoning, fits comfortably in 4–6GB VRAM.",
  },
  {
    name: "deepseek-r1:8b",
    label: "DeepSeek R1 8B",
    sizeGb: 4.9,
    kvGbPer1k: 0.07,
    tier: "sweet",
    capabilities: ["reasoning", "coding"],
    rank: { reasoning: 75, coding: 62 },
    blurb: "Deep reasoning and complex bug diagnosis.",
  },
  {
    name: "qwen2.5-coder:14b",
    label: "Qwen2.5 Coder 14B",
    sizeGb: 9.0,
    kvGbPer1k: 0.12,
    tier: "high",
    capabilities: ["coding"],
    rank: { coding: 80 },
    blurb: "Near frontier-level coding accuracy.",
  },
  {
    name: "qwen2.5-coder:32b",
    label: "Qwen2.5 Coder 32B",
    sizeGb: 20.0,
    kvGbPer1k: 0.25,
    tier: "high",
    capabilities: ["coding"],
    rank: { coding: 90 },
    blurb: "Full codebase architecture refactoring.",
  },
  {
    name: "command-r:35b",
    label: "Command R 35B",
    sizeGb: 21.0,
    kvGbPer1k: 0.25,
    tier: "high",
    capabilities: ["coding", "reasoning"],
    rank: { coding: 65, reasoning: 70 },
    blurb: "128k-context agentic powerhouse.",
  },
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

/** Normalize a model's quantization tag (from explicit metadata or name suffix). */
export function normalizeQuantization(raw?: string, modelName?: string): string | undefined {
  const src = (raw || "").trim().toLowerCase();
  const matchFrom = (s: string) =>
    s.match(/\b(iq[1-4]_(?:xxs|xs|nl|s|m)|q[2-8]_[01k](?:_[sml])?|fp16|f16|bf16|mxfp4)\b/i)?.[1]?.toLowerCase();
  if (src) {
    const m = matchFrom(src);
    if (m) return m === "fp16" ? "f16" : m;
    if (/^[qf]/i.test(src) || /^iq/i.test(src)) return src;
  }
  if (modelName) {
    const m = matchFrom(modelName.toLowerCase());
    if (m) return m === "fp16" ? "f16" : m;
  }
  return undefined;
}

/** Approximate average weight bytes per parameter (including block metadata) for a quant. */
export function bytesPerParamForQuant(quant?: string): number {
  const q = (quant ?? "").toLowerCase();
  if (!q) return 0.65;
  if (q.startsWith("q2") || q.startsWith("iq2") || q.startsWith("iq1")) return 0.36;
  if (q.startsWith("q3") || q.startsWith("iq3")) return 0.46;
  if (q === "q4_0" || q.startsWith("iq4") || q === "q4_k_s" || q === "mxfp4") return 0.56;
  if (q.startsWith("q4")) return 0.62;
  if (q.startsWith("q5")) return 0.74;
  if (q.startsWith("q6")) return 0.85;
  if (q.startsWith("q8")) return 1.08;
  if (q === "f16" || q === "fp16" || q === "bf16") return 2.05;
  return 0.65;
}

function kvScaleForQuant(kvQuant?: "f16" | "q8_0" | "q4_0"): number {
  if (kvQuant === "q8_0") return 0.55;
  if (kvQuant === "q4_0") return 0.30;
  return 1.0;
}

const RUNTIME_PROFILES: Record<LocalRuntimeId, { overheadGb: number; bwFactor: number; label: string }> = {
  ollama: { overheadGb: 0.4, bwFactor: 1.0, label: "Ollama" },
  llamacpp: { overheadGb: 0.25, bwFactor: 1.08, label: "llama.cpp" },
  lmstudio: { overheadGb: 0.45, bwFactor: 0.98, label: "LM Studio" },
  vllm: { overheadGb: 0.9, bwFactor: 1.15, label: "vLLM" },
};

export function runtimeOverheadGb(runtime?: LocalRuntimeId): number {
  return RUNTIME_PROFILES[runtime ?? "ollama"]?.overheadGb ?? 0.4;
}

/** Effective GPU memory bandwidth (GB/s) estimated from GPU SKU and runtime. */
export function estimateGpuBandwidth(hw: HardwareInput, runtime: LocalRuntimeId = "ollama"): number {
  const bwFactor = RUNTIME_PROFILES[runtime]?.bwFactor ?? 1.0;
  const g = (hw.gpuName ?? "").toLowerCase();
  let bw: number;
  if (hw.unifiedMemory) {
    if (/ultra/i.test(g)) bw = 480;
    else if (/max/i.test(g)) bw = 320;
    else if (/m[34]\s*pro/i.test(g)) bw = 180;
    else if (/m[12]\s*pro/i.test(g)) bw = 160;
    else bw = APPLE_BW;
  } else if (/5090|4090|h200|h100|a100/i.test(g)) {
    bw = 760;
  } else if (/5080|4080|3090|7900\s*xtx|a6000/i.test(g)) {
    bw = 560;
  } else if (/4070\s*(ti|super)|3080|7900\s*xt|7800\s*xt/i.test(g)) {
    bw = 420;
  } else if (/4070|3070|6800|7700\s*xt/i.test(g)) {
    bw = 340;
  } else if (/3050|2060|1660|1650|6600/i.test(g)) {
    bw = 180;
  } else if (/(uhd|iris|vega|radeon\s+graphics)/i.test(g) && hw.vramGb < 4) {
    bw = 85;
  } else {
    bw = GPU_BW;
  }
  return bw * bwFactor;
}

/** Memory Required = weights + (ctx / 1024) * KV GB per 1K. */
export function memoryRequiredGb(
  m: Pick<CatalogModel, "sizeGb" | "kvGbPer1k">,
  ctxTokens: number,
  kvQuantization?: "f16" | "q8_0" | "q4_0"
): number {
  return m.sizeGb + (ctxTokens / 1024) * m.kvGbPer1k * kvScaleForQuant(kvQuantization);
}

const GPU_BW = 260; // GB/s effective, mid-range consumer GPU (RTX 4060 class)
const APPLE_BW = 150;
const RAM_BW = 45; // GB/s dual-channel DDR5-ish

function round(n: number): number {
  return Math.max(1, Math.round(n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function shortGpuName(name?: string): string {
  if (!name) return "GPU";
  return (
    name
      .replace(/^NVIDIA\s+/i, "")
      .replace(/GeForce\s+/i, "")
      .replace(/\s+with Max-Q Design$/i, "")
      .replace(/\s+(Laptop GPU|Max-Q)$/i, "")
      .trim() || "GPU"
  );
}

const fmtGb = (n: number) => (Math.round(n * 10) / 10).toString();

function normalizeHardwareTier(tier?: string): HardwareTier | "unknown" {
  const t = (tier ?? "").toLowerCase();
  if (t === "light" || t === "low") return "light";
  if (t === "sweet" || t === "mid") return "sweet";
  if (t === "high") return "high";
  return "unknown";
}

function extractParamTag(normName: string): string | undefined {
  return normName.match(/(?:^|[:\-_])([a-z]?\d+(?:\.\d+)?b)(?:$|[:\-_])/i)?.[1]?.toLowerCase();
}

/**
 * Finds a matching, compatible, and unexpired benchmark result for a model.
 * Prefers exact `model:tag` match before falling back to compatible base-name variants,
 * checks methodology version & positive throughput, and normalizes tier names ("low"->"light", "mid"->"sweet").
 */
export function findMatchingBenchmark(
  modelName: string,
  benchmarks: Map<string, BenchResult> | Record<string, BenchResult> | BenchResult[] | undefined,
  hw?: HardwareInput
): BenchResult | undefined {
  if (!benchmarks) return undefined;

  let benchList: BenchResult[];
  if (benchmarks instanceof Map) {
    benchList = Array.from(benchmarks.values());
  } else if (Array.isArray(benchmarks)) {
    benchList = benchmarks;
  } else {
    benchList = Object.values(benchmarks);
  }

  const normTarget = modelName.toLowerCase().replace(/^(ollama|llamacpp|lmstudio|vllm):/i, "");
  const baseTarget = normTarget.split(":")[0];
  const targetParamTag = extractParamTag(normTarget);
  const currentTier = hw ? hardwareTier(hw) : undefined;
  const MAX_BENCH_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  const isValid = (b: BenchResult): boolean => {
    if (b.ranAt && Date.now() - b.ranAt > MAX_BENCH_AGE_MS) return false;
    if (typeof b.methodologyVersion === "number" && b.methodologyVersion < 1) return false;
    if (typeof b.tokensPerSec !== "number" || b.tokensPerSec <= 0 || !Number.isFinite(b.tokensPerSec)) {
      return false;
    }
    if (currentTier && b.hardwareClass) {
      const benchTier = normalizeHardwareTier(b.hardwareClass);
      if (benchTier !== "unknown" && benchTier !== currentTier) return false;
    }
    return true;
  };

  const valid = benchList.filter(isValid);
  const exact = valid.find(
    (b) => b.model.toLowerCase().replace(/^(ollama|llamacpp|lmstudio|vllm):/i, "") === normTarget
  );
  if (exact) return exact;

  return valid.find((b) => {
    const bModel = b.model.toLowerCase().replace(/^(ollama|llamacpp|lmstudio|vllm):/i, "");
    if (bModel.split(":")[0] !== baseTarget) return false;
    const bParamTag = extractParamTag(bModel);
    return !targetParamTag || !bParamTag || bParamTag === targetParamTag;
  });
}

export interface FitPredictOptions {
  measuredBenchTps?: number;
  quantization?: string;
  kvQuantization?: "f16" | "q8_0" | "q4_0";
  runtime?: LocalRuntimeId;
  /** True when `model.sizeGb` already reflects the target quantization (e.g. disk `sizeBytes`). */
  sizeMatchesQuant?: boolean;
  /** Empirical calibration multiplier (actual/predicted tok/s) learned from live turns. */
  calibrationScale?: number;
  /** Optional live runtime entry (/api/ps) to validate prediction against actual residency. */
  runtimeModel?: OllamaRuntimeModel;
  /** Live measured tok/s observed during actual inference turns. */
  liveMeasuredTps?: number;
}

export interface LiveObservation {
  model: string;
  tps: number;
  observedAt: number;
  ctxTokens?: number;
}

/** Validate predicted residency and throughput against live runtime telemetry (/api/ps) and measured tok/s. */
export function validatePredictionAgainstRuntime(
  predicted: FitAssessment,
  runtimeModel?: OllamaRuntimeModel,
  measuredTps?: number
): PredictionValidation {
  const predictedGpuPercent =
    predicted.gpuPercent ??
    (predicted.mode === "gpu"
      ? 100
      : predicted.mode === "cpu"
        ? 0
        : Math.round((predicted.gpuGb / Math.max(0.1, predicted.memRequiredGb)) * 100));
  const actualGpuPercent = runtimeModel ? runtimeModel.gpuPercent : undefined;
  const actualMemoryGb =
    runtimeModel && runtimeModel.sizeBytes > 0 ? round1(runtimeModel.sizeBytes / GB) : undefined;
  const actualContextTokens =
    runtimeModel && runtimeModel.contextLength > 0 ? runtimeModel.contextLength : undefined;
  const actualTokPerSec =
    typeof measuredTps === "number" && measuredTps > 0 && Number.isFinite(measuredTps)
      ? Math.round(measuredTps)
      : undefined;
  const predictedTokPerSec = predicted.tokPerSec;
  const calibrationFactor =
    actualTokPerSec !== undefined && predictedTokPerSec && predictedTokPerSec > 0
      ? round2(actualTokPerSec / predictedTokPerSec)
      : undefined;

  if (actualGpuPercent === undefined && actualTokPerSec === undefined) {
    return {
      status: "unverified",
      predictedGpuPercent,
      predictedTokPerSec,
      detail: "Awaiting live runtime telemetry or benchmark",
    };
  }

  let status: PredictionValidation["status"] = "matched";
  if (actualGpuPercent !== undefined && predictedGpuPercent >= 90 && actualGpuPercent < 70) {
    status = "more_offload";
  } else if (calibrationFactor !== undefined && calibrationFactor < 0.72) {
    status = "slower";
  } else if (calibrationFactor !== undefined && calibrationFactor > 1.35) {
    status = "faster";
  }

  const parts: string[] = [];
  if (actualGpuPercent !== undefined) {
    const memNote = actualMemoryGb !== undefined ? ` (${actualMemoryGb}GB)` : "";
    parts.push(`Live ${actualGpuPercent}% GPU${memNote} vs ${predictedGpuPercent}% pred`);
  }
  if (actualTokPerSec !== undefined) {
    const predNote = predictedTokPerSec !== undefined ? ` vs ${predictedTokPerSec}` : "";
    parts.push(`${actualTokPerSec} tok/s${predNote} live`);
  }

  return {
    status,
    predictedGpuPercent,
    actualGpuPercent,
    predictedTokPerSec,
    actualTokPerSec,
    actualMemoryGb,
    actualContextTokens,
    calibrationFactor,
    detail: parts.join(" · "),
  };
}

function classifyPressure(
  mode: FitAssessment["mode"],
  required: number,
  usableVram: number,
  totalPoolGb: number,
  isPressure: boolean
): NonNullable<FitAssessment["pressure"]> {
  if (mode === "exceeds") return "critical";
  if (mode === "gpu") {
    const util = usableVram > 0 ? required / usableVram : 1;
    if (isPressure || util >= 0.92) return "high";
    if (util >= 0.78) return "moderate";
    return "low";
  }
  const poolUtil = totalPoolGb > 0 ? required / totalPoolGb : 1;
  if (isPressure || poolUtil >= 0.88) return "high";
  return "moderate";
}

function floor1k(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.floor(n) * 1024);
}

/**
 * Predict hardware fit, memory pressure, safe context limit, and throughput across runtime,
 * quantization, and context length, optionally calibrated and validated against live measurements.
 */
export function assessFit(
  model: Pick<CatalogModel, "sizeGb" | "kvGbPer1k">,
  hw: HardwareInput,
  ctxTokens = DEFAULT_CONTEXT_TOKENS,
  measuredBenchOrOpts?: number | FitPredictOptions
): FitAssessment {
  const opts: FitPredictOptions =
    typeof measuredBenchOrOpts === "number"
      ? { measuredBenchTps: measuredBenchOrOpts }
      : measuredBenchOrOpts ?? {};
  const runtime: LocalRuntimeId = opts.runtime ?? "ollama";
  const quantization = normalizeQuantization(opts.quantization);
  const weightScale =
    quantization && !opts.sizeMatchesQuant ? bytesPerParamForQuant(quantization) / 0.625 : 1.0;
  const effectiveSizeGb = Math.max(0.4, round2(model.sizeGb * weightScale));
  const effectiveKvPer1k = Math.max(0.015, model.kvGbPer1k * kvScaleForQuant(opts.kvQuantization));
  const overheadGb = runtimeOverheadGb(runtime);
  const required = memoryRequiredGb(
    { sizeGb: effectiveSizeGb, kvGbPer1k: effectiveKvPer1k },
    ctxTokens
  ) + overheadGb;

  // 1. Nominal usable RAM based on safety reserve
  const nominalUsableRam = Math.max(0, hw.totalRamGb - hw.ramBufferGb);

  // 2. Usable RAM bounded by actual free RAM under pressure
  let usableRam = nominalUsableRam;
  let isPressure = false;
  if (hw.freeRamGb > 0) {
    const freeWithMargin = Math.max(0, hw.freeRamGb - Math.min(2.0, hw.totalRamGb * 0.08));
    if (freeWithMargin < nominalUsableRam) {
      usableRam = Math.max(0.5, freeWithMargin);
      isPressure = true;
    }
  }

  const usableVram = Math.max(0, hw.vramGb - VRAM_RESERVE_GB);
  const hasGpu = usableVram > 0;
  // On unified-memory SoCs (Apple Silicon), VRAM and RAM share the same physical RAM pool.
  const totalPoolGb = hw.unifiedMemory ? usableRam : usableVram + usableRam;
  const gpuBw = estimateGpuBandwidth(hw, runtime);
  const cal = Math.max(0.55, Math.min(1.55, opts.calibrationScale ?? 1.0));
  // Attention/KV bandwidth overhead above 8K context slightly reduces decode tok/s.
  const ctxFactor = ctxTokens <= 8192 ? 1.0 : 1 / (1 + 0.14 * Math.log2(ctxTokens / 8192));

  // Max context window that remains resident in VRAM (when weights fit) or safe total pool
  const vramHeadroom = (hw.unifiedMemory ? Math.min(usableVram, usableRam) : usableVram) - effectiveSizeGb - overheadGb;
  const poolHeadroom = totalPoolGb - effectiveSizeGb - overheadGb;
  const gpuSafeCtx = hasGpu && vramHeadroom > 0 ? floor1k(vramHeadroom / effectiveKvPer1k) : 0;
  const poolSafeCtx = poolHeadroom > 0 ? floor1k(poolHeadroom / effectiveKvPer1k) : 0;
  const maxSafeContextTokens = gpuSafeCtx >= 2048 ? gpuSafeCtx : poolSafeCtx;

  const base = {
    memRequiredGb: round1(required),
    maxSafeContextTokens,
    runtime,
    ...(quantization ? { quantization } : {}),
  };

  const benchTps = opts.measuredBenchTps;
  const hasBench = typeof benchTps === "number" && benchTps > 0;

  let result: FitAssessment;

  // 100% GPU resident (unified machines must also fit within usable physical RAM)
  if (hasGpu && required <= usableVram && (!hw.unifiedMemory || required <= usableRam)) {
    const useBenchDirectly = hasBench && ctxTokens <= 16384;
    const rawEstTok = Math.min(160, round((gpuBw / effectiveSizeGb) * ctxFactor * cal));
    const tok = useBenchDirectly
      ? Math.round(benchTps)
      : hasBench
        ? Math.max(1, Math.round(benchTps * ctxFactor))
        : rawEstTok;
    const speedLabel = useBenchDirectly
      ? `${tok} tok/s (measured benchmark)`
      : `~${tok} tok/s (estimated)`;
    const gpuPercent = 100;
    result = {
      ...base,
      mode: "gpu",
      badge: "green",
      gpuGb: round1(required),
      ramGb: 0,
      gpuPercent,
      pressure: classifyPressure("gpu", required, usableVram, totalPoolGb, isPressure),
      tokPerSec: tok,
      isEstimate: !useBenchDirectly,
      label: `Fits 100% in your ${shortGpuName(hw.gpuName)} ${
        hw.unifiedMemory ? "unified memory" : "VRAM"
      } (${speedLabel})`,
    };
  } else if (hasGpu && required <= totalPoolGb) {
    // Hybrid GPU+RAM (weights/KV spill into system RAM)
    const gpuPart = Math.min(usableVram, required);
    const ramPart = Math.max(0, required - gpuPart);
    const frac = Math.min(1, gpuPart / Math.max(0.1, required));
    const secPerToken = (frac * effectiveSizeGb) / gpuBw + ((1 - frac) * effectiveSizeGb) / RAM_BW;
    const useBenchDirectly = hasBench && ctxTokens <= 16384;
    const tok = useBenchDirectly
      ? Math.round(benchTps)
      : round((1 / secPerToken) * ctxFactor * cal);
    const speedLabel = useBenchDirectly
      ? `${tok} tok/s (measured benchmark)`
      : `~${tok} tok/s (estimated)`;
    const pressureNote = isPressure ? " — note: free RAM is currently tight" : "";
    const gpuPercent = Math.max(0, Math.min(99, Math.round(frac * 100)));
    result = {
      ...base,
      mode: "hybrid",
      badge: "yellow",
      gpuGb: round1(gpuPart),
      ramGb: round1(ramPart),
      gpuPercent,
      pressure: classifyPressure("hybrid", required, usableVram, totalPoolGb, isPressure),
      tokPerSec: tok,
      isEstimate: !useBenchDirectly,
      label: `Hybrid GPU+RAM: ${fmtGb(gpuPart)}GB VRAM + ${fmtGb(ramPart)}GB RAM (${speedLabel})${pressureNote}`,
    };
  } else if (!hasGpu && required <= usableRam) {
    // CPU only
    const scale = Math.min(1, hw.cpuCores / 8);
    const useBenchDirectly = hasBench && ctxTokens <= 16384;
    const tok = useBenchDirectly
      ? Math.round(benchTps)
      : round((RAM_BW / effectiveSizeGb) * Math.max(0.4, scale) * ctxFactor * cal);
    const speedLabel = useBenchDirectly
      ? `${tok} tok/s (measured benchmark)`
      : `~${tok} tok/s (estimated)`;
    const pressureNote = isPressure ? " — note: free RAM is currently tight" : "";
    result = {
      ...base,
      mode: "cpu",
      badge: "yellow",
      gpuGb: 0,
      ramGb: round1(required),
      gpuPercent: 0,
      pressure: classifyPressure("cpu", required, usableVram, totalPoolGb, isPressure),
      tokPerSec: tok,
      isEstimate: !useBenchDirectly,
      label: `CPU-only: runs in system RAM (${speedLabel})${pressureNote}`,
    };
  } else {
    const gpuPercent = hasGpu ? Math.min(99, Math.round((usableVram / required) * 100)) : 0;
    result = {
      ...base,
      mode: "exceeds",
      badge: "red",
      gpuGb: 0,
      ramGb: 0,
      gpuPercent,
      pressure: "critical",
      isEstimate: true,
      label: isPressure
        ? `Exceeds safe memory: requires ${fmtGb(required)}GB, but only ${fmtGb(hw.freeRamGb)}GB RAM currently free`
        : `Exceeds safe memory: requires ${fmtGb(required)}GB (heavy disk swap risk)`,
    };
  }

  if (opts.runtimeModel || opts.liveMeasuredTps !== undefined || hasBench) {
    result.validation = validatePredictionAgainstRuntime(
      result,
      opts.runtimeModel,
      opts.liveMeasuredTps ?? (hasBench ? benchTps : undefined)
    );
  }
  return result;
}

const MODE_SCORE: Record<FitAssessment["mode"], number> = { gpu: 3, hybrid: 2, cpu: 1, exceeds: 0 };

export function summarizeHardware(hw: HardwareInput): HardwareSummary {
  const tier = hardwareTier(hw);
  const gpuLabel =
    hw.vramGb > 0
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
  /** Optional prompt or task description for task-specific recommendation. */
  taskPrompt?: string;
  /** Execution mode used when interpreting `taskPrompt`. */
  taskMode?: "chat" | "plan" | "agent";
  /** Target local runtime to model memory overhead & bandwidth for. */
  runtime?: LocalRuntimeId;
  /** Quantization tag override when assessing unquantized/catalog models. */
  quantization?: string;
  /** KV cache quantization mode. */
  kvQuantization?: "f16" | "q8_0" | "q4_0";
  /** Names already installed locally, flagged in the result. */
  installed?: string[];
  /** Full ModelInfo list for installed models to evaluate arbitrary local models. */
  installedModels?: ModelInfo[];
  /** Benchmark results by model name to supply measured tokens/sec and tool reliability. */
  benchmarks?: Map<string, BenchResult> | Record<string, BenchResult> | BenchResult[];
  /** Live /api/ps runtime telemetry for validating residency predictions. */
  runtimeModels?: OllamaRuntimeModel[];
  /** Observed live tok/s per model (e.g. recent turn generation stats). */
  liveObservations?: LiveObservation[] | Record<string, number> | Map<string, number>;
}

interface InferredMetadata {
  label: string;
  sizeGb: number;
  kvGbPer1k: number;
  capabilities: ModelCapability[];
  rank: Record<ModelCapability, number>;
  quantization?: string;
  runtime: LocalRuntimeId;
  sizeIsActual: boolean;
  toolTrained?: boolean;
  thinking?: boolean;
}

function normModelKey(name: string): string {
  return name.toLowerCase().replace(/^(ollama|llamacpp|lmstudio|vllm):/i, "");
}

function findRuntimeModel(
  modelName: string,
  runtimeModels?: OllamaRuntimeModel[]
): OllamaRuntimeModel | undefined {
  if (!runtimeModels?.length) return undefined;
  const target = normModelKey(modelName);
  const exact = runtimeModels.find((r) => normModelKey(r.name) === target);
  if (exact) return exact;
  const baseTarget = target.split(":")[0];
  const targetParam = extractParamTag(target);
  return runtimeModels.find((r) => {
    const rKey = normModelKey(r.name);
    if (rKey.split(":")[0] !== baseTarget) return false;
    const rParam = extractParamTag(rKey);
    return !targetParam || !rParam || rParam === targetParam;
  });
}

function findLiveTps(
  modelName: string,
  liveObservations?: RecommendOptions["liveObservations"]
): number | undefined {
  if (!liveObservations) return undefined;
  const list: LiveObservation[] = Array.isArray(liveObservations)
    ? liveObservations
    : liveObservations instanceof Map
      ? Array.from(liveObservations.entries()).map(([model, tps]) => ({ model, tps, observedAt: 0 }))
      : Object.entries(liveObservations).map(([model, tps]) => ({ model, tps, observedAt: 0 }));
  const target = normModelKey(modelName);
  const exact = list.find((o) => normModelKey(o.model) === target && o.tps > 0);
  if (exact) return exact.tps;
  const baseTarget = target.split(":")[0];
  const targetParam = extractParamTag(target);
  return list.find((o) => {
    if (o.tps <= 0) return false;
    const key = normModelKey(o.model);
    if (key.split(":")[0] !== baseTarget) return false;
    const param = extractParamTag(key);
    return !targetParam || !param || param === targetParam;
  })?.tps;
}

function deriveCalibrationScale(
  candidates: { name: string; sizeGb: number; kvGbPer1k: number; quantization?: string; sizeIsActual?: boolean }[],
  hw: HardwareInput,
  ctxTokens: number,
  runtime: LocalRuntimeId,
  kvQuantization?: "f16" | "q8_0" | "q4_0",
  benchmarks?: RecommendOptions["benchmarks"],
  liveObservations?: RecommendOptions["liveObservations"]
): number {
  const ratios: number[] = [];
  for (const c of candidates) {
    const bench = findMatchingBenchmark(c.name, benchmarks, hw);
    const live = findLiveTps(c.name, liveObservations);
    const measured = live ?? bench?.tokensPerSec;
    if (!measured || measured <= 0) continue;
    const baseline = assessFit({ sizeGb: c.sizeGb, kvGbPer1k: c.kvGbPer1k }, hw, ctxTokens, {
      runtime,
      quantization: c.quantization,
      kvQuantization,
      sizeMatchesQuant: c.sizeIsActual ?? true,
    });
    if (baseline.tokPerSec && baseline.tokPerSec > 0 && baseline.mode !== "exceeds") {
      ratios.push(measured / baseline.tokPerSec);
    }
  }
  if (!ratios.length) return 1.0;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  return round2(Math.max(0.55, Math.min(1.55, median)));
}

function inferModelMetadata(m: ModelInfo, overrideQuant?: string, overrideRuntime?: LocalRuntimeId): InferredMetadata {
  const catalogMatch = MODEL_CATALOG.find((c) => matchInstalledModelName(c.name, [m.name]) !== undefined);
  const actualSizeGb = m.sizeBytes && m.sizeBytes > 0 ? round1(m.sizeBytes / GB) : undefined;
  const quantization = normalizeQuantization(overrideQuant ?? m.quantization, m.name);
  const runtime: LocalRuntimeId =
    overrideRuntime ??
    (m.provider === "llamacpp" || m.provider === "lmstudio" || m.provider === "vllm" ? m.provider : "ollama");

  if (catalogMatch) {
    const sizeGb =
      actualSizeGb ??
      (quantization
        ? round1(catalogMatch.sizeGb * (bytesPerParamForQuant(quantization) / 0.625))
        : catalogMatch.sizeGb);
    const caps = new Set<ModelCapability>(catalogMatch.capabilities);
    if (m.vision) caps.add("multimodal");
    if (m.thinking) caps.add("reasoning");
    return {
      label: catalogMatch.label,
      sizeGb,
      kvGbPer1k: catalogMatch.kvGbPer1k,
      capabilities: [...caps],
      rank: {
        coding: (catalogMatch.rank.coding ?? 50) + (m.toolTrained ? 4 : 0),
        reasoning: (catalogMatch.rank.reasoning ?? 45) + (m.thinking ? 6 : 0),
        multimodal: m.vision ? Math.max(60, catalogMatch.rank.multimodal ?? 30) : (catalogMatch.rank.multimodal ?? 30),
        autocomplete: catalogMatch.rank.autocomplete ?? 40,
      },
      quantization,
      runtime,
      sizeIsActual: Boolean(actualSizeGb),
      toolTrained: m.toolTrained,
      thinking: m.thinking,
    };
  }

  const lower = m.name.toLowerCase();
  const paramMatch =
    lower.match(/[:\-_]([a-z]?\d+(?:\.\d+)?)b\b/i) ?? lower.match(/(\d+(?:\.\d+)?)b/i);
  const inferredFromSize = actualSizeGb
    ? Math.max(0.5, actualSizeGb / bytesPerParamForQuant(quantization))
    : undefined;
  const paramB =
    typeof m.paramsB === "number" && m.paramsB > 0
      ? m.paramsB
      : paramMatch
        ? parseFloat(paramMatch[1].replace(/^[a-z]/i, ""))
        : inferredFromSize ?? 7;
  const sizeGb = actualSizeGb ?? round1(Math.max(0.8, paramB * bytesPerParamForQuant(quantization)));
  const kvGbPer1k = round3(Math.max(0.025, Math.min(0.45, paramB * 0.014)));

  const isCoder = /coder|codellama|starcoder|codestral|devstral|qwen2\.5-coder/i.test(lower);
  const isReasoning =
    Boolean(m.thinking) ||
    Boolean(m.capabilities?.includes("thinking")) ||
    /deepseek-r1|qwq|reason|think|\bo1\b|\br1\b/i.test(lower);
  const isVision =
    Boolean(m.vision) ||
    Boolean(m.capabilities?.includes("vision")) ||
    /vl|vision|llava|moondream|minicpm-v|gemma3|gemma4|pixtral/i.test(lower);
  const isSmallFast = paramB <= 3.5;

  const capabilities: ModelCapability[] = ["coding"];
  if (isReasoning || !isCoder) capabilities.push("reasoning");
  if (isVision) capabilities.push("multimodal");
  if (isCoder || isSmallFast) capabilities.push("autocomplete");

  const baseQuality = Math.min(92, Math.round(35 + Math.log2(Math.max(1, paramB)) * 14));
  const toolBonus = m.toolTrained ? 5 : 0;
  const rank: Record<ModelCapability, number> = {
    coding: isCoder ? Math.min(97, baseQuality + 12 + toolBonus) : Math.min(95, baseQuality + toolBonus),
    reasoning: isReasoning ? Math.min(97, baseQuality + 15) : baseQuality - 4,
    multimodal: isVision ? Math.min(92, baseQuality + 10) : 10,
    autocomplete: isSmallFast ? 82 : isCoder ? 65 : 45,
  };

  return {
    label: m.name.replace(/^(ollama|llamacpp|lmstudio|vllm):/i, ""),
    sizeGb,
    kvGbPer1k,
    capabilities,
    rank,
    quantization,
    runtime,
    sizeIsActual: Boolean(actualSizeGb),
    toolTrained: m.toolTrained,
    thinking: isReasoning,
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
  ctxTokens = DEFAULT_CONTEXT_TOKENS,
  benchmarks?: Map<string, BenchResult> | Record<string, BenchResult> | BenchResult[],
  extra?: Pick<RecommendOptions, "runtime" | "kvQuantization" | "runtimeModels" | "liveObservations"> & {
    calibrationScale?: number;
  }
): InstalledModelEvaluation[] {
  const hw = hardwareFromProfile(machine);
  const localModels = models.filter((m) => isLocalModel(m));
  if (localModels.length === 0) return [];

  const metaEntries = localModels.map((m) => ({
    model: m,
    meta: inferModelMetadata(m, undefined, extra?.runtime),
  }));

  const calibrationScale =
    extra?.calibrationScale ??
    deriveCalibrationScale(
      metaEntries.map((e) => ({
        name: e.model.name,
        sizeGb: e.meta.sizeGb,
        kvGbPer1k: e.meta.kvGbPer1k,
        quantization: e.meta.quantization,
        sizeIsActual: e.meta.sizeIsActual,
      })),
      hw,
      ctxTokens,
      extra?.runtime ?? "ollama",
      extra?.kvQuantization,
      benchmarks,
      extra?.liveObservations
    );

  const evals: InstalledModelEvaluation[] = metaEntries.map(({ model: m, meta }) => {
    const bench = findMatchingBenchmark(m.name, benchmarks, hw);
    const runtimeModel = findRuntimeModel(m.name, extra?.runtimeModels);
    const liveMeasuredTps = findLiveTps(m.name, extra?.liveObservations);
    const fit = assessFit(
      { sizeGb: meta.sizeGb, kvGbPer1k: meta.kvGbPer1k },
      hw,
      ctxTokens,
      {
        measuredBenchTps: bench?.tokensPerSec,
        quantization: meta.quantization,
        kvQuantization: extra?.kvQuantization,
        runtime: meta.runtime,
        sizeMatchesQuant: true,
        calibrationScale,
        runtimeModel,
        liveMeasuredTps,
      }
    );
    const benchToolBonus = bench && bench.toolCallReliability >= 0.8 ? 5 : 0;
    const quality = meta.rank[goal] ?? 50;
    return {
      name: m.name,
      label: meta.label,
      sizeGb: meta.sizeGb,
      capabilities: meta.capabilities,
      fit,
      recommended: false,
      quality: quality + benchToolBonus,
      reason: fit.label,
      ...(meta.quantization ? { quantization: meta.quantization } : {}),
      runtime: meta.runtime,
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
    pick = [...evals].sort(
      (a, b) => MODE_SCORE[b.fit.mode] - MODE_SCORE[a.fit.mode] || b.quality - a.quality
    )[0];
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

interface TaskProfile {
  goal: ModelCapability;
  complexity: ComplexityLevel;
  requiredCtx: number;
  needsVision: boolean;
  isAutocomplete: boolean;
  needsDeepReasoning: boolean;
  summary: string;
}

function profilePromptTask(
  prompt: string,
  mode: "chat" | "plan" | "agent" = "agent",
  requestedCtx?: number,
  attachmentCount = 0,
  explicitGoal?: ModelCapability
): TaskProfile {
  const analysis = analyzeTask(prompt, mode, attachmentCount);
  const complexity = toComplexity(analysis, estimateTokens(prompt));
  const lower = prompt.toLowerCase();
  const needsVision =
    explicitGoal === "multimodal" ||
    attachmentCount > 0 ||
    /\b(screenshot|image|diagram|mockup|png|jpg|jpeg|svg|vision|multimodal)\b/i.test(lower);
  const isAutocomplete =
    explicitGoal === "autocomplete" ||
    /\b(autocomplete|inline\s+completion|\bfim\b|fill\s+in\s+the\s+middle|snippet|quick\s+edit)\b/i.test(lower);
  const needsDeepReasoning =
    explicitGoal === "reasoning" ||
    analysis.reasoning === "high" ||
    /\b(architect|root\s*cause|race\s+condition|concurrency|security|algorithm|proof|refactor|design)\b/i.test(lower);

  const goal: ModelCapability = explicitGoal
    ? explicitGoal
    : needsVision
      ? "multimodal"
      : isAutocomplete
        ? "autocomplete"
        : needsDeepReasoning && !/\b(implement|build|write|create)\b/i.test(lower)
          ? "reasoning"
          : "coding";

  const requiredCtx = Math.max(requestedCtx ?? DEFAULT_CONTEXT_TOKENS, complexity.minContextTokens);
  const summaryParts = [
    complexity.level,
    analysis.scope.replace("_", "-"),
    goal,
    `${Math.round(requiredCtx / 1024)}k ctx`,
  ];
  return {
    goal,
    complexity: complexity.level,
    requiredCtx,
    needsVision,
    isAutocomplete,
    needsDeepReasoning,
    summary: summaryParts.join(" · "),
  };
}

function scoreTaskSuitability(
  quality: number,
  capabilities: ModelCapability[],
  fit: FitAssessment,
  task: TaskProfile,
  bench?: BenchResult
): { score: number; reason: string } {
  const speed = Math.min(100, (fit.tokPerSec ?? 0) * 1.4);
  const fitBonus = MODE_SCORE[fit.mode] * 18;
  const ctxOk = (fit.maxSafeContextTokens ?? 0) >= task.requiredCtx;
  const ctxBonus = ctxOk ? 14 : -18;
  const capBonus = capabilities.includes(task.goal) ? 18 : -15;
  const reasonBonus =
    task.needsDeepReasoning && capabilities.includes("reasoning") ? 12 : 0;
  const benchReliabilityBonus = bench ? Math.round((bench.toolCallReliability - 0.5) * 20) : 0;

  let qWeight = 0.65;
  let sWeight = 0.35;
  if (task.complexity === "simple" || task.isAutocomplete) {
    qWeight = 0.4;
    sWeight = 0.6;
  } else if (task.complexity === "complex" || task.needsDeepReasoning) {
    qWeight = 0.8;
    sWeight = 0.2;
  }

  const score = Math.round(
    quality * qWeight + speed * sWeight + fitBonus + ctxBonus + capBonus + reasonBonus + benchReliabilityBonus
  );

  const reasons: string[] = [];
  if (capabilities.includes(task.goal)) reasons.push(`Strong ${task.goal}`);
  if (ctxOk) reasons.push(`fits ${Math.round(task.requiredCtx / 1024)}k ctx safely`);
  else reasons.push(`tight for ${Math.round(task.requiredCtx / 1024)}k ctx`);
  if (fit.mode === "gpu") reasons.push("100% GPU");
  if (bench && bench.toolCallReliability >= 0.85) reasons.push("verified tools");

  return { score, reason: reasons.join(" · ") };
}

/**
 * Rank the curated catalog and installed models for this machine.
 * Supports generic capability goals as well as task-specific prompts, runtime & quantization targets,
 * and live measurement calibration.
 */
export function recommendModels(
  machine: MachineProfile | null | undefined,
  opts: RecommendOptions = {}
): RecommendationSet {
  const hw = hardwareFromProfile(machine);
  const taskProfile = opts.taskPrompt
    ? profilePromptTask(opts.taskPrompt, opts.taskMode ?? "agent", opts.ctxTokens, 0, opts.goal)
    : undefined;
  const ctx = taskProfile ? taskProfile.requiredCtx : opts.ctxTokens ?? DEFAULT_CONTEXT_TOKENS;
  const goal = taskProfile ? taskProfile.goal : opts.goal ?? "coding";
  const runtime: LocalRuntimeId = opts.runtime ?? "ollama";
  const installedList =
    opts.installed ?? (opts.installedModels ? opts.installedModels.map((m) => m.name) : []);
  const targetQuant = normalizeQuantization(opts.quantization);

  const syntheticModels: ModelInfo[] =
    opts.installedModels ?? installedList.map((name) => ({ name, provider: runtime }));

  const calibrationCandidates = [
    ...MODEL_CATALOG.map((m) => ({
      name: m.name,
      sizeGb: m.sizeGb,
      kvGbPer1k: m.kvGbPer1k,
      quantization: targetQuant ?? normalizeQuantization(undefined, m.name),
      sizeIsActual: false,
    })),
    ...syntheticModels
      .filter((m) => isLocalModel(m))
      .map((m) => {
        const meta = inferModelMetadata(m, undefined, runtime);
        return {
          name: m.name,
          sizeGb: meta.sizeGb,
          kvGbPer1k: meta.kvGbPer1k,
          quantization: meta.quantization,
          sizeIsActual: meta.sizeIsActual,
        };
      }),
  ];

  const calibrationScale = deriveCalibrationScale(
    calibrationCandidates,
    hw,
    ctx,
    runtime,
    opts.kvQuantization,
    opts.benchmarks,
    opts.liveObservations
  );

  const rows: ModelRecommendation[] = MODEL_CATALOG.map((m) => {
    const matchedName = matchInstalledModelName(m.name, installedList);
    const installedInfo = matchedName
      ? syntheticModels.find((x) => x.name === matchedName)
      : undefined;
    const effectiveQuant = targetQuant ?? normalizeQuantization(installedInfo?.quantization, matchedName ?? m.name);
    const bench = findMatchingBenchmark(matchedName ?? m.name, opts.benchmarks, hw);
    const runtimeModel = findRuntimeModel(matchedName ?? m.name, opts.runtimeModels);
    const liveMeasuredTps = findLiveTps(matchedName ?? m.name, opts.liveObservations);
    const fit = assessFit(m, hw, ctx, {
      measuredBenchTps: bench?.tokensPerSec,
      quantization: effectiveQuant,
      kvQuantization: opts.kvQuantization,
      runtime,
      sizeMatchesQuant: false,
      calibrationScale,
      runtimeModel,
      liveMeasuredTps,
    });
    const quality = m.rank[goal] ?? 0;
    const taskEval = taskProfile
      ? scoreTaskSuitability(quality, m.capabilities, fit, taskProfile, bench)
      : undefined;
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
      quality,
      ...(effectiveQuant ? { quantization: effectiveQuant } : {}),
      runtime,
      ...(taskEval ? { taskScore: taskEval.score, taskReason: taskEval.reason } : {}),
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
      .sort((a, b) =>
        taskProfile
          ? (b.taskScore ?? 0) - (a.taskScore ?? 0)
          : b.quality - a.quality
      );
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
      (taskProfile ? (b.taskScore ?? 0) - (a.taskScore ?? 0) : b.quality - a.quality)
  );

  const evaluatedInstalled = evaluateInstalledLocalModels(
    syntheticModels,
    machine,
    goal,
    ctx,
    opts.benchmarks,
    {
      runtime,
      kvQuantization: opts.kvQuantization,
      runtimeModels: opts.runtimeModels,
      liveObservations: opts.liveObservations,
      calibrationScale,
    }
  );
  if (taskProfile && evaluatedInstalled.length) {
    for (const ev of evaluatedInstalled) {
      const bench = findMatchingBenchmark(ev.name, opts.benchmarks, hw);
      const t = scoreTaskSuitability(ev.quality, ev.capabilities, ev.fit, taskProfile, bench);
      ev.taskScore = t.score;
      if (ev.recommended) {
        ev.reason = `${t.reason} (${ev.fit.label})`;
      }
    }
  }
  const bestInstalled = evaluatedInstalled.find((e) => e.recommended);

  const best = pick;
  const hwLabel = summarizeHardware(hw).label;
  return {
    hardware: summarizeHardware(hw),
    goal,
    ctxTokens: ctx,
    models: rows,
    recommendedName: best?.name,
    headline: best
      ? taskProfile
        ? `${best.name} — Best for this ${taskProfile.complexity} ${goal} task (${best.fit.label})`
        : `${best.name} — Recommended for your ${hwLabel}`
      : "No catalog model fits safely; try a smaller model or free up memory.",
    evaluatedInstalled,
    bestInstalledName: bestInstalled?.name,
    runtime,
    ...(taskProfile
      ? {
          taskQuery: opts.taskPrompt,
          taskComplexity: taskProfile.complexity,
          taskReason: taskProfile.summary,
        }
      : {}),
    ...(calibrationScale !== 1 ? { calibrationScale } : {}),
  };
}

export interface TaskRecommendOptions extends Omit<RecommendOptions, "taskPrompt"> {
  mode?: "chat" | "plan" | "agent";
  attachmentCount?: number;
}

/**
 * Recommend the best local model for a specific user prompt/task (factoring task complexity,
 * required context window, tool/reasoning/vision needs, runtime, quantization, and live calibration).
 */
export function recommendModelForTask(
  prompt: string,
  machine: MachineProfile | null | undefined,
  opts: TaskRecommendOptions = {}
): RecommendationSet {
  return recommendModels(machine, {
    ...opts,
    taskPrompt: prompt,
    taskMode: opts.mode ?? opts.taskMode ?? "agent",
  });
}

export interface BackgroundBenchGuardInput {
  reachable: boolean;
  manual: boolean;
  autoRunEnabled: boolean;
  turnActive: boolean;
  localModelUsed: boolean;
  targetModel?: string;
  runningModels?: { name: string; gpuPercent?: number; vramBytes?: number }[];
}

/**
 * Determine whether background benchmarking is safe to run without interrupting active
 * inference or evicting a resident local model from GPU VRAM.
 */
export function evaluateBackgroundBenchGuard(input: BackgroundBenchGuardInput): {
  allowed: boolean;
  reason?: string;
} {
  if (!input.reachable) return { allowed: false, reason: "provider_unreachable" };
  if (input.turnActive) return { allowed: false, reason: "turn_active" };
  if (input.manual) return { allowed: true };
  if (!input.autoRunEnabled) return { allowed: false, reason: "autorun_disabled" };
  if (input.localModelUsed) return { allowed: false, reason: "local_model_active_in_session" };

  if (input.runningModels && input.runningModels.length > 0 && input.targetModel) {
    const target = normModelKey(input.targetModel);
    const hasDifferentLoaded = input.runningModels.some((r) => {
      const resident = (r.vramBytes ?? 0) > 0 || (r.gpuPercent ?? 0) > 0 || r.gpuPercent === undefined;
      return resident && normModelKey(r.name) !== target;
    });
    if (hasDifferentLoaded) {
      return { allowed: false, reason: "would_evict_loaded_gpu_model" };
    }
  }

  return { allowed: true };
}
