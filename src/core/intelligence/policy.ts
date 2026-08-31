import type {
  AdaptivePlan,
  BenchResult,
  ComplexityAssessment,
  ModelCapabilityProfile,
  ModelInfo,
  TaskAnalysis,
  ToolSpec,
  VerificationKind,
} from "../../shared/types";
import type { ToolCall } from "../../shared/types";

/** Analyze the task along independent dimensions instead of one keyword-based complexity score. */
export function analyzeTask(prompt: string, mode: "chat" | "plan" | "agent", attachmentCount = 0): TaskAnalysis {
  const text = (prompt ?? "").toLowerCase();
  const fileRefs = new Set<string>();
  for (const m of prompt.matchAll(/(?:[\w@./-]+\/)*[\w.-]+\.[a-z0-9]{1,8}\b/gi)) fileRefs.add(m[0].toLowerCase());
  for (const m of prompt.matchAll(/@[\w./-]+/g)) fileRefs.add(m[0].toLowerCase());

  const codebase = /\b(codebase|entire project|all files|every file|throughout|migration|migrate|restructure|re-architect)\b/i.test(prompt);
  const multi = fileRefs.size + attachmentCount >= 2 || /\b(across|multiple files|both files|several files)\b/i.test(prompt);
  const scope: TaskAnalysis["scope"] = codebase ? "codebase" : multi ? "multi_file" : "single_file";

  const highReasoning = /\b(debug|race|concurrency|architecture|architect|refactor|migrate|performance|optimi[sz]e|algorithm|security|dependency|integration|root cause|design)\b/i.test(text);
  const moderateReasoning = /\b(implement|feature|fix|change|modify|wire|hook|add|remove|rename|update|create|build)\b/i.test(text);
  const reasoning: TaskAnalysis["reasoning"] = highReasoning ? "high" : moderateReasoning || scope !== "single_file" ? "medium" : "low";

  let risk: TaskAnalysis["risk"] = "low";
  if (/\b(rm\s+-rf|delete database|drop table|destroy|wipe|reset production|force push|credential|secret|api key|password)\b/i.test(text)) risk = "destructive";
  else if (/\b(deploy|publish|release|dependency|install|uninstall|migration|security|permission|auth|database|schema|git)\b/i.test(text)) risk = "high";
  else if (/\b(write|edit|modify|change|remove|rename|replace|create|implement|fix)\b/i.test(text)) risk = "medium";

  const verification: VerificationKind[] = [];
  if (/(test|tests|testing|spec|unit|integration)/i.test(text) || /\bbug|fix|regression\b/i.test(text)) verification.push("tests");
  if (/(build|compile|bundle|tsc|package)/i.test(text)) verification.push("build");
  if (/(lint|eslint|format|prettier)/i.test(text)) verification.push("lint");
  if (/(diagnostic|type error|types|compile error)/i.test(text)) verification.push("diagnostics");
  if (/(run|execute|runtime|start|server|endpoint|ui|browser)/i.test(text)) verification.push("runtime");
  if (!verification.length && mode !== "chat" && risk !== "low") verification.push("diagnostics");
  if (scope === "codebase" && !verification.includes("tests")) verification.push("tests");

  const ambiguity = /\b(maybe|somewhere|around|similar|something|it|that|the thing)\b/i.test(prompt) && fileRefs.size === 0 ? "medium" : "low";
  const estimatedSteps = Math.max(1, Math.min(20, 1 + fileRefs.size + (scope === "codebase" ? 4 : scope === "multi_file" ? 2 : 0) + verification.length));
  return { scope, reasoning, risk, verification: [...new Set(verification)], ambiguity, estimatedSteps };
}

export function toComplexity(task: TaskAnalysis, promptTokens: number): ComplexityAssessment {
  const level = task.scope === "codebase" || task.reasoning === "high" || promptTokens > 1200 ? "complex" : task.scope === "multi_file" || task.reasoning === "medium" || promptTokens > 350 ? "moderate" : "simple";
  const minContextTokens = level === "complex" ? 12288 : level === "moderate" ? 6144 : 2048;
  return {
    level,
    minContextTokens,
    signals: {
      filesReferenced: 0,
      estimatedSteps: task.estimatedSteps,
      keywords: [],
      promptTokens,
      scope: task.scope,
      reasoning: task.reasoning,
      risk: task.risk,
      verification: task.verification,
      ambiguity: task.ambiguity,
    },
    task,
  };
}

/** Capability scores are intentionally independent of parameter count. */
export function capabilityForModel(model: ModelInfo, bench?: BenchResult): ModelCapabilityProfile {
  const tier = model.tier ?? "small";
  const tierBase: Record<string, number> = { tiny: 0.38, small: 0.55, medium: 0.72, large: 0.88 };
  const base = tierBase[tier] ?? 0.55;
  const profile: ModelCapabilityProfile = {
    reasoning: base + (model.thinking ? 0.08 : 0),
    coding: base + (model.toolTrained ? 0.04 : 0),
    toolCalling: model.toolTrained ? Math.min(0.95, base + 0.12) : Math.max(0.25, base - 0.10),
    schemaAdherence: model.toolTrained ? Math.min(0.92, base + 0.08) : Math.max(0.25, base - 0.08),
    contextRetention: Math.min(0.96, base + 0.03),
    editFidelity: Math.min(0.94, base + 0.02),
    recovery: Math.max(0.25, base - 0.03),
    verification: Math.min(0.94, base + 0.04),
    speed: 0.5,
  };
  if (bench) {
    profile.speed = Math.max(0.05, Math.min(1, bench.tokensPerSec / Math.max(1, bench.tokensPerSec)));
    profile.toolCalling = Math.max(profile.toolCalling, bench.toolCallReliability);
    profile.schemaAdherence = taskPassRate(bench, "schema", profile.schemaAdherence);
    profile.reasoning = taskPassRate(bench, "reasoning", profile.reasoning);
    if (bench.capabilityProfile) return { ...profile, ...bench.capabilityProfile };
    const recovery = taskPassRate(bench, "recovery", profile.recovery);
    const edit = taskPassRate(bench, "edit", profile.editFidelity);
    const verification = taskPassRate(bench, "verification", profile.verification);
    profile.recovery = recovery;
    profile.editFidelity = edit;
    profile.verification = verification;
  }
  return clampProfile(profile);
}

function taskPassRate(bench: BenchResult, id: string, fallback: number): number {
  const task = bench.tasks.find(t => t.id === id);
  return task ? (task.passed ? Math.min(1, fallback + 0.12) : Math.max(0, fallback - 0.18)) : fallback;
}
function clampProfile(p: ModelCapabilityProfile): ModelCapabilityProfile {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.max(0, Math.min(1, Number(v))) ])) as ModelCapabilityProfile;
}

/** Relevant-tool selection replaces count-only priority trimming. */
export function rankTools(specs: ToolSpec[], task: TaskAnalysis, phase: "orient" | "edit" | "verify" | "final", previousFailures = new Map<string, number>()): ToolSpec[] {
  const verificationSet = new Set(task.verification);
  return [...specs].sort((a, b) => scoreTool(b, task, phase, verificationSet, previousFailures) - scoreTool(a, task, phase, verificationSet, previousFailures));
}

function scoreTool(tool: ToolSpec, task: TaskAnalysis, phase: string, verification: Set<VerificationKind>, failures: Map<string, number>): number {
  let score = 100 - tool.priority;
  const tags = new Set(tool.tags ?? []);
  const risk = tool.risk ?? (tool.sideEffecting ? "workspace_write" : "read");
  if (phase === "orient" && (tags.has("read") || tags.has("search") || tags.has("navigate"))) score += 35;
  if (phase === "edit" && (tags.has("write") || risk === "workspace_write")) score += 40;
  if (phase === "verify" && (tags.has("verify") || tool.name === "run_command")) score += 45;
  if (task.risk === "destructive" && (risk === "destructive" || risk === "execute")) score -= 30;
  if (task.verification.length && (tool.verifyAfter ?? []).some(v => verification.has(v))) score += 15;
  if ((failures.get(tool.name) ?? 0) >= 2) score += 5; // keep struggling tools visible so recovery can occur
  return score;
}

export function executionFingerprint(call: ToolCall, mutationEpoch: number): string {
  const args = stableNormalize(call.args);
  const stateful = ["read_file", "search_code", "find_files", "list_dir", "get_diagnostics", "code_outline"].includes(call.name);
  const epoch = stateful ? mutationEpoch : mutationEpoch;
  return `${call.name}|${JSON.stringify(args)}|epoch:${epoch}`;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableNormalize(v)]));
  }
  return value;
}

export function canRunInParallel(a: ToolSpec, b: ToolSpec): boolean {
  const ar = a.risk ?? (a.sideEffecting ? "workspace_write" : "read");
  const br = b.risk ?? (b.sideEffecting ? "workspace_write" : "read");
  if ((a.concurrency ?? "serial") === "serial" || (b.concurrency ?? "serial") === "serial") return false;
  if (ar !== "read" || br !== "read") return false;
  return true;
}

export function buildExecutionPolicy(task: TaskAnalysis, capability: ModelCapabilityProfile, maxSteps: number, maxTools: number): AdaptivePlan["executionPolicy"] {
  const concurrency = capability.toolCalling >= 0.78 && capability.recovery >= 0.60 ? 4 : capability.toolCalling >= 0.60 ? 2 : 1;
  return {
    maxConcurrent: task.risk === "destructive" ? 1 : Math.min(concurrency, 4),
    allowParallelReads: task.risk !== "destructive",
    serializeMutations: true,
    generationBudgetTokens: Math.max(256, Math.min(8192, Math.floor(300 + capability.reasoning * 2500 + capability.contextRetention * 1200))),
    stepBudget: Math.max(8, Math.min(200, Math.max(maxSteps, task.estimatedSteps * 3, maxTools * 2))),
  };
}

export function buildVerificationPlan(task: TaskAnalysis): AdaptivePlan["verification"] {
  return { required: [...new Set(task.verification)], completed: [], evidence: [] };
}

export function recoveryDirective(result: { status?: string; recovery?: { action?: string; hints?: string[] }; output: string }): string | undefined {
  const action = result.recovery?.action;
  if (!action) return undefined;
  const prefix: Record<string, string> = {
    reread: "Re-read the affected file before retrying the operation.",
    search: "Search for the correct path, symbol, or current text before retrying.",
    repair: "Re-check the tool schema and correct the arguments before retrying.",
    verify: "Run the relevant verification step before making another change.",
    retry: "Retry once after inspecting the reported error.",
    ask_user: "Ask the user for the missing information or approval.",
  };
  return `${prefix[action] ?? "Diagnose the tool failure before continuing."}${result.recovery?.hints?.length ? ` Hints: ${result.recovery.hints.join("; ")}` : ""}\nTool output: ${result.output}`;
}
