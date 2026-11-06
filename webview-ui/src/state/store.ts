import { useEffect, useMemo, useReducer } from "react";
import type {
  AdaptivePlan,
  Attachment,
  AutoDecision,
  BenchResult,
  ChatMessage,
  CloudUsageSummary,
  GenerationStats,
  HardwareMetrics,
  IndexStatus,
  IntelligenceSetting,
  MachineProfile,
  McpServerInfo,
  Mode,
  ModelInfo,
  OllamaRuntimeModel,
  PerModelConfig,
  ProjectContextSummary,
  ProjectMemoryNote,
  PullProgress,
  LocalRuntimeInfo,
  LocalRuntimeId,
  ModelCapability,
  ProviderLifecycleState,
  RecommendationSet,
  SessionSummary,
  ThinkingSetting,
  ToolCall,
  TokenUsage,
} from "../../../src/shared/types";
import type { HostMessage, PhotonConfig, ToolSummary } from "../../../src/shared/protocol";
import { onHostMessage, post } from "../vscode";

export interface AppState {
  ready: boolean;
  ollamaReachable: boolean;
  models: ModelInfo[];
  selectedModel: string;
  mode: Mode;
  machine: MachineProfile | null;
  plan: AdaptivePlan | null;
  messages: ChatMessage[];
  sessions: SessionSummary[];
  activeSessionId: string;
  status: "idle" | "thinking" | "running" | "error";
  statusDetail: string | null;
  usage: TokenUsage | null;
  generationStats: GenerationStats | null;
  pendingApproval: ToolCall | null;
  config: PhotonConfig;
  tools: ToolSummary[];
  error: string | null;
  decision: AutoDecision | null;
  benchResults: BenchResult[];
  benchRunning: string[];
  indexStatus: IndexStatus;
  mcpServers: McpServerInfo[];
  providerModels: Record<string, ModelInfo[]>;
  providerModelsFetching: string[];
  providerModelsError: Record<string, string>;
  modelTestResults: Record<string, { ok: boolean; latencyMs?: number; error?: string }>;
  modelTestRunning: string[];
  modelConfigs: Record<string, PerModelConfig>;
  ollamaRuntime: OllamaRuntimeModel[];
  hardwareMetrics: HardwareMetrics | null;
  cloudUsage: CloudUsageSummary | null;
  pullProgress: PullProgress | null;
  recommendations: RecommendationSet | null;
  localRuntimes: LocalRuntimeInfo[];
  providerLifecycle: Record<string, ProviderLifecycleState>;
  projectContext: ProjectContextSummary | null;
}

const initialConfig: PhotonConfig = {
  autoApprove: false,
  adaptiveEnabled: true,
  webSearchProvider: "duckduckgo",
  ollamaBaseUrl: "",
  llamacppBaseUrl: "http://localhost:8080",
  numCtxOverride: 0,
  intelligence: "auto",
  autoSelectModel: false,
  indexingEnabled: false,
  embeddingModel: "nomic-embed-text",
  providers: [],
  interfaceMode: "local",
  thinkingLevel: "auto",
};

const initialIndex: IndexStatus = { phase: "idle", filesIndexed: 0, chunks: 0, pending: 0 };
export const initial: AppState = {
  ready: false,
  ollamaReachable: false,
  models: [],
  selectedModel: "",
  mode: "chat",
  machine: null,
  plan: null,
  messages: [],
  sessions: [],
  activeSessionId: "",
  status: "idle",
  statusDetail: null,
  usage: null,
  generationStats: null,
  pendingApproval: null,
  config: initialConfig,
  tools: [],
  error: null,
  decision: null,
  benchResults: [],
  benchRunning: [],
  indexStatus: initialIndex,
  mcpServers: [],
  providerModels: {},
  providerModelsFetching: [],
  providerModelsError: {},
  modelTestResults: {},
  modelTestRunning: [],
  modelConfigs: {},
  ollamaRuntime: [],
  hardwareMetrics: null,
  cloudUsage: null,
  pullProgress: null,
  recommendations: null,
  localRuntimes: [],
  providerLifecycle: {},
  projectContext: null,
};

type LocalAction =
  | { type: "_clearApproval" }
  | { type: "_clearError" }
  | { type: "_setMode"; mode: Mode }
  | { type: "_setModel"; model: string }
  | { type: "_fetchProviderModels"; id: string }
  | { type: "_testModel"; providerId: string; model: ModelInfo };
export type Action = HostMessage | LocalAction;

export function reducer(state: AppState, msg: Action): AppState {
  switch (msg.type) {
    case "_clearApproval": return { ...state, pendingApproval: null };
    case "_clearError": return { ...state, error: null };
    case "_setMode": return { ...state, mode: msg.mode };
    case "_setModel": return { ...state, selectedModel: msg.model, autoSelectModel: false };
    case "_fetchProviderModels": return { ...state, providerModelsFetching: [...state.providerModelsFetching, msg.id], providerModelsError: { ...state.providerModelsError, [msg.id]: "" } };
    case "_testModel": return { ...state, modelTestRunning: [...state.modelTestRunning, modelTestKey(msg.providerId, msg.model.name)] };
    case "init": return { ...state, ready: true, ollamaReachable: msg.payload.ollamaReachable, models: msg.payload.models, selectedModel: msg.payload.selectedModel, mode: msg.payload.mode, machine: msg.payload.machine, plan: msg.payload.plan, messages: msg.payload.session.messages, sessions: msg.payload.sessions, activeSessionId: msg.payload.session.id, config: msg.payload.config, tools: msg.payload.tools, benchResults: msg.payload.benchResults, indexStatus: msg.payload.indexStatus, mcpServers: msg.payload.mcpServers, modelConfigs: (msg.payload as any).modelConfigs ?? {}, ollamaRuntime: msg.payload.ollamaRuntime ?? [], hardwareMetrics: msg.payload.hardwareMetrics ?? null, cloudUsage: msg.payload.cloudUsage ?? null, projectContext: msg.payload.projectContext ?? state.projectContext, usage: msg.payload.session.usage ?? state.usage };
    case "models": return { ...state, models: msg.payload.models, selectedModel: msg.payload.selected, ollamaReachable: msg.payload.ollamaReachable };
    case "sessionLoaded": {
      const isSameSession = msg.payload.id === state.activeSessionId;
      return {
        ...state,
        messages: isSameSession
          ? mergeMessages(state.messages, msg.payload.messages)
          : msg.payload.messages,
        mode: msg.payload.mode,
        activeSessionId: msg.payload.id,
        error: state.error && state.status === "idle" ? state.error : null,
        usage: msg.payload.usage ?? (isSameSession ? state.usage : null),
        generationStats: null,
      };
    }
    case "sessionList": return { ...state, sessions: msg.payload.sessions, activeSessionId: msg.payload.activeId };
    case "planUpdated": return { ...state, plan: msg.payload };
    case "config": return { ...state, config: msg.payload };
    case "messageAppended": return { ...state, messages: upsertLive(state.messages, msg.payload) };
    case "messageDelta": return { ...state, messages: state.messages.map((m) => m.id === msg.payload.id ? { ...m, content: capContent(m.content + msg.payload.delta), streaming: true } : m) };
    case "thinkingDelta": return { ...state, messages: state.messages.map((m) => m.id === msg.payload.id ? { ...m, thinking: capThinking((m.thinking ?? "") + msg.payload.delta), streaming: true } : m) };
    case "thinkingDone": return { ...state, messages: state.messages.map((m) => m.id === msg.payload.id ? { ...m, thinkingElapsedMs: msg.payload.elapsedMs } : m) };
    case "messageDone": return { ...state, messages: state.messages.map((m) => m.id === msg.payload.id ? { ...m, streaming: false } : m) };
    case "messageRemoved": return { ...state, messages: state.messages.filter((m) => m.id !== msg.payload.id) };
    case "toolUpdate": {
      const clearedApproval = state.pendingApproval?.id === msg.payload.call.id && ["done", "error", "denied"].includes(msg.payload.call.status) ? null : state.pendingApproval;
      if (!state.messages.some((m) => m.id === msg.payload.messageId)) {
        if (state.messages.length > 500) return { ...state, pendingApproval: clearedApproval };
        return {
          ...state,
          pendingApproval: clearedApproval,
          messages: [...state.messages, { id: msg.payload.messageId, role: "assistant", content: "", toolCalls: [msg.payload.call], createdAt: Date.now(), streaming: true } as ChatMessage],
        };
      }
      return {
        ...state,
        pendingApproval: clearedApproval,
        messages: state.messages.map((m) => m.id === msg.payload.messageId ? applyToolUpdate(m, msg.payload.call) : m),
      };
    }
    case "toolApprovalRequest": return { ...state, pendingApproval: msg.payload.call };
    case "tokenUsage": return { ...state, usage: msg.payload };
    case "generationStats": return { ...state, generationStats: msg.payload };
    case "status": return { ...state, status: msg.payload.kind, statusDetail: msg.payload.detail ?? null, error: msg.payload.kind === "error" ? msg.payload.detail ?? state.error : state.error };
    case "decision": return { ...state, decision: msg.payload };
    case "benchResults": return { ...state, benchResults: msg.payload };
    case "benchStatus": { const running = new Set(state.benchRunning); if (msg.payload.phase === "running") running.add(msg.payload.model); else running.delete(msg.payload.model); return { ...state, benchRunning: [...running] }; }
    case "indexStatus": return { ...state, indexStatus: msg.payload };
    case "mcpServers": return { ...state, mcpServers: msg.payload };
    case "tools": return { ...state, tools: msg.payload };
    case "providerModels": return { ...state, providerModelsFetching: state.providerModelsFetching.filter((id) => id !== msg.payload.id), providerModels: { ...state.providerModels, [msg.payload.id]: msg.payload.models }, providerModelsError: { ...state.providerModelsError, [msg.payload.id]: msg.payload.error || "" } };
    case "modelTestResult": { const key = modelTestKey(msg.payload.providerId, msg.payload.model.name); return { ...state, modelTestRunning: state.modelTestRunning.filter((k) => k !== key), modelTestResults: { ...state.modelTestResults, [key]: { ok: msg.payload.ok, latencyMs: msg.payload.latencyMs, error: msg.payload.error } } }; }
    case "modelConfigs": return { ...state, modelConfigs: msg.payload };
    case "ollamaRuntime": return { ...state, ollamaRuntime: msg.payload };
    case "hardwareMetrics": return { ...state, hardwareMetrics: msg.payload };
    case "cloudUsage": return { ...state, cloudUsage: msg.payload };
    case "pullProgress": return { ...state, pullProgress: msg.payload };
    case "modelRecommendations": return { ...state, recommendations: msg.payload };
    case "providerRuntimes": return { ...state, localRuntimes: msg.payload };
    case "providerLifecycle": return { ...state, providerLifecycle: { ...state.providerLifecycle, [msg.payload.id]: msg.payload } };
    case "projectContext": return { ...state, projectContext: msg.payload };
    case "error": {
      const errText = msg.payload.message;
      const hasNoticeAlready = state.messages.some(
        (m) => m.notice && m.notice.includes(errText)
      );
      const nextMessages = hasNoticeAlready
        ? state.messages
        : [
            ...state.messages,
            {
              id: `err-${Date.now()}`,
              role: "assistant" as const,
              content: "",
              notice: errText,
              createdAt: Date.now(),
              streaming: false,
            },
          ];
      return { ...state, error: errText, status: "idle", messages: nextMessages };
    }
    default: return state;
  }
}

const MAX_CONTENT_CHARS = 250_000;
const MAX_THINKING_CHARS = 30_000;
function capContent(s: string): string { return s.length > MAX_CONTENT_CHARS ? s.slice(0, MAX_CONTENT_CHARS) : s; }
function capThinking(s: string): string { return s.length > MAX_THINKING_CHARS ? s.slice(0, MAX_THINKING_CHARS) : s; }
function modelTestKey(providerId: string, modelName: string): string { return modelName.startsWith(`${providerId}:`) ? modelName : `${providerId}:${modelName}`; }
function upsertLive(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const index = list.findIndex((message) => message.id === m.id);
  if (index < 0) {
    // Also guard against double-appends from concurrent turns or duplicate user messages with distinct IDs
    // but identical user content submitted at the same second.
    return [...list, m];
  }
  const next = [...list];
  next[index] = {
    ...next[index],
    ...m,
    content: m.content || next[index].content,
    thinking: m.thinking ?? next[index].thinking,
    toolCalls: m.toolCalls ?? next[index].toolCalls,
    streaming: m.streaming !== undefined ? m.streaming : next[index].streaming,
  };
  return next;
}
function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  const order: string[] = [];
  const seen = new Set<string>();

  // Maintain initial current order
  for (const message of current) {
    if (!seen.has(message.id)) {
      seen.add(message.id);
      order.push(message.id);
    }
  }

  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (!existing) {
      byId.set(message.id, message);
      if (!seen.has(message.id)) {
        seen.add(message.id);
        order.push(message.id);
      }
      continue;
    }
    const live = existing.streaming === true;
    byId.set(message.id, {
      ...existing,
      ...message,
      content: live ? existing.content : message.content,
      thinking: live ? (existing.thinking ?? message.thinking) : (message.thinking ?? existing.thinking),
      toolCalls: live ? existing.toolCalls : (message.toolCalls ?? existing.toolCalls),
      streaming: live ? true : message.streaming,
    });
  }
  return order.map((id) => byId.get(id)).filter((message): message is ChatMessage => !!message);
}
function applyToolUpdate(m: ChatMessage, call: ToolCall): ChatMessage { const calls = m.toolCalls ? [...m.toolCalls] : []; const idx = calls.findIndex((c) => c.id === call.id); if (idx === -1) calls.push(call); else calls[idx] = call; return { ...m, toolCalls: calls }; }

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => { const off = onHostMessage((msg) => dispatch(msg)); post({ type: "ready" }); return off; }, []);
  const actions = useMemo(() => ({
    send: (text: string, attachments?: Attachment[]) => post({ type: "sendPrompt", payload: { text, attachments } }),
    cancel: () => post({ type: "cancel" }),
    setModel: (model: string) => { dispatch({ type: "_setModel", model }); post({ type: "setModel", payload: { model } }); },
    setMode: (mode: Mode) => { dispatch({ type: "_setMode", mode }); post({ type: "setMode", payload: { mode } }); },
    newSession: () => post({ type: "newSession" }),
    switchSession: (id: string) => post({ type: "switchSession", payload: { id } }),
    deleteSession: (id: string) => post({ type: "deleteSession", payload: { id } }),
    refreshModels: () => post({ type: "refreshModels" }),
    approve: (callId: string, approved: boolean, remember?: boolean) => post({ type: "toolApproval", payload: { callId, approved, remember } }),
    setContextWindow: (numCtx: number) => post({ type: "setContextWindow", payload: { numCtx } }),
    setAutoApprove: (enabled: boolean) => post({ type: "setAutoApprove", payload: { enabled } }),
    setAdaptiveEnabled: (enabled: boolean) => post({ type: "setAdaptiveEnabled", payload: { enabled } }),
    setIntelligence: (level: IntelligenceSetting) => post({ type: "setIntelligence", payload: { level } }),
    setWebSearchProvider: (provider: "google" | "duckduckgo" | "none") => post({ type: "setWebSearchProvider", payload: { provider } }),
    setProviderEnabled: (id: string, enabled: boolean) => post({ type: "setProviderEnabled", payload: { id, enabled } }),
    setProviderApiKey: (id: string, apiKey: string) => post({ type: "setProviderApiKey", payload: { id, apiKey } }),
    setInterfaceMode: (mode: "local" | "cloud") => post({ type: "setInterfaceMode", payload: { mode } }),
    setAutoSelect: (enabled: boolean) => post({ type: "setAutoSelect", payload: { enabled } }),
    setThinkingEnabled: (enabled: boolean) => post({ type: "setThinkingEnabled", payload: { enabled } }),
    setThinkingLevel: (level: "off" | "low" | "medium" | "high") => post({ type: "setThinkingLevel", payload: { level } }),
    setThinkingSetting: (level: ThinkingSetting) => post({ type: "setThinkingSetting", payload: { level } }),
    pinModel: (model: string) => post({ type: "pinModel", payload: { model } }),
    runBench: (model?: string) => post({ type: "runBench", payload: { model } }),
    setIndexingEnabled: (enabled: boolean) => post({ type: "setIndexingEnabled", payload: { enabled } }),
    setPerModelConfig: (model: string, config: PerModelConfig) => post({ type: "setPerModelConfig", payload: { model, config } }),
    removePerModelConfig: (model: string) => post({ type: "removePerModelConfig", payload: { model } }),
    unloadModel: (model?: string) => post({ type: "unloadModel", payload: { model } }),
    pullModel: (model: string) => post({ type: "pullModel", payload: { model } }),
    cancelPull: () => post({ type: "cancelPull" }),
    detectProviders: () => post({ type: "detectProviders" }),
    startProvider: (id: "ollama" | "llamacpp", modelPath?: string) => post({ type: "startProvider", payload: { id, modelPath } }),
    stopProvider: (id: "ollama" | "llamacpp") => post({ type: "stopProvider", payload: { id } }),
    restartProvider: (id: "ollama" | "llamacpp") => post({ type: "restartProvider", payload: { id } }),
    installProvider: (id: LocalRuntimeId, optionIndex: number) => post({ type: "installProvider", payload: { id, optionIndex } }),
    requestRecommendations: (goal?: ModelCapability, ctxTokens?: number) => post({ type: "requestRecommendations", payload: { goal, ctxTokens } }),
    requestHardwareMetrics: () => post({ type: "requestHardwareMetrics" }),
    resetCloudUsage: () => post({ type: "resetCloudUsage" }),
    requestProjectContext: () => post({ type: "requestProjectContext" }),
    refreshProjectContext: () => post({ type: "refreshProjectContext" }),
    addProjectNote: (payload: { category: ProjectMemoryNote["category"]; title: string; content: string; relatedFiles?: string[] }) => post({ type: "addProjectNote", payload }),
    deleteProjectNote: (id: string) => post({ type: "deleteProjectNote", payload: { id } }),
    clearWorkingMemory: () => post({ type: "clearWorkingMemory" }),
    reindex: () => post({ type: "reindex" }),
    approveMcpServer: (id: string) => post({ type: "approveMcpServer", payload: { id } }),
    revokeMcpServer: (id: string) => post({ type: "revokeMcpServer", payload: { id } }),
    diagnostics: () => post({ type: "openDiagnostics" }),
    fetchProviderModels: (id: string) => { dispatch({ type: "_fetchProviderModels", id }); post({ type: "fetchProviderModels", payload: { id } }); },
    testModel: (providerId: string, model: ModelInfo) => { dispatch({ type: "_testModel", providerId, model }); post({ type: "testModel", payload: { providerId, model } }); },
    addAvailableModel: (providerId: string, model: ModelInfo) => post({ type: "addAvailableModel", payload: { providerId, model } }),
    removeAvailableModel: (name: string) => post({ type: "removeAvailableModel", payload: { name } }),
    addCustomProvider: (label: string, baseUrl: string, apiKey?: string) => post({ type: "addCustomProvider", payload: { label, baseUrl, apiKey } }),
    removeCustomProvider: (id: string) => post({ type: "removeCustomProvider", payload: { id } }),
  }), []);
  return { state, dispatch, actions };
}
export type Actions = ReturnType<typeof useAppState>["actions"];
