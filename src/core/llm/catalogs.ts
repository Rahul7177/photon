import type { ProviderModel } from "./types";

/**
 * Static catalog for providers WITHOUT a live model-listing API. Providers
 * with live listing (Gemini, Claude, NVIDIA, OpenAI, OpenRouter, OpenCode)
 * start with EMPTY catalogs — models appear only after the user fetches their
 * account's list, tests one, and adds it. Names carry the provider prefix so
 * the ProviderManager can route them and the UI can show where each lives.
 */

export const BLACKBOX_MODELS: ProviderModel[] = [
  { id: "blackboxai-pro", name: "blackbox:blackboxai-pro", paramsB: 1000, contextLength: 128_000, toolTrained: true, vision: true, thinking: true, tier: "large", capabilities: ["tools","vision","thinking"] },
  { id: "blackboxai-pro-plus", name: "blackbox:blackboxai-pro-plus", paramsB: 1000, contextLength: 128_000, toolTrained: true, vision: true, thinking: true, tier: "large", capabilities: ["tools","vision","thinking"] },
  { id: "blackboxai-1.5-8b", name: "blackbox:blackboxai-1.5-8b", paramsB: 8, contextLength: 128_000, toolTrained: true, tier: "medium", capabilities: ["tools"] },
  { id: "llama-3.3-70b", name: "blackbox:llama-3.3-70b", paramsB: 70, contextLength: 128_000, toolTrained: true, tier: "large", capabilities: ["tools"] },
];

/** Curated flagship and top-tier models per provider. */
export const RECOMMENDED_PROVIDER_MODELS: Record<string, string[]> = {
  gemini: [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  claude: [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-20241022",
    "claude-3-5-haiku-latest",
    "claude-3-opus-20240229",
  ],
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "o3-mini",
    "o1",
    "chatgpt-4o-latest",
  ],
  nvidia: [
    "meta/llama-3.1-70b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "deepseek-ai/deepseek-r1",
    "qwen/qwen2.5-coder-32b-instruct",
  ],
  openrouter: [
    "anthropic/claude-3.5-sonnet",
    "openai/gpt-4o",
    "google/gemini-2.0-flash-001",
    "deepseek/deepseek-r1",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  opencode: [
    "claude-3-5-sonnet",
    "gpt-4o",
    "qwen2.5-coder-32b",
    "deepseek-coder-v2",
  ],
  blackbox: [
    "blackboxai-pro",
    "blackboxai-pro-plus",
    "llama-3.3-70b",
  ],
};

/** Checks whether a model ID or clean name is considered a recommended/flagship model for the provider. */
export function isRecommendedModel(providerId: string, modelName: string): boolean {
  const normProv = (providerId || "").toLowerCase();
  const clean = modelName.includes(":") ? modelName.split(":").slice(1).join(":") : modelName;
  const list = RECOMMENDED_PROVIDER_MODELS[normProv];
  if (!list) return false;
  const target = clean.toLowerCase();
  return list.some((rec) => target === rec.toLowerCase() || target.startsWith(rec.toLowerCase()));
}

/** Default profile for a user-supplied custom OpenAI-compatible model. */
export function customModel(id: string, providerId: string): ProviderModel {
  const caps = inferCapabilities(id);
  return {
    id,
    name: `${providerId}:${id}`,
    contextLength: 128_000,
    toolTrained: caps.includes("tools"),
    vision: caps.includes("vision"),
    audio: caps.includes("audio"),
    video: caps.includes("video"),
    thinking: caps.includes("thinking"),
    thinkingLevels: reasoningLevels(id, caps),
    capabilities: caps,
    tier: "large",
  };
}

function inferCapabilities(id: string): string[] {
  const n = id.toLowerCase();
  const caps: string[] = [];
  if (/vision|visual|vl|llava|pixtral|gemini|gpt-4o|multimodal/.test(n)) caps.push("vision");
  if (/audio|whisper|speech|voxtral|ultravox/.test(n)) caps.push("audio");
  if (/video|veo|video/.test(n)) caps.push("video");
  if (/r1|o1|o3|thinking|reasoning|qwq|qwen3|deepseek-r/.test(n)) caps.push("thinking");
  // tools only for known tool-trained families + explicit "tool" substring
  if (/qwen2|qwen3|llama3|mistral|hermes|qwq|deepseek-r|command-r|firefunction|tool/.test(n)) caps.push("tools");
  return caps;
}

function reasoningLevels(id: string, caps: string[]): import("../../shared/types").ThinkingLevel[] {
  if (!caps.includes("thinking")) return [];
  return /xtrahigh|o1|o3|o4|reasoning/i.test(id)
    ? ["off", "low", "medium", "high", "xtrahigh"]
    : ["off", "low", "medium", "high"];
}