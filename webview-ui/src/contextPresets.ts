import { isLocalModel, type MachineProfile, type ModelInfo } from "../../src/shared/types";

export const CONTEXT_PRESETS: { value: number; label: string; short: string }[] = [
  { value: 0, label: "Auto (Hardware-Aware)", short: "Auto ctx" },
  { value: 8192, label: "8k (8,192)", short: "8k ctx" },
  { value: 16384, label: "16k (16,384)", short: "16k ctx" },
  { value: 32768, label: "32k (32,768)", short: "32k ctx" },
  { value: 65536, label: "64k (65,536)", short: "64k ctx" },
  { value: 131072, label: "128k (131,072)", short: "128k ctx" },
  { value: 262144, label: "256k (262,144)", short: "256k ctx" },
];

export interface ContextOverflowCheck {
  overflows: boolean;
  title: string;
  explanation: string;
  recommendedTokens: number;
}

/**
 * Evaluates whether selecting `selectedTokens` on the user's laptop will exceed
 * available GPU VRAM + System RAM (after leaving a 22.5% RAM safety buffer for OS/VS Code)
 * or exceed the model's native trained context length.
 * Never blocks selection — returns a simple, friendly explanation for a warning popup.
 */
export function checkContextWindowOverflow(
  selectedTokens: number,
  model: ModelInfo | undefined,
  machine: MachineProfile | null
): ContextOverflowCheck {
  if (!selectedTokens || selectedTokens <= 0) {
    return { overflows: false, title: "", explanation: "", recommendedTokens: 8192 };
  }

  const modelMax = model?.contextLength ?? 131072;
  const paramsB =
    model?.paramsB ??
    (model?.tier === "tiny" ? 3 : model?.tier === "small" ? 7 : model?.tier === "medium" ? 14 : 30);
  const weightBytes =
    model?.sizeBytes && model.sizeBytes > 0 ? model.sizeBytes : paramsB * 0.65 * 1024 ** 3;
  const weightGb = weightBytes / 1024 ** 3;
  const kvGbPer1k = Math.max(0.04, Math.min(0.4, paramsB * 0.022));
  const neededKvGb = (selectedTokens / 1024) * kvGbPer1k;
  const totalNeededGb = weightGb + neededKvGb;

  const isLocal = isLocalModel(model);
  if (!isLocal) {
    if (selectedTokens > modelMax) {
      return {
        overflows: true,
        title: "Context exceeds model limit",
        explanation: `${formatK(selectedTokens)} tokens is larger than ${model?.name ?? "this model"}'s maximum context window (${formatK(modelMax)}). The provider may reject or truncate requests, though your selection has been applied.`,
        recommendedTokens: modelMax,
      };
    }
    return { overflows: false, title: "", explanation: "", recommendedTokens: modelMax };
  }

  if (!machine) {
    return { overflows: false, title: "", explanation: "", recommendedTokens: 8192 };
  }

  const totalRamGb = machine.totalRamBytes / 1024 ** 3;
  const freeRamGb = machine.freeRamBytes / 1024 ** 3;
  const ramBufferGb = totalRamGb * 0.225; // 22.5% buffer
  const usableRamGb = Math.max(0.5, Math.min(freeRamGb - totalRamGb * 0.1, totalRamGb - ramBufferGb));
  const vramGb = (machine.gpu?.vramBytes ?? 0) / 1024 ** 3;
  const usableVramGb = vramGb > 0 ? Math.max(0, vramGb - 0.5) : 0;
  const safePoolGb = usableVramGb + usableRamGb;

  const remainingForKvGb = Math.max(0, safePoolGb - weightGb);
  const rawSafeTokens = Math.floor((remainingForKvGb / kvGbPer1k) * 1024);
  const BUCKETS = [8192, 16384, 32768, 65536, 131072, 262144];
  let recommended = 8192;
  for (const b of BUCKETS) {
    if (b <= Math.max(8192, Math.min(modelMax, rawSafeTokens))) recommended = b;
  }

  const reasons: string[] = [];
  if (selectedTokens > modelMax) {
    reasons.push(
      `It exceeds ${model?.name ?? "the model"}'s trained context limit of ${formatK(modelMax)} tokens.`
    );
  }
  if (totalNeededGb > safePoolGb) {
    const hwDesc =
      vramGb > 0
        ? `${vramGb.toFixed(1)} GB GPU VRAM + ${freeRamGb.toFixed(1)} GB free RAM (keeping ~22% RAM buffer for your OS & VS Code)`
        : `${freeRamGb.toFixed(1)} GB free RAM (keeping ~22% RAM buffer for your OS & VS Code)`;
    reasons.push(
      `Running ${model?.name ?? "this model"} at ${formatK(selectedTokens)} context needs ~${totalNeededGb.toFixed(1)} GB of memory (weights ~${weightGb.toFixed(1)} GB + KV cache ~${neededKvGb.toFixed(1)} GB), which exceeds your safe available memory (${safePoolGb.toFixed(1)} GB across ${hwDesc}).`
    );
    reasons.push(
      `This can cause heavy disk swapping, very slow responses, or Ollama unloading the model. Photon recommends ${formatK(recommended)} (or Auto) for smooth performance on your device.`
    );
  }

  if (reasons.length === 0) {
    return { overflows: false, title: "", explanation: "", recommendedTokens: recommended };
  }

  return {
    overflows: true,
    title: `High Context Window (${formatK(selectedTokens)}) — Memory Overflow Warning`,
    explanation: reasons.join(" "),
    recommendedTokens: recommended,
  };
}

export function formatK(n: number): string {
  if (!n || n <= 0) return "Auto";
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_048_576 && n % 1_048_576 === 0) return `${n / 1_048_576}M`;
  // Exact binary power-of-two presets (4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288)
  if ((n & (n - 1)) === 0 && n >= 1024) return `${n / 1024}k`;
  // Decimal thousands (e.g. 128000 -> 128k, 200000 -> 200k)
  if (n % 1000 === 0) return `${n / 1000}k`;
  if (n % 1024 === 0) return `${n / 1024}k`;
  return `${Math.round(n / 1000)}k`;
}
