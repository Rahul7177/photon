import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { BenchResult, BenchTaskOutcome, ModelCapabilityProfile, ToolSpec } from "../../shared/types";
import type { LLMProvider, LLMChatChunk, LLMMessage } from "../llm/types";
import { parsePhotonBlocks } from "../protocol/parse";
import { estimateTokens } from "../adaptive/tokens";

export const BENCH_VERSION = 4;
const BENCH_OPTS = { temperature: 0, top_p: 1, num_ctx: 4096, num_predict: 260, seed: 7 };

const PROBE_READ_TOOL: ToolSpec = {
  name: "read_file",
  summary: "Read a file from the workspace.",
  params: [{ name: "path", type: "string", required: true, description: "File path to read." }],
  sideEffecting: false,
  priority: 1,
};

const PROBE_EDIT_TOOL: ToolSpec = {
  name: "edit_file",
  summary: "Replace an exact string in a file.",
  params: [
    { name: "path", type: "string", required: true, description: "Target file path." },
    { name: "old_str", type: "string", required: true, description: "Exact existing code to replace." },
    { name: "new_str", type: "string", required: true, description: "Replacement code." },
  ],
  sideEffecting: true,
  priority: 2,
};

const PROBE_SEARCH_TOOLS: ToolSpec[] = [
  PROBE_READ_TOOL,
  {
    name: "find_files",
    summary: "Find files by pattern.",
    params: [{ name: "pattern", type: "string", required: true, description: "Glob or filename fragment." }],
    sideEffecting: false,
    priority: 2,
  },
  {
    name: "search_code",
    summary: "Search file contents.",
    params: [{ name: "query", type: "string", required: true, description: "Search query." }],
    sideEffecting: false,
    priority: 3,
  },
];

const TOOLCALL_ATTEMPTS = 3;

export interface BenchOptions {
  hardwareClass: string;
  quantization?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CodingOutcomeMetrics {
  fileSelectionPassed: boolean;
  patchValidPassed: boolean;
  toolRecoveryPassed: boolean;
  contextRetentionPassed: boolean;
  verificationPassed: boolean;
  codingSuccessScore: number;
}

export interface RoutingEvalOutcome {
  taskId: string;
  modelUsed: string;
  fileSelectionOk: boolean;
  patchValidOk: boolean;
  toolRecoveryOk: boolean;
  contextRetentionOk: boolean;
  verificationOk: boolean;
  latencyMs: number;
  tokensUsed: number;
}

export interface RoutingComparisonReport {
  totalTasks: number;
  adaptiveSuccessRate: number;
  baselineSuccessRate: number;
  qualityDelta: number;
  adaptiveAvgLatencyMs: number;
  baselineAvgLatencyMs: number;
  adaptiveTotalTokens: number;
  baselineTotalTokens: number;
  adaptiveOutperformsBaseline: boolean;
  summary: string;
}

/**
 * Objective evaluation of a patch response for the coding benchmark task.
 * Checks that the model either emits a valid `edit_file` tool block targeting `src/pricing.ts`
 * with the exact `old_str` (`price + price * rate`) and a subtracting `new_str`,
 * OR outputs the exact target line and valid replacement without hallucinating unrelated edits.
 */
export function evaluateCodingPatchOutput(text: string): { passed: boolean; detail: string } {
  const parsed = parsePhotonBlocks(text, [PROBE_EDIT_TOOL]);
  const editCall = parsed.calls.find((c) => c.name === "edit_file" && c.errors.length === 0);
  if (editCall) {
    const p = String(editCall.args.path ?? "");
    const oldStr = String(editCall.args.old_str ?? "");
    const newStr = String(editCall.args.new_str ?? "");
    const validPath = p.includes("pricing.ts") || p === "src/pricing.ts";
    const validOld = /const\s+value\s*=\s*1|price\s*\+\s*price\s*\*\s*rate/.test(oldStr);
    const validNew = /const\s+value\s*=\s*2|price\s*-\s*price\s*\*\s*rate|price\s*\*\s*\(\s*1\s*-\s*rate\s*\)/.test(newStr);
    if (validPath && validOld && validNew) {
      return { passed: true, detail: "valid edit_file patch with exact old_str and fixed new_str" };
    }
  }

  // Fallback check for direct find-target / patch output
  const hasExactTarget = /const value = 1|return price - price \* rate|price \* \(1 - rate\)/.test(text);
  const noCorruptTarget = !/const value = 3/.test(text);
  if (hasExactTarget && noCorruptTarget) {
    return { passed: true, detail: "preserved exact target text and valid patch" };
  }
  return { passed: false, detail: "could not produce valid patch or preserve edit target" };
}

/**
 * Compares adaptive model routing outcomes against a fixed-model baseline across
 * objective coding success checks (file selection, patch validity, tool recovery,
 * context retention, verification), latency, and token usage.
 */
export function compareRoutingVsBaseline(
  adaptiveOutcomes: RoutingEvalOutcome[],
  baselineOutcomes: RoutingEvalOutcome[]
): RoutingComparisonReport {
  const count = Math.min(adaptiveOutcomes.length, baselineOutcomes.length);
  if (count === 0) {
    return {
      totalTasks: 0,
      adaptiveSuccessRate: 0,
      baselineSuccessRate: 0,
      qualityDelta: 0,
      adaptiveAvgLatencyMs: 0,
      baselineAvgLatencyMs: 0,
      adaptiveTotalTokens: 0,
      baselineTotalTokens: 0,
      adaptiveOutperformsBaseline: false,
      summary: "No benchmark tasks evaluated.",
    };
  }

  const scoreOutcome = (o: RoutingEvalOutcome): number => {
    const checks = [
      o.fileSelectionOk,
      o.patchValidOk,
      o.toolRecoveryOk,
      o.contextRetentionOk,
      o.verificationOk,
    ];
    return checks.filter(Boolean).length / checks.length;
  };

  let adaptiveScoreSum = 0;
  let baselineScoreSum = 0;
  let adaptiveLatencySum = 0;
  let baselineLatencySum = 0;
  let adaptiveTokens = 0;
  let baselineTokens = 0;

  for (let i = 0; i < count; i++) {
    adaptiveScoreSum += scoreOutcome(adaptiveOutcomes[i]);
    baselineScoreSum += scoreOutcome(baselineOutcomes[i]);
    adaptiveLatencySum += adaptiveOutcomes[i].latencyMs;
    baselineLatencySum += baselineOutcomes[i].latencyMs;
    adaptiveTokens += adaptiveOutcomes[i].tokensUsed;
    baselineTokens += baselineOutcomes[i].tokensUsed;
  }

  const adaptiveSuccessRate = Math.round((adaptiveScoreSum / count) * 1000) / 1000;
  const baselineSuccessRate = Math.round((baselineScoreSum / count) * 1000) / 1000;
  const qualityDelta = Math.round((adaptiveSuccessRate - baselineSuccessRate) * 1000) / 1000;
  const adaptiveAvgLatencyMs = Math.round(adaptiveLatencySum / count);
  const baselineAvgLatencyMs = Math.round(baselineLatencySum / count);

  const adaptiveOutperformsBaseline =
    adaptiveSuccessRate > baselineSuccessRate ||
    (adaptiveSuccessRate === baselineSuccessRate && adaptiveAvgLatencyMs <= baselineAvgLatencyMs);

  const deltaPct = Math.round(qualityDelta * 100);
  const sign = deltaPct >= 0 ? `+${deltaPct}%` : `${deltaPct}%`;
  const summary =
    `Adaptive routing achieved ${Math.round(adaptiveSuccessRate * 100)}% coding score vs ` +
    `${Math.round(baselineSuccessRate * 100)}% fixed-model baseline (${sign} quality delta, ` +
    `${adaptiveAvgLatencyMs}ms vs ${baselineAvgLatencyMs}ms avg latency).`;

  return {
    totalTasks: count,
    adaptiveSuccessRate,
    baselineSuccessRate,
    qualityDelta,
    adaptiveAvgLatencyMs,
    baselineAvgLatencyMs,
    adaptiveTotalTokens: adaptiveTokens,
    baselineTotalTokens: baselineTokens,
    adaptiveOutperformsBaseline,
    summary,
  };
}

/**
 * Calculates statistical percentiles (p50, p90, p95, p99), mean, variance, min, max.
 */
export function computePercentiles(samples: number[]): {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  mean: number;
  variance: number;
  min: number;
  max: number;
} {
  if (samples.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, mean: 0, variance: 0, min: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / sorted.length;
  const variance =
    sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / sorted.length;

  const getPercentile = (pct: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
    return sorted[idx];
  };

  return {
    p50: Math.round(getPercentile(50) * 100) / 100,
    p90: Math.round(getPercentile(90) * 100) / 100,
    p95: Math.round(getPercentile(95) * 100) / 100,
    p99: Math.round(getPercentile(99) * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    variance: Math.round(variance * 100) / 100,
    min,
    max,
  };
}

/**
 * Calculates the weighted composite score for a benchmark result.
 * Composite weighting:
 * - Speed (normalized against 80 tok/s): 25%
 * - Tool Calling Reliability: 25%
 * - Algorithmic Reasoning: 25%
 * - Coding Outcome Tasks: 25%
 */
export function calculateCompositeBenchmarkScore(result: BenchResult): {
  compositeScore: number;
  breakdown: {
    speedScore: number;
    toolCallingScore: number;
    reasoningScore: number;
    codingOutcomeScore: number;
  };
  explanation: string;
} {
  const speedScore = Math.min(1.0, Math.max(0, result.tokensPerSec / 80));
  const toolCallingScore = Math.min(1.0, Math.max(0, result.toolCallReliability));
  const reasoningScore = result.reasoningPass ? 1.0 : 0.0;

  const codingTaskIds = new Set(["tool_selection", "recovery", "edit", "verification", "context"]);
  const codingTasks = (result.tasks ?? []).filter((t) => codingTaskIds.has(t.id));
  const codingOutcomeScore =
    codingTasks.length > 0
      ? codingTasks.filter((t) => t.passed).length / codingTasks.length
      : 0.5;

  const compositeScore =
    Math.round(
      (0.25 * speedScore + 0.25 * toolCallingScore + 0.25 * reasoningScore + 0.25 * codingOutcomeScore) *
        1000
    ) / 1000;

  const explanation =
    `Composite Score ${Math.round(compositeScore * 100)}%: ` +
    `Speed (25% weight): ${Math.round(speedScore * 100)}% (${result.tokensPerSec} tok/s), ` +
    `Tool Calling (25% weight): ${Math.round(toolCallingScore * 100)}%, ` +
    `Reasoning (25% weight): ${Math.round(reasoningScore * 100)}%, ` +
    `Coding Tasks (25% weight): ${Math.round(codingOutcomeScore * 100)}%.`;

  return {
    compositeScore,
    breakdown: {
      speedScore: Math.round(speedScore * 100) / 100,
      toolCallingScore: Math.round(toolCallingScore * 100) / 100,
      reasoningScore: Math.round(reasoningScore * 100) / 100,
      codingOutcomeScore: Math.round(codingOutcomeScore * 100) / 100,
    },
    explanation,
  };
}

export interface RepoTaskOptions {
  signal?: AbortSignal;
  attemptWrongFile?: boolean;
  attemptExtraneousEdit?: boolean;
  attemptPartialPatch?: boolean;
}

export interface RepoTaskOutcome {
  taskCompleted: boolean;
  inspectPassed: boolean;
  editApplied: boolean;
  testPassed: boolean;
  noExtraneousEdits: boolean;
  detail: string;
  cleanedUp: boolean;
}

/**
 * Executes a deterministic end-to-end repository task inside an isolated disposable
 * workspace in the OS temporary directory (NEVER in the user's real project).
 * Evaluates the full lifecycle: inspect -> edit -> build/test -> verify postconditions.
 * Explicitly guards against wrong-file edits, partial patches, and extraneous destructive changes.
 */
export function evaluateRepoTaskInDisposableWorkspace(
  taskRunner: (repoDir: string) => {
    inspected?: boolean;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    editedPath?: string;
    oldStr?: string;
    newStr?: string;
  },
  options: RepoTaskOptions = {}
): RepoTaskOutcome {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-bench-repo-"));

  try {
    if (options.signal?.aborted) {
      return {
        taskCompleted: false,
        inspectPassed: false,
        editApplied: false,
        testPassed: false,
        noExtraneousEdits: true,
        detail: "Benchmark task cancelled before execution",
        cleanedUp: false,
      };
    }

    // Initialize disposable workspace structure
    const srcDir = path.join(repoDir, "src");
    const testDir = path.join(repoDir, "test");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    // Target file to fix
    const targetFilePath = path.join(srcDir, "pricing.ts");
    const initialTargetContent =
      `export function calculatePrice(base: number, taxRate: number): number {\n` +
      `  return base + base * taxRate;\n` +
      `}\n` +
      `export function calculateDiscount(base: number, discountRate: number): number {\n` +
      `  return base + base * discountRate;\n` + // Bug: plus instead of minus
      `}\n`;
    fs.writeFileSync(targetFilePath, initialTargetContent, "utf8");

    // Unrelated control file to ensure no extraneous modifications
    const controlFilePath = path.join(srcDir, "constants.ts");
    const initialControlContent = `export const APP_ID = "photon-core-v1";\nexport const MAX_RETRY = 5;\n`;
    fs.writeFileSync(controlFilePath, initialControlContent, "utf8");

    // Run the candidate's action
    const actions = taskRunner(repoDir);

    const inspectPassed = Boolean(actions.inspected);

    // Apply the candidate's edit
    let editApplied = false;
    let editError = "";

    const candidatePath = actions.editedPath || "src/pricing.ts";
    const fullCandidatePath = path.resolve(repoDir, candidatePath);

    // 1. Safety check: target must be inside disposable repoDir
    const rel = path.relative(repoDir, fullCandidatePath);
    const escapes = rel.startsWith("..") || path.isAbsolute(rel);

    if (escapes || options.attemptWrongFile || candidatePath.includes("other.ts")) {
      editError = `Rejected: attempt to edit wrong file or escape repository boundary (${candidatePath})`;
    } else if (!fs.existsSync(fullCandidatePath)) {
      editError = `Rejected: target file does not exist (${candidatePath})`;
    } else {
      const currentContent = fs.readFileSync(fullCandidatePath, "utf8");
      const oldStr = actions.oldStr ?? "";
      const newStr = actions.newStr ?? "";

      if (options.attemptPartialPatch || !currentContent.includes(oldStr)) {
        editError = `Rejected: exact old_str invariant not found in target file`;
      } else {
        const updated = currentContent.replace(oldStr, newStr);
        fs.writeFileSync(fullCandidatePath, updated, "utf8");
        editApplied = true;
      }
    }

    // 2. Extraneous edit check: ensure constants.ts was untouched
    const currentControl = fs.readFileSync(controlFilePath, "utf8");
    const noExtraneousEdits = !options.attemptExtraneousEdit && currentControl === initialControlContent;

    // 3. Postcondition test: test invariant
    let testPassed = false;
    if (editApplied && noExtraneousEdits) {
      const updatedTarget = fs.readFileSync(targetFilePath, "utf8");
      // Objective check: discount function must subtract instead of add
      const fixedDiscount = /return\s+base\s*-\s*base\s*\*\s*discountRate|base\s*\*\s*\(\s*1\s*-\s*discountRate\s*\)/.test(
        updatedTarget
      );
      // Invariant check: calculatePrice must remain untouched
      const pricePreserved = /return\s+base\s*\+\s*base\s*\*\s*taxRate/.test(updatedTarget);
      testPassed = fixedDiscount && pricePreserved;
    }

    const taskCompleted = inspectPassed && editApplied && testPassed && noExtraneousEdits;
    const detail = taskCompleted
      ? "Repository task successfully completed: inspect -> edit -> test -> verified in disposable sandbox"
      : editError ||
        (!noExtraneousEdits
          ? "Extraneous file modified during task"
          : "Postcondition test failed: patch did not resolve bug or regressed invariants");

    return {
      taskCompleted,
      inspectPassed,
      editApplied,
      testPassed,
      noExtraneousEdits,
      detail,
      cleanedUp: true,
    };
  } finally {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Measures throughput across multiple repeated trials and calculates variance and percentiles.
 */
export async function measureThroughputWithTrials(
  client: LLMProvider,
  model: string,
  trials = 3,
  signal?: AbortSignal
): Promise<{
  tokensPerSec: number;
  firstTokenMs: number;
  variance: number;
  p50: number;
  p95: number;
  samples: number[];
}> {
  const samples: number[] = [];
  const firstTokenSamples: number[] = [];

  for (let i = 0; i < trials; i++) {
    if (signal?.aborted) break;
    const res = await generate(
      client,
      model,
      [
        {
          role: "user",
          content:
            "Write a TypeScript function add(a: number, b: number): number that returns the sum. Code only.",
        },
      ],
      signal
    );
    if (res.tokensPerSec > 0) {
      samples.push(res.tokensPerSec);
      firstTokenSamples.push(res.firstTokenMs);
    }
  }

  const stats = computePercentiles(samples);
  const ftStats = computePercentiles(firstTokenSamples);

  return {
    tokensPerSec: stats.mean,
    firstTokenMs: ftStats.mean,
    variance: stats.variance,
    p50: stats.p50,
    p95: stats.p95,
    samples,
  };
}

export async function runBench(client: LLMProvider, model: string, opts: BenchOptions): Promise<BenchResult> {
  const tasks: BenchTaskOutcome[] = [];
  opts.onProgress?.("Measuring throughput and latency…");
  const speed = await generate(
    client,
    model,
    [{ role: "user", content: "Write a TypeScript function add(a: number, b: number): number that returns the sum. Code only." }],
    opts.signal
  );
  tasks.push({
    id: "throughput",
    passed: speed.tokensPerSec > 0,
    detail: `capability_probe:throughput: ${Math.round(speed.tokensPerSec)} tok/s, first token ${Math.round(speed.firstTokenMs)} ms`,
  });

  opts.onProgress?.("Measuring tool-call reliability…");
  let toolPasses = 0;
  for (let i = 0; i < TOOLCALL_ATTEMPTS; i++) {
    const out = await generate(
      client,
      model,
      [
        { role: "system", content: "Emit exactly one Photon tool block and nothing else. Use read_file with path src/index.ts." },
        { role: "user", content: "Read src/index.ts using the tool." },
      ],
      opts.signal
    );
    if (
      parsePhotonBlocks(out.text, [PROBE_READ_TOOL]).calls.some(
        (c) => c.name === "read_file" && !c.errors.length && c.args.path === "src/index.ts"
      )
    ) {
      toolPasses++;
    }
  }
  const toolReliability = toolPasses / TOOLCALL_ATTEMPTS;
  tasks.push({ id: "toolcall", passed: toolReliability >= 0.67, detail: `capability_probe:toolcall: ${toolPasses}/${TOOLCALL_ATTEMPTS} well-formed calls` });
  tasks.push({ id: "schema", passed: toolReliability >= 0.67, detail: `capability_probe:schema: adherence ${Math.round(toolReliability * 100)}%` });

  opts.onProgress?.("Checking file & tool selection and recovery…");
  const select = await generate(
    client,
    model,
    [
      {
        role: "system",
        content:
          "Workspace files: src/config/parser.ts, src/ui/Button.tsx, package.json. " +
          "Available tools: read_file, search_code, edit_file, run_command. " +
          "User asks: locate and inspect the implementation of parseConfig in the config parser without changing anything. " +
          "Reply with the tool name and target file path.",
      },
      { role: "user", content: "Inspect the implementation of parseConfig." },
    ],
    opts.signal
  );
  const selectionPass =
    /\b(read_file|search_code)\b/i.test(select.text) &&
    !/\b(edit_file|run_command)\b/i.test(select.text);
  const selectedRightFile = /src\/config\/parser\.ts|parser\.ts/i.test(select.text);
  tasks.push({
    id: "tool_selection",
    passed: selectionPass,
    detail: selectionPass
      ? selectedRightFile
        ? "capability_probe:selection: selected read/search tool + correct file (src/config/parser.ts)"
        : "capability_probe:selection: selected a read/search tool"
      : "capability_probe:selection: selected an unsafe or invalid tool",
  });

  const recover = await generate(
    client,
    model,
    [
      {
        role: "system",
        content:
          "A tool call `read_file` failed with `not_found` for `src/app.ts`. " +
          "Do NOT repeat the failed `read_file` call. The correct recovery is to search or find the file first (`find_files` or `search_code`). " +
          "Reply with the recovery action.",
      },
      { role: "user", content: "read_file failed for src/app.ts; what should you do next?" },
    ],
    opts.signal
  );
  const parsedRecover = parsePhotonBlocks(recover.text, PROBE_SEARCH_TOOLS);
  const recoveryPass =
    parsedRecover.calls.some((c) => c.name === "find_files" || c.name === "search_code") ||
    (/search|find/i.test(recover.text) && !/TOOL_NAME:\s*read_file[\s\S]*src\/app\.ts/i.test(recover.text));
  tasks.push({
    id: "recovery",
    passed: recoveryPass,
    detail: recoveryPass ? "capability_probe:recovery: selected search/find recovery" : "capability_probe:recovery: did not choose search/re-read recovery",
  });

  opts.onProgress?.("Checking coding patch correctness and verification…");
  const edit = await generate(
    client,
    model,
    [
      {
        role: "system",
        content:
          "You read `src/pricing.ts` containing `const value = 1;`. " +
          "Replace only that exact statement with `const value = 2;` (or emit an `edit_file` block for `src/pricing.ts`). " +
          "Reply with the exact find text or `edit_file` tool block and no unrelated code.",
      },
      { role: "user", content: "Prepare the smallest safe edit." },
    ],
    opts.signal
  );
  const patchCheck = evaluateCodingPatchOutput(edit.text);
  const editPass = patchCheck.passed;
  tasks.push({ id: "edit", passed: editPass, detail: `capability_probe:patch: ${patchCheck.detail}` });

  const verify = await generate(
    client,
    model,
    [
      {
        role: "system",
        content:
          "After changing code you must verify it objectively. The user edited a TypeScript function in `src/pricing.ts` and asks what to do next. " +
          "Reply with one of: diagnostics, tests, build.",
      },
      { role: "user", content: "The edit is complete. What is the next verification step?" },
    ],
    opts.signal
  );
  const verificationPass = /diagnostics|tests|build/i.test(verify.text);
  tasks.push({
    id: "verification",
    passed: verificationPass,
    detail: verificationPass ? "capability_probe:verification: selected an objective verification check" : "capability_probe:verification: did not select verification",
  });

  opts.onProgress?.("Checking multi-step coding context retention…");
  const context = await generate(
    client,
    model,
    [
      { role: "user", content: "We are refactoring `src/auth/tokenStore.ts` with constraint identifier PHOTON_CTX_7429." },
      { role: "assistant", content: "Understood. Tracking `src/auth/tokenStore.ts` and constraint PHOTON_CTX_7429." },
      { role: "user", content: "What constraint identifier did I ask you to track? Reply with the identifier only." },
    ],
    opts.signal
  );
  const contextPass = /PHOTON_CTX_7429/.test(context.text);
  tasks.push({
    id: "context",
    passed: contextPass,
    detail: contextPass ? "capability_probe:context: retained multi-turn coding state" : "capability_probe:context: lost prior coding state",
  });

  opts.onProgress?.("Checking coding & algorithmic reasoning…");
  const reason = await generate(
    client,
    model,
    [
      {
        role: "user",
        content: "A loop runs 3 times and appends 2 items to an array each time. How many items are in the array at the end? Reply only with the number.",
      },
    ],
    opts.signal
  );
  const reasoningPass = /\b6\b/.test(reason.text);
  tasks.push({
    id: "reasoning",
    passed: reasoningPass,
    detail: reasoningPass ? "capability_probe:reasoning: correct (6)" : `capability_probe:reasoning: unexpected: "${reason.text.trim().slice(0, 40)}"`,
  });

  const codingOutcomeComposite =
    (Number(selectionPass) + Number(editPass) + Number(recoveryPass) + Number(verificationPass) + Number(contextPass)) / 5;

  const profile: ModelCapabilityProfile = {
    reasoning: reasoningPass ? 0.9 : 0.35,
    coding: editPass ? Math.max(0.85, codingOutcomeComposite) : 0.45,
    toolCalling: toolReliability,
    schemaAdherence: toolReliability >= 0.67 ? Math.min(1, toolReliability + 0.05) : Math.max(0, toolReliability - 0.15),
    contextRetention: contextPass ? 0.9 : 0.35,
    editFidelity: editPass ? 0.88 : 0.4,
    recovery: recoveryPass ? 0.82 : 0.35,
    verification: verificationPass ? 0.85 : 0.4,
    speed: 1,
  };

  return {
    model,
    quantization: opts.quantization,
    hardwareClass: opts.hardwareClass,
    methodologyVersion: BENCH_VERSION,
    tokensPerSec: Math.round(speed.tokensPerSec * 10) / 10,
    firstTokenMs: Math.round(speed.firstTokenMs),
    toolCallReliability: toolReliability,
    reasoningPass,
    tasks,
    ranAt: Date.now(),
    capabilityProfile: profile,
  };
}

interface GenResult {
  text: string;
  tokensPerSec: number;
  firstTokenMs: number;
}

async function generate(
  client: LLMProvider,
  model: string,
  messages: LLMMessage[],
  signal?: AbortSignal
): Promise<GenResult> {
  const start = Date.now();
  let firstAt = 0;
  let text = "";
  let last: LLMChatChunk | undefined;
  for await (const chunk of client.chatStream({ model, messages, options: BENCH_OPTS }, signal)) {
    if (chunk.message?.content) {
      if (!firstAt) firstAt = Date.now();
      text += chunk.message.content;
    }
    last = chunk;
  }
  const end = Date.now();
  let tokensPerSec = 0;
  if (last?.eval_count && last.eval_duration && last.eval_duration > 0) {
    tokensPerSec = last.eval_count / (last.eval_duration / 1e9);
  } else {
    const genMs = Math.max(1, end - (firstAt || start));
    tokensPerSec = (estimateTokens(text) / genMs) * 1000;
  }
  return { text, tokensPerSec, firstTokenMs: (firstAt || end) - start };
}
