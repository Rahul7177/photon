// Wire types for the Ollama REST API (subset Photon uses).
export interface OllamaTagsResponse{models:OllamaTagModel[];}
export interface OllamaTagModel{name:string;model:string;size:number;digest:string;details?:{family?:string;families?:string[];parameter_size?:string;quantization_level?:string;format?:string;};}
export interface OllamaShowResponse{license?:string;modelfile?:string;parameters?:string;template?:string;details?:OllamaTagModel["details"];model_info?:Record<string,unknown>;capabilities?:string[];}
export interface OllamaChatMessage{role:"system"|"user"|"assistant"|"tool";content:string;tool_calls?:OllamaToolCall[];images?:string[];}
export interface OllamaToolCall{function:{name:string;arguments:Record<string,unknown>};}
export interface OllamaChatOptions{num_ctx?:number;temperature?:number;top_p?:number;num_predict?:number;stop?:string[];seed?:number;}
export interface OllamaChatRequest{model:string;messages:OllamaChatMessage[];stream?:boolean;options?:OllamaChatOptions;tools?:unknown[];keep_alive?:string|number;/** Thinking control for models that support it: false or low/medium/high. */think?:boolean|string;}
export interface OllamaChatChunk{model:string;created_at:string;message?:OllamaChatMessage;done:boolean;done_reason?:string;total_duration?:number;prompt_eval_count?:number;prompt_eval_duration?:number;eval_count?:number;eval_duration?:number;}
export interface OllamaEmbedRequest{model:string;input:string|string[];}
export interface OllamaEmbedResponse{embeddings:number[][];}
