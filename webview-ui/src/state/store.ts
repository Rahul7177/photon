import { useEffect, useReducer } from "react";
import type {
  AdaptivePlan,
  Attachment,
  AutoDecision,
  BenchResult,
  ChatMessage,
  GenerationStats,
  IndexStatus,
  IntelligenceSetting,
  MachineProfile,
  McpServerInfo,
  Mode,
  ModelInfo,
  PerModelConfig,
  SessionSummary,
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
  /** Optional phase detail, e.g. the tool currently executing. */
  statusDetail: string | null;
  usage: TokenUsage | null;
  generationStats: GenerationStats | null;
  pendingApproval: ToolCall | null;
  config: PhotonConfig;
  tools: ToolSummary[];
  error: string | null;
  /** Auto Mode transparency (M12): why the last turn's model was chosen. */
  decision: AutoDecision | null;
  /** Photon Bench results (M7), latest per model. */
  benchResults: BenchResult[];
  /** Models with a benchmark currently running. */
  benchRunning: string[];
  /** Workspace index status (M10). */
  indexStatus: IndexStatus;
  /** Imported MCP servers + their approval/connection status (M11). */
  mcpServers: McpServerInfo[];
  /** Dynamic model fetching per provider. */
  providerModels: Record<string, ModelInfo[]>;
  providerModelsFetching: string[];
  providerModelsError: Record<string, string>;
  /** Model test results (key: "providerId:modelName") */
  modelTestResults: Record<string, { ok: boolean; latencyMs?: number; error?: string }>;
  modelTestRunning: string[];
  /** Per-model overrides (context + llama.cpp flags) */
  modelConfigs: Record<string, PerModelConfig>;
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
};

const initialIndex: IndexStatus = { phase: "idle", filesIndexed: 0, chunks: 0, pending: 0 };

const initial: AppState = {
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
};

/** Local-only actions the webview dispatches to itself (optimistic UI). */
type LocalAction =
  | { type: "_clearApproval" }
  | { type: "_clearError" }
  | { type: "_setMode"; mode: Mode }
  | { type: "_fetchProviderModels"; id: string }
  | { type: "_testModel"; providerId: string; model: ModelInfo };
type Action = HostMessage | LocalAction;

function reducer(state: AppState, msg: Action): AppState {
  switch (msg.type) {
    case "_clearApproval":
      return { ...state, pendingApproval: null };
    case "_clearError":
      return { ...state, error: null };
    case "_setMode":
      return { ...state, mode: msg.mode };
    case "_fetchProviderModels":
      if (!("id" in msg)) return state; // type guard
      return {
        ...state,
        providerModelsFetching: [...state.providerModelsFetching, msg.id],
        providerModelsError: { ...state.providerModelsError, [msg.id]: "" },
      };
    case "_testModel":
      if (!("model" in msg)) return state; // type guard
      return {
        ...state,
        modelTestRunning: [
          ...state.modelTestRunning,
          modelTestKey(msg.providerId, msg.model.name),
        ],
      };
    case "init":
      return {
        ...state,
        ready: true,
        ollamaReachable: msg.payload.ollamaReachable,
        models: msg.payload.models,
        selectedModel: msg.payload.selectedModel,
        mode: msg.payload.mode,
        machine: msg.payload.machine,
        plan: msg.payload.plan,
        messages: msg.payload.session.messages,
        sessions: msg.payload.sessions,
        activeSessionId: msg.payload.session.id,
        config: msg.payload.config,
        tools: msg.payload.tools,
        benchResults: msg.payload.benchResults,
        indexStatus: msg.payload.indexStatus,
        mcpServers: msg.payload.mcpServers,
        modelConfigs: (msg.payload as any).modelConfigs ?? {},
      };
    case "models":
      return {
        ...state,
        models: msg.payload.models,
        selectedModel: msg.payload.selected,
        ollamaReachable: msg.payload.ollamaReachable,
      };
    case "sessionLoaded":
      return {
        ...state,
        messages: msg.payload.messages,
        mode: msg.payload.mode,
        activeSessionId: msg.payload.id,
        error: null,
        usage: null,
        generationStats: null,
      };
    case "sessionList":
      return { ...state, sessions: msg.payload.sessions, activeSessionId: msg.payload.activeId };
    case "planUpdated":
      return { ...state, plan: msg.payload };
    case "config":
      return { ...state, config: msg.payload };
    case "messageAppended":
      return { ...state, messages: upsert(state.messages, msg.payload) };
    case "messageDelta": {
      // Coalesce rapid deltas: multiple tokens arriving in one tick are batched by React (audit)
      const { id, delta } = msg.payload;
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === id ? { ...m, content: capContent(m.content + delta), streaming: true } : m
        ),
      };
    }
    case "messageDone":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === msg.payload.id ? { ...m, streaming: false } : m
        ),
      };
    case "messageRemoved":
      return { ...state, messages: state.messages.filter((m) => m.id !== msg.payload.id) };
    case "toolUpdate":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === msg.payload.messageId ? applyToolUpdate(m, msg.payload.call) : m
        ),
      };
    case "toolApprovalRequest":
      return { ...state, pendingApproval: msg.payload.call };
    case "tokenUsage":
      return { ...state, usage: msg.payload };
    case "generationStats":
      return { ...state, generationStats: msg.payload };
    case "status":
      // `detail` is phase context (e.g. the running tool name) — it must NOT
      // be treated as an error message (a previous version conflated them).
      return {
        ...state,
        status: msg.payload.kind,
        statusDetail: msg.payload.detail ?? null,
        error: msg.payload.kind === "error" ? msg.payload.detail ?? state.error : state.error,
      };
    case "decision":
      return { ...state, decision: msg.payload };
    case "benchResults":
      return { ...state, benchResults: msg.payload };
    case "benchStatus": {
      const running = new Set(state.benchRunning);
      if (msg.payload.phase === "running") running.add(msg.payload.model);
      else running.delete(msg.payload.model);
      return { ...state, benchRunning: [...running] };
    }
    case "indexStatus":
      return { ...state, indexStatus: msg.payload };
    case "mcpServers":
      return { ...state, mcpServers: msg.payload };
    case "tools":
      return { ...state, tools: msg.payload };
    case "providerModels":
      return {
        ...state,
        providerModelsFetching: state.providerModelsFetching.filter((id) => id !== msg.payload.id),
        providerModels: { ...state.providerModels, [msg.payload.id]: msg.payload.models },
        providerModelsError: {
          ...state.providerModelsError,
          [msg.payload.id]: msg.payload.error || "",
        },
      };
    case "modelTestResult": {
      const key = modelTestKey(msg.payload.providerId, msg.payload.model.name);
      return {
        ...state,
        modelTestRunning: state.modelTestRunning.filter((k) => k !== key),
        modelTestResults: {
          ...state.modelTestResults,
          [key]: {
            ok: msg.payload.ok,
            latencyMs: msg.payload.latencyMs,
            error: msg.payload.error,
          },
        },
      };
    }
    case "modelConfigs":
      return { ...state, modelConfigs: msg.payload };
    case "error":
      return { ...state, error: msg.payload.message, status: "idle" };
    default:
      return state;
  }
}

// Defense-in-depth: the host already caps output, but never let a single
// message's content grow without bound in the webview (protects the renderer
// from any host-side runaway).
const MAX_CONTENT_CHARS = 250_000;
function capContent(s: string): string {
  return s.length > MAX_CONTENT_CHARS ? s.slice(0, MAX_CONTENT_CHARS) : s;
}

/** Stable identity for a model test, e.g. "gemini:gemini-2.5-pro". Tolerates
 *  inputs that are already prefixed so spinner/result keys always match. */
function modelTestKey(providerId: string, modelName: string): string {
  return modelName.startsWith(`${providerId}:`) ? modelName : `${providerId}:${modelName}`;
}

function upsert(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx === -1) return [...list, m];
  const next = [...list];
  next[idx] = { ...next[idx], ...m };
  return next;
}

function applyToolUpdate(m: ChatMessage, call: ToolCall): ChatMessage {
  const calls = m.toolCalls ? [...m.toolCalls] : [];
  const idx = calls.findIndex((c) => c.id === call.id);
  if (idx === -1) calls.push(call);
  else calls[idx] = call;
  return { ...m, toolCalls: calls };
}

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    const off = onHostMessage((msg) => {
      // Approval requests clear once answered elsewhere; handle inline.
      dispatch(msg);
    });
    post({ type: "ready" });
    return off;
  }, []);

  // Actions
  const actions = {
    send: (text: string, attachments?: Attachment[]) =>
      post({ type: "sendPrompt", payload: { text, attachments } }),
    cancel: () => post({ type: "cancel" }),
    setModel: (model: string) => post({ type: "setModel", payload: { model } }),
    setMode: (mode: Mode) => {
      // Optimistically switch the UI so the tab reacts instantly, even offline.
      dispatch({ type: "_setMode", mode });
      post({ type: "setMode", payload: { mode } });
    },
    newSession: () => post({ type: "newSession" }),
    switchSession: (id: string) => post({ type: "switchSession", payload: { id } }),
    deleteSession: (id: string) => post({ type: "deleteSession", payload: { id } }),
    refreshModels: () => post({ type: "refreshModels" }),
    approve: (callId: string, approved: boolean, remember?: boolean) =>
      post({ type: "toolApproval", payload: { callId, approved, remember } }),
    setContextWindow: (numCtx: number) => post({ type: "setContextWindow", payload: { numCtx } }),
    setAutoApprove: (enabled: boolean) => post({ type: "setAutoApprove", payload: { enabled } }),
    setAdaptiveEnabled: (enabled: boolean) => post({ type: "setAdaptiveEnabled", payload: { enabled } }),
    setIntelligence: (level: IntelligenceSetting) =>
      post({ type: "setIntelligence", payload: { level } }),
    setWebSearchProvider: (provider: "duckduckgo" | "none") =>
      post({ type: "setWebSearchProvider", payload: { provider } }),
    setProviderEnabled: (id: string, enabled: boolean) =>
      post({ type: "setProviderEnabled", payload: { id, enabled } }),
    setProviderApiKey: (id: string, apiKey: string) =>
      post({ type: "setProviderApiKey", payload: { id, apiKey } }),
    setInterfaceMode: (mode: "local" | "cloud") =>
      post({ type: "setInterfaceMode", payload: { mode } }),
    setAutoSelect: (enabled: boolean) => post({ type: "setAutoSelect", payload: { enabled } }),
    pinModel: (model: string) => post({ type: "pinModel", payload: { model } }),
    runBench: (model?: string) => post({ type: "runBench", payload: { model } }),
    setIndexingEnabled: (enabled: boolean) =>
      post({ type: "setIndexingEnabled", payload: { enabled } }),
    reindex: () => post({ type: "reindex" }),
    approveMcpServer: (id: string) => post({ type: "approveMcpServer", payload: { id } }),
    revokeMcpServer: (id: string) => post({ type: "revokeMcpServer", payload: { id } }),
    diagnostics: () => post({ type: "openDiagnostics" }),
    fetchProviderModels: (id: string) => {
      dispatch({ type: "_fetchProviderModels", id } as unknown as Action); // Handled locally for UI state
      post({ type: "fetchProviderModels", payload: { id } });
    },
    testModel: (providerId: string, model: ModelInfo) => {
      dispatch({ type: "_testModel", providerId, model } as unknown as Action);
      post({ type: "testModel", payload: { providerId, model } });
    },
    addAvailableModel: (providerId: string, model: ModelInfo) =>
      post({ type: "addAvailableModel", payload: { providerId, model } }),
    removeAvailableModel: (name: string) =>
      post({ type: "removeAvailableModel", payload: { name } }),
    addCustomProvider: (label: string, baseUrl: string, apiKey?: string) =>
      post({ type: "addCustomProvider", payload: { label, baseUrl, apiKey } }),
    removeCustomProvider: (id: string) =>
      post({ type: "removeCustomProvider", payload: { id } }),
    setPerModelConfig: (model: string, config: import("../../../src/shared/types").PerModelConfig) =>
      post({ type: "setPerModelConfig", payload: { model, config } }),
    removePerModelConfig: (model: string) => post({ type: "removePerModelConfig", payload: { model } }),
  };

  return { state, dispatch, actions };
}

export type Actions = ReturnType<typeof useAppState>["actions"];
