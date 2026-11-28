import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelInfo, ScaffoldProfile } from "../../src/shared/types";
import { runEvalTask, type EvalTaskResult } from "./harness";
import { BASELINE_MOCK_MODELS, DEFAULT_MACHINE, createCompliantMockProvider } from "./runner";
import { EVAL_TASKS } from "./tasks";

export interface AblationVariant {
  id: string;
  label: string;
  scaffoldOptimizations?: boolean;
  profileOverride?: Partial<ScaffoldProfile>;
  freezeAdaptivity?: boolean;
}

export interface AblationTierMetrics {
  variantId: string;
  tier: string;
  model: string;
  tasksTotal: number;
  tasksPassed: number;
  passRatePct: number;
  avgPromptTokens: number;
  avgAgentToolsTokens: number;
  totalIssues: number;
  promptDeltaVsLegacyPct: number;
  toolsDeltaVsLegacyPct: number;
}

export interface AblationReport {
  generatedAt: string;
  variants: AblationVariant[];
  rows: AblationTierMetrics[];
  markdown: string;
}

export const ABLATION_VARIANTS: readonly AblationVariant[] = [
  { id: "full_phase4", label: "Full Phase 2–4 Profile (shortlist + budget clamp + phase examples + stateCard)" },
  { id: "legacy_flag_off", label: "Legacy Flag Off (Phase 1 baseline surface)", scaffoldOptimizations: false },
  { id: "toolCards_full", label: "Ablation: toolCards = full (no shortlist)", profileOverride: { toolCards: "full" } },
  { id: "stateCard_off", label: "Ablation: stateCard = off", profileOverride: { stateCard: "off" } },
  { id: "examples_none", label: "Ablation: examples = none", profileOverride: { examples: "none" } },
  { id: "adaptivity_frozen", label: "Ablation: freezeAdaptivity = true", freezeAdaptivity: true },
];

export async function runAblationSuite(options?: {
  models?: ModelInfo[];
  variants?: readonly AblationVariant[];
  writeReport?: boolean;
}): Promise<AblationReport> {
  const models = options?.models ?? BASELINE_MOCK_MODELS;
  const variants = [...(options?.variants ?? ABLATION_VARIANTS)];
  const rawByVariantAndModel = new Map<string, EvalTaskResult[]>();

  for (const variant of variants) {
    for (const model of models) {
      const list: EvalTaskResult[] = [];
      for (const task of EVAL_TASKS) {
        list.push(
          await runEvalTask(task, {
            model,
            machine: DEFAULT_MACHINE,
            providerFactory: createCompliantMockProvider,
            scaffoldOptimizations: variant.scaffoldOptimizations,
            profileOverride: variant.profileOverride,
            freezeAdaptivity: variant.freezeAdaptivity,
          })
        );
      }
      rawByVariantAndModel.set(`${variant.id}|${model.name}`, list);
    }
  }

  const rows: AblationTierMetrics[] = [];
  for (const variant of variants) {
    for (const model of models) {
      const list = rawByVariantAndModel.get(`${variant.id}|${model.name}`) ?? [];
      const legacy = rawByVariantAndModel.get(`legacy_flag_off|${model.name}`) ?? list;
      const passed = list.filter((r) => r.passed).length;
      const avgPrompt = Math.round(list.reduce((s, r) => s + r.promptTokens, 0) / Math.max(1, list.length));
      const agentList = list.filter((r) => r.mode === "agent");
      const avgAgentTools = Math.round(
        agentList.reduce((s, r) => s + (r.promptSections.find((sec) => sec.id === "tools")?.tokens ?? 0), 0) /
          Math.max(1, agentList.length)
      );
      const legacyPrompt = Math.round(legacy.reduce((s, r) => s + r.promptTokens, 0) / Math.max(1, legacy.length));
      const legacyAgent = legacy.filter((r) => r.mode === "agent");
      const legacyTools = Math.round(
        legacyAgent.reduce((s, r) => s + (r.promptSections.find((sec) => sec.id === "tools")?.tokens ?? 0), 0) /
          Math.max(1, legacyAgent.length)
      );

      rows.push({
        variantId: variant.id,
        tier: model.tier ?? "unknown",
        model: model.name,
        tasksTotal: list.length,
        tasksPassed: passed,
        passRatePct: Math.round((passed / Math.max(1, list.length)) * 1000) / 10,
        avgPromptTokens: avgPrompt,
        avgAgentToolsTokens: avgAgentTools,
        totalIssues: list.reduce((s, r) => s + r.totalIssues, 0),
        promptDeltaVsLegacyPct:
          legacyPrompt > 0 ? Math.round(((avgPrompt - legacyPrompt) / legacyPrompt) * 1000) / 10 : 0,
        toolsDeltaVsLegacyPct:
          legacyTools > 0 ? Math.round(((avgAgentTools - legacyTools) / legacyTools) * 1000) / 10 : 0,
      });
    }
  }

  const tableRows = rows
    .map(
      (r) =>
        `| \`${r.variantId}\` | ${r.tier} (\`${r.model}\`) | ${r.tasksPassed}/${r.tasksTotal} (${r.passRatePct}%) | ${r.avgPromptTokens} (${r.promptDeltaVsLegacyPct >= 0 ? "+" : ""}${r.promptDeltaVsLegacyPct}%) | ${r.avgAgentToolsTokens} (${r.toolsDeltaVsLegacyPct >= 0 ? "+" : ""}${r.toolsDeltaVsLegacyPct}%) | ${r.totalIssues} |`
    )
    .join("\n");

  const generatedAt = new Date().toISOString();
  const markdown = [
    "# Photon Adaptive Scaffolding — Phase 4 Ablation Matrix",
    "",
    `> Generated at ${generatedAt} across ${variants.length} scaffold variants × ${models.length} model tiers (${EVAL_TASKS.length} tasks each).`,
    "",
    "| Variant | Tier & Model | Pass Rate | Avg Prompt Tok (vs Legacy) | Agent `tools` Tok (vs Legacy) | Issues |",
    "|---|---|---:|---:|---:|---:|",
    tableRows,
    "",
  ].join("\n");

  if (options?.writeReport !== false) {
    fs.writeFileSync(path.join(__dirname, "ABLATION_PHASE4.md"), markdown, "utf8");
  }

  return { generatedAt, variants, rows, markdown };
}

async function main() {
  const report = await runAblationSuite({ writeReport: true });
  console.log(report.markdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[eval:ablation] failed:", err);
    process.exitCode = 1;
  });
}
