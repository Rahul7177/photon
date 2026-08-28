import type { AdaptivePlan, IntelligenceSetting, MachineProfile, ModelInfo, Mode } from "../../shared/types";
import { buildPlan } from "../../core/adaptive/orchestrator";
import { planRequest } from "../../core/adaptive/autoMode";
import type { BenchResult } from "../../shared/types";
import * as vscode from "vscode";

/**
 * Intelligence plugin — harness parity: registers on agent/pre-step.
 * Keeps your moat (orchestrator, autoMode, bench) intact but moves it from
 * PhotonController.onPrompt inline to a waterfall listener.
 */
export function createIntelligencePlugin(opts: {
  getModels: () => ModelInfo[];
  getMachine: () => MachineProfile | null;
  getBench: () => Map<string, BenchResult>;
  getAutoSelect: () => boolean;
  getSelectedModel: () => string;
  getMode: () => Mode;
  reserveOutputTokens: number;
  adaptiveEnabled: () => boolean;
  effectiveIntelligence: () => IntelligenceSetting;
  effectiveNumCtx: () => number | undefined;
}) {
  return {
    apply(loop: { onPreStep: (fn: any) => void }) {
      loop.onPreStep(async (decision: any, next: () => Promise<any>) => {
        if (decision.kind !== "enter") return next();
        const prompt = decision.messages.map((m: any)=>m.content).join("\n");
        const cfg = vscode.workspace.getConfiguration("photon");
        const { decision: autoDecision, plan } = planRequest({
          prompt,
          mode: opts.getMode(),
          attachmentCount: decision.messages.reduce((n:number,m:any)=>n+(m.attachments?.length??0),0),
          models: opts.getModels(),
          machine: opts.getMachine(),
          benchByModel: opts.getBench(),
          pinnedModel: opts.getAutoSelect() ? undefined : opts.getSelectedModel() || undefined,
          intelligence: opts.effectiveIntelligence(),
          reserveOutputTokens: opts.reserveOutputTokens,
          adaptiveEnabled: opts.adaptiveEnabled(),
          userNumCtx: opts.effectiveNumCtx(),
        });
        if (!plan) return { kind: "reject", reason: "No usable model/plan" };
        // attach decision for transparency
        (decision as any).autoDecision = autoDecision;
        (decision as any).plan = plan;
        return decision;
      });
    }
  };
}
