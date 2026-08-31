import type { ModelInfo, ModelTier, ModelCapabilityProfile } from "../../shared/types";
import type { OllamaClient } from "../ollama/client";
import type { OllamaShowResponse, OllamaTagModel } from "../ollama/types";
import { capabilityForModel } from "../intelligence/policy";

const TOOL_TRAINED_HINTS = ["qwen2.5-coder","qwen2.5","qwen3","llama3.1","llama3.2","llama3.3","mistral","mistral-nemo","firefunction","command-r","hermes"];
const VISION_HINTS = ["llava","bakllava","moondream","minicpm-v","llama3.2-vision","llama-vision","qwen2-vl","qwen2.5-vl","gemma3","granite3.2-vision","pixtral","vision","qwen-vl"];
const THINKING_HINTS = ["deepseek-r1","deepseek-r","r1-distill","qwen3","qwq","o1","o3","o4","reasoning","thinking","r1","magistral","nemotron-thinking"];
const AUDIO_HINTS = ["whisper","audio","speech","voxtral","ultravox","qwen2-audio","gemini-2","multimodal"];
const VIDEO_HINTS = ["video","qwen2-vl","gemini-2","veo","video-llava","llava-video"];

export async function profileModel(client: OllamaClient, tag: OllamaTagModel): Promise<ModelInfo> {
  const base: ModelInfo = {
    name: tag.name,
    paramSize: tag.details?.parameter_size,
    paramsB: parseParams(tag.details?.parameter_size),
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
  base.audio = detectAudio(tag.name, show);
  base.video = detectVideo(tag.name, show);
  base.capabilities = show?.capabilities?.slice() ?? [];
  base.tier = classifyModel(base.paramsB);
  base.capabilityProfile = capabilityForModel(base);
  return base;
}

function parseParams(paramSize?: string): number | undefined { if (!paramSize) return undefined; const m=paramSize.match(/([\d.]+)\s*([BM])/i); if(!m)return undefined; const n=parseFloat(m[1]); return m[2].toUpperCase()==="M"?n/1000:n; }
function classifyModel(paramsB?: number): ModelTier { if(paramsB===undefined)return "small"; if(paramsB<4)return "tiny"; if(paramsB<8.5)return "small"; if(paramsB<20)return "medium"; return "large"; }
function extractContextLength(show?: OllamaShowResponse): number|undefined {
  if (!show) return undefined;
  if (show.model_info) for (const [k,v] of Object.entries(show.model_info)) if (k.endsWith(".context_length") && typeof v === "number") return v;
  const blob=`${show.parameters??""}\n${show.modelfile??""}`; const m=blob.match(/num_ctx\s+(\d+)/i); return m?parseInt(m[1],10):undefined;
}
function guessContextLength(family?: string): number { const f=(family??"").toLowerCase(); if(f.includes("qwen"))return 32768; if(f.includes("llama"))return 8192; if(f.includes("gemma"))return 8192; if(f.includes("phi"))return 16384; return 8192; }
function detectToolTrained(name:string,show?:OllamaShowResponse):boolean { if(show?.capabilities?.some(c=>c.toLowerCase()==="tools"))return true; if(show?.template&&/tool_calls|\.Tools|tools/i.test(show.template))return true; const n=name.toLowerCase(); return TOOL_TRAINED_HINTS.some(h=>n.includes(h)); }
function detectVision(name:string,show?:OllamaShowResponse):boolean { if(show?.capabilities?.some(c=>c.toLowerCase()==="vision"))return true; if(show?.model_info&&Object.keys(show.model_info).some(k=>/clip|vision|mm_/i.test(k)))return true; return VISION_HINTS.some(h=>name.toLowerCase().includes(h)); }
function detectThinking(name:string,show?:OllamaShowResponse):boolean { if(show?.capabilities?.some(c=>["thinking","reasoning"].includes(c.toLowerCase())))return true; if(show?.model_info&&Object.keys(show.model_info).some(k=>/thinking|reasoning/i.test(k)))return true; if(show?.template&&/<think>|thinking/i.test(show.template))return true; return THINKING_HINTS.some(h=>name.toLowerCase().includes(h)); }
function detectAudio(name:string,show?:OllamaShowResponse):boolean { if(show?.capabilities?.some(c=>["audio","speech"].includes(c.toLowerCase())))return true; if(show?.model_info&&Object.keys(show.model_info).some(k=>/audio|speech|whisper/i.test(k)))return true; return AUDIO_HINTS.some(h=>name.toLowerCase().includes(h)); }
function detectVideo(name:string,show?:OllamaShowResponse):boolean { if(show?.capabilities?.some(c=>c.toLowerCase()==="video"))return true; if(show?.model_info&&Object.keys(show.model_info).some(k=>/video/i.test(k)))return true; return VIDEO_HINTS.some(h=>name.toLowerCase().includes(h)); }
