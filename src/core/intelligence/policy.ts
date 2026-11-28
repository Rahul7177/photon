import type { AdaptivePlan, AgentPhase, BenchResult, ComplexityAssessment, Mode, ModelCapabilityProfile, ModelInfo, ModelTier, SessionTaskContext, TaskAnalysis, ToolCall, ToolSpec, VerificationKind, VerificationPlan } from "../../shared/types";
import { blendCapabilitiesWithPassport, type PassportEntry } from "../adaptive/passport";

const LOCAL_CORE_TOOLS = ["query_project_context","list_dir","find_files","search_code","read_file","edit_file","append_file","write_file","get_diagnostics","run_command"] as const;
const LOCAL_EXTENDED_TOOLS = ["update_project_context","code_outline","move_path","todo_write","think","web_search","web_fetch"] as const;
const CHAT_READONLY_TOOLS = new Set(["read_file","list_dir","find_files","search_code","code_outline","get_diagnostics","query_project_context","web_search","web_fetch","think"]);
const PLAN_EXCLUDED_TOOLS = new Set(["todo_write","update_project_context"]);

const KNOWN_FILE_EXTENSIONS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","json","jsonc","md","mdx","py","pyi","rs","go",
  "java","kt","cs","cpp","cc","cxx","c","h","hpp","css","scss","less","html","htm",
  "vue","svelte","astro","yaml","yml","toml","xml","sql","graphql","gql","prisma",
  "schema","sh","bash","zsh","ps1","bat","cmd","env","lock","txt","csv","svg",
  "png","jpg","jpeg","gif","webp","pdf","gguf",
]);
const PROSE_ABBREVS = new Set(["e.g","i.e","etc","vs","cf","fig","sec","ch"]);
const BARE_PROPER_NOUNS = new Set([
  "node.js","next.js","vue.js","nuxt.js","react.js","angular.js","express.js","nest.js",
  "ember.js","three.js","d3.js","chart.js","electron.js","deno.js","bun.js","socket.io",
]);

export function extractFileReferences(prompt: string): string[] {
  const cleaned = (prompt ?? "").replace(/https?:\/\/\S+|www\.\S+/gi, " ");
  const refs = new Set<string>();

  // 1. Explicit @-references (e.g. @src/auth.ts or @utils/helpers)
  const atRe = /(?:^|[\s(\`"'])@([\w./-]+(?:\.[a-z][a-z0-9]{0,9}|\/[\w./-]+))(?=$|[\s)\`"':,;!?]|\.(?=\s|$))/gi;
  for (const m of cleaned.matchAll(atRe)) {
    const norm = m[1].replace(/^\.\//, "").toLowerCase();
    if (!/^(?:v?\d+(?:\.\d+)+[\w-]*)$/i.test(norm)) refs.add(norm);
  }

  // 2. Explicit path-separated file references (e.g. src/node.js, ./vue.js, .photon/config.json)
  const pathRe = /(?:^|[\s(\`"'])((?:\.{1,2}[\/\\])?(?:[\w.-]+[\/\\])+[\w.-]+\.[a-z][a-z0-9]{0,9})(?=$|[\s)\`"':,;!?]|\.(?=\s|$))/gi;
  for (const m of cleaned.matchAll(pathRe)) {
    const raw = m[1].replace(/\\/g, "/");
    if (!/[a-z0-9]/i.test(raw)) continue;
    refs.add(raw.toLowerCase());
  }

  // 3. Bare filenames (e.g. package.json, prisma.schema, server.ts) with known extensions
  const bareRe = /(?:^|[\s(\`"'])([a-z0-9_.-]+\.[a-z][a-z0-9]{0,9})(?=$|[\s)\`"':,;!?]|\.(?=\s|$))/gi;
  for (const m of cleaned.matchAll(bareRe)) {
    const token = m[1].toLowerCase();
    if (PROSE_ABBREVS.has(token) || BARE_PROPER_NOUNS.has(token)) continue;
    if (/^(?:v?\d+(?:\.\d+)+[\w-]*)$/i.test(token)) continue;
    const dot = token.lastIndexOf(".");
    if (dot <= 0) continue;
    const stem = token.slice(0, dot);
    const ext = token.slice(dot + 1);
    if (!/[a-z]/i.test(stem) || !KNOWN_FILE_EXTENSIONS.has(ext)) continue;
    // Avoid duplicating a filename that is already captured as the basename of a path ref
    if ([...refs].some((r) => r === token || r.endsWith(`/${token}`))) continue;
    refs.add(token);
  }

  return [...refs];
}

export function isContinuationPrompt(prompt: string): boolean {
  const trimmed = (prompt ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return false;
  const words = trimmed.split(" ");
  if (words.length > 12) return false;
  if (isFreshInfoRequest(trimmed)) return false;
  return /^(?:yes|yep|yeah|ok|okay|sure|please\s+do|go\s+ahead|do\s+it|continue|proceed|apply(?:\s+(?:it|that|this|the\s+(?:plan|changes?|fix(?:es)?)))?|implement(?:\s+(?:it|this|that|the\s+plan))?|execute(?:\s+(?:it|this|the\s+plan))?|looks?\s+good(?:\s*[,!.]?\s*(?:go\s+ahead|do\s+it|proceed|implement(?:\s+it)?))?|lgtm|ship\s+it|make\s+(?:the|those)\s+changes?|let['’]?s\s+(?:do\s+it|go|proceed))\b/i.test(
    trimmed
  );
}

function maxByRank<T extends string>(a: T, b: T, order: readonly T[]): T {
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

export function analyzeTask(prompt:string,mode:"chat"|"plan"|"agent",attachmentCount=0,sessionCtx?:SessionTaskContext):TaskAnalysis{
  const text=(prompt??"").toLowerCase();
  const fileRefs=extractFileReferences(prompt??"");
  const referenceCount=fileRefs.length+attachmentCount;

  const codebase=/\b(codebase|entire project|whole project|all files|every file|throughout|migration|migrate|restructure|re-architect|repo-wide|project-wide|repository-wide)\b/i.test(prompt);
  const multi=referenceCount>=2||/\b(across|multiple files|both files|several files|few files)\b/i.test(prompt);
  let scope:TaskAnalysis["scope"]=codebase?"codebase":multi?"multi_file":"single_file";

  const highReasoning=/\b(debug|race|concurrency|architecture|architect|refactor|migrate|performance|optimi[sz]e|algorithm|security|dependency|integration|root cause|design)\b/i.test(text);
  const moderateReasoning=/\b(implement|feature|fix|change|modify|wire|hook|add|remove|rename|update|create|build)\b/i.test(text);
  let reasoning:TaskAnalysis["reasoning"]=highReasoning?"high":moderateReasoning||scope!=="single_file"?"medium":"low";

  // Distinguish read-only inspection/explanation from active modification
  const hasMutationIntent=/\b(write|edit|modify|change|remove|rename|replace|create|implement|fix|refactor|update|add|delete|drop|wipe|destroy|install|uninstall|deploy|publish|reset|rebase|clean|purge)\b/i.test(text);
  const isQuestion=/^(?:what|why|how|where|who|when|which|is|are|can|could|should|explain|describe|show|find|search|list|inspect|view|read|summarize|tell me|outline|check|audit|grep)\b/i.test(text.trim());
  const hasImperativeAction=/\b(and (?:fix|edit|modify|change|delete|remove|update|create|write|implement|run|execute|deploy|install|purge)|please (?:fix|edit|modify|change|delete|remove|update|create|write|implement|run|execute|deploy|install|purge))\b/i.test(text);

  const isDestructive=/\b(rm\s+.*(-r|-f|\/s|\/q)|rm\s+-rf|rmdir\s+.*(\/s|\/q)|del\s+.*(\/s|\/q)|format\s+[a-z]:|mkfs|drop\s+table|drop\s+database|delete\s+database|wipe\s+(database|disk|drive|repo|workspace)|destroy\s+(cluster|database|server|env)|reset\s+production|force\s+push|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+push\s+.*(-f|--force))\b/i.test(text)
    ||(/\b(delete|wipe|purge|clear|drop)\b.*\b(credentials?|secrets?|api[\s_-]?keys?|passwords?|tokens?)\b/i.test(text));

  const isReadOnly=(isQuestion&&!hasImperativeAction)||(mode==="chat"&&!hasImperativeAction&&!isDestructive);

  let risk:TaskAnalysis["risk"]="low";
  const isHighRisk=!isReadOnly&&(
    /\b(deploy|publish|release|migration|migrate\s+(database|schema)|install|uninstall|chown|chmod\s+777|grant\s+permission|revoke\s+permission)\b/i.test(text)
    ||/\b(npm|yarn|pnpm)\s+(install|add|remove|uninstall|publish)\b/i.test(text)
    ||/\b(git\s+(commit|push|rebase|merge|branch\s+-[dD]))\b/i.test(text)
    ||(/\b(change|modify|update|rotate)\b.*\b(permission|auth|role|access|credentials?|secrets?|api[\s_-]?keys?|tokens?)\b/i.test(text))
  );

  const isMediumRisk=!isReadOnly&&hasMutationIntent;

  if(isDestructive)risk="destructive";
  else if(isHighRisk)risk="high";
  else if(isMediumRisk)risk="medium";
  else risk="low";

  let verification:VerificationKind[]=[];
  if(/\b(test|tests|testing|spec|unit|integration|regression)\b/i.test(text)||/\bbug\b/i.test(text))verification.push("tests");
  if(/\b(build|compile|bundle|tsc|package)\b/i.test(text))verification.push("build");
  if(/\b(lint|eslint|format|prettier)\b/i.test(text))verification.push("lint");
  if(/\b(diagnostic|type error|types|compile error)\b/i.test(text))verification.push("diagnostics");
  if(/\b(run|execute|runtime|start|server|endpoint|ui|browser)\b/i.test(text))verification.push("runtime");
  if(!verification.length&&mode!=="chat"&&risk!=="low"&&!isReadOnly)verification.push("diagnostics");
  if(scope==="codebase"&&!verification.includes("tests")&&!isReadOnly)verification.push("tests");

  const ambiguity=/\b(maybe|somewhere|around|similar|something|it|that|the thing)\b/i.test(prompt)&&fileRefs.length===0?"medium":"low";
  let estimatedSteps=Math.max(1,Math.min(20,1+referenceCount+(scope==="codebase"?4:scope==="multi_file"?2:0)+verification.length));

  const needsVision=Boolean(sessionCtx?.hasImageAttachments);
  let readOnly=isReadOnly;
  let carriedForward=false;

  const prev=sessionCtx?.previousTask;
  const isCont=isContinuationPrompt(prompt);
  const hasOpenTodos=(sessionCtx?.openTodoCount??0)>0&&!(mode==="chat"&&isReadOnly);
  const planToAgent=sessionCtx?.previousMode==="plan"&&mode==="agent"&&(isCont||(fileRefs.length===0&&/\b(plan|above|discussed|agreed|implement|build|apply)\b/i.test(prompt)));

  if(prev&&(isCont||hasOpenTodos||planToAgent)){
    scope=maxByRank(scope,prev.scope,["single_file","multi_file","codebase"]);
    reasoning=maxByRank(reasoning,prev.reasoning,["low","medium","high"]);
    const inheritedRisk=prev.risk==="low"&&mode==="agent"?"medium":prev.risk;
    risk=mode==="chat"&&isReadOnly?"low":maxByRank(risk,inheritedRisk,["low","medium","high","destructive"]);
    const baseVerif=[...verification,...prev.verification];
    if(mode==="agent"&&baseVerif.length===0)baseVerif.push("diagnostics");
    verification=[...new Set(baseVerif)];
    estimatedSteps=Math.max(estimatedSteps,prev.estimatedSteps);
    if(mode==="agent")readOnly=false;
    carriedForward=true;
  }

  return{scope,reasoning,risk,verification:[...new Set(verification)],ambiguity,estimatedSteps,needsVision,readOnly,...(carriedForward?{carriedForward:true}:{})};
}

export function isFreshInfoRequest(prompt:string):boolean{
  const text=prompt??"";
  const current=/\b(today|tonight|now|right now|currently|current|latest|recent|live|real[- ]?time|as of|this morning|this afternoon|this evening)\b/i.test(text);
  const external=/\b(price|prices|stock|stocks|share|shares|nifty|sensex|market|weather|forecast|news|exchange rate|forex|currency|bitcoin|crypto|score|scores|standings|schedule|release|version|updates?|time|date)\b/i.test(text);
  const inherentlyRealTime=/\b(weather|forecast|bitcoin|crypto|stock prices?|exchange rates?|live scores?)\b/i.test(text);
  const explicitWeb=/\bweb search\b|\b(search|check|look up|browse|find).{0,40}\b(web|internet|online)\b/i.test(text);
  return explicitWeb||inherentlyRealTime||(current&&external);
}
export function toComplexity(task:TaskAnalysis,promptTokens:number):ComplexityAssessment{const level=task.scope==="codebase"||task.reasoning==="high"||promptTokens>1200?"complex":task.scope==="multi_file"||task.reasoning==="medium"||promptTokens>350?"moderate":"simple";const minContextTokens=level==="complex"?12288:level==="moderate"?6144:2048;return{level,minContextTokens,signals:{filesReferenced:Math.max(0,task.estimatedSteps-1-(task.scope==="codebase"?4:task.scope==="multi_file"?2:0)-task.verification.length),estimatedSteps:task.estimatedSteps,keywords:[],promptTokens,scope:task.scope,reasoning:task.reasoning,risk:task.risk,verification:task.verification,ambiguity:task.ambiguity},task};}
export function capabilityForModel(model:ModelInfo,bench?:BenchResult,passport?:PassportEntry):ModelCapabilityProfile{return blendCapabilitiesWithPassport(baseCapabilityForModel(model,bench),passport);}
function baseCapabilityForModel(model:ModelInfo,bench?:BenchResult):ModelCapabilityProfile{const tier=model.tier??"small";const baseMap:Record<string,number>={tiny:.38,small:.55,medium:.72,large:.88};const base=baseMap[tier]??.55;const p:ModelCapabilityProfile={reasoning:Math.min(1,base+(model.thinking?.08:0)),coding:Math.min(1,base+(model.toolTrained?.04:0)),toolCalling:model.toolTrained?Math.min(.95,base+.12):Math.max(.25,base-.10),schemaAdherence:model.toolTrained?Math.min(.92,base+.08):Math.max(.25,base-.08),contextRetention:Math.min(.96,base+.03),editFidelity:Math.min(.94,base+.02),recovery:Math.max(.25,base-.03),verification:Math.min(.94,base+.04),speed:.5};if(bench){p.speed=Math.max(.05,Math.min(1,Math.log1p(Math.max(0,bench.tokensPerSec))/Math.log1p(100)));if(bench.capabilityProfile)return clampProfile({...p,...bench.capabilityProfile});p.toolCalling=bench.toolCallReliability;p.schemaAdherence=bench.toolCallReliability;p.reasoning=taskPassRate(bench,"reasoning",p.reasoning);p.recovery=taskPassRate(bench,"recovery",p.recovery);p.editFidelity=taskPassRate(bench,"edit",p.editFidelity);p.verification=taskPassRate(bench,"verification",p.verification);p.contextRetention=taskPassRate(bench,"context",p.contextRetention);p.coding=taskPassRate(bench,"edit",p.coding);}return clampProfile(p);}
function taskPassRate(bench:BenchResult,id:string,fallback:number){const t=bench.tasks.find(x=>x.id===id);return t?(t.passed?Math.min(1,fallback+.12):Math.max(0,fallback-.18)):fallback;}
function clampProfile(p:ModelCapabilityProfile):ModelCapabilityProfile{const out={...p};for(const k of Object.keys(out) as (keyof ModelCapabilityProfile)[])out[k]=Math.max(0,Math.min(1,Number(out[k])));return out;}

export function inferStepPhase(
  mode: Mode,
  executedTools: readonly { name: string; ok: boolean; sideEffecting?: boolean; directAnswer?: boolean }[],
  hasPendingTodos = false,
  hasDiagnosticErrors = false
): AgentPhase {
  if (executedTools.length === 0) return "orient";
  if (mode === "chat") {
    const onlyWebSearch =
      executedTools.length === 1 &&
      executedTools[0].name === "web_search" &&
      executedTools[0].ok &&
      !executedTools[0].directAnswer;
    if (onlyWebSearch) return "orient";
    return executedTools.some((t) => t.ok) ? "final" : "orient";
  }
  if (mode === "plan") return "orient";

  const WRITE_TOOLS = new Set(["edit_file", "write_file", "append_file", "move_path"]);
  const READ_CONTEXT_TOOLS = new Set([
    "read_file",
    "search_code",
    "find_files",
    "list_dir",
    "query_project_context",
    "code_outline",
    "web_search",
    "web_fetch",
  ]);
  const VERIFY_TOOLS = new Set(["get_diagnostics", "run_command", "execute_command"]);

  const hadMutation = executedTools.some((t) => t.ok && (WRITE_TOOLS.has(t.name) || Boolean(t.sideEffecting)));
  const readFileOk = executedTools.some((t) => t.ok && t.name === "read_file");

  let lastOk: { name: string; ok: boolean; sideEffecting?: boolean } | undefined;
  for (let i = executedTools.length - 1; i >= 0; i--) {
    if (executedTools[i].ok) {
      lastOk = executedTools[i];
      break;
    }
  }

  if (!lastOk) {
    return executedTools.some((t) => WRITE_TOOLS.has(t.name)) && readFileOk ? "edit" : "orient";
  }
  if (WRITE_TOOLS.has(lastOk.name) || lastOk.sideEffecting) return "verify";
  if (VERIFY_TOOLS.has(lastOk.name) && hadMutation) {
    return hasPendingTodos || hasDiagnosticErrors ? "edit" : "final";
  }
  if (READ_CONTEXT_TOOLS.has(lastOk.name)) {
    return lastOk.name === "read_file" || readFileOk || hadMutation ? "edit" : "orient";
  }
  return hadMutation ? "edit" : "orient";
}

export function rankTools(specs:ToolSpec[],task:TaskAnalysis,phase:"orient"|"edit"|"verify"|"final",previousFailures=new Map<string,number>()):ToolSpec[]{const verification=new Set(task.verification);return[...specs].sort((a,b)=>scoreTool(b,task,phase,verification,previousFailures)-scoreTool(a,task,phase,verification,previousFailures));}
function scoreTool(tool:ToolSpec,task:TaskAnalysis,phase:string,verification:Set<VerificationKind>,failures:Map<string,number>):number{let score=100-tool.priority;const tags=new Set(tool.tags??[]);const risk=tool.risk??(tool.sideEffecting?"workspace_write":"read");if(phase==="orient"&&(tags.has("read")||tags.has("search")||tags.has("navigate")||tags.has("web")) )score+=35;if(phase==="edit"&&(tags.has("write")||risk==="workspace_write"))score+=40;if(phase==="verify"&&(tags.has("verify")||tool.name==="run_command"||tool.name==="get_diagnostics"))score+=45;if(task.risk==="destructive"&&(risk==="destructive"||risk==="execute"))score-=30;if(task.verification.length&&(tool.verifyAfter??[]).some(v=>verification.has(v)))score+=15;if((failures.get(tool.name)??0)>=2)score+=5;return score;}

/** Intelligence changes the amount of assistance, never whether the local
 * model can access its core workspace tools. `freshInfo` promotes the web
 * tools to the front — they are the only way to answer a current/external
 * question, and a weak model otherwise picks the first spec it sees. */
export function selectToolSpecs(specs:ToolSpec[],plan:AdaptivePlan,phase:"orient"|"edit"|"verify"|"final",freshInfo=false):ToolSpec[]{
  let usable=plan.mode==="plan"
    ?specs.filter(s=>!s.sideEffecting&&!PLAN_EXCLUDED_TOOLS.has(s.name))
    :plan.mode==="chat"
      ?specs.filter(s=>!s.sideEffecting&&CHAT_READONLY_TOOLS.has(s.name)&&!(s.tags?.includes("mcp")||s.name.startsWith("mcp_")))
      :[...specs];
  const byName=new Map(usable.map(s=>[s.name,s]));const core=LOCAL_CORE_TOOLS.map(n=>byName.get(n)).filter((s):s is ToolSpec=>!!s);const extended=LOCAL_EXTENDED_TOOLS.map(n=>byName.get(n)).filter((s):s is ToolSpec=>!!s);const task=plan.task??analyzeTask("",plan.mode);const coreRanked=rankTools(core,task,phase);const ranked=rankTools(usable,task,phase);const ordered:ToolSpec[]=[];const push=(s:ToolSpec)=>{if(!ordered.some(x=>x.name===s.name))ordered.push(s);};
  const webTools=extended.filter(s=>s.name==="web_search"||s.name==="web_fetch");
  const otherExtended=extended.filter(s=>s.name!=="web_search"&&s.name!=="web_fetch");
  if(plan.mode==="chat"&&freshInfo){
    for(const s of webTools)push(s);
    for(const s of coreRanked)push(s);
    for(const s of otherExtended)push(s);
    for(const s of ranked)push(s);
  }else{
    for(const s of coreRanked)push(s);
    // Web tools are always available — they are the only way to get current/external facts.
    // Other extended tools (code_outline, move_path, todo_write, think) are ordered after core + web.
    for(const s of webTools)push(s);
    for(const s of otherExtended)push(s);
    for(const s of ranked)push(s);
  }
  let out=ordered.slice(0,Math.max(1,plan.maxTools));
  if(freshInfo){
    const web=out.filter(s=>s.name==="web_search"||s.name==="web_fetch");
    if(web.length)out=[...web,...out.filter(s=>s.name!=="web_search"&&s.name!=="web_fetch")];
  }
  return out;
}

/** The model narrated its intent ("I'll read the file next") instead of
 * emitting a tool call. Detected only on short, unstructured prose so a real
 * deliverable — a plan, a numbered answer, code — is never mistaken for it. */
export function looksLikeNarration(text:string):boolean{
  const t=(text??"").trim();
  if(t.length<8)return false;
  // Code/fenced output and structured answers are deliverables, not narration.
  if(/```/.test(t))return false;
  const lines=t.split("\n").map(l=>l.trim()).filter(Boolean);
  if(lines.filter(l=>/^(?:[-*•]|\d+[.)]|#{1,6}\s|>\s|\|)/.test(l)).length>=2)return false;
  // Direct clarifying questions to the user are interactive conversation, not omitted-tool narration.
  if(t.endsWith("?")||lines.some(l=>l.endsWith("?")&&!/^(?:let me|i['’]?ll|i will)\b/i.test(l)))return false;
  // Narration is a short burst of prose; anything long is a real answer.
  if(t.length>420||lines.length>6)return false;
  if(!/\b(?:i['’](?:ll|m going to)|i will|i am going to|let me|let['’]s|going to|now (?:i|let)|next,? i|then i)\b/i.test(t))return false;
  if(!/\b(?:search|look(?: up| for| into)?|check|read|open|find|list|inspect|review|examine|run|execute|create|write|edit|modify|update|fix|add|remove|delete|move|copy|browse|fetch|start|proceed|try|use|go to|navigate|grab|pull)\b/i.test(t))return false;
  // Future/intent framing rather than a completed statement.
  return /\b(?:will|going to|now|next|then|should|need to|want to|first|after)\b/i.test(t);
}

/**
 * Detects when a model ran `web_search`, never called `web_fetch`, and tries to end
 * the turn by telling the user to go visit/check the external websites themselves.
 */
export function looksLikeWebLinkDeflection(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 20) return false;
  return /\b(?:recommend\s+checking|here\s+are\s+(?:a\s+few|some|several)\s+(?:links|sources|websites|sites)|where\s+you\s+can\s+check|use\s+one\s+of\s+(?:those|these)\s+links|visit\s+(?:one\s+of\s+)?(?:the\s+following|these|those)\s+(?:links|sites|websites|pages)|check\s+(?:one\s+of\s+)?the\s+live\s+tracking\s+pages|cannot\s+provide\s+a\s+live|can['’]?t\s+provide\s+a\s+live|unable\s+to\s+provide\s+(?:a\s+)?live|for\s+the\s+most\s+(?:accurate|up-to-the-minute|real-time)[\s\S]{0,60}\b(?:check|visit|links|pages|websites)|please\s+(?:use|visit|check)\s+one\s+of\s+(?:those|these)\s+links)\b/i.test(
    t
  );
}

/** Fenced code blocks (and inline code) removed, prose lines rejoined. A model
 *  that pastes a file/command output and then narrates its next tool call
 *  ("To replace the content, I will use edit_file… Let me proceed") would
 *  otherwise dodge narration detection, which treats fenced output as a
 *  deliverable — and the turn dies right before the tool runs. */
export function stripFencedCode(text:string):string{
  return (text??"")
    .replace(/```[\s\S]*?```/g," ")
    .replace(/`[^`\n]*`/g," ")
    .split("\n").map(l=>l.trim()).filter(Boolean).join("\n").trim();
}
/** Contextually appropriate tool to nudge a non-acting model toward. Always
 * returns a name present in `specs` so the nudge never points at a tool the
 * model cannot call. */
export function suggestFirstTool(specs:ToolSpec[],lastUser:string):string{
  const have=new Map(specs.map(s=>[s.name,s] as const));
  const firstOf=(...candidates:string[]):string|undefined=>{for(const c of candidates)if(have.has(c))return c;return undefined;};
  const text=(lastUser??"").toLowerCase();
  const hasUrl=/https?:\/\/|www\./.test(text);
  const wantsWeb=/\b(current|latest|today|now|recent|live|real[- ]?time|weather|price|prices|stock|stocks|market|news|score|schedule|release|version|as of|forecast|exchange rate|currency|bitcoin|crypto)\b/.test(text)||hasUrl;
  const wantsFetch=/\b(fetch|download|scrape|page|url|link|website|webpage|article|documentation|docs)\b/.test(text);
  if(wantsWeb&&wantsFetch&&hasUrl)return firstOf("web_fetch","web_search")??"web_search";
  if(wantsWeb)return firstOf("web_search","web_fetch")??"web_search";
  if(/\b(?:grep|search (?:for |the code|the project|the workspace)|find (?:all )?(?:occurrences|usages|references)|which files? contain|text string|symbol)\b/.test(text))
    return firstOf("search_code","find_files")??"search_code";
  if(/\b(?:find|locate|where is|which files?|glob|\*\.|list (?:the )?(?:files|directory|folder)|directory tree|outline|structure)\b/.test(text))
    return firstOf("find_files","list_dir")??"list_dir";
  if(/\b(?:run|execute|test|tests|build|compile|lint|start|serve|npm|npx|pnpm|yarn|node |git )\b/.test(text))
    return firstOf("run_command","get_diagnostics")??"run_command";
  if(/\b(?:read|show|open|view|what('| i)s in|contents of|lines?\b)\b/.test(text)||/\.[a-z0-9]{1,8}\b/.test(text))
    return firstOf("read_file","list_dir")??"read_file";
  if(/\b(?:edit|write|fix|add|remove|delete|rename|replace|create|update|implement|change|move)\b/.test(text))
    return firstOf("edit_file","write_file")??"edit_file";
  const fallback=firstOf("list_dir","read_file","search_code")
    ??specs.find(s=>(s.tags??[]).includes("read"))?.name
    ??specs[0]?.name;
  return fallback??"list_dir";
}

/** Native JSON tool calling is an optimization, not the local fallback path.
 * A local model must demonstrate high tool-call and schema reliability before
 * Photon trusts its provider-native interface. Without a benchmark result,
 * local models stay on the tolerant Photon block protocol. */
export function shouldUseNativeToolProtocol(model:ModelInfo,capabilities:ModelCapabilityProfile,bench:BenchResult|undefined,intelligence:import("../../shared/types").IntelligenceLevel):boolean{
  const isLocal=!model.provider||model.provider==="ollama"||model.provider==="llamacpp";
  if(!isLocal)return true;
  const isFreshBench=!!bench&&(bench.methodologyVersion??0)>=1&&(Date.now()-bench.ranAt<=30*86_400_000);
  // Bench v5 (L-6 fix): gate native protocol on actual measured native tool-call probes, not block-format probes.
  if(isFreshBench&&(bench.methodologyVersion??0)>=5&&typeof bench.nativeToolCallReliability==="number"){
    if(bench.nativeToolCallReliability>=.80)return true;
    if(bench.nativeToolCallReliability<.60)return false;
  }
  const isTiny=model.tier==="tiny"||(typeof model.paramsB==="number"&&model.paramsB<=4.5);
  if(!isTiny&&model.capabilities?.some(c=>c.toLowerCase()==="tools"))return true;
  if(intelligence==="low"||isTiny)return false;
  return isFreshBench&&bench.toolCallReliability>=.80&&capabilities.schemaAdherence>=.82&&capabilities.toolCalling>=.82;
}
export function executionFingerprint(call:ToolCall,mutationEpoch:number):string{return`${call.name}|${JSON.stringify(stableNormalize(call.args))}|epoch:${mutationEpoch}`;}
function stableNormalize(value:unknown):unknown{if(Array.isArray(value))return value.map(stableNormalize);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stableNormalize(v)]));return value;}
export function canRunInParallel(a:ToolSpec,b:ToolSpec):boolean{const ar=a.risk??(a.sideEffecting?"workspace_write":"read");const br=b.risk??(b.sideEffecting?"workspace_write":"read");return(a.concurrency??"serial")==="safe_parallel"&&(b.concurrency??"serial")==="safe_parallel"&&ar==="read"&&br==="read";}
export function buildExecutionPolicy(task:TaskAnalysis,capability:ModelCapabilityProfile,maxSteps:number,maxTools:number):AdaptivePlan["executionPolicy"]{
  const concurrency=capability.toolCalling>=.78&&capability.recovery>=.60?4:capability.toolCalling>=.60?2:1;
  const reasoningBudget=task.reasoning==="high"?Math.round(3072+Math.max(0,capability.reasoning-.7)*3400):task.reasoning==="medium"?Math.round(768+Math.max(0,capability.reasoning-.65)*1200):0;
  const visibleBudget=task.reasoning==="high"?4096:task.reasoning==="medium"?2048:1536;
  const generationBudgetTokens=Math.max(512,Math.min(8192,visibleBudget+reasoningBudget));
  const requireExplicitApproval=task.risk==="destructive"||task.risk==="high";
  const stepBudget=Math.max(1,Math.min(maxSteps,Math.max(8,Math.min(200,Math.max(maxSteps,task.estimatedSteps*3,maxTools*2)))));
  return{
    maxConcurrent:task.risk==="destructive"?1:Math.min(concurrency,4),
    allowParallelReads:task.risk!=="destructive",
    serializeMutations:true,
    generationBudgetTokens,
    stepBudget,
    requireExplicitApproval,
    blockTerminalCommands:task.risk==="destructive",
  };
}
export function buildVerificationPlan(task:TaskAnalysis):VerificationPlan{return{required:[...new Set(task.verification)],completed:[],evidence:[]};}
export function recoveryDirective(result:{status?:string;recovery?:{action?:string;hints?:string[]};output:string}):string|undefined{const action=result.recovery?.action;if(!action)return undefined;const prefix:Record<string,string>={reread:"Re-read the affected file before retrying the operation.",search:"Search for the correct path, symbol, or current text before retrying.",repair:"Re-check the tool schema and correct the arguments before retrying.",verify:"Run the relevant verification step before making another change.",retry:"Retry once after inspecting the reported error.",ask_user:"Ask the user for the missing information or approval."};return`${prefix[action]??"Diagnose the tool failure before continuing."}${result.recovery?.hints?.length?` Hints: ${result.recovery.hints.join("; ")}`:""}\nTool output: ${result.output}`;}
