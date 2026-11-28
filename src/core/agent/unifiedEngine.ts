import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { resolveInWorkspace } from "../tools/paths";
import type { AdaptivePlan, AgentPhase, ChatMessage, ToolCall, ToolSpec, VerificationPlan } from "../../shared/types";
import type { LLMMessage } from "../llm/types";
import { buildSystemPromptWithReport } from "../prompts/system";
import { fitToWindow } from "./contextManager";
import { estimateTokens, estimateToolSchemasTokens } from "../adaptive/tokens";
import { ReliabilityGovernor, countDiagnosticErrors } from "../adaptive/governor";
import { buildStepStateCard } from "../adaptive/stateCard";
import { getProjectContextManager } from "../context/projectContext";
import { parsePhotonBlocks, validateAgainstSpec, canonicalToolName, stripToolMarkup } from "../protocol/parse";
import { renderToolResult } from "../protocol/serialize";
import { renderToolInstructionsWithMeta, toNativeTools } from "../protocol/serialize";
import { executionFingerprint, recoveryDirective, buildVerificationPlan, isFreshInfoRequest, looksLikeNarration, looksLikeWebLinkDeflection, selectToolSpecs, inferStepPhase, stripFencedCode, suggestFirstTool, canRunInParallel } from "../intelligence/policy";
import {
  classifyRuntimeError,
  formatNativeToolOutcome,
  isContextOverflowError,
  sanitizeToolPairing,
  shouldRetryStep,
  waitWithBackoff,
} from "./errorRecovery";
import { compactSessionMessages } from "./compactor";
import { ToolPipeline } from "../../photon-core/tools/pipeline";
import type { LLMProvider } from "../llm/types";
import type { TodoItem } from "../tools/types";

export interface UnifiedEngineDeps { provider:LLMProvider;tools:import("../tools/types").Tool[];workspaceName?:string;workspaceMap?:()=>Promise<string|undefined>;retrieveContext?:(query:string,signal:AbortSignal)=>Promise<string|undefined>;getCustomizationsPrompt?:()=>string|undefined;buildToolContext:(signal:AbortSignal)=>import("../tools/types").ToolContext;reserveOutputTokens?:number;/** Phase 3: restore a file to its pre-edit content when host diagnostics regress (default true when host verify is active). */autoRevertOnRegression?:boolean;/** Phase 3: wait this long after a file edit before host diagnostics so the language server can catch up (default 0). */hostVerifySettleMs?:number; }
export interface UnifiedEmitter { onAssistantStart(id:string):void;onDelta(id:string,delta:string):void;onThinkingDelta?(id:string,delta:string):void;onThinkingEnd?(id:string,elapsedMs:number):void;onContent(id:string,content:string):void;onAssistantCancel(id:string):void;onPhase(phase:"thinking"|"working",detail?:string):void;onCompacting?(active:boolean):void;onToolCall(id:string,call:ToolCall):void;onToolUpdate(id:string,call:ToolCall):void;onQueuedTools?(calls:ToolCall[]):void;onUsage(usage:import("../../shared/types").TokenUsage):void;onGenerationStats(stats:import("../../shared/types").GenerationStats|null):void;onTurnTelemetry?(summary:import("../../shared/types").TurnReliabilitySummary):void;onDone(id:string,notice?:string):void;onError(message:string):void; }
const MAX_OUTPUT_CHARS = 200_000;
const MAX_TOOL_OUTPUT_CHARS = 100_000;
const MAX_WORKSPACE_MAP_CHARS = 10_000;
const MAX_RETRIEVED_CONTEXT_CHARS = 15_000;
const RETRIEVAL_TIMEOUT_MS = 6_000;

function boundOutput(output: string, maxChars: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (!output || output.length <= maxChars) return output ?? "";
  return output.slice(0, maxChars) + `\n\n[... Output truncated: exceeded ${maxChars} characters ...]`;
}

async function fetchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  parentSignal: AbortSignal
): Promise<T | undefined> {
  if (parentSignal.aborted) return undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

// High non-blocking safety ceilings so tasks complete without artificial cutoffs
const MODE_CAPS:Record<string,number>={chat:100,plan:150,agent:200};
const CHECK_IN_INTERVAL=8;

export async function runUnifiedTurn(session:{messages:ChatMessage[]},plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal,deps:UnifiedEngineDeps):Promise<void>{
  const turnStart = Date.now(); // overall turn start for avg stats
  const pipeline = new ToolPipeline();
  pipeline.registerAll(deps.tools);
  pipeline.lockTurn();
  const task=plan.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1};
  // Phase 3: governor actions only run when the scaffold profile is active and the user has not frozen adaptivity.
  const profileActive=Boolean(plan.scaffoldProfile&&plan.scaffoldOptimizations!==false);
  const adaptive=profileActive&&plan.adaptivityFrozen!==true;
  const governor=new ReliabilityGovernor({
    model:plan.model,
    mode:plan.mode,
    protocol:plan.toolProtocol,
    intelligence:plan.intelligence,
    task,
    adaptive,
    allowProtocolDowngrade:adaptive&&plan.toolProtocol==="native",
    ...(adaptive&&plan.initialRung?{initialRung:plan.initialRung}:{}),
  });
  const autoReverted:string[]=[];
  let stepsObserved=0;
  let baselineDiagErrors:number|undefined;
  let telemetryEmitted=false;
  let logLine:((m:string)=>void)|undefined;
  const emitTelemetryOnce=()=>{
    if(telemetryEmitted)return;
    telemetryEmitted=true;
    logLine?.(governor.formatLogLine(stepsObserved));
    emitter.onTurnTelemetry?.(governor.summary(stepsObserved,{autoReverted}));
  };
  try {
  const lastUserText=lastUser(session.messages)??"";
  // FIX: detect fresh-info requests upfront so we can wire it through
  // to tool selection (guarantees web_search/web_fetch are in the list)
  // and to the system prompt (injects explicit web-search directive).
  const freshInfo = isFreshInfoRequest(lastUserText);

  // Single assistant message id reused across all steps of this turn so the UI
  // shows one continuous working message instead of a new bubble per tool call.
  let currentAssistantId = randomUUID();
  let activeAssistantId: string | null = null;
  let currentRunningTool: ToolCall | null = null;

  const startAssistant = (id: string) => {
    if (activeAssistantId && activeAssistantId !== id) {
      emitter.onDone(activeAssistantId);
    }
    activeAssistantId = id;
    emitter.onAssistantStart(id);
  };

  const completeAssistant = (id: string, notice?: string) => {
    if (currentRunningTool) {
      emitter.onToolUpdate(id, { ...currentRunningTool, status: "error", error: notice || "Operation interrupted." });
      currentRunningTool = null;
    }
    emitter.onDone(id, notice);
    if (activeAssistantId === id) {
      activeAssistantId = null;
    }
  };

  const cancelAssistant = (id: string) => {
    if (currentRunningTool) {
      emitter.onToolUpdate(id, { ...currentRunningTool, status: "error", error: "Operation cancelled." });
      currentRunningTool = null;
    }
    emitter.onAssistantCancel(id);
    if (activeAssistantId === id) {
      activeAssistantId = null;
    }
  };

  if (signal.aborted) {
    startAssistant(currentAssistantId);
    completeAssistant(currentAssistantId, "Stopped.");
    return;
  }

  const isCasualGreeting = /^(?:hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|good (?:morning|afternoon|evening)|bye)[!.\s?]*$/i.test(
    lastUserText.trim()
  );
  const shouldRetrieveRag =
    !!deps.retrieveContext && (plan.mode !== "chat" || (!freshInfo && !isCasualGreeting));

  if ((plan.mode !== "chat" && deps.workspaceMap) || shouldRetrieveRag) {
    emitter.onPhase("thinking", "Retrieving project context");
  }

  let workspaceMap: string | undefined;
  if (plan.mode !== "chat" && deps.workspaceMap) {
    const rawMap = await fetchWithTimeout(() => deps.workspaceMap!(), RETRIEVAL_TIMEOUT_MS, signal);
    if (rawMap) {
      workspaceMap = rawMap.length > MAX_WORKSPACE_MAP_CHARS
        ? rawMap.slice(0, MAX_WORKSPACE_MAP_CHARS) + "\n\n[... Workspace map truncated ...]"
        : rawMap;
    }
  }

  let retrieved: string | undefined;
  if (shouldRetrieveRag && deps.retrieveContext) {
    const rawCtx = await fetchWithTimeout(() => deps.retrieveContext!(lastUserText, signal), RETRIEVAL_TIMEOUT_MS, signal);
    if (rawCtx) {
      retrieved = rawCtx.length > MAX_RETRIEVED_CONTEXT_CHARS
        ? rawCtx.slice(0, MAX_RETRIEVED_CONTEXT_CHARS) + "\n\n[... Retrieved context truncated ...]"
        : rawCtx;
    }
  }

  if (signal.aborted) {
    startAssistant(currentAssistantId);
    completeAssistant(currentAssistantId, "Stopped.");
    return;
  }

  const verificationPlan:VerificationPlan=plan.verification??buildVerificationPlan(task);

  // Spec §2: core loop — enforce step budget from mode caps and execution policy
  const configuredMaxSteps = MODE_CAPS[plan.mode] ?? 200;
  const policyStepBudget = plan.executionPolicy?.stepBudget ?? configuredMaxSteps;
  const maxSteps = Math.min(configuredMaxSteps, policyStepBudget);

  let turnStartIndex = session.messages.length;
  const hasPriorConversation = session.messages.some(
    (m, i) => i < session.messages.length - 1 && !m.hidden && m.role === "assistant" && (m.content.trim().length > 0 || (m.toolCalls?.length ?? 0) > 0)
  );
  let chatBlockNudges = 0;
  let midTurnCompactions = 0;
  let overflowCompactions = 0;

  let mutationEpoch=0;
  let lastDiagHasErrors=false;
  let duplicateStreak=0;
  const executed=new Set<string>();
  const executedTools: { name: string; args: Record<string, unknown>; ok: boolean; directAnswer?: boolean }[] = [];
  let lastAssistantResponse = "";
  // OPT + FIX: preserve todos across tool-context rebuilds by initializing from existing
  // tool context and writing mutations back to baseToolCtx on every update.
  const baseToolCtx={...deps.buildToolContext(signal),mode:plan.mode,executionPolicy:plan.executionPolicy};
  const initialTodos = baseToolCtx.todos ?? [];
  const sharedTodos:TodoItem[]=[...initialTodos];
  const todoState=sharedTodos;
  const sharedLog=baseToolCtx.log;
  logLine=sharedLog;
  const recordToolOutcome=(toolName:string,ok:boolean,output:string,stepIdx:number,isVerify:boolean)=>{
    if(toolName==="get_diagnostics"){
      const errs=countDiagnosticErrors(output);
      lastDiagHasErrors=errs>0;
      if(mutationEpoch===0&&baselineDiagErrors===undefined){
        baselineDiagErrors=errs;
      }else if(mutationEpoch>0&&errs>(baselineDiagErrors??0)){
        governor.record("diag_regression",{step:stepIdx,tool:toolName,detail:`${baselineDiagErrors??0}->${errs}`});
        baselineDiagErrors=errs;
      }else{
        baselineDiagErrors=errs;
      }
    }else if(ok){
      const spec=toolSpecByName.get(toolName);
      if(spec?.sideEffecting) lastDiagHasErrors=false;
    }
    governor.record(ok?(isVerify?"verify_ok":"tool_ok"):"tool_error",{step:stepIdx,tool:toolName,detail:ok?undefined:output});
  };
  const syncTodosBack=()=>{
    if(baseToolCtx.todos){
      baseToolCtx.todos.length=0;
      baseToolCtx.todos.push(...sharedTodos);
    }
  };
  const toolCtxFor=(pendingCallId:string)=>({...deps.buildToolContext(signal),mode:plan.mode,todos:sharedTodos,pendingCallId,executionPolicy:plan.executionPolicy});
  const ctxMgr=getProjectContextManager(baseToolCtx.workspaceRoot);
  if(ctxMgr) await ctxMgr.ensureInitialized().catch(()=>undefined);
  const projectContextDigest=!freshInfo?ctxMgr?.buildPromptDigest({userQuery:lastUserText,activeModel:plan.model,maxTokens:Math.min(1200,Math.floor(plan.numCtx*0.18))}):undefined;

  const buildTurnSummary = (outcome: "completed" | "stopped" | "step_limit" | "blocked"): string => {
    const completed = executedTools.filter((t) => t.ok).map((t) => t.name);
    const attempted = executedTools.filter((t) => !t.ok).map((t) => t.name);
    const unresolved = todoState
      .filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked")
      .map((t) => t.task);

    const parts: string[] = [];
    if (outcome === "stopped") {
      parts.push("Turn was stopped by user.");
    } else if (outcome === "step_limit") {
      parts.push(`Reached the ${maxSteps}-step limit for this turn.`);
    } else if (outcome === "blocked") {
      parts.push("Execution was blocked due to repeated failures.");
    } else {
      parts.push("Turn completed.");
    }

    if (completed.length) parts.push(`Completed: ${completed.join(", ")}.`);
    if (attempted.length) parts.push(`Failed/attempted: ${attempted.join(", ")}.`);
    if (unresolved.length) parts.push(`Unresolved tasks: ${unresolved.join("; ")}.`);

    return parts.join(" ");
  };

  const commitTurnHandoff = (outcome: "completed" | "stopped" | "step_limit" | "blocked" = "completed") => {
    syncTodosBack();
    if (ctxMgr && (lastAssistantResponse || executedTools.length)) {
      ctxMgr.recordTurnHandoff({
        fromModel: plan.model,
        userPrompt: lastUserText,
        assistantResponse: lastAssistantResponse || buildTurnSummary(outcome),
        toolsUsed: executedTools,
        pendingTodos: todoState.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => t.task),
      });
    }
  };
  // Phase 2 dynamic scaffold: keep prompt prefix cached within a phase and rebuild
  // only when the inferred phase or failing tool example target changes.
  const dynamicScaffold=Boolean(plan.scaffoldProfile&&plan.scaffoldOptimizations!==false);
  const allSpecs=deps.tools.map(t=>t.spec);
  const customizationsPrompt=deps.getCustomizationsPrompt?.();
  const toolSpecByName=new Map(deps.tools.map(t=>[t.spec.name,t.spec] as const));

  let currentPhase:AgentPhase="orient";
  let lastFailedTool:string|undefined;
  let renderedPhase:AgentPhase="orient";
  let renderedFailedTool:string|undefined;

  let specs:ToolSpec[]=[];
  let modeToolNames=new Set<string>();
  let toolInstructions="";
  let promptReport!:ReturnType<typeof buildSystemPromptWithReport>["report"];
  let systemMsg!:LLMMessage;
  let nativeTools:unknown[]|undefined;

  const rebuildStepSurface=(phase:AgentPhase,failedTool:string|undefined,initial=false)=>{
    specs=selectToolSpecs(allSpecs,plan,phase,freshInfo);
    // Names the model may actually call this turn. In chat mode this is just
    // the web tools — anything else is a mode violation, not a retryable error.
    modeToolNames=new Set(specs.map(s=>s.name));
    const toolRender=plan.toolProtocol==="native"
      ? undefined
      : renderToolInstructionsWithMeta(specs,plan,{phase,failingTools:failedTool?[failedTool]:undefined});
    toolInstructions=toolRender?.text??"";
    const built=buildSystemPromptWithReport({
      mode:plan.mode,
      plan,
      toolInstructions,
      workspaceName:deps.workspaceName,
      workspaceMap,
      retrievedContext:retrieved,
      projectContextDigest,
      lastUserText:lastUserText,
      freshInfoRequest:freshInfo,
      customizationsPrompt,
      toolSpecs:specs,
      toolMeta:{exampleToolNames:toolRender?.exampleToolNames,toolCount:specs.length},
    });
    promptReport=built.report;
    systemMsg={role:"system",content:built.text};
    const compactNative = Boolean(
      plan.scaffoldProfile &&
      plan.scaffoldOptimizations !== false &&
      plan.scaffoldProfile.toolCards !== "full"
    );
    nativeTools =
      plan.toolProtocol === "native" && specs.length
        ? toNativeTools(specs, compactNative ? {
            compact: true,
            shortlistSize: plan.scaffoldProfile?.shortlistSize,
            failingTools: failedTool ? [failedTool] : undefined,
          } : undefined)
        : undefined;
    renderedPhase=phase;
    renderedFailedTool=failedTool;
    if(initial){
      sharedLog(
        `[prompt] model=${plan.model} level=${plan.intelligence} protocol=${plan.toolProtocol} total=${promptReport.totalTokens}/${promptReport.budgetTokens??plan.numCtx} tok (${promptReport.sections.map(s=>`${s.id}:${s.tokens}${s.status!=="kept"?`(${s.status})`:""}`).join(", ")})`
      );
    }else{
      sharedLog(
        `[scaffold] phase=${phase}${failedTool?` failingTool=${failedTool}`:""} total=${promptReport.totalTokens}/${promptReport.budgetTokens??plan.numCtx} tok (tools:${promptReport.sections.find(s=>s.id==="tools")?.tokens??0})`
      );
    }
  };

  rebuildStepSurface("orient",undefined,true);
  const effectiveOutputReserve = Math.max(
    256,
    Math.min(deps.reserveOutputTokens ?? plan.maxOutputTokens ?? 1000, Math.floor(plan.numCtx * 0.5))
  );
  const budgetTokens = Math.max(512, plan.numCtx - effectiveOutputReserve);
  // Track retries per logical step for §5 retry policy
  const retryCount = new Map<string, number>();
  let continueNudges = 0;
  const MAX_CONTINUE_NUDGES = dynamicScaffold && plan.scaffoldProfile ? plan.scaffoldProfile.nudgePolicy.continue : 5;
  let finalAnswerNudges = 0;
  const MAX_FINAL_ANSWER_NUDGES = dynamicScaffold && plan.scaffoldProfile ? plan.scaffoldProfile.nudgePolicy.finalAnswer : 2;
  // FIX: a first-step empty completion (no tools yet, nothing visible) used to
  // fall straight through to a bare onDone — a silent turn end with an
  // invisible bubble. Retry bounded like the legacy engine, then say so.
  let emptyStreak = 0;
  const MAX_EMPTY_RETRIES = 2;
  // FIX: count tools that actually ran this turn. Once a tool has run, the model
  // must conclude; if it keeps emitting tool calls instead, we nudge it to answer.
  let toolsRun = 0;
  let concludeNudges = 0;
  const MAX_CONCLUDE_NUDGES = 2;
  // FIX: track output truncation separately. When the stream is cut off
  // (done_reason "length") mid-tool-call, the parser finds no valid call and
  // the turn used to die silently. We now retry a bounded number of times.
  let truncationRetries = 0;
  const MAX_TRUNCATION_RETRIES = dynamicScaffold && plan.scaffoldProfile ? plan.scaffoldProfile.nudgePolicy.truncation : 2;
  let streamRetries = 0;
  const MAX_STREAM_RETRIES = 1;
  // Turn-scoped output tally: raw is declared per step, but the closing stats
  // are emitted after the loop — sum here so the average is per turn, not per step.
  let generatedChars = 0;
  // FIX: when a small model emits 2+ tool calls in one response, the extras used
  // to be silently dropped — the model then believed they ran and got confused. We
  // now queue them and execute them in subsequent iterations without re-querying.
  const pendingCalls:ToolCall[]=[];

  // ---- Phase 3.3: host-verified edits with automatic revert on diagnostics regression ----
  const hostVerifyOn=adaptive&&plan.mode==="agent"&&(plan.scaffoldProfile?.hostVerify??"off")!=="off";
  const autoRevertOn=hostVerifyOn&&deps.autoRevertOnRegression!==false;
  const FILE_MUTATORS=new Set(["edit_file","write_file","append_file"]);
  const hostBaseline=new Map<string,number>();
  const preImages=new Map<string,{rel:string;abs:string;content:string|null}>();
  let forceConclude=false;
  const countHostErrors=async(abs:string|undefined):Promise<{errors:number;lines:string[]}|undefined>=>{
    try{
      if(typeof baseToolCtx.getDiagnostics!=="function")return undefined;
      const all=await baseToolCtx.getDiagnostics(abs);
      const errs=all.filter(d=>d.severity==="error");
      return{errors:errs.length,lines:errs.slice(0,3).map(d=>`${d.file}:${d.line}:${d.col} ${d.message}`)};
    }catch{return undefined;}
  };
  /** Snapshot the target file and capture a diagnostics baseline BEFORE a file mutation runs. */
  const hostPrepare=async(call:ToolCall):Promise<void>=>{
    if(!hostVerifyOn||!FILE_MUTATORS.has(call.name))return;
    const rel=typeof call.args?.path==="string"?call.args.path.trim():"";
    if(!rel||!baseToolCtx.workspaceRoot)return;
    const r=resolveInWorkspace(baseToolCtx.workspaceRoot,rel);
    if("error" in r)return;
    let content:string|null=null;
    try{content=await fs.readFile(r.abs,"utf8");}catch{content=null;}
    preImages.set(call.id,{rel,abs:r.abs,content});
    if(!hostBaseline.has(rel)){
      const d=await countHostErrors(r.abs);
      if(d)hostBaseline.set(rel,d.errors);
    }
  };
  /** After a successful file mutation: run diagnostics, tell the model N→M, and revert on regression. */
  const hostFinish=async(call:ToolCall,ok:boolean,output:string,stepIdx:number):Promise<{ok:boolean;output:string}>=>{
    const pre=preImages.get(call.id);
    preImages.delete(call.id);
    if(!pre||!ok)return{ok,output};
    const base=hostBaseline.get(pre.rel);
    if(base===undefined)return{ok,output};
    const settle=deps.hostVerifySettleMs??0;
    if(settle>0)await new Promise<void>(res=>setTimeout(res,settle));
    const d=await countHostErrors(pre.abs);
    if(!d)return{ok,output};
    if(d.errors>base){
      governor.record("diag_regression",{step:stepIdx,tool:call.name,detail:`${pre.rel} ${base}->${d.errors}`});
      const errLines=d.lines.length?`\n${d.lines.join("\n")}`:"";
      if(autoRevertOn){
        try{
          if(pre.content===null)await fs.unlink(pre.abs);
          else await fs.writeFile(pre.abs,pre.content,"utf8");
          autoReverted.push(pre.rel);
          governor.note("auto_revert",stepIdx,`${pre.rel}: diagnostics ${base}→${d.errors}; edit reverted`);
          sharedLog(`[governor] auto-reverted ${pre.rel} (diagnostics ${base}->${d.errors})`);
          return{ok:false,output:`${output}\n[Photon host verify] Diagnostics for ${pre.rel} regressed ${base}→${d.errors} after this edit, so Photon AUTOMATICALLY REVERTED the file to its previous content. The edit did NOT apply.${errLines}\nRe-read ${pre.rel} and retry with a smaller, correct change.`};
        }catch(e){
          sharedLog(`[governor] auto-revert of ${pre.rel} failed: ${(e as Error).message}`);
        }
      }
      return{ok,output:`${output}\n[Photon host verify] Diagnostics for ${pre.rel} regressed ${base}→${d.errors} after this edit. Fix these errors before finishing:${errLines}`};
    }
    hostBaseline.set(pre.rel,d.errors);
    return{ok,output:`${output}\n[Photon host verify] get_diagnostics(${pre.rel}): ${d.errors===0?"no errors":`${d.errors} error(s) (was ${base})`}.`};
  };

  for(let step=0;step<maxSteps&&!signal.aborted;step++){
    stepsObserved=step+1;
    if (signal.aborted) {
      pendingCalls.length = 0;
      if (activeAssistantId) completeAssistant(activeAssistantId, "Stopped.");
      commitTurnHandoff("stopped");
      return;
    }

    // Drain any queued tool calls from a previous multi-call response BEFORE
    // querying the model again.
    if(pendingCalls.length){
      const queuedRaw=pendingCalls.shift()!;
      emitter.onQueuedTools?.([...pendingCalls]);
      const qId=currentAssistantId;

      // Chat mode can't run workspace tools — a queued extra the model
      // emitted alongside a web call must not become an error card either.
      if(plan.mode==="chat"&&!modeToolNames.has(queuedRaw.name)){
        governor.record("mode_violation",{step,tool:queuedRaw.name});
        startAssistant(qId);
        emitter.onContent(qId,chatRedirectText(queuedRaw));
        completeAssistant(qId);
        currentAssistantId=randomUUID();
        continue;
      }

      if(queuedRaw.status==="error"){
        lastFailedTool=queuedRaw.name;
        governor.record("invalid_args",{step,tool:queuedRaw.name,detail:queuedRaw.error});
        governor.record("repair",{step,tool:queuedRaw.name});
        startAssistant(qId);
        emitter.onToolCall(qId,queuedRaw);
        emitter.onToolUpdate(qId,queuedRaw);
        const spec=toolSpecByName.get(queuedRaw.name);
        const example=spec?renderCorrectExample(spec,queuedRaw.args):"";
        const errDetail = (queuedRaw.error||"Invalid tool call")+(example?`\n\nCorrect format for ${queuedRaw.name}:\n${example}`:"");
        if(plan.toolProtocol==="native"){
          session.messages.push({
            id:randomUUID(),
            role:"tool",
            content:formatNativeToolOutcome(queuedRaw.name, errDetail, false),
            toolCallId:queuedRaw.id,
            name:queuedRaw.name,
            createdAt:Date.now(),
            hidden:true,
          } as ChatMessage);
        } else {
          session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(queuedRaw.name, errDetail, false),createdAt:Date.now(),hidden:true});
        }
        completeAssistant(qId);
        currentAssistantId=randomUUID();
        continue;
      }

      const qFingerprint=executionFingerprint(queuedRaw,mutationEpoch);
      if(executed.has(qFingerprint)){
        governor.record("duplicate",{step,tool:queuedRaw.name});
        startAssistant(qId);
        emitter.onToolCall(qId,queuedRaw);
        emitter.onToolUpdate(qId,{...queuedRaw,status:"error",statusDetail:undefined,error:"Duplicate call — already ran. Use the earlier result."});
        const dupResult=renderToolResult(queuedRaw.name, "You already ran this exact call. Use the earlier result. If the task is complete, give your final answer with no tool call.", false);
        if(plan.toolProtocol==="native"){
          session.messages.push({
            id:randomUUID(),
            role:"tool",
            content:formatNativeToolOutcome(queuedRaw.name, "Duplicate call — already ran. Use the earlier result.", false),
            toolCallId:queuedRaw.id,
            name:queuedRaw.name,
            createdAt:Date.now(),
            hidden:true,
          } as ChatMessage);
        } else {
          session.messages.push({id:randomUUID(),role:"user",content:dupResult,createdAt:Date.now(),hidden:true});
        }
        completeAssistant(qId);
        currentAssistantId=randomUUID();
        continue;
      }
      executed.add(qFingerprint);

      // Normalize: the queued copy must start clean in its own bubble.
      const queued:ToolCall={...queuedRaw,status:"proposed",statusDetail:undefined} as ToolCall;
      const isQueuedVerify =
        queued.name === "get_diagnostics" ||
        ((queued.name === "run_command" || queued.name === "execute_command") && mutationEpoch > 0);
      startAssistant(qId);
      emitter.onPhase("working", isQueuedVerify ? `Verifying changes (${queued.name})` : queued.name);
      emitter.onToolCall(qId,queued);
      emitter.onToolUpdate(qId,{...queued,status:"running",statusDetail:undefined});
      currentRunningTool = queued;
      const qCtx=toolCtxFor(queued.id);
      await hostPrepare(queued);
      const qResults=await pipeline.executeMany([queued],qCtx,1);
      currentRunningTool = null;
      syncTodosBack();

      if(signal.aborted){
        pendingCalls.length = 0;
        emitter.onToolUpdate(qId, { ...queued, status: "error", error: "Operation cancelled." });
        completeAssistant(qId, "Stopped.");
        commitTurnHandoff("stopped");
        return;
      }
      const qResult=qResults.get(queued.id);
      if(!qResult){
        lastFailedTool=queued.name;
        governor.record("tool_error",{step,tool:queued.name,detail:"no_result"});
        emitter.onToolUpdate(qId,{...queued,status:"error",statusDetail:undefined,error:"Tool execution produced no result."});
        if(plan.toolProtocol==="native"){
          session.messages.push({
            id:randomUUID(),
            role:"tool",
            content:formatNativeToolOutcome(queued.name, "Tool execution produced no result.", false),
            toolCallId:queued.id,
            name:queued.name,
            createdAt:Date.now(),
            hidden:true,
          } as ChatMessage);
        } else {
          session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(queued.name, "Tool execution produced no result.", false),createdAt:Date.now(),hidden:true});
        }
        completeAssistant(qId);
        currentAssistantId=randomUUID();
        continue;
      }
      {
        const qSpec=toolSpecByName.get(queued.name);
        const qEff=await hostFinish(queued,qResult.ok,qResult.output,step);
        const qOk=qEff.ok;
        lastFailedTool=qOk?undefined:queued.name;
        recordToolOutcome(queued.name,qOk,qEff.output,step,isQueuedVerify);
        if(qSpec?.sideEffecting&&qOk)mutationEpoch++;
        toolsRun++;
        executedTools.push({
          name: queued.name,
          args: queued.args,
          ok: qOk,
          directAnswer: qOk && queued.name === "web_search" && qEff.output.includes("[Live data retrieved directly"),
        });
        const boundedQOutput = boundOutput(qEff.output);
        emitter.onToolUpdate(qId,{...queued,status:qOk?"done":"error",statusDetail:undefined,result:qOk?boundedQOutput:undefined,error:qOk?undefined:boundedQOutput});
        if(plan.toolProtocol==="native"){
          session.messages.push({id:randomUUID(),role:"tool",content:formatNativeToolOutcome(queued.name,boundedQOutput,qOk),toolCallId:queued.id,name:queued.name,createdAt:Date.now(),hidden:true} as ChatMessage);
        }else{
          session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(queued.name,boundedQOutput,qOk),createdAt:Date.now(),hidden:true});
        }
        if(qSpec?.sideEffecting&&qOk&&plan.mode!=="chat"){
          session.messages.push({id:randomUUID(),role:"user",content:mutationConcludeNudge(queued.name),createdAt:Date.now(),hidden:true});
        }
        completeAssistant(qId);
        currentAssistantId=randomUUID();
      }
      continue;
    }
    // Spec §5: check-in every 8
    if(step>0 && step%CHECK_IN_INTERVAL===0 && step < maxSteps){
      const pending = todoState.filter(t=>t.status==="pending"||t.status==="in_progress").length;
      if(pending>0){
        sharedLog(`[progress] Step ${step}/${maxSteps}: ${pending} todos remaining`);
      }
    }

    if (signal.aborted) {
      pendingCalls.length = 0;
      if (activeAssistantId) completeAssistant(activeAssistantId, "Stopped.");
      commitTurnHandoff("stopped");
      return;
    }

    if (adaptive) {
      // Rung 3: native tool calling kept failing -> switch this turn to the tolerant block protocol.
      if (governor.consumeProtocolDowngrade() && plan.toolProtocol === "native") {
        plan = { ...plan, toolProtocol: "photon-block" };
        governor.setProtocol("photon-block");
        governor.note("protocol_downgrade", step, "Native tool calling failed repeatedly; switched to the Photon block protocol for the rest of this turn.");
        sharedLog(`[governor] rung=${governor.rung()} native → photon-block protocol downgrade`);
        rebuildStepSurface(currentPhase, lastFailedTool, false);
        session.messages.push({
          id: randomUUID(),
          role: "user",
          content:
            "Photon switched tool calling to its text format because structured tool calls kept failing. From now on call tools ONLY with a single ```tool block exactly as shown in the system prompt (TOOL_NAME / BEGIN_ARG / END_ARG), then stop. Retry the last step now.",
          createdAt: Date.now(),
          hidden: true,
        });
      }
      // Rung 4: host takes over, reports what it can verify, and forces a text conclusion.
      if (governor.consumeTakeover()) {
        forceConclude = true;
        continueNudges = MAX_CONTINUE_NUDGES;
        truncationRetries = MAX_TRUNCATION_RETRIES;
        finalAnswerNudges = MAX_FINAL_ANSWER_NUDGES;
        emptyStreak = MAX_EMPTY_RETRIES;
        let hostReport = "";
        if (hostVerifyOn && mutationEpoch > 0) {
          const d = await countHostErrors(undefined);
          if (d) {
            hostReport = ` Host diagnostics for the workspace: ${d.errors} error(s)${d.lines.length ? ` — ${d.lines.join("; ")}` : ""}.`;
          }
        }
        governor.note("force_conclude", step, "Repeated failures; host stopped tool use and asked for a final answer.");
        sharedLog(`[governor] rung=${governor.rung()} host takeover — forcing a text conclusion`);
        session.messages.push({
          id: randomUUID(),
          role: "user",
          content: `Photon stopped tool use after repeated tool-call failures.${hostReport} Do NOT call any more tools. Using only what you have already gathered, write your final answer now: say plainly what was completed, what was not, and what the user should do next. Do not claim anything succeeded unless a tool result confirmed it.`,
          createdAt: Date.now(),
          hidden: true,
        });
      }
    }

    if (dynamicScaffold) {
      const hasPendingTodos = todoState.some((t) => t.status === "pending" || t.status === "in_progress");
      const nextPhase = inferStepPhase(
        plan.mode,
        executedTools.map((t) => ({ ...t, sideEffecting: toolSpecByName.get(t.name)?.sideEffecting })),
        hasPendingTodos,
        lastDiagHasErrors
      );
      currentPhase = nextPhase;
      const failingExamples = plan.scaffoldProfile?.examples === "phase+failing" || (adaptive && governor.rung() >= 1);
      const wantFailed = failingExamples ? lastFailedTool : undefined;
      if (nextPhase !== renderedPhase || wantFailed !== renderedFailedTool) {
        rebuildStepSurface(nextPhase, wantFailed, false);
      }
    }

    const attachStateCard = (baseHistory: LLMMessage[]): LLMMessage[] => {
      const baseStyle = plan.scaffoldProfile?.stateCard ?? "off";
      // Rung 2 forces at least a compact working-memory card even when the profile has none.
      const style = adaptive && governor.rung() >= 2 && baseStyle === "off" ? "compact" : baseStyle;
      if (!dynamicScaffold || step === 0 || !plan.scaffoldProfile || style === "off") {
        return baseHistory;
      }
      const card = buildStepStateCard({
        goal: lastUserText,
        mode: plan.mode,
        phase: currentPhase,
        style,
        todos: todoState,
        messages: session.messages.slice(Math.max(0, turnStartIndex - 1)),
        executedTools,
        lastFailedTool,
      });
      return card ? [...baseHistory, { role: "user", content: card }] : baseHistory;
    };

    emitter.onPhase("thinking");
    let history = attachStateCard(historyToLLM(session.messages, plan, turnStartIndex));
    const toolSchemasTokens = nativeTools && nativeTools.length > 0 ? estimateToolSchemasTokens(nativeTools, plan.model) : 0;
    let fit=fitToWindow(systemMsg,history,budgetTokens,plan.numCtx,plan.model,{
      preserveFirstUser: true,
      toolSchemasTokens,
      reserveOutputTokens: effectiveOutputReserve,
      promptReport,
    });
    const usableBudget = Math.max(512, plan.numCtx - effectiveOutputReserve);
    if (
      step > 0 &&
      midTurnCompactions < 2 &&
      session.messages.length >= 8 &&
      usableBudget >= 2048 &&
      (fit.droppedCount > 0 || fit.usage.used >= usableBudget * 0.82)
    ) {
      emitter.onCompacting?.(true);
      emitter.onPhase("thinking", "Compacting context window");
      let comp: Awaited<ReturnType<typeof compactSessionMessages>>;
      try {
        comp = await compactSessionMessages({
          messages: session.messages,
          contextWindow: plan.numCtx,
          model: plan.model,
          provider: deps.provider,
          force: true,
          keepRecentUserTurns: 1,
          signal,
        });
      } finally {
        emitter.onCompacting?.(false);
      }
      if (comp.compacted) {
        midTurnCompactions++;
        for (const m of comp.newMessages) {
          if (m.isCompacted) m.hidden = true;
        }
        session.messages = comp.newMessages;
        turnStartIndex = Math.max(0, session.messages.length - (comp.retained?.recentMessagesKept ?? 0));
        history = attachStateCard(historyToLLM(session.messages, plan, turnStartIndex));
        fit = fitToWindow(systemMsg, history, budgetTokens, plan.numCtx, plan.model, {
          preserveFirstUser: true,
          toolSchemasTokens,
          reserveOutputTokens: effectiveOutputReserve,
          promptReport,
        });
        sharedLog(`[compactor] mid-turn compacted session (${comp.strategy}) — saved ~${comp.tokensSaved} tokens.`);
      }
    }
    emitter.onUsage(fit.usage);
    const id=currentAssistantId;
    startAssistant(id);
    const stepTemperature =
      !dynamicScaffold || plan.samplingOverridden || !plan.scaffoldProfile
        ? plan.temperature
        : currentPhase === "final" || (plan.mode === "chat" && toolsRun > 0)
          ? plan.scaffoldProfile.sampling.answerTurnTemp
          : Math.max(0, plan.scaffoldProfile.sampling.toolTurnTemp - (adaptive && governor.rung() >= 2 ? 0.05 : 0));
    const stepThinking =
      dynamicScaffold && plan.scaffoldProfile ? plan.scaffoldProfile.thinking : undefined;
    let raw="";let thinkingStep="";const thinkingStart=Date.now();const nativeCalls:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[]=[];let doneReason:string|undefined;
    const streamStart=Date.now();
    let gotFirstChunk=false;
    let hadExactUsage=false;
    let slowTimer:ReturnType<typeof setInterval>|undefined;
    const stopSlowTimer=()=>{if(slowTimer){clearInterval(slowTimer);slowTimer=undefined;}};
    slowTimer=setInterval(()=>{
      if(gotFirstChunk||signal.aborted)return;
      const elapsed=Math.round((Date.now()-streamStart)/1000);
      sharedLog(`[engine] still waiting for model response (${elapsed}s) — a cold or large model loading into memory can take minutes on first use.`);
      emitter.onPhase("thinking",`Waiting for model (${elapsed}s)…`);
    },20000);
    try{
      for await(const chunk of deps.provider.chatStream({
        model:plan.model,
        messages:fit.messages,
        options:{
          num_ctx:plan.numCtx,
          temperature:stepTemperature,
          top_p:plan.topP,
          num_predict:plan.maxOutputTokens,
          ...(plan.seed!==undefined?{seed:plan.seed}:{}),
          ...(stepThinking!==undefined?{thinkingLevel:stepThinking}:{}),
        },
        tools:forceConclude?undefined:nativeTools
      },signal)){
        if(!gotFirstChunk){gotFirstChunk=true;stopSlowTimer();}
        if(chunk.message?.thinking){
          thinkingStep+=chunk.message.thinking;
          emitter.onThinkingDelta?.(id,chunk.message.thinking);
        }
        if(chunk.message?.content){
          raw+=chunk.message.content;
          if(plan.toolProtocol==="native") emitter.onDelta(id,chunk.message.content);
        }
        for(const tc of chunk.message?.tool_calls??[])nativeCalls.push({id:tc.id,name:tc.function.name,args:tc.function.arguments??{},thoughtSignature:tc.thoughtSignature});
        if(chunk.done_reason)doneReason=chunk.done_reason;
        if(chunk.prompt_eval_count && chunk.prompt_eval_count > 0){
          hadExactUsage = true;
          const convTok = Math.max(0, chunk.prompt_eval_count - (fit.usage.breakdown[0]?.tokens ?? 0));
          emitter.onUsage({
            used: chunk.prompt_eval_count + (chunk.eval_count ?? 0),
            window: plan.numCtx,
            breakdown: [
              fit.usage.breakdown[0] ?? { label: "System + tools", tokens: 0 },
              { label: "Conversation (exact)", tokens: convTok + (chunk.eval_count ?? 0) },
            ],
            promptReport,
          });
        }
        if(chunk.eval_count && chunk.eval_duration && chunk.eval_duration > 0){
          const exactTps = Math.round((chunk.eval_count / (chunk.eval_duration / 1e9)) * 10) / 10;
          emitter.onGenerationStats({ tps: exactTps, totalTokens: chunk.eval_count, elapsedMs: Math.round(chunk.eval_duration / 1e6) });
        }
        if(raw.length>MAX_OUTPUT_CHARS){doneReason="length";break;}
      }
      stopSlowTimer();
      if(!hadExactUsage && raw.trim()){
        const outputTok = estimateTokens(raw);
        emitter.onUsage({
          used: fit.usage.used + outputTok,
          window: plan.numCtx,
          breakdown: [
            fit.usage.breakdown[0] ?? { label: "System + tools", tokens: 0 },
            { label: "Conversation", tokens: (fit.usage.breakdown[1]?.tokens ?? 0) + outputTok },
          ],
          promptReport,
        });
      }
    }catch(e){
      stopSlowTimer();
      if(thinkingStep)emitter.onThinkingEnd?.(id,Date.now()-thinkingStart);
      const classified=classifyRuntimeError(e,signal);
      if(classified.category==="cancelled"||signal.aborted){
        completeAssistant(id, raw.trim()?"Stopped.":"Stopped before the model replied.");
        commitTurnHandoff("stopped");
        return;
      }
      if (
        isContextOverflowError(e, classified.rawMessage) &&
        !raw.trim() &&
        nativeCalls.length === 0 &&
        overflowCompactions < 2
      ) {
        overflowCompactions++;
        governor.record("context_overflow",{step});
        cancelAssistant(id);
        emitter.onCompacting?.(true);
        emitter.onPhase("thinking", "Context overflow — compacting and retrying");
        let comp: Awaited<ReturnType<typeof compactSessionMessages>>;
        try {
          comp = await compactSessionMessages({
            messages: session.messages,
            contextWindow: plan.numCtx,
            model: plan.model,
            provider: overflowCompactions === 1 ? deps.provider : undefined,
            force: true,
            keepRecentUserTurns: 1,
            signal,
          });
        } finally {
          emitter.onCompacting?.(false);
        }
        if (comp.compacted) {
          for (const m of comp.newMessages) {
            if (m.isCompacted) m.hidden = true;
          }
          session.messages = comp.newMessages;
          turnStartIndex = Math.max(0, session.messages.length - (comp.retained?.recentMessagesKept ?? 0));
          sharedLog(`[compactor] recovered from context overflow (${comp.strategy}) — retrying step.`);
          step--;
          continue;
        }
      }
      const canRetry = shouldRetryStep(classified, {
        sideEffectsOccurred: mutationEpoch > 0 || toolsRun > 0,
        streamRetries,
        maxRetries: MAX_STREAM_RETRIES,
        hasContent: Boolean(raw.trim()),
        toolCallsCount: nativeCalls.length,
      });
      if (canRetry.shouldRetry) {
        streamRetries++;
        governor.record("stream_retry",{step,detail:classified.category});
        sharedLog(
          `[engine] transient ${classified.category} error (${classified.rawMessage}) — retrying step (${streamRetries}/${MAX_STREAM_RETRIES}) after ${classified.backoffMs}ms backoff.`
        );
        cancelAssistant(id);
        step--;
        const okToContinue = await waitWithBackoff(classified.backoffMs, signal);
        if (!okToContinue || signal.aborted) {
          completeAssistant(id, "Stopped.");
          commitTurnHandoff("stopped");
          return;
        }
        continue;
      }
      cancelAssistant(id);
      emitter.onError(classified.userMessage);
      commitTurnHandoff("blocked");
      return;
    }
    if(thinkingStep)emitter.onThinkingEnd?.(id,Date.now()-thinkingStart);
    generatedChars+=raw.length;

    const resolved=resolveCalls(raw,nativeCalls,specs,plan);
    // After a host takeover the model must answer in text: any tool call it still emits is ignored.
    if(forceConclude&&resolved.calls.length){
      sharedLog(`[governor] ignoring ${resolved.calls.length} tool call(s) emitted after forced conclusion`);
      resolved.calls.length=0;
    }
    const calls=resolved.calls;
    let visible=resolved.cleanedText;
    const failedAttempt=calls.length===0&&looksLikeFailedToolAttempt(raw);
    if(failedAttempt){
      const attemptedName=specs.map(s=>s.name).find(n=>new RegExp(`\\b${n}\\b`).test(raw));
      const firstTool=attemptedName??suggestFirstTool(specs,lastUserText);
      lastFailedTool=firstTool;
      governor.record("parse_fail",{step,tool:attemptedName,detail:"incomplete_tool_block"});
      visible=stripToolAttemptMarkup(visible);
      if(continueNudges<MAX_CONTINUE_NUDGES){
        continueNudges++;
        const spec=toolSpecByName.get(firstTool);
        const example=spec?`\n\nCorrect format:\n${renderCorrectExample(spec,{})}`:"";
        session.messages.push({id:randomUUID(),role:"user",content:`You tried to call a tool but the block was incomplete, so nothing ran. Do NOT explain — re-emit EXACTLY one complete tool block now, starting with ${firstTool}.${example}`,createdAt:Date.now(),hidden:true});
        completeAssistant(id);
        currentAssistantId=randomUUID();
        continue;
      }
    }

    if(plan.mode==="chat"&&calls.length&&(!modeToolNames.has(calls[0].name)||toolSpecByName.get(calls[0].name)?.sideEffecting)){
      const blocked=calls[0];
      governor.record("mode_violation",{step,tool:blocked.name});
      if(chatBlockNudges<1&&step<maxSteps-1){
        chatBlockNudges++;
        const blockMsg=
          `Tool "${blocked.name}" is blocked because Chat mode is strictly read-only (no file modifications, creations, moves, or shell commands). `+
          `Do NOT call write/edit/command tools. Reply politely in plain text: show the user how to make the change manually (with clear steps or code snippet) and suggest switching the mode selector to Agent mode to edit files directly.`;
        if(plan.toolProtocol==="native"){
          session.messages.push({id:randomUUID(),role:"assistant",content:visible||"",toolCalls:[blocked],createdAt:Date.now(),hidden:true} as ChatMessage);
          session.messages.push({id:randomUUID(),role:"tool",content:formatNativeToolOutcome(blocked.name,blockMsg,false),toolCallId:blocked.id,name:blocked.name,createdAt:Date.now(),hidden:true} as ChatMessage);
        }else{
          session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(blocked.name,blockMsg,false),createdAt:Date.now(),hidden:true});
        }
        completeAssistant(id);
        currentAssistantId=randomUUID();
        continue;
      }
      const prefix=visible.trim()?`${boundOutput(visible.trim(), MAX_OUTPUT_CHARS)}\n\n`:"";
      const redirect=prefix+chatRedirectText(blocked);
      lastAssistantResponse=redirect;
      emitter.onContent(id,redirect);
      completeAssistant(id);
      commitTurnHandoff("completed");
      return;
    }
    if(plan.mode==="plan"&&calls.length&&(!modeToolNames.has(calls[0].name)||toolSpecByName.get(calls[0].name)?.sideEffecting)){
      const blocked=calls[0];
      governor.record("mode_violation",{step,tool:blocked.name});
      const blockMsg=`Tool "${blocked.name}" is not available in Plan mode (read-only). Do not modify files or run commands; ask focused clarifying questions (2–4 at most) if requirements are unclear, or present the final Markdown implementation plan directly.`;
      if(plan.toolProtocol==="native"){
        session.messages.push({id:randomUUID(),role:"assistant",content:visible||"",toolCalls:[blocked],createdAt:Date.now(),hidden:true} as ChatMessage);
        session.messages.push({id:randomUUID(),role:"tool",content:formatNativeToolOutcome(blocked.name,blockMsg,false),toolCallId:blocked.id,name:blocked.name,createdAt:Date.now(),hidden:true} as ChatMessage);
      }else{
        session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(blocked.name,blockMsg,false),createdAt:Date.now(),hidden:true});
      }
      completeAssistant(id);
      currentAssistantId=randomUUID();
      continue;
    }
    if (calls.length > 0 && (calls.every((c) => c.status === "error") || looksLikeNarration(visible))) {
      visible = "";
    }
    if(plan.toolProtocol!=="native"){
      if(visible.trim()) emitter.onContent(id,boundOutput(visible, MAX_OUTPUT_CHARS));
    }else if(visible!==raw){
      emitter.onContent(id,boundOutput(visible, MAX_OUTPUT_CHARS));
    }
    if (visible.trim()) lastAssistantResponse = boundOutput(visible.trim(), MAX_OUTPUT_CHARS);

    // Hard guard: standalone opening greetings must never trigger a tool.
    // Never trigger on confirmations ("ok", "great") in ongoing conversations or when tools were called.
    if (!calls.length && isGreetingOnly(lastUserText ?? "", hasPriorConversation)) {
      const text = visible || "Hello! How can I help you with your coding tasks today?";
      lastAssistantResponse = text;
      commitTurnHandoff("completed");
      emitter.onContent(id, text);
      completeAssistant(id);
      return;
    }

    // No tool calls — plain text answer ends the turn per §2
    if(!calls.length){
      if(doneReason === "length" && plan.mode !== "chat" && truncationRetries < MAX_TRUNCATION_RETRIES){
        truncationRetries++;
        governor.record("truncation",{step});
        const firstTool = suggestFirstTool(specs, lastUserText);
        const nudge = `Your previous response was cut off before a complete tool call. Re-emit EXACTLY one tool block now (start with ${firstTool}) and nothing else. Keep it short.`;
        session.messages.push({id:randomUUID(),role:"user",content:nudge,createdAt:Date.now(),hidden:true});
        completeAssistant(id);
        currentAssistantId=randomUUID();
        continue;
      }
      const toolsRunThisTurn = toolsRun;
      if(!visible.trim()){
        if(toolsRunThisTurn > 0){
          governor.record("empty",{step,detail:"post_tool_empty"});
          const prevToolOk = lastToolSucceeded(session.messages);
          if(finalAnswerNudges < MAX_FINAL_ANSWER_NUDGES){
            finalAnswerNudges++;
            session.messages.push({
              id:randomUUID(),
              role:"user",
              content: prevToolOk
                ? "The tool completed successfully. Now give the user a concise final answer based on the tool result. Do not call another tool unless it is necessary. Reply in plain text."
                : "The previous tool call failed and the action was NOT completed. Explain the failure clearly or call a corrective tool to resolve the issue. Do NOT claim the action succeeded.",
              createdAt:Date.now(),
              hidden:true,
            });
            completeAssistant(id);
            currentAssistantId=randomUUID();
            continue;
          }
          const fallback = forceConclude
            ? buildTurnSummary("blocked")
            : prevToolOk
              ? "Done. The requested operation completed successfully."
              : "The tool step failed, and the model did not provide a follow-up explanation.";
          emitter.onContent(id,fallback);
          completeAssistant(id);
          commitTurnHandoff(forceConclude||!prevToolOk ? "blocked" : "completed");
          return;
        }
        governor.record("empty",{step});
        if(emptyStreak < MAX_EMPTY_RETRIES){
          emptyStreak++;
          session.messages.push({
            id:randomUUID(),
            role:"user",
            content:"Your previous reply arrived empty. Answer the user's request now in plain text, or call a tool first if you need information. Do not reply empty again.",
            createdAt:Date.now(),
            hidden:true,
          });
          completeAssistant(id);
          currentAssistantId=randomUUID();
          continue;
        }
        emitter.onContent(id, forceConclude ? buildTurnSummary("blocked") : "The model returned an empty response. Try rephrasing your request or try again.");
        completeAssistant(id);
        commitTurnHandoff("blocked");
        return;
      }
      const shouldCheckNarration =
        (plan.mode !== "chat" || toolsRunThisTurn > 0) &&
        !isGreetingOnly(lastUserText ?? "", hasPriorConversation) &&
        continueNudges < MAX_CONTINUE_NUDGES;
      if(raw.trim() && shouldCheckNarration){
        const proseOnly=stripFencedCode(raw);
        const isNarration = looksLikeNarration(raw)
          || (proseOnly.length>=8&&looksLikeNarration(proseOnly));
        if(isNarration){
          if (plan.mode === "chat") {
            governor.record("narration",{step});
            session.messages.push({
              id: randomUUID(),
              role: "user",
              content:
                "Chat mode is strictly read-only and cannot write or modify files. Do not narrate 'Let me create/update it' or attempt any write/edit tool. Output the complete proposed content (or manual edit instructions) directly in Markdown so the user can paste it manually, and suggest switching to Agent mode to let Photon apply it directly.",
              createdAt: Date.now(),
              hidden: true,
            });
            continueNudges++;
            completeAssistant(id);
            currentAssistantId = randomUUID();
            continue;
          }
          const firstTool = suggestFirstTool(specs, lastUserText);
          const namedTool=specs.map(s=>s.name).find(n=>new RegExp(`\\b${n}\\b`).test(raw));
          governor.record("narration",{step,tool:namedTool??firstTool});
          const nudge = toolsRunThisTurn === 0
            ? `You described what to do but did not call a tool. Do NOT answer from memory — call a tool now. Start with ${namedTool??firstTool}. Reply with EXACTLY one tool block and nothing else.`
            : namedTool
              ? `You said you would call ${namedTool} next but did not emit a tool call. Stop explaining — emit the ${namedTool} block now. Reply with EXACTLY one tool block and nothing else.`
              : `You narrated what to do next but did not emit a tool call. Stop explaining — call the tool now. Reply with EXACTLY one tool block and nothing else.`;
          session.messages.push({id:randomUUID(),role:"user",content:nudge,createdAt:Date.now(),hidden:true});
          continueNudges++;
          completeAssistant(id);
          currentAssistantId=randomUUID();
          continue;
        }
      }

      // Guard: if the model ran web_search, never called web_fetch, and tries to deflect
      // by telling the user to visit the links themselves, force a web_fetch call on the best URL.
      const ranWebSearch = executedTools.some((t) => t.name === "web_search" && t.ok);
      const ranWebFetch = executedTools.some((t) => t.name === "web_fetch");
      if (
        ranWebSearch &&
        !ranWebFetch &&
        modeToolNames.has("web_fetch") &&
        continueNudges < MAX_CONTINUE_NUDGES &&
        looksLikeWebLinkDeflection(visible)
      ) {
        const recentText = session.messages
          .slice(turnStartIndex)
          .map((m) => `${m.content ?? ""}\n${(m.toolCalls ?? []).map((tc) => tc.result ?? "").join("\n")}`)
          .join("\n");
        const candidateUrls = [...recentText.matchAll(/https:\/\/[^\s)\]"'>]+/gi)]
          .map((m) => m[0].replace(/[.,;]+$/, ""))
          .filter((u) => !/duckduckgo\.com|google\.com\/search/i.test(u));
        const bestUrl =
          candidateUrls.find((u) =>
            /moneycontrol\.com|niftytrader\.in|wikipedia\.org|reuters\.com|cnbc\.com|investing\.com|marketwatch\.com/i.test(
              u
            )
          ) ??
          candidateUrls[0] ??
          "https://example.com";
        const fetchSpec = toolSpecByName.get("web_fetch");
        const exBlock =
          plan.toolProtocol === "native" || !fetchSpec
            ? `Call web_fetch with {"url": "${bestUrl}"}`
            : `\n\n\`\`\`tool\nTOOL_NAME: web_fetch\nBEGIN_ARG: url\n${bestUrl}\nEND_ARG\n\`\`\``;
        session.messages.push({
          id: randomUUID(),
          role: "user",
          content: `Do NOT tell the user to check external links themselves. You only ran web_search (which returns short link previews) and have not called web_fetch yet. Call web_fetch right now on "${bestUrl}" to read the page content and extract the exact value for the user.${exBlock}`,
          createdAt: Date.now(),
          hidden: true,
        });
        continueNudges++;
        completeAssistant(id);
        currentAssistantId = randomUUID();
        continue;
      }

      commitTurnHandoff("completed");
      completeAssistant(id);
      return;
    }

    // In Chat mode, allow a few read-only or web calls (e.g. web_search -> web_fetch), then nudge to conclude before hitting the step cap
    if(plan.mode === "chat" && ((freshInfo && toolsRun >= 3) || toolsRun >= 4) && concludeNudges < MAX_CONCLUDE_NUDGES){
      concludeNudges++;
      session.messages.push({
        id: randomUUID(),
        role: "user",
        content: "You have gathered the necessary information. Please provide your direct final answer to the user now in plain text without calling any more tools.",
        createdAt: Date.now(),
        hidden: true,
      });
      completeAssistant(id);
      currentAssistantId = randomUUID();
      continue;
    }

    // Check if parallel execution of safe read-only tools is allowed and possible
    const allowParallel =
      plan.allowParallelTools !== false &&
      plan.executionPolicy?.allowParallelReads !== false &&
      plan.mode !== "chat";

    const firstSpec = toolSpecByName.get(calls[0].name);
    const canParallelFirst =
      allowParallel &&
      firstSpec &&
      firstSpec.concurrency === "safe_parallel" &&
      firstSpec.risk === "read" &&
      !firstSpec.sideEffecting &&
      calls[0].status !== "error";

    let wave: ToolCall[] = [calls[0]];
    let toQueue: ToolCall[] = [];

    if (canParallelFirst && calls.length > 1) {
      const maxConcurrent = Math.min(plan.executionPolicy?.maxConcurrent ?? 4, 4);
      for (let i = 1; i < calls.length; i++) {
        const candidate = calls[i];
        const candSpec = toolSpecByName.get(candidate.name);
        if (
          candSpec &&
          wave.length < maxConcurrent &&
          candSpec.concurrency === "safe_parallel" &&
          candSpec.risk === "read" &&
          !candSpec.sideEffecting &&
          candidate.status !== "error" &&
          wave.every((w) => {
            const ws = toolSpecByName.get(w.name);
            return ws && canRunInParallel(ws, candSpec);
          })
        ) {
          wave.push(candidate);
        } else {
          toQueue.push(candidate);
        }
      }
    } else {
      toQueue = calls.slice(1);
    }

    if (toQueue.length > 0) {
      const waveFingerprints = new Set(wave.map((w) => executionFingerprint(w, mutationEpoch)));
      const queuedFingerprints = new Set(pendingCalls.map((p) => executionFingerprint(p, mutationEpoch)));
      for (const c of toQueue) {
        if (plan.mode === "chat" && !modeToolNames.has(c.name)) continue;
        const fp = executionFingerprint(c, mutationEpoch);
        if (executed.has(fp) || waveFingerprints.has(fp) || queuedFingerprints.has(fp)) continue;
        queuedFingerprints.add(fp);
        pendingCalls.push({ ...c, status: c.status, statusDetail: undefined } as ToolCall);
      }
      emitter.onQueuedTools?.([...pendingCalls]);
    }

    if (wave.length > 1) {
      // Execute parallel read wave
      emitter.onPhase("working", `Running ${wave.length} tools in parallel`);
      const runnableWave: ToolCall[] = [];
      for (const call of wave) {
        const fingerprint = executionFingerprint(call, mutationEpoch);
        if (executed.has(fingerprint)) {
          governor.record("duplicate", { step, tool: call.name });
          emitter.onToolCall(id, call);
          emitter.onToolUpdate(id, {
            ...call,
            status: "error",
            statusDetail: undefined,
            error: "Duplicate call — already ran. Use the earlier result.",
          });
          const dupText = "You already ran this exact call. Use the earlier result.";
          if (plan.toolProtocol === "native") {
            session.messages.push({
              id: randomUUID(),
              role: "tool",
              content: formatNativeToolOutcome(call.name, dupText, false),
              toolCallId: call.id,
              name: call.name,
              createdAt: Date.now(),
              hidden: true,
            } as ChatMessage);
          } else {
            session.messages.push({
              id: randomUUID(),
              role: "user",
              content: renderToolResult(call.name, dupText, false),
              createdAt: Date.now(),
              hidden: true,
            });
          }
        } else {
          executed.add(fingerprint);
          emitter.onToolCall(id, call);
          emitter.onToolUpdate(id, { ...call, status: "running" });
          runnableWave.push(call);
        }
      }

      if (runnableWave.length > 0) {
        const toolCtx = toolCtxFor(runnableWave[0].id);
        const results = await pipeline.executeMany(runnableWave, toolCtx, runnableWave.length);
        syncTodosBack();

        if (signal.aborted) {
          pendingCalls.length = 0;
          for (const call of runnableWave) {
            emitter.onToolUpdate(id, { ...call, status: "error", error: "Operation cancelled." });
          }
          completeAssistant(id, "Stopped.");
          commitTurnHandoff("stopped");
          return;
        }

        let waveFailedTool: string | undefined;
        for (const call of runnableWave) {
          const result = results.get(call.id);
          const ok = result?.ok ?? false;
          if (!ok) waveFailedTool = call.name;
          const isWaveVerify = call.name === "get_diagnostics" || ((call.name === "run_command" || call.name === "execute_command") && mutationEpoch > 0);
          recordToolOutcome(call.name, ok, result?.output ?? "", step, isWaveVerify);
          const output = boundOutput(result?.output ?? "Tool execution produced no result.");
          toolsRun++;
          executedTools.push({ name: call.name, args: call.args, ok });
          emitter.onToolUpdate(id, {
            ...call,
            status: ok ? "done" : "error",
            result: ok ? output : undefined,
            error: ok ? undefined : output,
          });

          if (plan.toolProtocol === "native") {
            session.messages.push({
              id: randomUUID(),
              role: "tool",
              content: formatNativeToolOutcome(call.name, output, ok),
              toolCallId: call.id,
              name: call.name,
              createdAt: Date.now(),
              hidden: true,
            } as ChatMessage);
          } else {
            session.messages.push({
              id: randomUUID(),
              role: "user",
              content: renderToolResult(call.name, output, ok),
              createdAt: Date.now(),
              hidden: true,
            });
          }
        }
        lastFailedTool = waveFailedTool;
      }

      completeAssistant(id);
      currentAssistantId = randomUUID();
      continue;
    }

    const call=wave[0];
    // Handle invalid call — §5 retry policy
    if(call.status==="error"){
      lastFailedTool=call.name;
      governor.record("invalid_args",{step,tool:call.name,detail:call.error});
      governor.record("repair",{step,tool:call.name});
      const key=`${call.name}:${call.error}`;
      const count=(retryCount.get(key)||0)+1;
      retryCount.set(key,count);
      emitter.onToolCall(id,call);
      emitter.onToolUpdate(id,call);
      const spec=toolSpecByName.get(call.name);
      const example=spec?renderCorrectExample(spec,call.args):"";
      const errDetail = (call.error||"Invalid tool call")+(example?`\n\nCorrect format for ${call.name}:\n${example}`:"");
      if(plan.toolProtocol==="native"){
        session.messages.push({
          id:randomUUID(),
          role:"tool",
          content:formatNativeToolOutcome(call.name, errDetail, false),
          toolCallId:call.id,
          name:call.name,
          createdAt:Date.now(),
          hidden:true,
        } as ChatMessage);
      } else {
        session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(call.name, errDetail, false),createdAt:Date.now(),hidden:true});
      }
      completeAssistant(id);
      currentAssistantId=randomUUID();
      if(count>=2){
        if(plan.mode==="agent"){
          const pending=todoState.find(t=>t.status==="pending"||t.status==="in_progress");
          if(pending){
            pending.status="blocked";
            (pending as any).reason=call.error||"Invalid tool call after 2 retries";
          }
        }
        const hasIndependent=todoState.some(t=>t.status==="pending");
        if(!hasIndependent && step >= maxSteps-1){
          emitter.onError(`Blocked: ${call.error} — no independent steps remain.`);
          commitTurnHandoff("blocked");
          return;
        }
      }
      continue;
    }

    // Check duplicate — don't repeat identical failed call per §5
    const fingerprint=executionFingerprint(call,mutationEpoch);
    if(executed.has(fingerprint)){
      duplicateStreak++;
      governor.record("duplicate",{step,tool:call.name});
      if((plan.mode==="chat"&&toolsRun>0)||duplicateStreak>=2){
        forceConclude=true;
        pendingCalls.length=0;
        session.messages.push({
          id:randomUUID(),
          role:"user",
          content:`You already ran ${call.name} with those exact arguments and the result is above. Do NOT call any more tools — write your final answer to the user right now in plain text using the information already gathered.`,
          createdAt:Date.now(),
          hidden:true,
        });
        cancelAssistant(id);
        currentAssistantId=randomUUID();
        continue;
      }
      emitter.onToolCall(id,call);
      emitter.onToolUpdate(id,{...call,status:"error",statusDetail:undefined,error:"Duplicate call — already ran. Use the earlier result."});
      const dupResult=renderToolResult(call.name, "You already ran this exact call. Use the earlier result. If the task is complete, give your final answer with no tool call.", false);
      if(plan.toolProtocol==="native"){
        session.messages.push({
          id:randomUUID(),
          role:"tool",
          content:formatNativeToolOutcome(call.name, "Duplicate call — already ran. Use the earlier result.", false),
          toolCallId:call.id,
          name:call.name,
          createdAt:Date.now(),
          hidden:true,
        } as ChatMessage);
      } else {
        session.messages.push({id:randomUUID(),role:"user",content:dupResult,createdAt:Date.now(),hidden:true});
      }
      completeAssistant(id);
      currentAssistantId=randomUUID();
      continue;
    }
    duplicateStreak=0;
    executed.add(fingerprint);

    // Execute one tool
    const toolCtx=toolCtxFor(call.id);
    const isVerification = call.name === "get_diagnostics" || (call.name === "run_command" && mutationEpoch > 0);
    emitter.onPhase("working", isVerification ? `Verifying changes (${call.name})` : call.name);
    emitter.onToolCall(id,call);
    emitter.onToolUpdate(id,{...call,status:"running"});
    currentRunningTool = call;
    await hostPrepare(call);
    const results=await pipeline.executeMany([call],toolCtx,1);
    currentRunningTool = null;
    syncTodosBack();

    if(signal.aborted){
      pendingCalls.length = 0;
      emitter.onToolUpdate(id, { ...call, status: "error", error: "Operation cancelled." });
      completeAssistant(id, "Stopped.");
      commitTurnHandoff("stopped");
      return;
    }
    const result=results.get(call.id);
    if(!result){
      lastFailedTool=call.name;
      governor.record("tool_error",{step,tool:call.name,detail:"no_result"});
      emitter.onToolUpdate(id,{...call,status:"error",error:"Tool execution produced no result."});
      if(plan.toolProtocol==="native"){
        session.messages.push({
          id:randomUUID(),
          role:"tool",
          content:formatNativeToolOutcome(call.name, "Tool execution produced no result.", false),
          toolCallId:call.id,
          name:call.name,
          createdAt:Date.now(),
          hidden:true,
        } as ChatMessage);
      } else {
        session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(call.name, "Tool execution produced no result.", false),createdAt:Date.now(),hidden:true});
      }
      completeAssistant(id);
      currentAssistantId=randomUUID();
      continue;
    }

    // Track mutation epoch for fingerprinting
    const toolSpec=toolSpecByName.get(call.name);
    const eff=await hostFinish(call,result.ok,result.output,step);
    const effOk=eff.ok;
    const effOutput=eff.output;
    lastFailedTool=effOk?undefined:call.name;
    recordToolOutcome(call.name,effOk,effOutput,step,isVerification);
    if(toolSpec?.sideEffecting&&effOk) mutationEpoch++;
    toolsRun++;
    executedTools.push({
      name: call.name,
      args: call.args,
      ok: effOk,
      directAnswer: effOk && call.name === "web_search" && effOutput.includes("[Live data retrieved directly"),
    });

    const boundedResultOutput = boundOutput(effOutput);
    emitter.onToolUpdate(id,{...call,status:effOk?"done":"error",result:effOk?boundedResultOutput:undefined,error:effOk?undefined:boundedResultOutput});

    if(plan.toolProtocol==="native"){
      session.messages.push({id:randomUUID(),role:"tool",content:formatNativeToolOutcome(call.name,boundedResultOutput,effOk),toolCallId:call.id,name:call.name,createdAt:Date.now(),hidden:true} as ChatMessage);
    }else{
      session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(call.name, boundedResultOutput, effOk),createdAt:Date.now(),hidden:true});
    }

    if(toolSpec?.sideEffecting&&effOk&&plan.mode!=="chat"){
      session.messages.push({id:randomUUID(),role:"user",content:mutationConcludeNudge(call.name),createdAt:Date.now(),hidden:true});
    }

    completeAssistant(id);
    currentAssistantId=randomUUID();

    // Spec §5: on error, track retry — don't repeat identical failed call
    if(!effOk){
      const key=`${call.name}:${effOutput.slice(0,100)}`;
      const count=(retryCount.get(key)||0)+1;
      retryCount.set(key,count);
      if(count>=3){
        if(plan.mode==="agent"){
          const pending=todoState.find(t=>t.status==="pending"||t.status==="in_progress");
          if(pending){
            pending.status="blocked";
            (pending as any).reason=effOutput.slice(0,120);
          }
        }
        const hint=result.recovery?recoveryDirective(result):undefined;
        if(hint){
          session.messages.push({id:randomUUID(),role:"user",content:hint,createdAt:Date.now(),hidden:true});
        }
      } else {
        const hint=result.recovery?recoveryDirective(result):undefined;
        if(hint){
          session.messages.push({id:randomUUID(),role:"user",content:hint,createdAt:Date.now(),hidden:true});
        }
      }
    } else {
      retryCount.delete(`${call.name}:${effOutput.slice(0,100)}`);
      truncationRetries = 0;
    }

    if(plan.mode==="agent" && todoState.length>0){
      const todoLine=todoState.map(t=>`[${t.id}] ${t.status}`).join("  ");
      toolCtx.log(`[todo] ${todoLine}`);
    }
  }

  if(signal.aborted){
    pendingCalls.length = 0;
    if(activeAssistantId){
      completeAssistant(activeAssistantId, "Stopped.");
    }
    commitTurnHandoff("stopped");
  } else {
    pendingCalls.length = 0;
    const finalElapsed = Date.now() - turnStart;
    const finalTokens = Math.ceil(generatedChars / 4);
    const finalTps = Math.round(finalTokens / (finalElapsed / 1000));
    emitter.onGenerationStats({ tps: finalTps, totalTokens: finalTokens, elapsedMs: finalElapsed, avg: true });
    emitter.onGenerationStats(null);
    const summary = buildTurnSummary("step_limit");
    if(!lastAssistantResponse){
      lastAssistantResponse = summary;
      startAssistant(currentAssistantId);
      emitter.onContent(currentAssistantId, summary);
    }
    emitter.onError(`Reached the ${maxSteps}-step limit for this turn.`);
    completeAssistant(currentAssistantId, "Reached step limit.");
    commitTurnHandoff("step_limit");
  }
  } finally {
    emitTelemetryOnce();
    emitter.onQueuedTools?.([]);
    pipeline.unlockTurn();
  }
}

function injectUser(session:{messages:ChatMessage[]},content:string):void{session.messages.push({id:randomUUID(),role:"user",content,createdAt:Date.now(),hidden:true});}

/** Graceful Chat-mode redirect when the model reaches for a workspace tool it
 *  doesn't have. Plain assistant text (never an error card): names what it
 *  tried, what file it was aiming at when known, and exactly how to get it
 *  done — switch the mode selector to Agent and ask again. */
function chatRedirectText(call:ToolCall):string{
  const target=[call.args?.path,call.args?.file,(call.args as any)?.query]
    .find(v=>typeof v==="string"&&(v as string).trim());
  const what=target?` on \`${String(target).trim()}\``:"";
  return `I can't modify files or run commands in **Chat** mode — here I can only read files, answer questions, and search the web, so I couldn't run \`${call.name}\`${what}.\n\nYou can apply the change manually from the code/guidance above, or switch the mode selector below from **Chat** to **Agent** and ask again so I can edit it directly.`;
}

/** Off-ramp after a mutation lands: without an explicit stop condition weak
 *  models loop (retry the write with new args, invent follow-up appends)
 *  instead of concluding. Read-only successes don't need this — answering
 *  from a read result is already the model's default next move. */
function mutationConcludeNudge(toolName:string):string{
  return `${toolName} succeeded. If the user's request is now fully complete, reply with a concise final answer in plain text and call no further tools. Only call another tool if a required step is still outstanding (for example verification the task needs).`;
}

/** True when the model clearly attempted a tool block but the parser yielded
 *  zero calls — a bare header, unclosed fence, or arg markers with no valid
 *  call. Only consulted when calls.length===0, so complete blocks never match. */
function looksLikeFailedToolAttempt(text:string):boolean{
  return /(TOOL_NAME\s*:|BEGIN_ARG\s*:|END_ARG|\[TOOL|tool_call|```\s*tool)/i.test(text);
}

/** Drop protocol-fragment lines (fence remnants, headers, arg markers) so a
 *  malformed attempt is never displayed as chat text. Other prose survives. */
function stripToolAttemptMarkup(text:string):string{
  const dropRe=/(TOOL_NAME\s*:|BEGIN_ARG\s*:|END_ARG\b|\[TOOL|tool_call|^\s*```\s*tool\s*$|^\s*tool\s*$)/i;
  return text.split("\n").filter(l=>!dropRe.test(l)).join("\n").trim();
}
function dedupResponseCalls(rawCalls:ToolCall[],mode:AdaptivePlan["mode"]):ToolCall[]{
  if(rawCalls.length<=1)return rawCalls;
  const validToolNames=new Set(rawCalls.filter(c=>c.status!=="error").map(c=>c.name));
  const seen=new Set<string>();
  const out:ToolCall[]=[];
  for(const c of rawCalls){
    // If the model emitted both a malformed attempt and a valid call for the same tool in one response, drop the broken duplicate.
    if(c.status==="error"&&validToolNames.has(c.name))continue;
    const key=`${c.name}|${JSON.stringify(c.args)}|${c.status}|${c.error??""}`;
    if(seen.has(key))continue;
    seen.add(key);
    out.push(c);
  }
  return mode==="chat"?out.slice(0,1):out;
}
function resolveCalls(raw:string,native:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[],specs:ToolSpec[],plan:AdaptivePlan):{calls:ToolCall[];cleanedText:string}{
  if(plan.toolProtocol==="native"&&native.length){
    const calls:ToolCall[]=native.map(c=>{
      const name=canonicalToolName(c.name,specs)??c.name;
      const sideEffecting=specs.find(s=>s.name===name)?.sideEffecting;
      if (c.args.__malformedToolArgs) {
        const parseErr = typeof c.args.__parseError === "string"
          ? `${c.args.__parseError} Re-emit "${name}" with valid JSON object arguments.`
          : `Malformed JSON arguments for tool "${name}". Re-emit the tool call with valid JSON object arguments.`;
        return{id:c.id??randomUUID(),name,args:{},status:"error" as ToolCall["status"],error:parseErr,sideEffecting,thoughtSignature:c.thoughtSignature};
      }
      const v=validateAgainstSpec(name,c.args,specs);
      return{id:c.id??randomUUID(),name,args:v.args,status:(v.errors.length?"error":"proposed") as ToolCall["status"],error:v.errors.join(" "),sideEffecting,thoughtSignature:c.thoughtSignature};
    });
    return{calls:dedupResponseCalls(calls,plan.mode),cleanedText:stripToolMarkup(raw)};
  }
  const parsed=parsePhotonBlocks(raw,specs);
  const calls:ToolCall[]=parsed.calls.map(p=>({id:randomUUID(),name:p.name,args:p.args,status:(p.errors.length?"error":"proposed") as ToolCall["status"],error:p.errors.join(" "),sideEffecting:specs.find(s=>s.name===p.name)?.sideEffecting}));
  return{calls:dedupResponseCalls(calls,plan.mode),cleanedText:parsed.cleanedText};
}
function isSyntheticToolMsg(m:ChatMessage):boolean{
  if(m.role==="tool")return true;
  if(m.role!=="user")return false;
  const trimmed=(m.content??"").trimStart();
  return trimmed.startsWith("<tool_result")||trimmed.startsWith("<photon:result")||trimmed.startsWith("[TOOL_RESULT")||trimmed.startsWith("[tool:");
}
function historyToLLM(messages:ChatMessage[],plan:AdaptivePlan,turnStartIndex=messages.length):LLMMessage[]{
  const out:LLMMessage[]=[];
  const existingToolIds=new Set<string>();
  for(const m of messages){
    if(m.role==="tool"&&(m as any).toolCallId) existingToolIds.add((m as any).toolCallId);
  }
  for(let idx=0;idx<messages.length;idx++){
    const m=messages[idx];
    if(m.role==="user"){
      // Skip internal step coaching nudges from previous finished turns so they
      // don't confuse future turns or mode switches, while preserving active-turn nudges
      // and current-protocol tool outputs.
      if(idx<turnStartIndex&&m.hidden&&!m.isCompacted&&!isSyntheticToolMsg(m)) continue;
      if(plan.toolProtocol==="native"&&m.hidden&&isSyntheticToolMsg(m)) continue;
      const docs=(m.attachments??[]).filter(a=>a.kind==="text"&&a.text);
      let content=m.content;
      for(const d of docs){
        content+=`\n\n--- Attached file: ${d.name} ---\n${d.text}\n--- end ${d.name} ---`;
      }
      out.push({role:"user",content,images:m.attachments?.filter(a=>a.kind==="image"&&a.dataBase64).map(a=>a.dataBase64 as string)});
    }else if(m.role==="assistant"){
      const calls=m.toolCalls??[];
      if(plan.toolProtocol==="native"){
        if(m.content.trim()||calls.length){
          out.push({role:"assistant",content:m.content,tool_calls:calls.length?calls.map(c=>({id:c.id,function:{name:c.name,arguments:c.args},thoughtSignature:c.thoughtSignature})):undefined});
          for(const c of calls){
            if(!existingToolIds.has(c.id)){
              const outcome=c.result!==undefined?c.result:c.error!==undefined?c.error:c.status==="denied"?"Tool execution declined by user.":"Tool execution did not complete.";
              out.push({role:"tool",tool_call_id:c.id,name:c.name,content:formatNativeToolOutcome(c.name,outcome,c.status==="done")});
            }
          }
        }
      }else{
        const nextMsg=messages[idx+1];
        const hasFollowingResult=nextMsg&&(nextMsg.role==="tool"||isSyntheticToolMsg(nextMsg));
        const finished=calls.filter(c=>c.result!==undefined||c.error!==undefined);
        if(m.content.trim()||calls.length){
          const fallbackText=finished.length?`Calling ${finished.map(c=>c.name).join(", ")}`:m.content;
          if(m.content.trim()||finished.length){
            out.push({role:"assistant",content:m.content.trim()?m.content:fallbackText});
          }
        }
        // When switching from Cloud -> Local photon-block, prior tool calls may have outcomes
        // stored on m.toolCalls without trailing <tool_result> user messages.
        if(finished.length&&!hasFollowingResult){
          const summary=finished.map(c=>renderToolResult(c.name,String(c.result??c.error??""),c.status==="done")).join("\n");
          out.push({role:"user",content:summary});
        }
      }
    }else if(m.role==="tool"){
      if(plan.toolProtocol==="native"){
        out.push({role:"tool",content:m.content,tool_call_id:m.toolCallId,name:(m as any).name});
      }else{
        out.push({role:"user",content:renderToolResult(String((m as any).name??"tool"),m.content,!/^\[TOOL_ERROR/i.test(m.content.trim()))});
      }
    }
  }
  return sanitizeToolPairing(out);
}
function lastUser(messages:ChatMessage[]):string|undefined{for(let i=messages.length-1;i>=0;i--)if(messages[i].role==="user"&&!messages[i].hidden&&!isSyntheticToolMsg(messages[i]))return messages[i].content;return undefined;}
function lastToolSucceeded(messages:ChatMessage[]):boolean{
  for(let i=messages.length-1;i>=0;i--){
    const message=messages[i];
    if(message.role==="tool"){
      const trimmed=message.content.trim();
      return !/^error:/i.test(trimmed)&&!trimmed.startsWith("[TOOL_ERROR")&&!trimmed.startsWith("[TOOL_OUTCOME");
    }
    if(message.role!=="user"||!message.hidden||!message.content.includes("<tool_result"))continue;
    return /<tool_result\b[^>]*status="ok"/i.test(message.content);
  }
  return false;
}

/** Build a copy-paste-ready tool block for a failed call, reusing the args the
 *  model already supplied and marking the missing required ones. Small models
 *  copy a concrete example far more reliably than they follow an error message. */
function renderCorrectExample(spec:ToolSpec,args:Record<string,unknown>):string{
  const lines=["```tool",`TOOL_NAME: ${spec.name}`];
  for(const p of spec.params){
    const v=args[p.name];
    const val=(v!==undefined&&v!==null&&String(v).trim()!=="")?String(v):`<${p.name}>`;
    lines.push(`BEGIN_ARG: ${p.name}`,val,"END_ARG");
  }
  lines.push("```");
  return lines.join("\n");
}

function isGreetingOnly(text: string, hasPriorConversation = false): boolean {
  const t = text.trim().toLowerCase().replace(/[!.,?]+$/g, "").trim();
  if (!t) return true;
  if (hasPriorConversation) {
    // In an ongoing conversation, confirmations ("ok", "great", "cool") continue the workflow.
    return /^(hi|hello|hey|hiya|howdy|yo|greetings|good\s*(morning|afternoon|evening)|bye|goodbye|hello\s*there|hi\s*there)[\s!.,?]*$/i.test(t);
  }
  const greetingRe = /^(hi|hello|hey|hiya|howdy|yo|sup|greetings|good\s*(morning|afternoon|evening)|thanks|thank\s*you|thx|bye|goodbye|ok|okay|cool|nice|great|awesome|hello\s*there|hi\s*there|what's\s*up|whats\s*up)[\s!.,?]*$/i;
  return greetingRe.test(t);
}
