import type {
  AdaptivePlan,
  IntelligenceLevel,
  IntelligenceSetting,
  MachineProfile,
  Mode,
  ModelInfo,
  ModelTier,
} from "../../shared/types";

export interface OrchestratorInput {
  model: ModelInfo;
  machine: MachineProfile | null;
  mode: Mode;
  /** User override for the context window, if any. */
  userNumCtx?: number;
  /** "auto" lets Photon derive the level from the model/machine. */
  intelligence: IntelligenceSetting;
  reserveOutputTokens: number;
  adaptiveEnabled: boolean;
  /** Opt-in: let cloud models use native tool calling instead of Photon's
   *  portable block protocol. Defaults to false (block protocol). */
  cloudNativeTools?: boolean;
}

/** Per-level knobs. Higher levels spend more context on richer prompts + tools. */
interface LevelProfile {
  maxTools: number;
  allowParallelTools: boolean;
  outputCap: number;
  chatTemp: number;
  taskTemp: number;
}

// maxTools is a count cap; the registry ALSO hard-gates by each tool's minTier.
// Counts are chosen so a low-tier coding agent still gets a complete core loop
// (read/edit/write/find/list), medium adds search + diagnostics + shell, and
// web/planning tools only appear at high+ (blueprint: ≤5–7 tools for weak
// models). Capable models are never tool-starved: max allows the full set.
const LEVELS: Record<IntelligenceLevel, LevelProfile> = {
  low: { maxTools: 5, allowParallelTools: false, outputCap: 768, chatTemp: 0.5, taskTemp: 0.2 },
  medium: { maxTools: 8, allowParallelTools: false, outputCap: 2048, chatTemp: 0.6, taskTemp: 0.3 },
  high: { maxTools: 14, allowParallelTools: true, outputCap: 4096, chatTemp: 0.7, taskTemp: 0.35 },
  max: { maxTools: 18, allowParallelTools: true, outputCap: 8192, chatTemp: 0.7, taskTemp: 0.4 },
};

/**
 * The core of Photon: translate (machine, model, mode, intelligence) into
 * concrete settings, a tool protocol, and a prompt detail level a local model
 * can actually handle. Rule-based and transparent — every choice lands in
 * `rationale` and is surfaced in the UI.
 */
export function buildPlan(input: OrchestratorInput): AdaptivePlan {
  const { model, machine, mode, reserveOutputTokens, adaptiveEnabled } = input;
  const rationale: string[] = [];
  const tier = model.tier ?? "small";

  // --- Intelligence level: auto-derive from capability, or honor the override.
  const auto = input.intelligence === "auto";
  const level: IntelligenceLevel =
    input.intelligence === "auto" ? deriveIntelligence(tier, machine) : input.intelligence;
  const profile = LEVELS[level];
  rationale.push(
    auto
      ? `Intelligence: ${level} (auto from a ${tier} model${machine ? ` on a ${machine.tier}-end machine` : ""}).`
      : `Intelligence: ${level} (pinned by user).`
  );

  // --- Context window: bounded by the model, then shrunk to fit weak hardware.
  const modelMax = model.contextLength ?? 8192;
  let numCtx = modelMax;

  if (adaptiveEnabled && machine) {
    const ramGb = machine.freeRamBytes / 1024 ** 3;
    // KV-cache grows with num_ctx; on low-RAM machines a huge window swaps and
    // crawls. Cap to what the machine can comfortably hold.
    const ramCap =
      machine.tier === "low" ? 8192 : machine.tier === "mid" ? 16384 : 32768;
    if (modelMax > ramCap) {
      numCtx = ramCap;
      rationale.push(
        `Capped context to ${ramCap} tokens for a ${machine.tier}-end machine (${ramGb.toFixed(
          1
        )} GB free); ${model.name} supports ${modelMax}.`
      );
    } else {
      rationale.push(`Using the model's full ${modelMax}-token window.`);
    }
  }

  if (input.userNumCtx && input.userNumCtx > 0) {
    numCtx = input.userNumCtx;
    rationale.push(`Context window pinned to ${numCtx} by user.`);
  }

  // --- Tool protocol: weak / non-tool-trained models get the forgiving block
  // protocol; capable tool-trained models can use native calling. Cloud models
  // typically use the block protocol — it's portable across every provider's API
  // but can be overridden by the user.
  const isCloud = !!model.provider && model.provider !== "ollama" && model.provider !== "llamacpp";
  const canNative = model.toolTrained === true && (tier === "medium" || tier === "large");
  
  let toolProtocol: AdaptivePlan["toolProtocol"] = "photon-block";
  if (!isCloud && adaptiveEnabled && canNative) {
    toolProtocol = "native";
  } else if (isCloud && input.cloudNativeTools === true && canNative) {
    toolProtocol = "native";
  }

  rationale.push(
    toolProtocol === "native"
      ? `${model.name} is tool-trained; using native tool calling.`
      : isCloud
        ? `${model.name} is a cloud model; using Photon's portable block protocol.`
        : `Using Photon's forgiving block protocol — safest for a ${tier} model.`
  );

  // --- Tools + parallelism come from the intelligence profile.
  const maxTools = isCloud ? 100 : profile.maxTools;
  const allowParallelTools = profile.allowParallelTools;
  if (!isCloud && (level === "low" || level === "medium")) {
    rationale.push(
      `Exposing ${maxTools} tools, one call per turn — keeps a ${level} run from overwhelming the model.`
    );
  } else if (isCloud) {
    rationale.push(`Cloud model detected; exposing all tools (${maxTools} limit).`);
  }

  // --- Sampling. Plan/Agent want determinism; Chat can be a touch warmer.
  const temperature = mode === "chat" ? profile.chatTemp : profile.taskTemp;
  const topP = 0.9;

  // --- Output budget: leave room in the window; don't let low levels ramble.
  const maxOutputTokens = Math.max(
    256,
    Math.min(profile.outputCap, numCtx - reserveOutputTokens, Math.floor(numCtx * 0.5))
  );

  if (model.vision) rationale.push(`${model.name} accepts images — attachments enabled.`);

  return {
    model: model.name,
    mode,
    contextWindow: numCtx,
    numCtx,
    temperature,
    topP,
    maxOutputTokens,
    toolProtocol,
    maxTools,
    allowParallelTools,
    intelligence: level,
    intelligenceAuto: auto,
    rationale,
  };
}

function deriveIntelligence(
  tier: ModelTier,
  machine: MachineProfile | null
): IntelligenceLevel {
  let level: IntelligenceLevel =
    tier === "tiny" ? "low" : tier === "small" ? "medium" : tier === "medium" ? "high" : "max";
  // A low-end machine can't sustain the heaviest prompts even on a big model.
  if (machine?.tier === "low" && level === "max") level = "high";
  return level;
}
