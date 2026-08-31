// Domain types shared between the extension host and the webview UI.
// Keep this file dependency-free (no vscode / node imports) so the webview can import it directly.
export type Mode="chat"|"plan"|"agent";export type Role="system"|"user"|"assistant"|"tool";
export interface ChatMessage{id:string;role:Role;content:string;toolCalls?:ToolCall[];attachments?:Attachment[];toolCallId?:string;createdAt:number;streaming?:boolean;notice?:string;}
export interface Attachment{id:string;kind:"image"|"text";name:string;mime:string;size:number;dataBase64?:string;text?:string;}
export interface ToolCall{id:string;name:string;args:Record<string,unknown>;status:"proposed"|"running"|"done"|"error"|"denied";result?:string;error?:string;sideEffecting?:boolean;thoughtSignature?:string;}
export interface ModelCapabilityProfile{reasoning:number;coding:number;toolCalling:number;schemaAdherence:number;contextRetention:number;editFidelity:number;recovery:number;verification:number;speed:number;}
export interface ModelInfo{name:string;provider?:string;paramSize?:string;paramsB?:number;quantization?:string;family?:string;contextLength?:number;sizeBytes?:number;toolTrained?:boolean;vision?:boolean;audio?:boolean;video?:boolean;thinking?:boolean;capabilities?:string[];tier?:ModelTier;capabilityProfile?:ModelCapabilityProfile;}
export interface GenerationStats{tps:number;totalTokens:number;elapsedMs:number;}
export interface LlamaCppSettings{ctx?:number;ngl?:number|"all";fit?:boolean;np?:number;fa?:boolean;ctk?:string;ctv?:string;extraArgs?:string;}
export interface PerModelConfig{numCtx?:number;llamacpp?:LlamaCppSettings;sampling?:{temp?:number;topP?:number;seed?:number};note?:string;}
export type ModelTier="tiny"|"small"|"medium"|"large";export type IntelligenceLevel="low"|"medium"|"high"|"max";export type IntelligenceSetting="auto"|IntelligenceLevel;
export type ThinkingLevel="off"|"low"|"medium"|"high"|"xtrahigh";export type ThinkingSetting="auto"|ThinkingLevel;
export interface MachineProfile{totalRamBytes:number;freeRamBytes:number;cpuCores:number;cpuModel:string;platform:string;arch:string;gpu?:{name:string;vramBytes?:number;vendor?:string};tier:"low"|"mid"|"high";}
export type ToolRisk="read"|"workspace_write"|"execute"|"network"|"destructive";export type ToolConcurrency="safe_parallel"|"serial";export type ToolIdempotency="idempotent"|"stateful"|"non_idempotent";export type VerificationKind="diagnostics"|"tests"|"build"|"lint"|"runtime";
export interface JsonSchema{type?:"object"|"array"|"string"|"number"|"integer"|"boolean"|"null";description?:string;enum?:unknown[];const?:unknown;default?:unknown;properties?:Record<string,JsonSchema>;required?:string[];additionalProperties?:boolean|JsonSchema;items?:JsonSchema;anyOf?:JsonSchema[];oneOf?:JsonSchema[];nullable?:boolean;}
export interface ToolSpec{name:string;summary:string;params:ToolParam[];inputSchema?:JsonSchema;sideEffecting:boolean;priority:number;minTier?:IntelligenceLevel;tags?:string[];example?:string;risk?:ToolRisk;concurrency?:ToolConcurrency;idempotency?:ToolIdempotency;verifyAfter?:VerificationKind[];}
export interface ToolParam{name:string;type:"string"|"number"|"boolean"|"integer"|"array"|"object"|"null";required:boolean;description:string;enum?:unknown[];items?:JsonSchema;properties?:Record<string,JsonSchema>;}
export interface ExecutionPolicy{maxConcurrent:number;allowParallelReads:boolean;serializeMutations:boolean;generationBudgetTokens:number;thinkingBudgetTokens:number;stepBudget:number;}
export interface VerificationPlan{required:VerificationKind[];completed:VerificationKind[];evidence:string[];}
export interface TaskAnalysis{scope:"single_file"|"multi_file"|"codebase";reasoning:"low"|"medium"|"high";risk:"low"|"medium"|"high"|"destructive";verification:VerificationKind[];ambiguity:"low"|"medium"|"high";estimatedSteps:number;freshness:"none"|"current"|"latest";requiresWeb:boolean;}
export interface AdaptivePlan{model:string;mode:Mode;contextWindow:number;numCtx:number;temperature:number;topP:number;maxOutputTokens:number;toolProtocol:ToolProtocol;maxTools:number;allowParallelTools:boolean;intelligence:IntelligenceLevel;intelligenceAuto:boolean;rationale:string[];task?:TaskAnalysis;modelCapabilities?:ModelCapabilityProfile;executionPolicy?:ExecutionPolicy;verification?:VerificationPlan;thinkingLevel?:ThinkingLevel;thinkingBudgetTokens?:number;}
export type ToolProtocol="native"|"photon-block";
export interface SessionState{id:string;title:string;mode:Mode;model:string;messages:ChatMessage[];createdAt:number;updatedAt:number;}
export interface SessionSummary{id:string;title:string;mode:Mode;model:string;updatedAt:number;messageCount:number;}
export interface TokenUsage{used:number;window:number;breakdown:{label:string;tokens:number}[];}
export type ComplexityLevel="simple"|"moderate"|"complex";
export interface ComplexitySignals{filesReferenced:number;estimatedSteps:number;keywords:string[];promptTokens:number;scope?:TaskAnalysis["scope"];reasoning?:TaskAnalysis["reasoning"];risk?:TaskAnalysis["risk"];verification?:VerificationKind[];ambiguity?:TaskAnalysis["ambiguity"];freshness?:TaskAnalysis["freshness"];requiresWeb?:boolean;}
export interface ComplexityAssessment{level:ComplexityLevel;minContextTokens:number;signals:ComplexitySignals;task?:TaskAnalysis;}
export interface ModelScore{model:string;score:number;fits:boolean;reasons:string[];}
export interface AutoDecision{chosenModel:string;auto:boolean;pinned:boolean;complexity:ComplexityAssessment;scores:ModelScore[];reason:string;}
export type BenchTaskId="throughput"|"toolcall"|"schema"|"tool_selection"|"recovery"|"edit"|"verification"|"context"|"reasoning";
export interface BenchTaskOutcome{id:BenchTaskId;passed:boolean;detail:string;}
export interface BenchResult{model:string;quantization?:string;hardwareClass:string;methodologyVersion:number;tokensPerSec:number;firstTokenMs:number;toolCallReliability:number;reasoningPass:boolean;tasks:BenchTaskOutcome[];ranAt:number;capabilityProfile?:ModelCapabilityProfile;}
export type BenchPhase="idle"|"running"|"done"|"error";
export type IndexPhase="idle"|"indexing"|"ready"|"unavailable"|"error";
export interface IndexStatus{phase:IndexPhase;filesIndexed:number;chunks:number;pending:number;embeddingModel?:string;message?:string;}
export type McpTransport="http"|"stdio";export type McpServerStatus="pending"|"approved"|"connected"|"error"|"revoked";export interface McpServerInfo{id:string;transport:McpTransport;target:string;status:McpServerStatus;toolCount:number;message?:string;}
