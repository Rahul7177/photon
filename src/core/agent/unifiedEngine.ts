import { randomUUID } from "node:crypto";
import type { AdaptivePlan, ChatMessage, ToolCall, ToolSpec, VerificationPlan } from "../../shared/types";
import type { LLMMessage } from "../llm/types";
import { buildSystemPrompt } from "../prompts/system";
import { fitToWindow } from "./contextManager";
import { estimateTokens, estimateToolSchemasTokens } from "../adaptive/tokens";
import { getProjectContextManager } from "../context/projectContext";
import { parsePhotonBlocks, validateAgainstSpec, canonicalToolName, stripToolMarkup } from "../protocol/parse";
import { renderToolResult } from "../protocol/serialize";
import { renderToolInstructions, toNativeTools } from "../protocol/serialize";
import { executionFingerprint, recoveryDirective, buildVerificationPlan, isFreshInfoRequest, looksLikeNarration, selectToolSpecs, stripFencedCode, suggestFirstTool, canRunInParallel } from "../intelligence/policy";
import {
  classifyRuntimeError,
  formatNativeToolOutcome,
  sanitizeToolPairing,
  shouldRetryStep,
  waitWithBackoff,
} from "./errorRecovery";
import { ToolPipeline } from "../../photon-core/tools/pipeline";
import type { LLMProvider } from "../llm/types";
import type { TodoItem } from "../tools/types";

export interface UnifiedEngineDeps { provider:LLMProvider;tools:import("../tools/types").Tool[];workspaceName?:string;workspaceMap?:()=>Promise<string|undefined>;retrieveContext?:(query:string,signal:AbortSignal)=>Promise<string|undefined>;buildToolContext:(signal:AbortSignal)=>import("../tools/types").ToolContext;reserveOutputTokens?:number; }
export interface UnifiedEmitter { onAssistantStart(id:string):void;onDelta(id:string,delta:string):void;onThinkingDelta?(id:string,delta:string):void;onThinkingEnd?(id:string,elapsedMs:number):void;onContent(id:string,content:string):void;onAssistantCancel(id:string):void;onPhase(phase:"thinking"|"working",detail?:string):void;onToolCall(id:string,call:ToolCall):void;onToolUpdate(id:string,call:ToolCall):void;onUsage(usage:import("../../shared/types").TokenUsage):void;onGenerationStats(stats:import("../../shared/types").GenerationStats|null):void;onDone(id:string,notice?:string):void;onError(message:string):void; }
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

// Spec §5 hard caps
const MODE_CAPS:Record<string,number>={chat:6,plan:10,agent:25};
const CHECK_IN_INTERVAL=8;

export async function runUnifiedTurn(session:{messages:ChatMessage[]},plan:AdaptivePlan,emitter:UnifiedEmitter,signal:AbortSignal,deps:UnifiedEngineDeps):Promise<void>{
  const turnStart = Date.now(); // overall turn start for avg stats
  const pipeline = new ToolPipeline();
  pipeline.registerAll(deps.tools);
  pipeline.lockTurn();
  try {
  const task=plan.task??{scope:"single_file",reasoning:"medium",risk:"low",verification:[],ambiguity:"low",estimatedSteps:1};
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

  if(plan.mode!=="chat"&&(deps.workspaceMap||deps.retrieveContext)){
    emitter.onPhase("thinking","Retrieving project context");
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
  if (plan.mode !== "chat" && deps.retrieveContext) {
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
  const configuredMaxSteps = MODE_CAPS[plan.mode] ?? 25;
  const policyStepBudget = plan.executionPolicy?.stepBudget ?? configuredMaxSteps;
  const maxSteps = Math.min(configuredMaxSteps, policyStepBudget);

  let mutationEpoch=0;
  const executed=new Set<string>();
  const executedTools: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
  let lastAssistantResponse = "";
  // OPT + FIX: preserve todos across tool-context rebuilds by initializing from existing
  // tool context and writing mutations back to baseToolCtx on every update.
  const baseToolCtx={...deps.buildToolContext(signal),executionPolicy:plan.executionPolicy};
  const initialTodos = baseToolCtx.todos ?? [];
  const sharedTodos:TodoItem[]=[...initialTodos];
  const todoState=sharedTodos;
  const sharedLog=baseToolCtx.log;
  const syncTodosBack=()=>{
    if(baseToolCtx.todos){
      baseToolCtx.todos.length=0;
      baseToolCtx.todos.push(...sharedTodos);
    }
  };
  const toolCtxFor=(pendingCallId:string)=>({...deps.buildToolContext(signal),todos:sharedTodos,pendingCallId,executionPolicy:plan.executionPolicy});
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
  // OPT: per-turn invariants hoisted out of the step loop. plan/freshInfo/
  // workspaceMap/retrieved/lastUserText are all fixed for the turn, so specs,
  // tool instructions, system prompt and native tools are identical every step.
  // Rebuilding them x25 steps wasted CPU and reallocated large strings.
  const allSpecs=deps.tools.map(t=>t.spec);
  const specs=selectToolSpecs(allSpecs,plan,"orient",freshInfo);
  // Names the model may actually call this turn. In chat mode this is just
  // the web tools — anything else is a mode violation, not a retryable error.
  const modeToolNames=new Set(specs.map(s=>s.name));
  const toolInstructions=plan.toolProtocol==="native"?"":renderToolInstructions(specs,plan);
  const system=buildSystemPrompt({mode:plan.mode,plan,toolInstructions,workspaceName:deps.workspaceName,workspaceMap,retrievedContext:retrieved,projectContextDigest,lastUserText:lastUserText,freshInfoRequest:freshInfo});
  const systemMsg:LLMMessage={role:"system",content:system};
  const budgetTokens=Math.max(512, plan.numCtx - 1000); // reserve 1000 for output per §4
  const nativeTools=plan.toolProtocol==="native"&&specs.length?toNativeTools(specs):undefined;
  const toolSpecByName=new Map(deps.tools.map(t=>[t.spec.name,t.spec] as const));
  // Track retries per logical step for §5 retry policy
  const retryCount = new Map<string, number>();
  let continueNudges = 0;
  const MAX_CONTINUE_NUDGES = 5;
  let finalAnswerNudges = 0;
  const MAX_FINAL_ANSWER_NUDGES = 2;
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
  const MAX_TRUNCATION_RETRIES = 2;
  let streamRetries = 0;
  const MAX_STREAM_RETRIES = 1;
  // Turn-scoped output tally: raw is declared per step, but the closing stats
  // are emitted after the loop — sum here so the average is per turn, not per step.
  let generatedChars = 0;
  // FIX: when a small model emits 2+ tool calls in one response, the extras used
  // to be silently dropped — the model then believed they ran and got confused. We
  // now queue them and execute them in subsequent iterations without re-querying.
  const pendingCalls:ToolCall[]=[];

  for(let step=0;step<maxSteps&&!signal.aborted;step++){
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
      const qId=currentAssistantId;

      // Chat mode can't run workspace tools — a queued extra the model
      // emitted alongside a web call must not become an error card either.
      if(plan.mode==="chat"&&!modeToolNames.has(queuedRaw.name)){
        startAssistant(qId);
        emitter.onContent(qId,chatRedirectText(queuedRaw));
        completeAssistant(qId);
        currentAssistantId=randomUUID();
        continue;
      }

      if(queuedRaw.status==="error"){
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
      startAssistant(qId);
      emitter.onPhase("working",queued.name);
      emitter.onToolCall(qId,queued);
      emitter.onToolUpdate(qId,{...queued,status:"running",statusDetail:undefined});
      currentRunningTool = queued;
      const qCtx=toolCtxFor(queued.id);
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
        if(qSpec?.sideEffecting&&qResult.ok)mutationEpoch++;
        toolsRun++;
        executedTools.push({ name: queued.name, args: queued.args, ok: qResult.ok });
        const boundedQOutput = boundOutput(qResult.output);
        emitter.onToolUpdate(qId,{...queued,status:qResult.ok?"done":"error",statusDetail:undefined,result:qResult.ok?boundedQOutput:undefined,error:qResult.ok?undefined:boundedQOutput});
        if(plan.toolProtocol==="native"){
          session.messages.push({id:randomUUID(),role:"tool",content:formatNativeToolOutcome(queued.name,boundedQOutput,qResult.ok),toolCallId:queued.id,name:queued.name,createdAt:Date.now(),hidden:true} as ChatMessage);
        }else{
          session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(queued.name,boundedQOutput,qResult.ok),createdAt:Date.now(),hidden:true});
        }
        if(qSpec?.sideEffecting&&qResult.ok&&plan.mode!=="chat"){
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

    emitter.onPhase("thinking");
    const history=historyToLLM(session.messages,plan);
    const toolSchemasTokens = nativeTools && nativeTools.length > 0 ? estimateToolSchemasTokens(nativeTools, plan.model) : 0;
    const fit=fitToWindow(systemMsg,history,budgetTokens,plan.numCtx,plan.model,{
      preserveFirstUser: true,
      toolSchemasTokens,
    });
    emitter.onUsage(fit.usage);
    const id=currentAssistantId;
    startAssistant(id);
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
        options:{num_ctx:plan.numCtx,temperature:plan.temperature,top_p:plan.topP,num_predict:plan.maxOutputTokens,...(plan.seed!==undefined?{seed:plan.seed}:{})},
        tools:nativeTools
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
      const canRetry = shouldRetryStep(classified, {
        sideEffectsOccurred: mutationEpoch > 0 || toolsRun > 0,
        streamRetries,
        maxRetries: MAX_STREAM_RETRIES,
        hasContent: Boolean(raw.trim()),
        toolCallsCount: nativeCalls.length,
      });
      if (canRetry.shouldRetry) {
        streamRetries++;
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
    const calls=resolved.calls;
    let visible=resolved.cleanedText;
    const failedAttempt=calls.length===0&&looksLikeFailedToolAttempt(raw);
    if(failedAttempt){
      visible=stripToolAttemptMarkup(visible);
      if(continueNudges<MAX_CONTINUE_NUDGES){
        continueNudges++;
        const firstTool=suggestFirstTool(specs,lastUserText);
        const spec=toolSpecByName.get(firstTool);
        const example=spec?`\n\nCorrect format:\n${renderCorrectExample(spec,{})}`:"";
        session.messages.push({id:randomUUID(),role:"user",content:`You tried to call a tool but the block was incomplete, so nothing ran. Do NOT explain — re-emit EXACTLY one complete tool block now, starting with ${firstTool}.${example}`,createdAt:Date.now(),hidden:true});
        completeAssistant(id);
        currentAssistantId=randomUUID();
        continue;
      }
    }

    if(plan.mode==="chat"&&calls.length&&!modeToolNames.has(calls[0].name)){
      emitter.onContent(id,chatRedirectText(calls[0]));
      completeAssistant(id);
      commitTurnHandoff("completed");
      return;
    }
    if(plan.toolProtocol!=="native"){
      if(visible.trim()) emitter.onContent(id,boundOutput(visible, MAX_OUTPUT_CHARS));
    }else if(visible!==raw){
      emitter.onContent(id,boundOutput(visible, MAX_OUTPUT_CHARS));
    }
    if (visible.trim()) lastAssistantResponse = boundOutput(visible.trim(), MAX_OUTPUT_CHARS);

    // Hard guard: greetings / small talk must never trigger a tool.
    if (isGreetingOnly(lastUserText ?? "")) {
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
          const fallback = prevToolOk
            ? "Done. The requested operation completed successfully."
            : "The tool step failed, and the model did not provide a follow-up explanation.";
          emitter.onContent(id,fallback);
          completeAssistant(id);
          commitTurnHandoff(prevToolOk ? "completed" : "blocked");
          return;
        }
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
        emitter.onContent(id,"The model returned an empty response. Try rephrasing your request or try again.");
        completeAssistant(id);
        commitTurnHandoff("blocked");
        return;
      }
      const shouldCheckNarration =
        (plan.mode !== "chat" || toolsRunThisTurn > 0) &&
        !isGreetingOnly(lastUserText ?? "") &&
        continueNudges < MAX_CONTINUE_NUDGES;
      if(raw.trim() && shouldCheckNarration){
        const proseOnly=stripFencedCode(raw);
        const isNarration = looksLikeNarration(raw)
          || (proseOnly.length>=8&&looksLikeNarration(proseOnly));
        if(isNarration){
          const firstTool = suggestFirstTool(specs, lastUserText);
          const namedTool=specs.map(s=>s.name).find(n=>new RegExp(`\\b${n}\\b`).test(raw));
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
      commitTurnHandoff("completed");
      completeAssistant(id);
      return;
    }

    // In Chat mode, if a tool already ran, nudge the model to conclude with an answer instead of running endless tools
    if(plan.mode === "chat" && toolsRun >= 1 && concludeNudges < MAX_CONCLUDE_NUDGES){
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
      for (const c of toQueue) {
        if (plan.mode === "chat" && !modeToolNames.has(c.name)) continue;
        pendingCalls.push({ ...c, status: c.status, statusDetail: undefined } as ToolCall);
      }
    }

    if (wave.length > 1) {
      // Execute parallel read wave
      emitter.onPhase("working", `Running ${wave.length} tools in parallel`);
      const runnableWave: ToolCall[] = [];
      for (const call of wave) {
        const fingerprint = executionFingerprint(call, mutationEpoch);
        if (executed.has(fingerprint)) {
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

        for (const call of runnableWave) {
          const result = results.get(call.id);
          const ok = result?.ok ?? false;
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
      }

      completeAssistant(id);
      currentAssistantId = randomUUID();
      continue;
    }

    const call=wave[0];
    // Handle invalid call — §5 retry policy
    if(call.status==="error"){
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
    executed.add(fingerprint);

    // Execute one tool
    const toolCtx=toolCtxFor(call.id);
    const isVerification = call.name === "get_diagnostics" || (call.name === "run_command" && mutationEpoch > 0);
    emitter.onPhase("working", isVerification ? `Verifying changes (${call.name})` : call.name);
    emitter.onToolCall(id,call);
    emitter.onToolUpdate(id,{...call,status:"running"});
    currentRunningTool = call;
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
    if(toolSpec?.sideEffecting&&result.ok) mutationEpoch++;
    toolsRun++;
    executedTools.push({ name: call.name, args: call.args, ok: result.ok });

    const boundedResultOutput = boundOutput(result.output);
    emitter.onToolUpdate(id,{...call,status:result.ok?"done":"error",result:result.ok?boundedResultOutput:undefined,error:result.ok?undefined:boundedResultOutput});

    if(plan.toolProtocol==="native"){
      session.messages.push({id:randomUUID(),role:"tool",content:formatNativeToolOutcome(call.name,boundedResultOutput,result.ok),toolCallId:call.id,name:call.name,createdAt:Date.now(),hidden:true} as ChatMessage);
    }else{
      session.messages.push({id:randomUUID(),role:"user",content:renderToolResult(call.name, boundedResultOutput, result.ok),createdAt:Date.now(),hidden:true});
    }

    if(toolSpec?.sideEffecting&&result.ok&&plan.mode!=="chat"){
      session.messages.push({id:randomUUID(),role:"user",content:mutationConcludeNudge(call.name),createdAt:Date.now(),hidden:true});
    }

    completeAssistant(id);
    currentAssistantId=randomUUID();

    // Spec §5: on error, track retry — don't repeat identical failed call
    if(!result.ok){
      const key=`${call.name}:${result.output.slice(0,100)}`;
      const count=(retryCount.get(key)||0)+1;
      retryCount.set(key,count);
      if(count>=3){
        if(plan.mode==="agent"){
          const pending=todoState.find(t=>t.status==="pending"||t.status==="in_progress");
          if(pending){
            pending.status="blocked";
            (pending as any).reason=result.output.slice(0,120);
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
      retryCount.delete(`${call.name}:${result.output.slice(0,100)}`);
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
  const what=target?` to update \`${String(target).trim()}\``:"";
  return `I can't change files in **Chat** mode — here I can only answer questions and look things up on the web, so I couldn't run \`${call.name}\`${what}.\n\nSwitch the mode selector below from **Chat** to **Agent** and send your request again — I'll take care of it there.`;
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
function resolveCalls(raw:string,native:{id?:string;name:string;args:Record<string,unknown>;thoughtSignature?:string}[],specs:ToolSpec[],plan:AdaptivePlan):{calls:ToolCall[];cleanedText:string}{
  if(plan.toolProtocol==="native"&&native.length){
    const calls:ToolCall[]=native.map(c=>{
      const name=canonicalToolName(c.name,specs)??c.name;
      const v=validateAgainstSpec(name,c.args,specs);
      return{id:c.id??randomUUID(),name,args:v.args,status:(v.errors.length?"error":"proposed") as ToolCall["status"],error:v.errors.join(" "),sideEffecting:specs.find(s=>s.name===name)?.sideEffecting,thoughtSignature:c.thoughtSignature};
    });
    return{calls,cleanedText:stripToolMarkup(raw)};
  }
  const parsed=parsePhotonBlocks(raw,specs);
  const calls:ToolCall[]=parsed.calls.map(p=>({id:randomUUID(),name:p.name,args:p.args,status:(p.errors.length?"error":"proposed") as ToolCall["status"],error:p.errors.join(" "),sideEffecting:specs.find(s=>s.name===p.name)?.sideEffecting}));
  return{calls,cleanedText:parsed.cleanedText};
}
function historyToLLM(messages:ChatMessage[],plan:AdaptivePlan):LLMMessage[]{const out:LLMMessage[]=[];for(const m of messages){if(m.role==="user")out.push({role:"user",content:m.content,images:m.attachments?.filter(a=>a.kind==="image"&&a.dataBase64).map(a=>a.dataBase64 as string)});else if(m.role==="assistant"){const calls=m.toolCalls??[];if(m.content.trim()||calls.length)out.push({role:"assistant",content:m.content,tool_calls:plan.toolProtocol==="native"&&calls.length?calls.map(c=>({id:c.id,function:{name:c.name,arguments:c.args},thoughtSignature:c.thoughtSignature})):undefined});}else if(m.role==="tool")out.push({role:"tool",content:m.content,tool_call_id:m.toolCallId,name:(m as any).name});}return sanitizeToolPairing(out);}
function lastUser(messages:ChatMessage[]):string|undefined{for(let i=messages.length-1;i>=0;i--)if(messages[i].role==="user")return messages[i].content;return undefined;}
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

function isGreetingOnly(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.,?]+$/g, "").trim();
  if (!t) return true;
  const greetingRe = /^(hi|hello|hey|hiya|howdy|yo|sup|greetings|good\s*(morning|afternoon|evening)|thanks|thank\s*you|thx|bye|goodbye|ok|okay|cool|nice|great|awesome|hello\s*there|hi\s*there|what's\s*up|whats\s*up)[\s!.,?]*$/i;
  return greetingRe.test(t);
}
