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