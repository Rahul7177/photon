import * as fs from "node:fs";
import * as path from "node:path";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import { OllamaClient } from "../../src/core/ollama/client";
import { OllamaProvider } from "../../src/core/llm/providers/ollamaProvider";
import type { MachineProfile, ModelInfo } from "../../src/shared/types";
import { runEvalTask, type EvalTaskResult } from "./harness";
import { EVAL_TASKS, type EvalTask } from "./tasks";

export const DEFAULT_MACHINE: MachineProfile = {
  totalRamBytes: 16 * 1024 ** 3,
  freeRamBytes: 10 * 1024 ** 3,
  cpuCores: 8,
  cpuModel: "Laptop 8-core",
  platform: "win32",
  arch: "x64",
  gpu: {
    name: "Laptop 6GB GPU",
    vramBytes: 6 * 1024 ** 3,
    vendor: "nvidia",
  },
  tier: "mid",
};

export const BASELINE_MOCK_MODELS: ModelInfo[] = [
  {
    name: "qwen2.5-coder:3b",
    provider: "ollama",
    paramsB: 3.1,
    tier: "tiny",
    contextLength: 32768,
    sizeBytes: 2.0 * 1024 ** 3,
    toolTrained: true,
  },
  {
    name: "qwen2.5-coder:7b",
    provider: "ollama",
    paramsB: 7.6,
    tier: "small",
    contextLength: 32768,
    sizeBytes: 4.7 * 1024 ** 3,
    toolTrained: true,
  },
  {
    name: "qwen2.5-coder:14b",
    provider: "ollama",
    paramsB: 14.8,
    tier: "medium",
    contextLength: 32768,
    sizeBytes: 9.0 * 1024 ** 3,
    toolTrained: true,
  },
];

export function createCompliantMockProvider(task: EvalTask): LLMProvider {
  let stepIdx = 0;
  return {
    id: "mock-eval",
    label: "Mock Eval Provider",
    enabled: true,
    isConfigured: () => true,
    ping: async () => true,
    listModels: async () => [],
    async *chatStream(_req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
      const chunks = task.compliantResponses[stepIdx++] ?? [{ message: { content: "Done." } }, { done: true }];
      for (const c of chunks) yield c;
    },
  };
}

function summarizeSections(results: EvalTaskResult[]): string {
  const byMode = new Map<string, EvalTaskResult[]>();
  for (const r of results) {
    const key = `${r.model} (${r.tier}/${r.intelligence}) | ${r.mode}`;
    const arr = byMode.get(key) ?? [];
    arr.push(r);
    byMode.set(key, arr);
  }
  const lines: string[] = [
    "| Model & Scaffold | Mode | Tasks Passed | Avg Prompt Tok | Tools Section Tok | Examples Rendered (first task) | Issues |",
    "|---|---|---:|---:|---:|---|---:|",
  ];
  for (const [key, list] of byMode.entries()) {
    const [modelPart, modePart] = key.split(" | ");
    const passed = list.filter((r) => r.passed).length;
    const avgPrompt = Math.round(list.reduce((s, r) => s + r.promptTokens, 0) / list.length);
    const avgTools = Math.round(
      list.reduce((s, r) => s + (r.promptSections.find((sec) => sec.id === "tools")?.tokens ?? 0), 0) / list.length
    );
    const examples = list[0].exampleToolsRendered.join(", ") || "(native / none)";
    const issues = list.reduce((s, r) => s + r.totalIssues, 0);
    lines.push(
      `| ${modelPart} | ${modePart} | ${passed}/${list.length} | ${avgPrompt} | ${avgTools} | ${examples} | ${issues} |`
    );
  }
  return lines.join("\n");
}

function buildBaselineMarkdown(results: EvalTaskResult[], liveMode: boolean, phaseLabel = "Phase 1 Eval"): string {
  const passedCount = results.filter((r) => r.passed).length;
  const agentSample = results.find((r) => r.mode === "agent" && r.intelligence === "max");
  const sectionRows = agentSample
    ? agentSample.promptSections
        .map((s) => `| \`${s.id}\` | ${s.label} | ${s.tokens} | ${s.status} |`)
        .join("\n")
    : "";

  const perTaskRows = results
    .map(
      (r) =>
        `| ${r.taskId} | ${r.model} | ${r.mode} | ${r.intelligence} | ${r.protocol} | ${r.passed ? "PASS" : "FAIL"} | ${r.steps} | ${r.promptTokens} | ${r.totalIssues} | ${r.detail} |`
    )
    .join("\n");

  return [
    `# Photon Adaptive Scaffolding — ${phaseLabel} (${liveMode ? "Live Ollama" : "Deterministic Harness"})`,
    "",
    `> Generated at ${new Date().toISOString()} against \`EVAL_TASKS\` (${EVAL_TASKS.length} tasks).`,
    `> Overall pass count: **${passedCount}/${results.length}** (${Math.round((passedCount / Math.max(1, results.length)) * 100)}%).`,
    "",
    "## Summary by Model & Mode",
    "",
    summarizeSections(results),
    "",
    "## Representative `max` Agent Prompt Breakdown (First Agent Task)",
    "",
    ...(agentSample
      ? [
          `- Model: \`${agentSample.model}\` · Total prompt: **${agentSample.promptTokens}** tok (budget: ${agentSample.promptBudgetTokens} tok) · Tools rendered: ${agentSample.renderedToolCount}`,
          `- Worked examples rendered: \`${agentSample.exampleToolsRendered.join("`, `") || "none"}\``,
          "",
          "| Section ID | Label | Tokens | Status |",
          "|---|---|---:|---|",
          sectionRows,
          "",
        ]
      : ["No agent sample captured.", ""]),
    "## Full Task Matrix",
    "",
    "| Task ID | Model | Mode | Level | Protocol | Result | Steps | Prompt Tok | Issues | Detail |",
    "|---|---|---|---|---|---|---:|---:|---:|---|",
    perTaskRows,
    "",
  ].join("\n");
}

export async function runBaselineEval(options?: {
  live?: boolean;
  modelNames?: string[];
  writeReport?: boolean;
  writePhase0?: boolean;
}): Promise<EvalTaskResult[]> {
  const live = Boolean(options?.live);
  let modelsToRun: ModelInfo[] = BASELINE_MOCK_MODELS;
  let providerFactory: (task: EvalTask) => LLMProvider = createCompliantMockProvider;

  if (live) {
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const client = new OllamaClient({ baseUrl, timeoutMs: 120_000, connectTimeoutMs: 120_000 });
    const ollama = new OllamaProvider(client);
    const reachable = await ollama.ping();
    if (!reachable) {
      throw new Error(`Ollama daemon not reachable at ${baseUrl} for --live eval.`);
    }
    const available = await ollama.listModels();
    const requested = options?.modelNames?.length ? options.modelNames : [];
    modelsToRun = requested.length
      ? available.filter((m) => requested.includes(m.name))
      : available.slice(0, 2);
    if (!modelsToRun.length) {
      throw new Error(`No matching live Ollama models found. Available: ${available.map((m) => m.name).join(", ")}`);
    }
    providerFactory = () => ollama;
  }

  const results: EvalTaskResult[] = [];
  for (const model of modelsToRun) {
    for (const task of EVAL_TASKS) {
      results.push(
        await runEvalTask(task, {
          model,
          machine: DEFAULT_MACHINE,
          providerFactory,
        })
      );
    }
  }

  const writePhase0 = Boolean(options?.writePhase0);
  const phaseLabel = writePhase0 ? "Phase 0 Baseline" : "Phase 4 Eval";
  const md = buildBaselineMarkdown(results, live, phaseLabel);
  if (options?.writeReport !== false) {
    const outName = writePhase0
      ? (live ? "BASELINE_PHASE0_LIVE.md" : "BASELINE_PHASE0.md")
      : (live ? "EVAL_PHASE4_LIVE.md" : "EVAL_PHASE4.md");
    const outPath = path.join(__dirname, outName);
    fs.writeFileSync(outPath, md, "utf8");
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const writePhase0 = args.includes("--write-phase0");
  const modelsArgIdx = args.indexOf("--models");
  const modelNames =
    modelsArgIdx >= 0 && args[modelsArgIdx + 1]
      ? args[modelsArgIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  const results = await runBaselineEval({ live, modelNames, writeReport: true, writePhase0 });
  console.log(summarizeSections(results));
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nPhase 0 baseline eval finished: ${passed}/${results.length} passed.`);
  if (!live && passed !== results.length) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[eval:baseline] failed:", err);
    process.exitCode = 1;
  });
}
