import type { AdaptivePlan, IntelligenceLevel, Mode, PromptSectionBreakdown, PromptTokenReport, ToolSpec } from "../../shared/types";
import { estimateTokens } from "../adaptive/tokens";
import {
  CORE_PROMPT_RULES,
  editFilePatchParamNames,
  selectDeduplicatedRules,
  toolRequiredSignature,
  type RuleRenderContext,
} from "./rulebook";

export interface SystemPromptInput {
  mode: Mode;
  plan: AdaptivePlan;
  toolInstructions: string;
  workspaceName: string | undefined;
  workspaceMap?: string;
  retrievedContext?: string;
  projectContextDigest?: string;
  /** Last user message for this turn — carried for tool-selection policy. */
  lastUserText?: string;
  /** The request needs current external facts: force the web-tool directive. */
  freshInfoRequest?: boolean;
  /** Active Custom Agent persona, enabled Custom Instructions, and invoked Skills. */
  customizationsPrompt?: string;
  /** Active ToolSpecs used to derive exact argument names for scaffold rules. */
  toolSpecs?: readonly ToolSpec[];
  /** Optional metadata from renderToolInstructionsWithMeta for Phase 0 observability. */
  toolMeta?: { exampleToolNames?: string[]; toolCount?: number };
}

/**
 * Budget fraction of numCtx reserved for the system prompt + workspace map + RAG.
 * Higher scaffolding levels (`max` / `high`) allocate a generous share so smaller
 * local models receive full behavioral instructions, worked tool examples, and
 * result-framing rules without getting truncated.
 */
const BUDGET_FRACTION: Record<IntelligenceLevel, number> = { low: 0.2, medium: 0.26, high: 0.34, max: 0.42 };
const MAP_LINES: Record<IntelligenceLevel, number> = { low: 30, medium: 60, high: 90, max: 120 };

export function buildSystemPrompt(input: SystemPromptInput): string {
  return buildSystemPromptWithReport(input).text;
}

export function buildSystemPromptWithReport(input: SystemPromptInput): { text: string; report: PromptTokenReport } {
  const { mode, plan, toolInstructions, workspaceName, workspaceMap, retrievedContext, projectContextDigest } = input;
  const level = plan.intelligence;
  const coreChunks: { id: string; text: string }[] = [];
  const sections: PromptSectionBreakdown[] = [];

  const idText = identity(level);
  const wsLine = workspaceName ? `Workspace: ${workspaceName}.` : "";
  const idBlock = wsLine ? `${idText}\n\n${wsLine}` : idText;
  coreChunks.push({ id: "identity", text: idBlock });
  sections.push({
    id: "identity",
    label: "Identity & Workspace",
    tokens: estimateTokens(idBlock),
    status: "kept",
  });

  const { oldParam, newParam } = editFilePatchParamNames(input.toolSpecs);
  const appendSignature = toolRequiredSignature("append_file", input.toolSpecs);
  const ruleCtx: RuleRenderContext = {
    mode,
    level,
    protocol: plan.toolProtocol,
    hasToolInstructions: Boolean(toolInstructions),
    freshInfoRequest: Boolean(input.freshInfoRequest),
    oldParam,
    newParam,
    appendSignature,
  };
  const { kept } = selectDeduplicatedRules(CORE_PROMPT_RULES, ruleCtx);
  const renderedBySection = new Map<string, string>();
  for (const rule of kept) {
    const chunk = rule.render(ruleCtx);
    if (!chunk) continue;
    const prev = renderedBySection.get(rule.section);
    renderedBySection.set(rule.section, prev ? `${prev}\n\n${chunk}` : chunk);
  }

  const freshText = renderedBySection.get("fresh_info");
  if (freshText) {
    coreChunks.push({ id: "fresh_info", text: freshText });
    sections.push({ id: "fresh_info", label: "Live Info Directive", tokens: estimateTokens(freshText), status: "kept" });
  }

  const modeText = renderedBySection.get("mode");
  if (modeText) {
    coreChunks.push({ id: "mode", text: modeText });
    sections.push({ id: "mode", label: "Mode Rules", tokens: estimateTokens(modeText), status: "kept" });
  }

  if (toolInstructions) {
    coreChunks.push({ id: "tools", text: toolInstructions });
    sections.push({ id: "tools", label: "Tool Instructions", tokens: estimateTokens(toolInstructions), status: "kept" });
  } else {
    const nativeText = renderedBySection.get("tools");
    if (nativeText) {
      coreChunks.push({ id: "tools", text: nativeText });
      sections.push({ id: "tools", label: "Native Tool Coaching", tokens: estimateTokens(nativeText), status: "kept" });
    }
  }

  const framingText = renderedBySection.get("result_framing") ?? "";
  if (framingText) {
    coreChunks.push({ id: "result_framing", text: framingText });
    sections.push({ id: "result_framing", label: "Result Framing", tokens: estimateTokens(framingText), status: "kept" });
  } else {
    sections.push({ id: "result_framing", label: "Result Framing", tokens: 0, status: "dropped" });
  }

  const wfText = renderedBySection.get("workflow");
  if (wfText) {
    coreChunks.push({ id: "workflow", text: wfText });
    sections.push({ id: "workflow", label: "Engineering Workflow", tokens: estimateTokens(wfText), status: "kept" });
  }

  const fmtText = renderedBySection.get("formatting");
  if (fmtText) {
    coreChunks.push({ id: "formatting", text: fmtText });
    sections.push({ id: "formatting", label: "Formatting & Language", tokens: estimateTokens(fmtText), status: "kept" });
  }

  const useClampedProfile = Boolean(plan.scaffoldProfile && plan.scaffoldOptimizations !== false);
  let budgetTokens: number;
  if (useClampedProfile && plan.scaffoldProfile) {
    const pb = plan.scaffoldProfile.promptBudget;
    const hardMax = Math.max(512, Math.floor(plan.numCtx * 0.55));
    const rawBudget = Math.floor(plan.numCtx * pb.frac);
    budgetTokens = Math.max(512, Math.min(hardMax, Math.max(pb.minTokens, Math.min(pb.maxTokens, rawBudget))));
  } else {
    budgetTokens = Math.max(512, Math.floor(plan.numCtx * BUDGET_FRACTION[level]));
  }

  const coreUsedTokens = () =>
    estimateTokens(coreChunks.filter((c) => c.text).map((c) => c.text).join("\n\n"));

  const hasExtrasInput = Boolean(
    input.customizationsPrompt ||
      projectContextDigest ||
      (workspaceMap && mode !== "chat") ||
      retrievedContext
  );
  const extrasFloor =
    useClampedProfile && hasExtrasInput && plan.numCtx >= 4096
      ? Math.min(520, Math.floor(budgetTokens * 0.22))
      : 0;
  const coreCeiling = Math.max(450, budgetTokens - extrasFloor);

  // Priority-trim lower-priority non-essential core sections (workflow -> result_framing)
  // while NEVER dropping identity, mode boundary, fresh_info, tools, or formatting (Language Integrity).
  if (useClampedProfile && coreUsedTokens() > coreCeiling) {
    const wfChunk = coreChunks.find((c) => c.id === "workflow");
    const wfSec = sections.find((s) => s.id === "workflow");
    if (wfChunk && wfChunk.text && wfSec) {
      const compactWf =
        `## Structured Engineering Workflow\n1. Inspect (\`find_files\`/\`search_code\`/\`read_file\`) before editing.\n2. Edit with \`${oldParam}\`/\`${newParam}\` (or \`${appendSignature}\`), then verify with \`get_diagnostics\`.`;
      if (estimateTokens(compactWf) < estimateTokens(wfChunk.text)) {
        wfChunk.text = compactWf;
        wfSec.tokens = estimateTokens(compactWf);
        wfSec.status = "trimmed";
      }
      if (coreUsedTokens() > coreCeiling) {
        wfChunk.text = "";
        wfSec.tokens = 0;
        wfSec.status = "dropped";
      }
    }

    if (coreUsedTokens() > coreCeiling) {
      const frChunk = coreChunks.find((c) => c.id === "result_framing");
      const frSec = sections.find((s) => s.id === "result_framing");
      if (frChunk && frChunk.text && frSec) {
        const compactFr =
          "Synthesize tool outputs concisely in Markdown; do not repeat identical failing calls.";
        if (estimateTokens(compactFr) < estimateTokens(frChunk.text)) {
          frChunk.text = compactFr;
          frSec.tokens = estimateTokens(compactFr);
          frSec.status = "trimmed";
        }
        if (coreUsedTokens() > coreCeiling) {
          frChunk.text = "";
          frSec.tokens = 0;
          frSec.status = "dropped";
        }
      }
    }
  }

  const core = coreChunks.filter((c) => c.text).map((c) => c.text);
  let used = estimateTokens(core.join("\n\n"));
  const extras: string[] = [];
  if (input.customizationsPrompt) {
    const customBudget = useClampedProfile
      ? Math.max(120, Math.floor((budgetTokens - used) * 0.35))
      : Math.max(160, Math.floor((budgetTokens - used) * 0.45));
    const trimmedCustom = fitBlock(input.customizationsPrompt, customBudget);
    if (trimmedCustom) {
      extras.push(trimmedCustom);
      used += estimateTokens(trimmedCustom);
      sections.push({
        id: "customizations",
        label: "Customizations",
        tokens: estimateTokens(trimmedCustom),
        status: trimmedCustom !== input.customizationsPrompt ? "trimmed" : "kept",
      });
    } else {
      sections.push({ id: "customizations", label: "Customizations", tokens: 0, status: "dropped" });
    }
  }
  if (projectContextDigest) {
    const digestReserve = workspaceMap && mode !== "chat" ? 180 : 0;
    const digestCap = useClampedProfile
      ? Math.max(180, Math.min(budgetTokens - used - digestReserve, Math.floor((budgetTokens - used) * 0.6)))
      : Math.max(220, Math.floor((budgetTokens - used) * 0.65));
    const trimmedDigest = fitBlock(projectContextDigest, digestCap);
    if (trimmedDigest) {
      extras.push(trimmedDigest);
      used += estimateTokens(trimmedDigest);
      sections.push({
        id: "project_digest",
        label: "Project Digest",
        tokens: estimateTokens(trimmedDigest),
        status: trimmedDigest !== projectContextDigest ? "trimmed" : "kept",
      });
    } else {
      sections.push({ id: "project_digest", label: "Project Digest", tokens: 0, status: "dropped" });
    }
  }
  if (workspaceMap && mode !== "chat") {
    const capped = capLines(workspaceMap, MAP_LINES[level]);
    const mapBlock = `Project files (partial):\n${capped}`;
    const t = estimateTokens(mapBlock);
    const mapBudget = useClampedProfile
      ? Math.max(0, retrievedContext ? Math.floor((budgetTokens - used) * 0.6) : budgetTokens - used - 16)
      : budgetTokens - used;
    if (used + t <= budgetTokens && (!useClampedProfile || t <= mapBudget)) {
      extras.push(mapBlock);
      used += t;
      sections.push({
        id: "workspace_map",
        label: "Workspace Map",
        tokens: t,
        status: capped !== workspaceMap ? "trimmed" : "kept",
      });
    } else if (useClampedProfile && mapBudget >= 48) {
      const fittedMap = fitBlock(mapBlock, mapBudget);
      if (fittedMap) {
        extras.push(fittedMap);
        used += estimateTokens(fittedMap);
        sections.push({
          id: "workspace_map",
          label: "Workspace Map",
          tokens: estimateTokens(fittedMap),
          status: "trimmed",
        });
      } else {
        sections.push({ id: "workspace_map", label: "Workspace Map", tokens: 0, status: "dropped" });
      }
    } else {
      sections.push({ id: "workspace_map", label: "Workspace Map", tokens: 0, status: "dropped" });
    }
  }
  if (retrievedContext) {
    const trimmed = fitBlock(retrievedContext, budgetTokens - used - 8);
    if (trimmed) {
      const ragBlock = "Relevant code from the workspace (retrieved for this request; read files to confirm before editing):\n" + trimmed;
      extras.push(ragBlock);
      sections.push({
        id: "retrieved_rag",
        label: "Retrieved RAG",
        tokens: estimateTokens(ragBlock),
        status: trimmed !== retrievedContext ? "trimmed" : "kept",
      });
    } else {
      sections.push({ id: "retrieved_rag", label: "Retrieved RAG", tokens: 0, status: "dropped" });
    }
  }
  const text = [...core, ...extras].join("\n\n");
  return {
    text,
    report: {
      totalTokens: estimateTokens(text),
      budgetTokens,
      sections,
      ...(input.toolMeta?.exampleToolNames ? { renderedExampleTools: input.toolMeta.exampleToolNames } : {}),
      ...(input.toolMeta?.toolCount !== undefined ? { renderedToolCount: input.toolMeta.toolCount } : {}),
    },
  };
}

function capLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : lines.slice(0, max).join("\n") + "\n…";
}

function fitBlock(text: string, maxTokens: number): string | null {
  if (maxTokens < 40) return null;
  if (estimateTokens(text) <= maxTokens) return text;
  const chars = Math.max(200, maxTokens * 4);
  const cut = text.slice(0, chars);
  const lastNl = cut.lastIndexOf("\n");
  return (lastNl > 100 ? cut.slice(0, lastNl) : cut) + "\n… (truncated)";
}

function identity(level: IntelligenceLevel): string {
  if (level === "max") {
    return "You are Photon, an expert AI software engineer inside VS Code. Follow the structured cognitive workflow below: never guess file contents or live facts, call tools directly, and synthesize accurate answers from tool outputs.";
  }
  if (level === "high") {
    return "You are Photon, an expert coding and information assistant inside VS Code. Reason carefully, inspect via tools before claiming facts, verify edits, and reply concisely.";
  }
  return "You are Photon, a precise, practical coding and information assistant inside VS Code.";
}
