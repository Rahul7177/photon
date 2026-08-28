import type { PhotonSession } from "../session/store";

// Discriminant-tagged pre-step decision — harness parity: agent/pre-step waterfall
export type PreStepDecision =
  | { kind: "reject"; reason: string }
  | { kind: "enter"; messages: { content: string; attachments?: any[]; source: any }[]; startsRequestSeries?: boolean };

export type AgentStatus = "idle" | "running" | "cancelling";

export interface AgentOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface AgentEvents {
  "agent/pre-step": (decision: PreStepDecision, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>;
  "agent/request": (opts: any, next: () => Promise<any>) => Promise<any>;
  "agent/turn-stopping": (info: { turnId: string; reason: string }) => Promise<{ continue?: boolean; steer?: string } | void>;
  "agent/status": (status: AgentStatus) => void;
}

export interface InboxItem {
  id: string;
  content: string;
  attachments?: any[];
  source: { kind: "user" | "plugin" | "injected"; plugin?: string };
  wake: boolean; // followup/steer wake, inject does not
}
