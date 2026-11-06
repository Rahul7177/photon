import type { ModelInfo, ModelTier, ModelCapabilityProfile, ThinkingLevel } from "../../shared/types";
import type { OllamaClient } from "../ollama/client";
import type { OllamaShowResponse, OllamaTagModel } from "../ollama/types";
import { capabilityForModel } from "../intelligence/policy";

const TOOL_TRAINED_HINTS = ["qwen2.5-coder","qwen2.5","qwen3","llama3.1","llama3.2","llama3.3","mistral","mistral-nemo","firefunction","command-r","hermes","gemma4"];
const VISION_HINTS = ["llava","bakllava","moondream","minicpm-v","llama3.2-vision","llama-vision","qwen2-vl","qwen2.5-vl","gemma3","gemma4","granite3.2-vision","pixtral","vision","qwen-vl"];
const THINKING_HINTS = ["deepseek-r1","deepseek-r","r1-distill","qwen3","qwq","o1","o3","o4","reasoning","thinking","r1","magistral","nemotron-thinking","gemma4"];
const AUDIO_HINTS = ["whisper","audio","speech","voxtral","ultravox","qwen2-audio","gemini-2","multimodal","gemma4"];
const VIDEO_HINTS = ["video","qwen2-vl","gemini-2","veo","video-llava","llava-video"];

export async function profileModel(client: OllamaClient, tag: OllamaTagModel): Promise<ModelInfo> {
  const key = `${tag.name}@${tag.digest ?? tag.size ?? ""}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return { ...hit.info };
  const info = await profileUncached(client, tag);
  if (profileCache.size >= 50) profileCache.delete(profileCache.keys().next().value as string);
  profileCache.set(key, { at: Date.now(), info });
  return { ...info };
}

const profileCache = new Map<string, { at: number; info: ModelInfo }>();
const PROFILE_TTL_MS = 10 * 60 * 1000;

async function profileUncached(client: OllamaClient, tag: OllamaTagModel): Promise<ModelInfo> {
  const effectiveParamsB = parseEffectiveParams(tag.name, tag.details?.parameter_size);
  const base: ModelInfo = {
    name: tag.name,
    paramSize: tag.details?.parameter_size,
    paramsB: effectiveParamsB,
    quantization: tag.details?.quantization_level,
    family: tag.details?.family ?? tag.details?.families?.[0],
    sizeBytes: tag.size,
  };
  let show: OllamaShowResponse | undefined;
  try { show = await client.showModel(tag.name); } catch { /* tag-only fallback */ }
  base.contextLength = extractContextLength(show) ?? guessContextLength(base.family);
  base.toolTrained = detectToolTrained(tag.name, show);
  base.vision = detectVision(tag.name, show);
  base.thinking = detectThinking(tag.name, show);
  base.thinkingLevels = detectThinkingLevels(tag.name, show);
  base.audio = detectAudio(tag.name, show);
  base.video = detectVideo(tag.name, show);
  base.capabilities = show?.capabilities?.slice() ?? [];
  base.tier = classifyModel(base.paramsB);
  base.capabilityProfile = capabilityForModel(base);
  return base;
}

/**
 * Extract effective parameter count in billions.
 * Handles Gemma-4 style effective-parameter tags (`gemma4:e2b` -> 2B, `gemma4:e4b` -> 4B)
 * where Ollama's raw GGUF header otherwise reports the combined MoE/draft/projector total (7.5B),
 * as well as standard model name suffixes (`:3b`, `:7b`, `-14b`) and `details.parameter_size`.
 */
export function parseEffectiveParams(modelName: string, paramSize?: string): number | undefined {
  const n = modelName.toLowerCase();
  // Explicit effective-param tag like `:e2b` or `:e4b`
  const effMatch = n.match(/[:_-]e(\d+(?:\.\d+)?)b\b/);
  if (effMatch) return parseFloat(effMatch[1]);

  if (paramSize) {
    const m = paramSize.match(/([\d.]+)\s*([BM])/i);
    if (m) {
      const val = parseFloat(m[1]);
      return m[2].toUpperCase() === "M" ? val / 1000 : val;
    }
  }
  const nameMatch = n.match(/(?:^|[:_-])(\d+(?:\.\d+)?)([bm])\b/);
  if (nameMatch) {
    const val = parseFloat(nameMatch[1]);
    return nameMatch[2] === "m" ? val / 1000 : val;
  }
  return undefined;
}

export function classifyModel(paramsB?: number): ModelTier {
  if (paramsB === undefined) return "small";
  if (paramsB <= 4.2) return "tiny";
  if (paramsB <= 8.5) return "small";
  if (paramsB < 20) return "medium";
  return "large";
}
function extractContextLength(show?: OllamaShowResponse): number|undefined {
  if (!show) return undefined;
  if (show.model_info) for (const [k,v] of Object.entries(show.model_info)) if (k.endsWith(".context_length") && typeof v === "number") return v;
  const blob=`${show.parameters??""}\n${show.modelfile??""}`; const m=blob.match(/num_ctx\s+(\d+)/i); return m?parseInt(m[1],10):undefined;
}
function guessContextLength(family?: string): number { const f=(family??"").toLowerCase(); if(f.includes("qwen"))return 32768; if(f.includes("llama"))return 8192; if(f.includes("gemma"))return 8192; if(f.includes("phi"))return 16384; return 8192; }
function detectToolTrained(name:string,show?:OllamaShowResponse):boolean { if(show?.capabilities?.some(c=>c.toLowerCase()==="tools"))return true; if(show?.template&&/tool_calls|\.Tools|tools/i.test(show.template))return true; const n=name.toLowerCase(); return TOOL_TRAINED_HINTS.some(h=>n.includes(h)); }
function capabilityTokens(show?:OllamaShowResponse):Set<string>{return new Set((show?.capabilities??[]).map(c=>c.toLowerCase().replace(/[ _-]/g,"")));}
function detectVision(name:string,show?:OllamaShowResponse):boolean { const caps=capabilityTokens(show); if(caps.has("vision")||caps.has("image")||caps.has("multimodal"))return true; if(show?.model_info&&Object.keys(show.model_info).some(k=>/clip|vision|mm_|image/i.test(k)))return true; return VISION_HINTS.some(h=>name.toLowerCase().includes(h)); }
function detectThinking(name:string,show?:OllamaShowResponse):boolean { return detectThinkingLevels(name,show).length>0; }
function detectThinkingLevels(name:string,show?:OllamaShowResponse):ThinkingLevel[]{ const caps=capabilityTokens(show); const n=name.toLowerCase(); if(!(caps.has("thinking")||caps.has("reasoning")||show?.template&&/<think>|thinking/i.test(show.template)||THINKING_HINTS.some(h=>n.includes(h))))return []; if(/xtrahigh|extra[-_ ]?high|o4|o3|o1|reasoning/i.test(n))return["off","low","medium","high","xtrahigh"]; if(/qwen3|deepseek-r1|qwq|thinking|magistral|nemotron|gemma4/i.test(n))return["off","low","medium","high"]; return["off","medium"]; }
function detectAudio(name:string,show?:OllamaShowResponse):boolean { const caps=capabilityTokens(show); if(caps.has("audio")||caps.has("speech")||caps.has("multimodal"))return true; if(show?.model_info&&Object.keys(show.model_info).some(k=>/audio|speech|whisper/i.test(k)))return true; return AUDIO_HINTS.some(h=>name.toLowerCase().includes(h)); }
function detectVideo(name:string,show?:OllamaShowResponse):boolean { const caps=capabilityTokens(show); if(caps.has("video")||caps.has("multimodal"))return true; if(show?.model_info&&Object.keys(show.model_info).some(k=>/video/i.test(k)))return true; return VIDEO_HINTS.some(h=>name.toLowerCase().includes(h)); }
