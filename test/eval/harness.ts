import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planRequest } from "../../src/core/adaptive/autoMode";
import { runUnifiedTurn, type UnifiedEmitter } from "../../src/core/agent/unifiedEngine";
import type { LLMProvider } from "../../src/core/llm/types";
import { builtinTools } from "../../src/core/tools/builtin";
import { ok, type Tool } from "../../src/core/tools/types";
import type {
  BenchResult,
  ChatMessage,
  GovernorEventKind,
  IntelligenceLevel,
  MachineProfile,
  ModelInfo,
  PromptSectionBreakdown,
  ScaffoldProfile,
  ToolProtocol,
  TurnReliabilitySummary,
} from "../../src/shared/types";
import type { EvalExecutedTool, EvalTask } from "./tasks";

export interface EvalTaskResult {
  taskId: string;
  title: string;
  model: string;
  tier: string;
  intelligence: IntelligenceLevel;
  protocol: ToolProtocol;
  mode: EvalTask["mode"];
  passed: boolean;
  steps: number;
  promptTokens: number;
  promptBudgetTokens: number;
  promptSections: PromptSectionBreakdown[];
  exampleToolsRendered: string[];
  renderedToolCount: number;
  governorCounts: Partial<Record<GovernorEventKind, number>>;
  totalIssues: number;
  detail: string;
  elapsedMs: number;
  cleanedUp: boolean;
}

export interface RunEvalTaskOptions {
  model: ModelInfo;
  machine: MachineProfile;
  providerFactory: (task: EvalTask) => LLMProvider;
  bench?: BenchResult;
  workspaceMap?: string;
  scaffoldOptimizations?: boolean;
  profileOverride?: Partial<ScaffoldProfile>;
  freezeAdaptivity?: boolean;
}

function listWorkspaceFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  const dir = rel ? path.join(root, rel) : root;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listWorkspaceFiles(root, childRel));
    } else {
      out.push(childRel);
    }
  }
  return out.sort();
}

export async function runEvalTask(task: EvalTask, opts: RunEvalTaskOptions): Promise<EvalTaskResult> {
  const start = Date.now();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), `photon-eval-${task.id}-`));
  let result: EvalTaskResult | undefined;

  try {
    for (const [relPath, content] of Object.entries(task.files)) {
      const abs = path.join(repoDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }

    const benchByModel = opts.bench ? new Map([[opts.model.name, opts.bench]]) : undefined;
    const { plan } = planRequest({
      prompt: task.prompt,
      mode: task.mode,
      models: [opts.model],
      machine: opts.machine,
      benchByModel,
      pinnedModel: opts.model.name,
      intelligence: "auto",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
      scaffoldOptimizations: opts.scaffoldOptimizations,
      freezeAdaptivity: opts.freezeAdaptivity,
    });

    if (!plan) {
      throw new Error(`planRequest failed to produce a plan for ${opts.model.name}`);
    }
    if (opts.profileOverride && plan.scaffoldProfile) {
      plan.scaffoldProfile = { ...plan.scaffoldProfile, ...opts.profileOverride };
    }

    const rawTools = builtinTools();
    const tools: Tool[] = task.webSearchStubOutput
      ? rawTools.map((t) =>
          t.spec.name === "web_search"
            ? {
                ...t,
                execute: async () => ok(task.webSearchStubOutput!),
              }
            : t
        )
      : rawTools;

    const assistantChunks: string[] = [];
    const contentChunks: string[] = [];
    const executedTools: EvalExecutedTool[] = [];
    let latestTelemetry: TurnReliabilitySummary | undefined;
    let promptTokens = 0;
    let promptBudgetTokens = 0;
    let promptSections: PromptSectionBreakdown[] = [];
    let exampleToolsRendered: string[] = [];
    let renderedToolCount = 0;

    const emitter: UnifiedEmitter = {
      onAssistantStart: () => {},
      onDelta: (_id, delta) => assistantChunks.push(delta),
      onContent: (_id, content) => contentChunks.push(content),
      onAssistantCancel: () => {},
      onPhase: () => {},
      onToolCall: () => {},
      onToolUpdate: (_id, call) => {
        if (call.status === "done" || call.status === "error") {
          executedTools.push({ name: call.name, args: call.args, ok: call.status === "done" });
        }
      },
      onUsage: (usage) => {
        if (usage.promptReport && promptTokens === 0) {
          promptTokens = usage.promptReport.totalTokens;
          promptBudgetTokens = usage.promptReport.budgetTokens ?? plan.numCtx;
          promptSections = usage.promptReport.sections;
          exampleToolsRendered = usage.promptReport.renderedExampleTools ?? [];
          renderedToolCount = usage.promptReport.renderedToolCount ?? 0;
        }
      },
      onGenerationStats: () => {},
      onTurnTelemetry: (summary) => {
        latestTelemetry = summary;
      },
      onDone: () => {},
      onError: () => {},
    };

    const session: { messages: ChatMessage[] } = {
      messages: [
        {
          id: `eval-user-${task.id}`,
          role: "user",
          content: task.prompt,
          createdAt: Date.now(),
        },
      ],
    };

    const workspaceMap =
      opts.workspaceMap !== undefined
        ? opts.workspaceMap
        : Object.keys(task.files).sort().join("\n");

    await runUnifiedTurn(session, plan, emitter, new AbortController().signal, {
      provider: opts.providerFactory(task),
      tools,
      workspaceName: "EvalSandbox",
      workspaceMap: async () => workspaceMap,
      buildToolContext: (signal) => ({
        workspaceRoot: repoDir,
        mode: task.mode,
        signal,
        log: () => {},
        webSearchProvider: task.webSearchStubOutput ? "duckduckgo" : "none",
        requestApproval: async () => true,
        findFiles: async (query, maxResults) => {
          const all = listWorkspaceFiles(repoDir);
          const q = query.replace(/^\*+|\*+$/g, "").replace(/\*\*\/?/g, "").toLowerCase();
          const matched = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
          return matched.slice(0, maxResults ?? 50);
        },
        capability: plan.intelligence,
        getDiagnostics: async () => (task.diagnosticsFn ? task.diagnosticsFn(repoDir) : []),
        todos: [],
      }),
      reserveOutputTokens: 1024,
    });

    const assistantText = (contentChunks.length ? contentChunks : assistantChunks).join("\n").trim();
    const verdict = task.verify({
      repoDir,
      assistantText,
      executedTools,
      telemetry: latestTelemetry,
    });

    const counts = latestTelemetry?.counts ?? {};
    let totalIssues = 0;
    for (const [k, v] of Object.entries(counts)) {
      if (k !== "tool_ok" && k !== "verify_ok" && typeof v === "number") {
        totalIssues += v;
      }
    }

    result = {
      taskId: task.id,
      title: task.title,
      model: opts.model.name,
      tier: opts.model.tier ?? "unknown",
      intelligence: plan.intelligence,
      protocol: plan.toolProtocol,
      mode: task.mode,
      passed: verdict.passed,
      steps: latestTelemetry?.steps ?? 0,
      promptTokens,
      promptBudgetTokens,
      promptSections,
      exampleToolsRendered,
      renderedToolCount,
      governorCounts: counts,
      totalIssues,
      detail: verdict.detail,
      elapsedMs: Date.now() - start,
      cleanedUp: false,
    };
  } finally {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
    if (result) {
      result.cleanedUp = !fs.existsSync(repoDir);
    }
  }
  return result!;
}
