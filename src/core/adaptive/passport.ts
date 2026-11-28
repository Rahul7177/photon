import type { ModelCapabilityProfile, TurnReliabilitySummary } from "../../shared/types";

/**
 * Capability Passport (light version, Phase 3.4).
 *
 * A small on-device record per (model, quantization, runtime) of how reliably
 * the model has driven Photon's tool protocol in real turns. It is blended into
 * the capability estimate by shrinkage (weight = evidence / (evidence + K)) so a
 * single bad turn barely moves the numbers, while consistent behaviour across
 * sessions does. Pure data + math: persistence lives in the host.
 */
export interface PassportEntry {
  key: string;
  model: string;
  quantization?: string;
  runtime?: string;
  /** Capped evidence units (tool calls seen, at most 5 per turn). */
  evidence: number;
  turns: number;
  /** EWMA of valid tool calls / (valid + malformed). 0..1 */
  toolValid: number;
  /** EWMA of repairs per tool call. */
  repairRate: number;
  /** EWMA of narration events per step. */
  narrationRate: number;
  /** Turns that started on the native protocol. */
  nativeTurns: number;
  /** Native turns that had to fall back to the block protocol. */
  nativeDowngrades: number;
  updatedAt: number;
}

export interface PassportIdentity {
  model: string;
  quantization?: string;
  runtime?: string;
}

/** Shrinkage constant: evidence units for the live data to count as much as the prior. */
export const PASSPORT_SHRINKAGE_K = 100;
/** Evidence a single turn can contribute, so one bad turn cannot dominate. */
export const PASSPORT_MAX_EVIDENCE_PER_TURN = 5;
const EWMA_ALPHA = 0.3;
const STALE_MS = 14 * 86_400_000;

export function passportKey(id: PassportIdentity): string {
  return `${id.model}|${(id.quantization ?? "").toLowerCase()}|${id.runtime ?? "ollama"}`;
}

/** Fold one finished turn into the passport. Returns `prev` unchanged for turns with no tool calls. */
export function updatePassport(
  prev: PassportEntry | undefined,
  id: PassportIdentity,
  summary: TurnReliabilitySummary,
  now = Date.now()
): PassportEntry | undefined {
  const c = summary.counts;
  const valid = (c.tool_ok ?? 0) + (c.verify_ok ?? 0);
  const invalid = (c.parse_fail ?? 0) + (c.invalid_args ?? 0);
  const calls = valid + invalid;
  const startedNative = summary.protocol === "native" || summary.protocolDowngraded === true;
  if (calls === 0) return prev;

  const evidenceUnits = Math.min(calls, PASSPORT_MAX_EVIDENCE_PER_TURN);
  const alpha = EWMA_ALPHA * (evidenceUnits / PASSPORT_MAX_EVIDENCE_PER_TURN);
  const obsValid = valid / calls;
  const obsRepair = (c.repair ?? 0) / calls;
  const obsNarration = (c.narration ?? 0) / Math.max(1, summary.steps);
  const mix = (old: number, obs: number) => old + alpha * (obs - old);

  if (!prev) {
    return {
      key: passportKey(id),
      model: id.model,
      ...(id.quantization ? { quantization: id.quantization } : {}),
      ...(id.runtime ? { runtime: id.runtime } : {}),
      evidence: evidenceUnits,
      turns: 1,
      toolValid: obsValid,
      repairRate: obsRepair,
      narrationRate: obsNarration,
      nativeTurns: startedNative ? 1 : 0,
      nativeDowngrades: summary.protocolDowngraded ? 1 : 0,
      updatedAt: now,
    };
  }
  return {
    ...prev,
    evidence: prev.evidence + evidenceUnits,
    turns: prev.turns + 1,
    toolValid: mix(prev.toolValid, obsValid),
    repairRate: mix(prev.repairRate, obsRepair),
    narrationRate: mix(prev.narrationRate, obsNarration),
    nativeTurns: prev.nativeTurns + (startedNative ? 1 : 0),
    nativeDowngrades: prev.nativeDowngrades + (summary.protocolDowngraded ? 1 : 0),
    updatedAt: now,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Weight the live passport gets against the static/bench prior (0 with no evidence). */
export function passportWeight(entry: PassportEntry | undefined): number {
  if (!entry || entry.evidence <= 0) return 0;
  return entry.evidence / (entry.evidence + PASSPORT_SHRINKAGE_K);
}

/** prior -> bench -> live: shrink the tool-protocol capabilities toward what the model actually did. */
export function blendCapabilitiesWithPassport(
  base: ModelCapabilityProfile,
  entry: PassportEntry | undefined
): ModelCapabilityProfile {
  const w = passportWeight(entry);
  if (!entry || w === 0) return base;
  return {
    ...base,
    toolCalling: clamp01((1 - w) * base.toolCalling + w * entry.toolValid),
    schemaAdherence: clamp01((1 - w) * base.schemaAdherence + w * entry.toolValid),
  };
}

/** Rung a new session should start at, learned from past reliability (needs >= 2 turns of evidence). */
export function suggestedInitialRung(entry: PassportEntry | undefined): number {
  if (!entry || entry.evidence < 10) return 0;
  if (entry.toolValid < 0.5) return 2;
  if (entry.toolValid < 0.75) return 1;
  return 0;
}

/** True when native tool calling has repeatedly had to be abandoned for this model recently. */
export function passportNativeUnreliable(entry: PassportEntry | undefined, now = Date.now()): boolean {
  if (!entry || now - entry.updatedAt > STALE_MS) return false;
  return entry.nativeTurns >= 2 && entry.nativeDowngrades / entry.nativeTurns >= 0.5;
}
