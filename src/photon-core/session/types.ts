// Event-sourced session vocabulary — harness-inspired, Photon-shaped.
export type SessionId = string & { readonly __brand: "SessionId" };
export type TurnId = string;
export type StepId = string;

export interface SessionMeta { cwd?: string; workspaceName?: string; createdAt: number; }

export interface SessionEventMap {
  "user/message": { id: string; content: string; attachments?: import("../../shared/types").Attachment[]; source: MessageSource; createdAt: number };
  "assistant/message": { id: string; content: string; model: string; provider?: string; toolCalls?: import("../../shared/types").ToolCall[]; createdAt: number };
  "assistant/chunk": { id: string; delta: string; model: string; seq: number };
  "tool/call": { id: string; name: string; args: Record<string, unknown>; attempt: number };
  "tool/result": { callId: string; name: string; output: string; ok: boolean; isError?: boolean; status?: string; retryable?: boolean };
  "turn/start": { turnId: TurnId; at: number };
  "turn/end": { turnId: TurnId; reason: TurnEndReason; at: number };
  "step/start": { stepId: StepId; turnId: TurnId; at: number };
  "step/end": { stepId: StepId; turnId: TurnId; at: number };
  "request/header": { provider: string; model: string; systemPrompt: string; tools: unknown[]; temperature: number; contextWindow: number; reason: "initial" | "resume" | "change" | "series"; startsSeries?: boolean };
  "request/context": { provider: string; model: string };
  "session/created": { sessionId: SessionId; meta: SessionMeta };
  "session/title": { title: string };
}
export type SessionEventType = keyof SessionEventMap;
export interface SessionEvent<T extends SessionEventType = SessionEventType> { seq: number; type: T; data: SessionEventMap[T]; at: number; }
export type MessageSource = { kind: "user" } | { kind: "plugin"; plugin: string } | { kind: "injected" };
export type TurnEndReason = "stop" | "tool-calls" | "max-steps" | "max-tokens" | "aborted" | "error" | "cancelled";
export interface DerivedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; function: { name: string; arguments: Record<string, unknown> } }[];
  tool_call_id?: string;
  name?: string;
  id?: string;
}
