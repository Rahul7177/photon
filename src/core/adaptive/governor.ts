import type {
  GovernorEventKind,
  GovernorEventRecord,
  GovernorTimelineEntry,
  GovernorTimelineType,
  IntelligenceLevel,
  Mode,
  TaskAnalysis,
  ToolProtocol,
  TurnReliabilitySummary,
} from "../../shared/types";

export interface GovernorAction {
  type: "escalate" | "deescalate";
  fromRung: number;
  toRung: number;
  reason: string;
  /** What the engine must do in response to this transition. */
  effect?: "failing_example" | "state_card" | "protocol_downgrade" | "host_takeover";
}

export interface GovernorInit {
  model: string;
  mode: Mode;
  protocol: ToolProtocol;
  intelligence: IntelligenceLevel;
  task?: TaskAnalysis;
  initialRung?: number;
  maxEvents?: number;
  /**
   * When true the governor changes rungs and requests actions. When false
   * (default; also used for cloud turns, legacy plans and the user's
   * "freeze adaptivity" switch) it only counts and logs events.
   */
  adaptive?: boolean;
  /** Allow rung 3 (native -> photon-block). Only meaningful for local native turns. */
  allowProtocolDowngrade?: boolean;
}

const ISSUE_KINDS: readonly GovernorEventKind[] = [
  "parse_fail",
  "invalid_args",
  "repair",
  "narration",
  "duplicate",
  "truncation",
  "empty",
  "mode_violation",
  "tool_error",
  "diag_regression",
  "stream_retry",
  "context_overflow",
];

/**
 * Model-side scaffold failures that move the rung. `tool_error` is excluded on
 * purpose: a failing test run or a diagnostics report with errors is a task
 * outcome, not evidence that the scaffold is failing the model.
 */
const RUNG_FAILURE_KINDS: ReadonlySet<GovernorEventKind> = new Set([
  "parse_fail",
  "invalid_args",
  "narration",
  "truncation",
  "empty",
]);

const FAILURE_WINDOW_RUNG2 = 4;
const FAILURE_WINDOW_RUNG4 = 6;
const FAILURES_FOR_RUNG2 = 2;
const FAILURES_FOR_RUNG4 = 3;
const NATIVE_FAILURES_FOR_DOWNGRADE = 2;
const CLEAN_CALLS_TO_LEAVE_RUNG1 = 3;
const CLEAN_STEPS_TO_LEAVE_RUNG2 = 4;

/**
 * Reliability Governor (Phase 3).
 *
 * Rungs (see docs/ADAPTIVE_SCAFFOLDING_PLAN_V3.md §3.5):
 *  0 profile as derived
 *  1 failing-tool example + recovery card        (up: 1 parse_fail/invalid_args; down: 3 clean calls)
 *  2 working-memory state card + cooler tool temp (up: 2 failure steps in 4, or a diagnostics regression; down: 4 clean steps)
 *  3 native -> photon-block protocol downgrade    (up: 2 native parse failures;    sticky for the turn)
 *  4 host takes over: host diagnostics + force a text conclusion
 *                                                 (up: 3 failure steps in 6; sticky)
 *
 * Hysteresis: escalation is only evaluated on failures and de-escalation only
 * on successes, and each de-escalation resets the evidence counters so every
 * rung must be earned back separately. Rungs 3 and 4 never relax inside a turn.
 */
export class ReliabilityGovernor {
  private readonly counts: Partial<Record<GovernorEventKind, number>> = {};
  private readonly events: GovernorEventRecord[] = [];
  private readonly timelineEntries: GovernorTimelineEntry[] = [];
  private readonly maxEvents: number;
  private readonly initialRungValue: number;
  private currentRung: number;
  private peak: number;
  private protocol: ToolProtocol;
  private lastStep = 0;

  private failureSteps: number[] = [];
  private nativeFailures = 0;
  private cleanCalls = 0;
  private cleanSteps = new Set<number>();
  private downgraded = false;
  private pendingDowngrade = false;
  private tookOver = false;
  private pendingTakeover = false;

  constructor(private readonly init: GovernorInit) {
    this.currentRung = init.initialRung ?? 0;
    this.initialRungValue = this.currentRung;
    this.peak = this.currentRung;
    this.protocol = init.protocol;
    this.maxEvents = init.maxEvents ?? 100;
  }

  isAdaptive(): boolean {
    return this.init.adaptive === true;
  }

  record(
    kind: GovernorEventKind,
    meta?: { step?: number; tool?: string; detail?: string; at?: number }
  ): GovernorAction[] {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    const step = meta?.step ?? this.lastStep;
    this.lastStep = Math.max(this.lastStep, step);
    if (this.events.length < this.maxEvents) {
      this.events.push({
        kind,
        step,
        ...(meta?.tool ? { tool: meta.tool } : {}),
        ...(meta?.detail ? { detail: meta.detail.slice(0, 160) } : {}),
        at: meta?.at ?? Date.now(),
      });
    }
    if (!this.isAdaptive()) return [];

    if (RUNG_FAILURE_KINDS.has(kind)) {
      if (!this.failureSteps.includes(step)) this.failureSteps.push(step);
      this.cleanCalls = 0;
      this.cleanSteps.clear();
      if (this.protocol === "native" && (kind === "parse_fail" || kind === "invalid_args")) {
        this.nativeFailures++;
      }
      return this.escalate(kind, step);
    }
    if (kind === "diag_regression") {
      this.cleanCalls = 0;
      this.cleanSteps.clear();
      return this.escalate(kind, step);
    }
    if (kind === "tool_ok" || kind === "verify_ok") {
      this.cleanCalls++;
      this.cleanSteps.add(step);
      return this.relax(step);
    }
    return [];
  }

  private failuresWithin(step: number, window: number): number {
    return this.failureSteps.filter((s) => s > step - window && s <= step).length;
  }

  private escalate(kind: GovernorEventKind, step: number): GovernorAction[] {
    let target = this.currentRung;
    let reason = "";
    let effect: GovernorAction["effect"];

    if ((kind === "parse_fail" || kind === "invalid_args") && target < 1) {
      target = 1;
      reason = `${kind} → add the failing tool's card and worked example`;
      effect = "failing_example";
    }
    const recent2 = this.failuresWithin(step, FAILURE_WINDOW_RUNG2);
    if (recent2 >= FAILURES_FOR_RUNG2 && target < 2) {
      target = 2;
      reason = `${recent2} failures in the last ${FAILURE_WINDOW_RUNG2} steps → add working-memory card and cool tool turns`;
      effect = "state_card";
    }
    if (
      this.init.allowProtocolDowngrade &&
      this.protocol === "native" &&
      !this.downgraded &&
      this.nativeFailures >= NATIVE_FAILURES_FOR_DOWNGRADE &&
      target < 3
    ) {
      target = 3;
      reason = `${this.nativeFailures} native tool-call failures → fall back to the Photon block protocol`;
      effect = "protocol_downgrade";
      this.downgraded = true;
      this.pendingDowngrade = true;
    }
    const recent6 = this.failuresWithin(step, FAILURE_WINDOW_RUNG4);
    // A diagnostics regression is handled by the host (verify + auto-revert + N→M message), so it only
    // raises the model to rung 2 (working-memory card, cooler tool turns); it must not end the turn.
    if (kind === "diag_regression" && target < 2) {
      target = 2;
      reason = "diagnostics regressed after an edit → add working-memory card and cool tool turns";
      effect = "state_card";
    }
    if (recent6 >= FAILURES_FOR_RUNG4 && target < 4 && !this.tookOver) {
      target = 4;
      reason = `${recent6} failures in the last ${FAILURE_WINDOW_RUNG4} steps → host takes over and forces a conclusion`;
      effect = "host_takeover";
      this.tookOver = true;
      this.pendingTakeover = true;
    }
    if (target === this.currentRung) return [];
    return [this.shift(target, step, reason, effect)];
  }

  private relax(step: number): GovernorAction[] {
    if (this.currentRung === 1 && this.cleanCalls >= CLEAN_CALLS_TO_LEAVE_RUNG1) {
      this.cleanCalls = 0;
      this.cleanSteps.clear();
      return [this.shift(0, step, `${CLEAN_CALLS_TO_LEAVE_RUNG1} clean tool calls → back to the derived profile`)];
    }
    if (this.currentRung === 2 && this.cleanSteps.size >= CLEAN_STEPS_TO_LEAVE_RUNG2) {
      this.cleanCalls = 0;
      this.cleanSteps.clear();
      return [this.shift(1, step, `${CLEAN_STEPS_TO_LEAVE_RUNG2} clean steps → drop the working-memory card`)];
    }
    return [];
  }

  private shift(to: number, step: number, reason: string, effect?: GovernorAction["effect"]): GovernorAction {
    const from = this.currentRung;
    this.currentRung = to;
    this.peak = Math.max(this.peak, to);
    const type: GovernorAction["type"] = to > from ? "escalate" : "deescalate";
    this.timelineEntries.push({ step, type, fromRung: from, toRung: to, reason, at: Date.now() });
    return { type, fromRung: from, toRung: to, reason, ...(effect ? { effect } : {}) };
  }

  /** Engine-driven timeline annotation (protocol switch, host verify, auto-revert, forced conclusion). */
  note(type: GovernorTimelineType, step: number, reason: string): void {
    this.timelineEntries.push({
      step,
      type,
      fromRung: this.currentRung,
      toRung: this.currentRung,
      reason,
      at: Date.now(),
    });
  }

  /** Engine confirms the downgrade took effect so later events are attributed to the new protocol. */
  setProtocol(protocol: ToolProtocol): void {
    this.protocol = protocol;
  }

  /** True exactly once after rung 3 is reached. */
  consumeProtocolDowngrade(): boolean {
    const v = this.pendingDowngrade;
    this.pendingDowngrade = false;
    return v;
  }

  /** True exactly once after rung 4 is reached. */
  consumeTakeover(): boolean {
    const v = this.pendingTakeover;
    this.pendingTakeover = false;
    return v;
  }

  rung(): number {
    return this.currentRung;
  }

  peakRung(): number {
    return this.peak;
  }

  protocolDowngraded(): boolean {
    return this.downgraded;
  }

  timeline(): GovernorTimelineEntry[] {
    return [...this.timelineEntries];
  }

  count(kind: GovernorEventKind): number {
    return this.counts[kind] ?? 0;
  }

  totalIssues(): number {
    let total = 0;
    for (const k of ISSUE_KINDS) {
      total += this.counts[k] ?? 0;
    }
    return total;
  }

  summary(steps = 0, extras?: { autoReverted?: string[] }): TurnReliabilitySummary {
    return {
      model: this.init.model,
      mode: this.init.mode,
      protocol: this.protocol,
      intelligence: this.init.intelligence,
      rung: this.currentRung,
      peakRung: this.peak,
      initialRung: this.initialRungValue,
      steps,
      counts: { ...this.counts },
      events: [...this.events],
      timeline: [...this.timelineEntries],
      adaptive: this.isAdaptive(),
      ...(this.downgraded ? { protocolDowngraded: true } : {}),
      ...(extras?.autoReverted?.length ? { autoReverted: [...extras.autoReverted] } : {}),
      ...(this.init.task?.scope ? { taskScope: this.init.task.scope } : {}),
      ...(this.init.task?.reasoning ? { taskReasoning: this.init.task.reasoning } : {}),
      completedAt: Date.now(),
    };
  }

  formatLogLine(steps = 0): string {
    const entries = Object.entries(this.counts)
      .filter(([, v]) => typeof v === "number" && v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const peak = this.peak !== this.currentRung ? ` peak=${this.peak}` : "";
    const mode = this.isAdaptive() ? "" : " adaptive=off";
    return `[governor] model=${this.init.model} mode=${this.init.mode} protocol=${this.protocol} level=${this.init.intelligence} rung=${this.currentRung}${peak}${mode} steps=${steps} events=${entries || "clean"}`;
  }
}

/** Count `ERROR ...` lines emitted by `get_diagnostics`. */
export function countDiagnosticErrors(toolOutput: string): number {
  if (!toolOutput) return 0;
  return (toolOutput.match(/^ERROR\s/gm) ?? []).length;
}
