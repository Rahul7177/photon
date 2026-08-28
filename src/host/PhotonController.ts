import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
  AdaptivePlan,
  Attachment,
  AutoDecision,
  ChatMessage,
  IndexStatus,
  IntelligenceSetting,
  MachineProfile,
  Mode,
  ModelInfo,
  SessionState,
  ToolCall,
} from "../shared/types";
import type { HostMessage, PhotonConfig, ToolSummary, ViewMessage } from "../shared/protocol";
import { OllamaClient } from "../core/ollama/client";
import { profileMachine } from "../core/adaptive/machineProfiler";
import { buildPlan } from "../core/adaptive/orchestrator";
import { planRequest } from "../core/adaptive/autoMode";
import { runBench } from "../core/bench/bench";
import { ToolRegistry } from "../core/tools/registry";
import { builtinTools } from "../core/tools/builtin";
import { McpManager, type McpServerConfig } from "../core/tools/mcp/bridge";
import { AgentEngine, type TurnEmitter } from "../core/agent/engine";
import { runCloudTurn, cloudHistoryFromSession } from "../core/agent/cloudEngine";
import { cloudTools } from "../core/tools/cloud/cloudTools";
import { buildCloudSystemPrompt } from "../core/prompts/cloudSystem";
import { buildWorkspaceMap } from "../core/tools/workspaceMap";
import type { DiagnosticInfo, ToolContext } from "../core/tools/types";
import { ProviderManager } from "../core/llm/providerManager";
import { OllamaProvider } from "../core/llm/providers/ollamaProvider";
import { OpenAICompatProvider, type OpenAICompatConfig } from "../core/llm/providers/openaiCompatProvider";
import { GeminiProvider } from "../core/llm/providers/geminiProvider";
import { AnthropicProvider } from "../core/llm/providers/anthropicProvider";
import {
  BLACKBOX_MODELS,
  customModel,
} from "../core/llm/catalogs";
import type { LLMProvider, ProviderModel } from "../core/llm/types";
import { SessionStore } from "./sessionStore";
import { BenchStore } from "./benchStore";
import { ProjectStore } from "./projectStore";
import { IndexService } from "./indexService";
import { ModelConfigStore } from "./modelConfigStore";
import { loadProjectConfig, type ProjectConfig } from "./projectConfig";
import { SessionRegistry, PhotonSession } from "../photon-core/session/store";
import { AgentRegistry, PhotonAgent } from "../photon-core/agent/agent";
import { ToolPipeline } from "../photon-core/tools/pipeline";
import { SystemPromptRegistry } from "../photon-core/systemPrompt/registry";
import { AgentLoop } from "../photon-core/loop/agentLoop";
import { bridgeLegacyProvider } from "../photon-core/llm/types.v2";

const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

/** Inline base64 images kept in PERSISTED sessions. Images dominate storage —
 *  a few screenshots would otherwise bloat every globalState rewrite forever.
 *  The live in-memory session keeps everything; only the stored copy is pruned. */
const KEEP_INLINE_IMAGES = 4;

function pruneInlineImages(session: SessionState): SessionState {
  let remaining = KEEP_INLINE_IMAGES;
  const messages = [...session.messages]
    .reverse()
    .map((m) => {
      const imageCount = m.attachments?.filter((a) => a.dataBase64).length ?? 0;
      if (!imageCount) return m;
      const keep = Math.max(0, remaining);
      remaining -= imageCount;
      if (keep >= imageCount) return m;
      let toStrip = imageCount - keep;
      const attachments = m.attachments!.map((a) =>
        a.dataBase64 && toStrip-- > 0 ? { ...a, dataBase64: undefined } : a
      );
      return { ...m, attachments };
    })
    .reverse();
  return { ...session, messages };
}

type Post = (msg: HostMessage) => void;

// Cap messages kept per session (memory + persisted-blob size).
const MAX_SESSION_MESSAGES = 400;

/**
 * Owns all runtime state for a Photon session and mediates between the webview
 * and the core engine. One controller instance per webview.
 */
export class PhotonController {
  private client: OllamaClient;
  /** Local Ollama adapter — always present. */
  private ollamaProvider: OllamaProvider;
  /** Routes chat requests to the right provider by model prefix. */
  private providers: ProviderManager;
  private registry = new ToolRegistry();
  private engine: AgentEngine;
  private sessionStore: SessionStore;
  private benchStore: BenchStore;
  private projectStore: ProjectStore;
  private mcp: McpManager;
  private index: IndexService;
  private modelConfigs: ModelConfigStore;

  private machine: MachineProfile | null = null;
  private models: ModelInfo[] = [];
  private selectedModel = "";
  /** Auto Mode: when true, Photon picks the model per request (M8). */
  private autoSelect = false;
  private lastDecision: AutoDecision | null = null;
  /** Checked-in project defaults from `.photon/config.*` (M5), if any. */
  private projectConfig: ProjectConfig | null = null;
  private mode: Mode = "chat";
  /** Which engine stack is active: local (Ollama + adaptive) or cloud
   *  (direct provider APIs, native tool calling, no adaptive limits). */
  private interfaceMode: "local" | "cloud" = "local";
  private plan: AdaptivePlan | null = null;
  private userNumCtx: number | undefined;
  private session: SessionState;
  // --- Harness-inspired durable core (alongside legacy for incremental migration) ---
  private durableSessions = new SessionRegistry();
  private agentRegistry: AgentRegistry;
  private toolPipeline = new ToolPipeline();
  private systemPromptRegistry = new SystemPromptRegistry();
  private agentLoop: AgentLoop;
  private activeHarnessAgent: PhotonAgent | null = null;

  private turnAbort?: AbortController;
  /** Cancels an in-flight benchmark run. */
  private benchAbort?: AbortController;
  private autoApprove: boolean;
  private reachable = false;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private rawPost: Post = () => {};
  /** Updates the status-bar item (active model + reachability). */
  private statusUpdater?: (text: string, tooltip: string) => void;
  /** Guards the one-time expensive setup so a webview re-mount can't re-run it. */
  private initPromise?: Promise<void>;
  /** Last successfully fetched per-provider live model lists, so a webview
   *  remount can repaint the settings cards without refetching. */
  private liveModelCache = new Map<string, ModelInfo[]>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    const cfg = vscode.workspace.getConfiguration("photon");
    this.client = new OllamaClient({
      baseUrl: cfg.get<string>("ollama.baseUrl", "http://localhost:11434"),
      timeoutMs: cfg.get<number>("ollama.requestTimeoutMs", 180000),
      // Keep models resident between turns — Ollama's 5-minute default unloads
      // them, so infrequent chats and bench runs paid a full cold load each time.
      keepAlive: "30m",
    });
    this.ollamaProvider = new OllamaProvider(this.client);
    // The engine keeps ONE ProviderManager instance; providers are swapped in
    // at runtime via setProviders() when settings/API keys change.
    this.providers = new ProviderManager([this.ollamaProvider]);
    this.mode = cfg.get<Mode>("defaultMode", "chat");
    this.interfaceMode = cfg.get<"local" | "cloud">("interfaceMode", "local");
    this.autoApprove = cfg.get<boolean>("tools.autoApprove", false);
    this.sessionStore = new SessionStore(context);
    this.benchStore = new BenchStore(context);
    this.projectStore = new ProjectStore(context);
    this.modelConfigs = new ModelConfigStore(context);
    // MCP bridges into BOTH registries — legacy engine + harness pipeline stay in sync
    const mcpRegistryBridge = {
      register: (t: any) => { this.registry.register(t); this.toolPipeline.register(t); return () => { this.registry["tools"]?.delete?.(t.spec.name); (this.toolPipeline as any).tools?.delete?.(t.spec.name); }; },
      registerAll: (ts: any[]) => { this.registry.registerAll(ts); this.toolPipeline.registerAll(ts); },
      unregisterByPrefix: (p: string) => { this.registry.unregisterByPrefix(p); (this.toolPipeline as any).tools && [...(this.toolPipeline as any).tools.keys()].filter((k: string)=>k.startsWith(p)).forEach((k: string)=>(this.toolPipeline as any).tools.delete(k)); },
    } as any;
    this.mcp = new McpManager(mcpRegistryBridge, (m) => this.output.appendLine(`[mcp] ${m}`));
    this.index = new IndexService(
      context,
      this.client,
      (m) => this.output.appendLine(m),
      (status) => this.safePost({ type: "indexStatus", payload: status })
    );
    this.registry.registerAll(builtinTools());
    // Mirror tools into harness pipeline (keeps single source of truth)
    this.toolPipeline.registerAll(builtinTools() as any);
    this.agentRegistry = new AgentRegistry(this.durableSessions);
    this.agentLoop = new AgentLoop({
      llm: bridgeLegacyProvider(this.providers as any),
      tools: this.toolPipeline,
      systemPrompt: this.systemPromptRegistry,
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      retrieveContext: (query, signal) => this.index.retrieveContext(query, signal),
      reserveOutputTokens: cfg.get<number>("context.reserveOutputTokens", 1024),
      buildPlan: (prompt, mode, attachmentsCount) => {
        const { decision, plan } = planRequest({
          prompt,
          mode: this.mode,
          attachmentCount: attachmentsCount,
          models: this.modelsForUi(),
          machine: this.machine,
          benchByModel: this.benchStore.byModel(),
          pinnedModel: this.autoSelect ? undefined : this.selectedModel || undefined,
          intelligence: this.effectiveIntelligence(),
          reserveOutputTokens: cfg.get<number>("context.reserveOutputTokens", 1024),
          adaptiveEnabled: this.adaptiveEnabled(),
          userNumCtx: this.effectiveNumCtx(),
        });
        this.lastDecision = decision;
        return plan;
      },
      buildToolContext: (signal, capability) => this.buildToolContext(signal),
    });
    // Intelligence as pre-step waterfall (harness pattern) — keep moat in orchestrator
    // The loop's buildPlan already runs orchestrator; this hook mirrors auto decision transparency
    this.agentLoop.onPreStep(async (decision: any, next: any) => {
      if (decision.plan) this.plan = decision.plan;
      return next();
    });
    this.engine = new AgentEngine({
      client: this.providers,
      registry: this.registry,
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      workspaceMap: () =>
        buildWorkspaceMap(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
      retrieveContext: (query, signal) => this.index.retrieveContext(query, signal),
      reserveOutputTokens: cfg.get<number>("context.reserveOutputTokens", 1024),
      toolContext: (signal) => this.buildToolContext(signal),
    });
    this.session = this.freshSession();

    // Deterministic teardown on extension deactivate — abort work, close every
    // MCP connection, dispose the index watcher. Prevents process/connection leaks.
    this.context.subscriptions.push({
      dispose: () => {
        this.turnAbort?.abort();
        this.benchAbort?.abort();
        this.index.dispose();
        void this.mcp.dispose();
      },
    });

    // Keep in sync if the user edits settings.json directly instead of using
    // the in-webview settings panel. Disposed with the extension.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (!e.affectsConfiguration("photon")) return;
        try {
          const c = vscode.workspace.getConfiguration("photon");
          this.autoApprove = c.get<boolean>("tools.autoApprove", false);
          this.syncClientConfig();
          this.recomputePlan();
          this.pushPlan();
          this.pushConfig();
          // If the Ollama URL/timeout changed, re-check the connection.
          if (e.affectsConfiguration("photon.ollama")) {
            await this.refresh();
          }
          // Provider enable flags changed via settings.json → rebuild providers.
          if (e.affectsConfiguration("photon.providers") || e.affectsConfiguration("photon.llamacpp")) {
            await this.rebuildProviders();
            await this.refresh();
          }
          // Index settings changed via settings.json → reconfigure the indexer.
          if (e.affectsConfiguration("photon.index")) {
            await this.configureIndex();
          }
        } catch (err) {
          this.output.appendLine(`[config] ${(err as Error).stack ?? err}`);
        }
      })
    );
  }

  /** Re-read the Ollama URL/timeout from settings into the client. */
  private syncClientConfig(): void {
    const cfg = vscode.workspace.getConfiguration("photon");
    this.client.update({
      baseUrl: cfg.get<string>("ollama.baseUrl", "http://localhost:11434"),
      timeoutMs: cfg.get<number>("ollama.requestTimeoutMs", 180000),
    });
  }

  setPost(post: Post) {
    this.rawPost = post;
  }

  /** Wire the status-bar updater (owned by the extension host) and paint it. */
  setStatusUpdater(fn: (text: string, tooltip: string) => void) {
    this.statusUpdater = fn;
    this.updateStatusBar();
  }

  /** Model names available for the status-bar quick-pick command. */
  modelNames(): string[] {
    return this.modelsForUi().map((m) => m.name);
  }

  private updateStatusBar(): void {
    if (!this.statusUpdater) return;
    if (!this.reachable) {
      this.statusUpdater("$(error) Photon", `Ollama not reachable at ${this.client.baseUrl}`);
    } else if (this.autoSelect) {
      this.statusUpdater(
        "$(sparkle) Photon: Auto",
        `Auto-select model${this.selectedModel ? ` (last: ${this.selectedModel})` : ""}`
      );
    } else {
      this.statusUpdater(
        `$(sparkle) Photon: ${this.selectedModel || "no model"}`,
        this.selectedModel || "No model selected"
      );
    }
  }

  /** Post to the webview, swallowing errors if it was already disposed. */
  private safePost(msg: HostMessage): void {
    try {
      this.rawPost(msg);
    } catch (e) {
      this.output.appendLine(`[post] ${(e as Error).message}`);
    }
  }

  /* --------------------------------- init --------------------------------- */

  async initialize(): Promise<void> {
    // The expensive setup (machine profiling → spawns a platform GPU probe,
    // Ollama connect, MCP registration) must run exactly ONCE, even if the
    // webview is disposed and re-mounted and sends `ready` again. A re-mount
    // should only re-paint the fresh webview, never re-spawn processes or
    // re-open MCP connections. Concurrent `ready` messages await the same promise.
    if (!this.initPromise) this.initPromise = this.initializeOnce();
    await this.initPromise;
    this.postInit();
  }

  /** One-time heavy setup: machine profile, connect, MCP, index. */
  private async initializeOnce(): Promise<void> {
    // Always start with a fresh session in chat mode — never carry over old
    // messages, mode, or decisions from a previous session. The user can switch
    // to history or change modes via the UI.
    this.mode = "chat";
    this.lastDecision = null;
    this.session = this.freshSession();
    // Load checked-in project defaults (M5) before deriving effective settings.
    this.applyProjectConfig();
    this.watchProjectConfig();

    // Restore a model choice: a per-user project pin wins over the checked-in
    // config default (M5/M8).
    const pin = this.projectStore.pinnedModel() ?? this.projectConfig?.model;
    if (pin) {
      this.selectedModel = pin;
      this.autoSelect = false;
    }

    this.machine = await profileMachine().catch(() => null);
    await this.rebuildProviders();
    await this.connectAndLoad();
    await this.setupMcp();
    await this.configureIndex();
    this.recomputePlan();
    // Benchmark newly-seen models in the background — never blocks init (M7).
    void this.kickOffBench();
  }

  /* --------------------------- project config (M5) ---------------------------- */

  /** (Re)load `.photon/config.*` and apply file-level defaults. */
  private applyProjectConfig(): void {
    const result = loadProjectConfig();
    if (result.error) {
      this.output.appendLine(`[config] ${result.error}`);
      this.safePost({ type: "error", payload: { message: result.error } });
    }
    this.projectConfig = result.config;
    // The file may enable auto-approve for the project (it can enable, not disable).
    if (this.projectConfig?.autoApprove) this.autoApprove = true;
  }

  /** Watch the project config file so team edits apply without a reload. */
  private watchProjectConfig(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".photon/config.{json,yaml,yml}")
    );
    const reload = async () => {
      this.applyProjectConfig();
      await this.configureIndex();
      this.recomputePlan();
      this.pushPlan();
      this.pushConfig();
    };
    watcher.onDidCreate(() => void reload());
    watcher.onDidChange(() => void reload());
    watcher.onDidDelete(() => void reload());
    this.context.subscriptions.push(watcher);
  }

  /** Effective intelligence: an explicit user choice wins; else file default; else auto. */
  private effectiveIntelligence(): IntelligenceSetting {
    const setting = vscode.workspace
      .getConfiguration("photon")
      .get<IntelligenceSetting>("intelligence.level", "auto");
    if (setting !== "auto") return setting;
    return this.projectConfig?.intelligence ?? "auto";
  }

  /** Effective context override: a UI override wins; else the file default. */
  private effectiveNumCtx(): number | undefined {
    return this.userNumCtx ?? this.projectConfig?.numCtx;
  }

  /** Per-model context: per-model config wins over the global override. */
  private effectiveNumCtxFor(model: string): number | undefined {
    const per = this.modelConfigs.get(model);
    const perCtx = per?.numCtx ?? per?.llamacpp?.ctx;
    if (perCtx && perCtx > 0) return perCtx;
    return this.effectiveNumCtx();
  }

  /** Push the full current state to the (possibly freshly re-mounted) webview. */
  private postInit(): void {
    this.safePost({ type: "init", payload: this.buildInitPayload() });
    if (this.lastDecision) this.safePost({ type: "decision", payload: this.lastDecision });
    // Repaint cached provider model lists so settings cards don't look empty
    // after a panel close/reopen.
    for (const [id, models] of this.liveModelCache) {
      this.safePost({ type: "providerModels", payload: { id, models } });
    }
    this.updateStatusBar();
  }

  /** Ping every configured provider and, if any is reachable, load the model list. */
  private async connectAndLoad(): Promise<void> {
    this.syncClientConfig();
    this.reachable = await this.providers.ping();
    if (this.reachable) {
      await this.loadModels();
    } else {
      this.output.appendLine(`[connect] No provider reachable (Ollama at ${this.client.baseUrl} and cloud providers).`);
    }
  }

  /** Models visible in the picker for the active interface mode. Stacks are independent. */
  private modelsForUi(): ModelInfo[] {
    const isLocal = (m: ModelInfo) => !m.provider || m.provider === "ollama" || m.provider === "llamacpp";
    if (this.interfaceMode === "cloud") {
      return this.models.filter((m) => !isLocal(m));
    }
    return this.models.filter(isLocal);
  }

  /** Switch engine stacks. Re-validates the model selection for the new mode. */
  private async setInterfaceMode(mode: "local" | "cloud"): Promise<void> {
    if (mode === this.interfaceMode) return;
    this.interfaceMode = mode;
    await vscode.workspace
      .getConfiguration("photon")
      .update("interfaceMode", mode, vscode.ConfigurationTarget.Global);

    // The pinned/selected model must belong to the active stack.
    const visible = this.modelsForUi();
    if (!visible.some((m) => m.name === this.selectedModel)) {
      this.selectedModel = visible[0]?.name ?? "";
    }
    this.cancelActiveTurn();
    this.recomputePlan();
    this.safePost({
      type: "models",
      payload: { models: visible, selected: this.selectedModel, ollamaReachable: this.reachable },
    });
    this.pushPlan();
    this.pushConfig();
    this.updateStatusBar();
  }

  /** Re-check the connection + reload models, then notify the webview. */
  private async refresh(): Promise<void> {
    await this.connectAndLoad();
    this.recomputePlan();
    this.safePost({
      type: "models",
      payload: {
        models: this.modelsForUi(),
        selected: this.selectedModel,
        ollamaReachable: this.reachable,
      },
    });
    this.pushPlan();
    // A refreshed model list may make the embedding model (un)available, and may
    // surface new models to benchmark.
    await this.configureIndex();
    void this.kickOffBench();
  }

  async loadModels(): Promise<void> {
    try {
      // Cloud providers only report models the user explicitly added after a
      // successful test; Ollama reports everything installed locally.
      const all = await this.providers.listModels();

      this.models = all;
      const preferred = vscode.workspace
        .getConfiguration("photon")
        .get<string>("defaultModel", "");
      const stillExists = this.models.some((m) => m.name === this.selectedModel);
      if (!stillExists) {
        this.selectedModel =
          this.models.find((m) => m.name === preferred)?.name ??
          this.models[0]?.name ??
          "";
      }
      this.output.appendLine(`[models] loaded ${this.models.length} model(s) across ${this.providers.active().length} provider(s).`);
    } catch (e) {
      this.models = [];
      this.output.appendLine(`[models] ${(e as Error).message}`);
    }
  }

  /* --------------------------- cloud providers ---------------------------- */

  /** Models the user explicitly added to the picker after testing, per provider. */
  private addedModels(): ModelInfo[] {
    return this.context.globalState.get<ModelInfo[]>("photon.customModels") ?? [];
  }

  private async setAddedModels(models: ModelInfo[]): Promise<void> {
    await this.context.globalState.update("photon.customModels", models);
  }

  /** Fetch the models a provider's API exposes for THIS account's key and push
   *  them to the webview. A failed fetch (bad key, no quota, network) is
   *  reported through the providerModels error field so the settings card can
   *  show exactly why the connection didn't validate. */
  private async pushLiveModels(id: string): Promise<void> {
    const p = this.providers.all().find((x) => x.id === id);
    if (!p || !p.fetchLiveModels || !p.isConfigured()) return;
    try {
      const models = await p.fetchLiveModels();
      this.liveModelCache.set(id, models);
      this.safePost({ type: "providerModels", payload: { id, models } });
      this.output.appendLine(`[providers] ${id}: ${models.length} model(s) available to this key.`);
    } catch (e) {
      this.safePost({
        type: "providerModels",
        payload: { id, models: [], error: (e as Error).message },
      });
      this.output.appendLine(`[providers] ${id} live model list failed: ${(e as Error).message}`);
    }
  }

  /** Rebuild the provider set from settings + stored API keys. Keeps the same
   *  ProviderManager instance so the engine's reference stays valid. */
  private async rebuildProviders(): Promise<void> {
    const cloud = await this.buildCloudProviders();
    const llamacpp = await this.buildLlamaCppProvider();
    const locals: LLMProvider[] = [this.ollamaProvider];
    if (llamacpp) locals.push(llamacpp);
    this.providers.setProviders([...locals, ...cloud]);
    this.output.appendLine(
      `[providers] active: ${this.providers.active().map((p) => p.id).join(", ") || "none"}`
    );
  }

  /** Local llama.cpp server — OpenAI-compatible at /v1, no API key needed. */
  private async buildLlamaCppProvider(): Promise<LLMProvider | null> {
    const cfg = vscode.workspace.getConfiguration("photon");
    const baseUrl = cfg.get<string>("llamacpp.baseUrl", "http://localhost:8080");
    const normalized = (baseUrl || "http://localhost:8080").replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
    const enabled = cfg.get<boolean>("providers.llamacpp.enabled", false);
    const apiKey = (await this.context.secrets.get("photon.provider.llamacpp.apiKey")) ?? "";
    const models = this.addedModels()
      .filter((m) => m.provider === "llamacpp")
      .map((m) => ({
        id: m.name.startsWith("llamacpp:") ? m.name.slice("llamacpp:".length) : m.name,
        name: m.name,
        paramsB: m.paramsB,
        contextLength: m.contextLength,
        toolTrained: m.toolTrained,
        vision: m.vision,
        audio: m.audio,
        video: m.video,
        thinking: m.thinking,
        capabilities: m.capabilities,
        tier: m.tier,
      }));
    return new OpenAICompatProvider({
      id: "llamacpp",
      label: "llama.cpp",
      baseUrl: normalized,
      apiKey,
      enabled,
      models,
      requireApiKey: false,
    });
  }

  /** Build cloud provider instances from settings + secrets.
   *  Cloud catalogs start EMPTY: a model only appears in the picker after the
   *  user fetched their account's live model list, tested it, and added it.
   *  That way the dropdown reflects what the user's API key can actually use,
   *  not every model a provider publishes. */
  private async buildCloudProviders(): Promise<LLMProvider[]> {
    const cfg = vscode.workspace.getConfiguration("photon");
    const out: LLMProvider[] = [];

    const enabled = (id: string) => cfg.get<boolean>(`providers.${id}.enabled`, false);
    const apiKey = async (id: string) =>
      (await this.context.secrets.get(`photon.provider.${id}.apiKey`)) ?? "";

    /** Models the user explicitly added for a provider prefix ("gemini", …),
     *  converted to the ProviderModel shape the provider configs expect. */
    const addedFor = (id: string): ProviderModel[] =>
      this.addedModels()
        .filter((m) => m.provider === id)
        .map((m) => ({
          id: m.name.startsWith(`${id}:`) ? m.name.slice(id.length + 1) : m.name,
          name: m.name,
          paramsB: m.paramsB,
          contextLength: m.contextLength,
          toolTrained: m.toolTrained,
          vision: m.vision,
          audio: m.audio,
          video: m.video,
          thinking: m.thinking,
          capabilities: m.capabilities,
          tier: m.tier,
        }));

    // Google Gemini
    out.push(
      new GeminiProvider({
        apiKey: await apiKey("gemini"),
        enabled: enabled("gemini"),
        models: addedFor("gemini"),
      })
    );

    // Anthropic Claude
    out.push(
      new AnthropicProvider({
        apiKey: await apiKey("claude"),
        enabled: enabled("claude"),
        models: addedFor("claude"),
      })
    );

    // NVIDIA NIM (OpenAI-compatible)
    out.push(
      new OpenAICompatProvider({
        id: "nvidia",
        label: "NVIDIA NIM",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: await apiKey("nvidia"),
        enabled: enabled("nvidia"),
        models: addedFor("nvidia"),
      })
    );

    // OpenAI (OpenAI-compatible)
    out.push(
      new OpenAICompatProvider({
        id: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiKey: await apiKey("openai"),
        enabled: enabled("openai"),
        models: addedFor("openai"),
      })
    );

    // OpenRouter (OpenAI-compatible)
    out.push(
      new OpenAICompatProvider({
        id: "openrouter",
        label: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: await apiKey("openrouter"),
        enabled: enabled("openrouter"),
        models: addedFor("openrouter"),
        // Attribution headers OpenRouter asks for so usage shows on their dashboards.
        extraHeaders: { "HTTP-Referer": "https://github.com/photon-vscode", "X-Title": "Photon" },
      })
    );

    // OpenCode Zen (OpenAI-compatible gateway)
    out.push(
      new OpenAICompatProvider({
        id: "opencode",
        label: "OpenCode Zen",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: await apiKey("opencode"),
        enabled: enabled("opencode"),
        models: addedFor("opencode"),
      })
    );

    // Blackbox AI (OpenAI-compatible, key in body). No live model listing is
    // available, so keep the small curated catalog as suggestions; users can
    // still add model ids manually from the settings panel.
    out.push(
      new OpenAICompatProvider({
        id: "blackbox",
        label: "Blackbox AI",
        baseUrl: "https://api.blackbox.ai",
        apiKey: await apiKey("blackbox"),
        enabled: enabled("blackbox"),
        keyInBody: true,
        extraHeaders: { "Agent-Id": "photon" },
        models: [
          ...BLACKBOX_MODELS,
          // Skip manually-added ids already covered by the curated catalog.
          ...addedFor("blackbox").filter(
            (m) => !BLACKBOX_MODELS.some((b) => b.id === m.id)
          ),
        ],
      })
    );

    // Custom OpenAI-compatible endpoints (added via the settings UI)
    const custom = cfg.get<OpenAICompatConfig[]>("providers.custom", []);
    for (const c of custom) {
      if (!c.id || !c.baseUrl) continue;
      out.push(
        new OpenAICompatProvider({
          id: c.id,
          label: c.label || c.id,
          baseUrl: c.baseUrl,
          apiKey: c.apiKey || (await apiKey(c.id)),
          enabled: c.enabled !== false,
          models: addedFor(c.id),
          extraHeaders: c.extraHeaders,
          keyInBody: c.keyInBody,
        })
      );
    }

    return out;
  }

  /** Status of every provider for the settings UI. */
  private providerStatuses() {
    return this.providers.all().map((p) => ({
      id: p.id,
      label: p.label,
      enabled: p.enabled,
      configured: p.isConfigured(),
      modelCount: p.enabled && p.isConfigured() ? this.models.filter((m) => m.provider === p.id).length : 0,
    }));
  }

  /* --------------------------------- MCP (M11) -------------------------------- */

  /** Register configured MCP servers, connecting only those already approved. */
  private async setupMcp(): Promise<void> {
    const servers = this.readMcpConfig();
    await this.mcp.setConfigs(servers);
    for (const s of servers) {
      if (this.projectStore.isMcpApproved(s.id)) await this.mcp.connect(s.id);
    }
    this.pushMcpServers();
    this.pushTools();
  }

  private pushMcpServers(): void {
    this.safePost({ type: "mcpServers", payload: this.mcp.list() });
  }

  private async approveMcpServer(id: string): Promise<void> {
    await this.projectStore.approveMcp(id);
    await this.mcp.connect(id);
    this.pushMcpServers();
    this.pushTools();
  }

  private async revokeMcpServer(id: string): Promise<void> {
    await this.projectStore.revokeMcp(id);
    await this.mcp.disconnect(id);
    this.pushMcpServers();
    this.pushTools();
  }

  /* --------------------------- Photon Bench (M7) ------------------------------ */

  /** True while a chat turn is running — bench must not compete for the model. */
  private turnActive(): boolean {
    return !!this.turnAbort && !this.turnAbort.signal.aborted;
  }

  /** Benchmark any detected LOCAL model that has no stored result. Background + abortable. */
  private async kickOffBench(): Promise<void> {
    if (!this.reachable) return;
    const have = this.benchStore.byModel();
    // Bench is a local-hardware measurement — Ollama + llama.cpp both local.
    const todo = this.models.filter((m) => (m.provider === "ollama" || m.provider === "llamacpp") && !have.has(m.name));
    for (const m of todo) {
      // Stop the moment a turn starts or the connection drops — don't queue work
      // that would contend with the user's request for the model.
      if (!this.reachable || this.turnActive()) return;
      await this.runBenchFor(m.name);
    }
  }

  /** Run Photon Bench for one model, persist the result, and notify the webview. */
  private async runBenchFor(model: string): Promise<void> {
    if (!model || !this.reachable || this.turnActive()) return;
    const abort = new AbortController();
    // A benchmark and a chat turn shouldn't fight for the model; run bench only
    // when idle, and let a new turn cancel it.
    this.benchAbort?.abort();
    this.benchAbort = abort;
    this.safePost({ type: "benchStatus", payload: { model, phase: "running" } });
    try {
      const result = await runBench(this.providers, model, {
        hardwareClass: this.machine?.tier ?? "unknown",
        quantization: this.models.find((m) => m.name === model)?.quantization,
        signal: abort.signal,
        onProgress: (msg) => this.output.appendLine(`[bench ${model}] ${msg}`),
      });
      await this.benchStore.upsert(result);
      this.safePost({ type: "benchStatus", payload: { model, phase: "done" } });
      this.safePost({ type: "benchResults", payload: [...this.benchStore.byModel().values()] });
    } catch (e) {
      if (abort.signal.aborted) return;
      this.safePost({ type: "benchStatus", payload: { model, phase: "error", message: (e as Error).message } });
    } finally {
      if (this.benchAbort === abort) this.benchAbort = undefined;
    }
  }

  /* --------------------------- Indexing (M10) --------------------------------- */

  private embeddingModelName(): string {
    return vscode.workspace
      .getConfiguration("photon")
      .get<string>("index.embeddingModel", DEFAULT_EMBEDDING_MODEL);
  }

  private indexingEnabled(): boolean {
    const setting = vscode.workspace.getConfiguration("photon").get<boolean>("index.enabled", false);
    return setting || !!this.projectConfig?.indexing;
  }

  /** (Re)configure the index service from settings + current model availability. */
  private async configureIndex(): Promise<void> {
    const model = this.embeddingModelName();
    // An embedding model is "available" if a local model (Ollama or llama.cpp) matches it.
    const available = this.models.some(
      (m) => (m.provider === "ollama" || m.provider === "llamacpp") && (m.name === model || m.name.startsWith(`${model}:`) || m.name === `llamacpp:${model}` || m.name.startsWith(`llamacpp:${model}:`))
    );
    await this.index.configure(this.indexingEnabled(), model, available);
  }

  /* ------------------------------ view messages --------------------------- */

  /** Entry point from the webview. Never throws — a failed handler is reported,
   *  not allowed to crash the extension host. */
  async handleMessage(msg: ViewMessage): Promise<void> {
    try {
      await this.route(msg);
    } catch (e) {
      const err = e as Error;
      this.output.appendLine(`[error] ${err?.stack ?? err}`);
      this.safePost({ type: "error", payload: { message: `Something went wrong: ${err?.message ?? err}` } });
      this.safePost({ type: "status", payload: { kind: "idle" } });
    }
  }

  private async route(msg: ViewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        return this.initialize();
      case "sendPrompt":
        return this.onPrompt(msg.payload.text, msg.payload.attachments);
      case "cancel":
        this.cancelActiveTurn();
        return;
      case "setModel":
        // Manually picking a model turns off per-request auto-selection for the
        // session (but is not a persisted project pin — that's `pinModel`).
        this.autoSelect = false;
        this.selectedModel = msg.payload.model;
        this.recomputePlan();
        this.pushPlan();
        this.pushConfig();
        return;
      case "setAutoSelect":
        this.autoSelect = msg.payload.enabled;
        if (this.autoSelect) void this.projectStore.setPinnedModel(undefined);
        this.pushConfig();
        return;
      case "pinModel":
        // Persist a project-level pin (Auto Mode override, M8/M12).
        this.autoSelect = false;
        this.selectedModel = msg.payload.model;
        await this.projectStore.setPinnedModel(msg.payload.model);
        this.recomputePlan();
        this.pushPlan();
        this.pushConfig();
        return;
      case "runBench":
        if (msg.payload.model) await this.runBenchFor(msg.payload.model);
        else await this.kickOffBench();
        return;
      case "setIndexingEnabled":
        await vscode.workspace
          .getConfiguration("photon")
          .update("index.enabled", msg.payload.enabled, vscode.ConfigurationTarget.Global);
        await this.configureIndex();
        this.pushConfig();
        return;
      case "reindex":
        await this.index.reindex();
        return;
      case "approveMcpServer":
        return this.approveMcpServer(msg.payload.id);
      case "revokeMcpServer":
        return this.revokeMcpServer(msg.payload.id);
      case "setMode":
        this.mode = msg.payload.mode;
        this.session.mode = msg.payload.mode;
        this.recomputePlan();
        this.pushPlan();
        return;
      case "setContextWindow":
        this.userNumCtx = msg.payload.numCtx || undefined;
        this.recomputePlan();
        this.pushPlan();
        this.pushConfig();
        return;
      case "setAutoApprove":
        this.autoApprove = msg.payload.enabled;
        await vscode.workspace
          .getConfiguration("photon")
          .update("tools.autoApprove", msg.payload.enabled, vscode.ConfigurationTarget.Global);
        this.pushConfig();
        return;
      case "setAdaptiveEnabled":
        await vscode.workspace
          .getConfiguration("photon")
          .update("adaptive.enabled", msg.payload.enabled, vscode.ConfigurationTarget.Global);
        this.recomputePlan();
        this.pushPlan();
        this.pushConfig();
        return;
      case "setIntelligence":
        await vscode.workspace
          .getConfiguration("photon")
          .update("intelligence.level", msg.payload.level, vscode.ConfigurationTarget.Global);
        this.recomputePlan();
        this.pushPlan();
        this.pushConfig();
        return;
      case "setWebSearchProvider":
        await vscode.workspace
          .getConfiguration("photon")
          .update("webSearch.provider", msg.payload.provider, vscode.ConfigurationTarget.Global);
        this.pushConfig();
        return;
      case "setProviderEnabled":
        await vscode.workspace
          .getConfiguration("photon")
          .update(
            `providers.${msg.payload.id}.enabled`,
            msg.payload.enabled,
            vscode.ConfigurationTarget.Global
          );
        await this.rebuildProviders();
        await this.refresh();
        this.pushConfig();
        // Connecting a provider validates its key against the live API and
        // pushes the models this account can actually use.
        if (msg.payload.enabled) await this.pushLiveModels(msg.payload.id);
        return;
      case "setProviderApiKey":
        if (msg.payload.apiKey) {
          await this.context.secrets.store(
            `photon.provider.${msg.payload.id}.apiKey`,
            msg.payload.apiKey
          );
        } else {
          await this.context.secrets.delete(`photon.provider.${msg.payload.id}.apiKey`);
        }
        await this.rebuildProviders();
        await this.refresh();
        this.pushConfig();
        // A saved key is a new connection: validate it and list the models
        // available to THIS account. Failures (bad key, no access) surface in
        // the provider card via the providerModels error field.
        if (msg.payload.apiKey) await this.pushLiveModels(msg.payload.id);
        else {
          this.liveModelCache.delete(msg.payload.id);
          this.safePost({ type: "providerModels", payload: { id: msg.payload.id, models: [] } });
        }
        return;
      case "setInterfaceMode":
        await this.setInterfaceMode(msg.payload.mode);
        return;
      case "newSession": {
        // Swap the session SYNCHRONOUSLY, before any await. Message handlers
        // run fire-and-forget and interleave at their await points, so awaiting
        // the persistence write first allowed a fast-follow `sendPrompt` to pin
        // the OLD session — e.g. "Hi" in a fresh chat continuing a previous
        // conversation invisibly.
        this.cancelActiveTurn();
        const previous = this.session;
        this.mode = "chat";
        this.lastDecision = null;
        this.session = this.freshSession();
        this.recomputePlan();
        this.safePost({ type: "sessionLoaded", payload: this.session });
        // Persist the session we just left AFTER the swap; correctness no
        // longer depends on when this write finishes.
        await this.persistActiveSession(previous);
        this.pushPlan();
        this.pushSessionList();
        return;
      }
      case "switchSession":
        await this.switchSession(msg.payload.id);
        return;
      case "deleteSession":
        await this.deleteSession(msg.payload.id);
        return;
      case "refreshModels":
        return this.refresh();
      case "toolApproval": {
        const resolve = this.pendingApprovals.get(msg.payload.callId);
        if (resolve) {
          this.pendingApprovals.delete(msg.payload.callId);
          if (msg.payload.remember) this.autoApprove = true;
          resolve(msg.payload.approved);
        }
        return;
      }
      case "fetchProviderModels": {
        const p = this.providers.all().find((p) => p.id === msg.payload.id);
        if (!p) return;
        if (!p.fetchLiveModels) {
          this.safePost({
            type: "providerModels",
            payload: { id: p.id, models: [], error: "This provider does not support live model listing." },
          });
          return;
        }
        await this.pushLiveModels(p.id);
        return;
      }
      case "testModel": {
        const { providerId, model } = msg.payload;
        const bare = model.name.startsWith(`${providerId}:`)
          ? model.name.slice(providerId.length + 1)
          : model.name;
        // Report with the prefixed name so the webview keys results correctly.
        const resultModel: ModelInfo = { ...model, name: `${providerId}:${bare}`, provider: providerId };

        const p = this.providers.all().find((x) => x.id === providerId);
        if (!p) {
          this.safePost({
            type: "modelTestResult",
            payload: { providerId, model: resultModel, ok: false, error: `Provider ${providerId} not found` },
          });
          return;
        }
        if (!p.isConfigured()) {
          this.safePost({
            type: "modelTestResult",
            payload: { providerId, model: resultModel, ok: false, error: `${p.label} has no API key set` },
          });
          return;
        }
        try {
          const start = Date.now();
          const stream = p.chatStream(
            { model: bare, messages: [{ role: "user", content: "Reply with exactly: ok" }] },
            AbortSignal.timeout(20_000)
          );
          let responded = false;
          for await (const chunk of stream) {
            if (chunk.message?.content || chunk.done) {
              responded = true;
              break;
            }
          }
          if (!responded) throw new Error("The model returned an empty response.");
          this.safePost({
            type: "modelTestResult",
            payload: { providerId, model: resultModel, ok: true, latencyMs: Date.now() - start },
          });
        } catch (e) {
          this.safePost({
            type: "modelTestResult",
            payload: { providerId, model: resultModel, ok: false, error: (e as Error).message },
          });
        }
        return;
      }
      case "addAvailableModel": {
        const { providerId, model } = msg.payload;
        const bare = model.name.startsWith(`${providerId}:`)
          ? model.name.slice(providerId.length + 1)
          : model.name;
        const prefixed = `${providerId}:${bare}`;
        const added = this.addedModels();
        if (!added.some((m) => m.name === prefixed)) {
          added.push({ ...customModel(bare, providerId), ...model, name: prefixed, provider: providerId });
          await this.setAddedModels(added);
          // Rebuild so the owning provider's catalog includes the new model,
          // then refresh to push the updated picker list to the webview.
          await this.rebuildProviders();
          await this.refresh();
          this.pushConfig();
        }
        return;
      }
      case "removeAvailableModel": {
        const name = msg.payload.name;
        const added = this.addedModels();
        const next = added.filter((m) => m.name !== name);
        if (next.length !== added.length) {
          await this.setAddedModels(next);
          // If the removed model was selected, drop the selection.
          if (this.selectedModel === name) this.selectedModel = "";
          await this.rebuildProviders();
          await this.refresh();
          this.pushConfig();
        }
        return;
      }
      case "addCustomProvider": {
        const { label, baseUrl, apiKey } = msg.payload;
        if (!label.trim() || !baseUrl.trim()) return;
        const cfg = vscode.workspace.getConfiguration("photon");
        const existing = cfg.get<OpenAICompatConfig[]>("providers.custom", []);
        // Derive a stable unique id from the label (used as the model prefix).
        let id = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom";
        while (existing.some((c) => c.id === id)) id = `${id}-2`;
        await cfg.update(
          "providers.custom",
          [...existing, { id, label: label.trim(), baseUrl: baseUrl.trim(), enabled: true }],
          vscode.ConfigurationTarget.Global
        );
        if (apiKey?.trim()) {
          await this.context.secrets.store(`photon.provider.${id}.apiKey`, apiKey.trim());
        }
        await this.rebuildProviders();
        await this.refresh();
        this.pushConfig();
        // Validate the new connection right away.
        await this.pushLiveModels(id);
        return;
      }
      case "removeCustomProvider": {
        const id = msg.payload.id;
        const cfg = vscode.workspace.getConfiguration("photon");
        const existing = cfg.get<OpenAICompatConfig[]>("providers.custom", []);
        if (!existing.some((c) => c.id === id)) return;
        await cfg.update(
          "providers.custom",
          existing.filter((c) => c.id !== id),
          vscode.ConfigurationTarget.Global
        );
        await this.context.secrets.delete(`photon.provider.${id}.apiKey`);
        // Also drop any models the user had added under this provider.
        await this.setAddedModels(this.addedModels().filter((m) => m.provider !== id));
        this.liveModelCache.delete(id);
        await this.rebuildProviders();
        await this.refresh();
        this.pushConfig();
        return;
      }
      case "openDiagnostics":
        return this.runDiagnostics();
      case "setPerModelConfig": {
        const { model, config } = msg.payload;
        if (!model) return;
        await this.modelConfigs.set(model, config);
        this.pushModelConfigs();
        // Recompute plan if this is the selected model — context etc may have changed
        if (model === this.selectedModel || model === this.plan?.model) {
          this.recomputePlan();
          this.pushPlan();
        }
        return;
      }
      case "removePerModelConfig": {
        await this.modelConfigs.remove(msg.payload.model);
        this.pushModelConfigs();
        this.recomputePlan();
        this.pushPlan();
        return;
      }
    }
  }

  /* -------------------------------- turns --------------------------------- */

  /** Abort the in-flight turn and release any awaited approval promises. */
  private cancelActiveTurn(): void {
    this.turnAbort?.abort();
    // Resolve any pending approval prompts as "denied" so the tool call that is
    // awaiting them unwinds instead of hanging forever.
    for (const [id, resolve] of this.pendingApprovals) {
      this.pendingApprovals.delete(id);
      resolve(false);
    }
  }

  private promptQueue: Array<{ text: string; attachments?: Attachment[] }> = [];
  private drainingQueue = false;
  private async onPrompt(text: string, attachments?: Attachment[]): Promise<void> {
    // Inbox-style queue (audit) — instead of erroring, enqueue and drain sequentially.
    if (this.turnAbort && !this.turnAbort.signal.aborted) {
      this.promptQueue.push({ text, attachments });
      this.safePost({ type: "status", payload: { kind: "running", detail: `Queued (${this.promptQueue.length}) — will run after current turn.` } });
      return;
    }
    await this.runPrompt(text, attachments);
    // Drain queued prompts (preserves order, like harness Inbox.claim)
    if (this.promptQueue.length && !this.drainingQueue) {
      this.drainingQueue = true;
      while (this.promptQueue.length) {
        const next = this.promptQueue.shift()!;
        await this.runPrompt(next.text, next.attachments);
      }
      this.drainingQueue = false;
    }
  }
  private async runPrompt(text: string, attachments?: Attachment[]): Promise<void> {
    if (this.modelsForUi().length === 0) {
      this.safePost({
        type: "error",
        payload: {
          message:
            this.interfaceMode === "cloud"
              ? "No cloud models available. Connect a provider and add a tested model in Settings → Cloud providers."
              : "No models available. Connect Ollama (check it's running) or add and test a cloud provider model in Settings → Cloud providers.",
        },
      });
      return;
    }

    // A running benchmark must not compete with a real turn for the model.
    this.benchAbort?.abort();

    // Auto Mode (M8): choose the model + plan for THIS request. When the user
    // has a model pinned/selected, that wins but is still ranked for transparency.
    const cfg = vscode.workspace.getConfiguration("photon");
    // Per-model ctx: if a model has a stored numCtx/llamacpp.ctx, honor it for THIS turn.
    const perModelCtx = (m: string) => this.effectiveNumCtxFor(m);
    let { decision, plan } = planRequest({
      prompt: text,
      mode: this.mode,
      attachmentCount: attachments?.length ?? 0,
      models: this.modelsForUi(),
      machine: this.machine,
      benchByModel: this.benchStore.byModel(),
      pinnedModel: this.autoSelect ? undefined : this.selectedModel || undefined,
      intelligence: this.effectiveIntelligence(),
      reserveOutputTokens: cfg.get<number>("context.reserveOutputTokens", 1024),
      adaptiveEnabled: this.adaptiveEnabled(),
      userNumCtx: this.effectiveNumCtx(),
    });
    if (!plan) {
      this.safePost({
        type: "error",
        payload: { message: "No usable model/plan. Check that Ollama is running and a model is selected." },
      });
      return;
    }
    // Rebuild plan with per-model ctx if that model carries an override (e.g. llamacpp -c 32768)
    const perCtx = perModelCtx(plan.model);
    if (perCtx && perCtx !== plan.numCtx) {
      const reb = planRequest({
        prompt: text,
        mode: this.mode,
        attachmentCount: attachments?.length ?? 0,
        models: this.modelsForUi(),
        machine: this.machine,
        benchByModel: this.benchStore.byModel(),
        pinnedModel: plan.model,
        intelligence: this.effectiveIntelligence(),
        reserveOutputTokens: cfg.get<number>("context.reserveOutputTokens", 1024),
        adaptiveEnabled: this.adaptiveEnabled(),
        userNumCtx: perCtx,
      });
      if (reb.plan) { plan = reb.plan; decision = reb.decision; }
    }
    // Reflect the chosen model in the UI (auto-selection may differ from the picker).
    if (this.autoSelect && decision.chosenModel) this.selectedModel = decision.chosenModel;
    this.plan = plan;
    // Cloud mode: swap the adaptive plan for the permissive cloud plan (but keep per-model ctx if set).
    if (this.interfaceMode === "cloud") {
      const m = this.models.find((x) => x.name === plan.model) ?? this.modelsForUi()[0];
      if (m) {
        const cPlan = this.cloudPlan(m, this.mode);
        const pCtx = this.modelConfigs.get(m.name)?.numCtx ?? this.modelConfigs.get(m.name)?.llamacpp?.ctx;
        if (pCtx && pCtx > 0) { cPlan.numCtx = pCtx; cPlan.contextWindow = pCtx; }
        this.plan = cPlan;
      }
    }
    this.lastDecision = decision;
    this.safePost({ type: "decision", payload: decision });
    this.pushPlan();
    this.updateStatusBar();

    // Pin the target session for this turn so a mid-stream session switch
    // can't cause late callbacks to land in the wrong conversation.
    const session = this.session;
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: text,
      attachments: attachments?.length ? attachments : undefined,
      createdAt: Date.now(),
    };
    session.messages.push(userMsg);
    this.safePost({ type: "messageAppended", payload: userMsg });
    if (session.messages.length === 1) {
      session.title = text.slice(0, 40);
    }
    await this.persistActiveSession(session);

    const abort = new AbortController();
    this.turnAbort = abort;
    this.safePost({ type: "status", payload: { kind: "thinking" } });

    const emitter = this.makeEmitter(session);
    try {
      if (this.interfaceMode === "cloud") {
        await this.runCloudTurn(session, plan, emitter, abort.signal);
      } else {
        await this.engine.runTurn(session, plan, emitter, abort.signal);
      }
    } catch (e) {
      this.safePost({ type: "error", payload: { message: (e as Error).message } });
    } finally {
      // Only clear the shared reference if this turn still owns it.
      if (this.turnAbort === abort) this.turnAbort = undefined;
      this.safePost({ type: "status", payload: { kind: "idle" } });
      this.safePost({ type: "generationStats", payload: null });
      // Finalize messages left mid-stream by an abort/error: without this a
      // reload shows a perpetual spinner, and empty assistant bubbles created
      // before any content arrived would linger forever.
      let touched = false;
      for (const m of session.messages) {
        if (m.streaming) {
          m.streaming = false;
          m.notice ??= "Stopped.";
          touched = true;
        }
      }
      const before = session.messages.length;
      session.messages = session.messages.filter(
        (m) => !(m.role === "assistant" && !m.content.trim() && !m.toolCalls?.length)
      );
      touched = touched || session.messages.length !== before;
      await this.persistActiveSession(session);
      if (touched) this.safePost({ type: "sessionLoaded", payload: session });
      this.pushSessionList();
    }
  }

  /** Bridge engine events to webview messages and record them in the given session.
   *  Events are ALWAYS recorded into the pinned session (history stays correct),
   *  but only POSTED to the webview while that session is still the active one —
   *  after a new-chat/switch, a draining aborted turn must not paint its output
   *  into the conversation that replaced it. */
  private makeEmitter(session: SessionState): TurnEmitter {
    let current: ChatMessage | null = null;
    const isLive = (): boolean => this.session === session;
    const ensure = (id: string): ChatMessage => {
      if (!current || current.id !== id) {
        current = {
          id,
          role: "assistant",
          content: "",
          toolCalls: [],
          createdAt: Date.now(),
          streaming: true,
        };
        session.messages.push(current);
      }
      return current;
    };
    return {
      onAssistantStart: (id) => {
        const m = ensure(id);
        if (!isLive()) return;
        this.safePost({ type: "messageAppended", payload: { ...m } });
      },
      onDelta: (id, delta) => {
        const m = ensure(id);
        m.content += delta;
        if (!isLive()) return;
        this.safePost({ type: "messageDelta", payload: { id, delta } });
      },
      onContent: (id, content) => {
        const m = ensure(id);
        m.content = content;
        if (!isLive()) return;
        this.safePost({ type: "messageAppended", payload: { ...m } });
      },
      onAssistantCancel: (id) => {
        // An empty generation: remove the bubble entirely (nothing to show).
        const idx = session.messages.findIndex((m) => m.id === id);
        if (idx !== -1) session.messages.splice(idx, 1);
        current = null;
        if (!isLive()) return;
        this.safePost({ type: "messageRemoved", payload: { id } });
      },
      onPhase: (phase, detail) => {
        if (!isLive()) return;
        this.safePost({
          type: "status",
          payload: { kind: phase === "thinking" ? "thinking" : "running", detail },
        });
      },
      onToolCall: (id, call) => {
        const m = ensure(id);
        m.toolCalls = [...(m.toolCalls ?? []), call];
        if (!isLive()) return;
        this.safePost({ type: "toolUpdate", payload: { messageId: id, call } });
      },
      onToolUpdate: (id, call) => {
        const m = ensure(id);
        m.toolCalls = (m.toolCalls ?? []).map((c) => (c.id === call.id ? call : c));
        if (!m.toolCalls.some((c) => c.id === call.id)) m.toolCalls.push(call);
        if (!isLive()) return;
        this.safePost({ type: "toolUpdate", payload: { messageId: id, call } });
      },
      onUsage: (usage) => {
        if (!isLive()) return;
        this.safePost({ type: "tokenUsage", payload: usage });
      },
      onGenerationStats: (stats) => {
        if (!isLive()) return;
        this.safePost({ type: "generationStats", payload: stats });
      },
      onDone: (id, notice) => {
        // Find (don't ensure) — the message may have been cancelled/removed.
        const m = session.messages.find((x) => x.id === id);
        if (m) {
          m.streaming = false;
          if (notice) m.notice = notice;
        }
        current = null;
        if (!isLive()) return;
        this.safePost({ type: "messageDone", payload: { id } });
      },
      onError: (message) => {
        if (!isLive()) return;
        this.safePost({ type: "error", payload: { message } });
      },
    };
  }

  /* ------------------------------ cloud mode ------------------------------ */

  /** A permissive plan for cloud models: the model's own context window,
   *  native tool calling, no tool caps, no adaptive tuning. */
  private cloudPlan(model: ModelInfo, mode: Mode): AdaptivePlan {
    const contextWindow = model.contextLength ?? 128_000;
    return {
      model: model.name,
      mode,
      contextWindow,
      numCtx: contextWindow,
      temperature: 0.3,
      topP: 0.95,
      maxOutputTokens: Math.floor(contextWindow * 0.25),
      toolProtocol: "native",
      maxTools: 100,
      allowParallelTools: false,
      intelligence: "max",
      intelligenceAuto: false,
      rationale: ["Cloud mode: direct native tool calling — no adaptive limits."],
    };
  }

  /** Run one turn through the independent cloud engine (native tool calling). */
  private async runCloudTurn(
    session: SessionState,
    plan: AdaptivePlan,
    emitter: TurnEmitter,
    signal: AbortSignal
  ): Promise<void> {
    const model = this.models.find((m) => m.name === plan.model);
    if (!model) {
      this.safePost({ type: "error", payload: { message: `Model "${plan.model}" is no longer available.` } });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceMap = await buildWorkspaceMap(root).catch(() => undefined);
    const system = buildCloudSystemPrompt({
      mode: plan.mode,
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      workspaceMap,
    });
    await runCloudTurn({
      provider: this.providers,
      model: plan.model,
      system,
      history: cloudHistoryFromSession(session.messages),
      tools: cloudTools(),
      contextWindow: model.contextLength ?? 128_000,
      ctx: this.buildToolContext(signal),
      emitter,
      signal,
    });
  }

  /* ------------------------------ tool context ---------------------------- */

  private buildToolContext(signal: AbortSignal): ToolContext {
    return {
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      signal,
      log: (m) => this.output.appendLine(`[tool] ${m}`),
      webSearchProvider: vscode.workspace
        .getConfiguration("photon")
        .get<"duckduckgo" | "none">("webSearch.provider", "duckduckgo"),
      requestApproval: (call) => this.requestApproval(call),
      findFiles: (query, maxResults) => this.findFiles(query, maxResults),
      // Scales every tool's output budget: tiny models get tight clamps that
      // protect their context window; strong/cloud models get generous ones so
      // results are never needlessly truncated.
      capability: this.plan?.intelligence ?? "medium",
      getDiagnostics: (absPath) => this.collectDiagnostics(absPath),
      todos: [],
    };
  }

  /** Current editor problems mapped to compact, model-friendly records. */
  private async collectDiagnostics(absPath?: string): Promise<DiagnosticInfo[]> {
    const out: DiagnosticInfo[] = [];
    try {
      const all = vscode.languages.getDiagnostics();
      for (const [uri, diags] of all) {
        if (uri.scheme !== "file") continue;
        if (absPath && uri.fsPath !== absPath) continue;
        for (const d of diags) {
          out.push({
            file: vscode.workspace.asRelativePath(uri, false),
            line: d.range.start.line + 1,
            col: d.range.start.character + 1,
            severity:
              d.severity === vscode.DiagnosticSeverity.Error
                ? "error"
                : d.severity === vscode.DiagnosticSeverity.Warning
                  ? "warning"
                  : "info",
            message: d.message.split("\n")[0],
            source: d.source,
          });
          if (out.length >= 500) return out;
        }
      }
    } catch (e) {
      this.output.appendLine(`[tool] diagnostics failed: ${(e as Error).message}`);
    }
    return out;
  }

  /** Native, index-backed filename search (fast even on large repos).
   *  Accepts a plain substring ("button") or a glob (e.g. a "**" prefix with
   *  "*.test.ts"). */
  private async findFiles(query: string, maxResults: number): Promise<string[]> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) return [];
    const isGlob = /[*?]/.test(query);
    // Globs pass through (anchored under ** when the pattern has no slash);
    // plain text becomes a case-insensitive substring match on the path.
    const glob = isGlob
      ? query.includes("/")
        ? query
        : `**/${query}`
      : `**/*${query}*`;
    const exclude = "**/{node_modules,.git,dist,out,.venv,__pycache__,.next,build}/**";
    const uris = await vscode.workspace.findFiles(glob, exclude, maxResults);
    return uris
      .map((u) => vscode.workspace.asRelativePath(u, false))
      .sort((a, b) => a.length - b.length);
  }

  private requestApproval(call: ToolCall): Promise<boolean> {
    if (this.autoApprove || !call.sideEffecting) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(call.id, resolve);
      this.safePost({
        type: "toolApprovalRequest",
        payload: { messageId: "", call },
      });
    });
  }

  /* -------------------------------- helpers ------------------------------- */

  private recomputePlan(): void {
    const model = this.models.find((m) => m.name === this.selectedModel);
    if (!model) {
      this.plan = null;
      return;
    }
    const perCtx = this.effectiveNumCtxFor(model.name);
    // Cloud mode bypasses the adaptive orchestrator entirely.
    if (this.interfaceMode === "cloud") {
      const p = this.cloudPlan(model, this.mode);
      if (perCtx && perCtx > 0) { p.numCtx = perCtx; p.contextWindow = perCtx; }
      this.plan = p;
      return;
    }
    const cfg = vscode.workspace.getConfiguration("photon");
    this.plan = buildPlan({
      model,
      machine: this.machine,
      mode: this.mode,
      userNumCtx: perCtx ?? this.effectiveNumCtx(),
      intelligence: this.effectiveIntelligence(),
      reserveOutputTokens: cfg.get<number>("context.reserveOutputTokens", 1024),
      adaptiveEnabled: this.adaptiveEnabled(),
    });
  }

  private pushPlan(): void {
    if (this.plan) this.safePost({ type: "planUpdated", payload: this.plan });
  }

  private adaptiveEnabled(): boolean {
    return vscode.workspace.getConfiguration("photon").get<boolean>("adaptive.enabled", true);
  }

  private buildConfig(): PhotonConfig {
    const cfg = vscode.workspace.getConfiguration("photon");
    return {
      autoApprove: this.autoApprove,
      adaptiveEnabled: this.adaptiveEnabled(),
      webSearchProvider: cfg.get<"duckduckgo" | "none">("webSearch.provider", "duckduckgo"),
      ollamaBaseUrl: this.client.baseUrl,
      llamacppBaseUrl: cfg.get<string>("llamacpp.baseUrl", "http://localhost:8080"),
      numCtxOverride: this.effectiveNumCtx() ?? 0,
      intelligence: this.effectiveIntelligence(),
      autoSelectModel: this.autoSelect,
      indexingEnabled: this.indexingEnabled(),
      embeddingModel: this.embeddingModelName(),
      providers: this.providerStatuses(),
      interfaceMode: this.interfaceMode,
    };
  }

  private pushConfig(): void {
    this.safePost({ type: "config", payload: this.buildConfig() });
    this.updateStatusBar();
  }

  private toolSummaries(): ToolSummary[] {
    return this.registry
      .all()
      .map((t) => ({ name: t.spec.name, summary: t.spec.summary, sideEffecting: t.spec.sideEffecting }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Re-push the tool list (changes when MCP servers connect/disconnect). */
  private pushTools(): void {
    this.safePost({ type: "tools", payload: this.toolSummaries() });
  }

  private buildInitPayload() {
    return {
      session: this.session,
      sessions: this.sessionStore.summaries(),
      models: this.modelsForUi(),
      selectedModel: this.selectedModel,
      mode: this.mode,
      machine: this.machine,
      plan: this.plan,
      ollamaReachable: this.reachable,
      config: this.buildConfig(),
      tools: this.toolSummaries(),
      benchResults: [...this.benchStore.byModel().values()],
      indexStatus: this.index.getStatus(),
      mcpServers: this.mcp.list(),
      modelConfigs: this.modelConfigs.all(),
    };
  }

  private pushModelConfigs(): void {
    this.safePost({ type: "modelConfigs", payload: this.modelConfigs.all() });
  }

  private freshSession(): SessionState {
    const now = Date.now();
    return {
      id: randomUUID(),
      title: "New chat",
      mode: this.mode,
      model: this.selectedModel,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async switchSession(id: string): Promise<void> {
    if (id === this.session.id) return;
    this.cancelActiveTurn();
    const target = this.sessionStore.get(id);
    if (!target) return;
    const previous = this.session;
    // Reassign synchronously (same rule as newSession): a prompt sent while we
    // persist must land in the TARGET session, not the one switched away from.
    this.loadSession(target);
    await this.persistActiveSession(previous);
    this.pushSessionList();
  }

  private async deleteSession(id: string): Promise<void> {
    // Move off the doomed session BEFORE awaiting its removal — otherwise a
    // prompt arriving during the await would target (and re-persist) a deleted
    // session as a zombie.
    if (id === this.session.id) {
      this.cancelActiveTurn();
      const next = this.sessionStore.loadAll().find((s) => s.id !== id);
      if (next) {
        this.loadSession(next);
      } else {
        this.mode = "chat";
        this.loadSession(this.freshSession());
      }
    }
    await this.sessionStore.remove(id);
    this.pushSessionList();
  }

  /** Swap the active session in-place and notify the webview. Does not persist. */
  private loadSession(target: SessionState): void {
    this.session = target;
    this.mode = target.mode;
    if (this.modelsForUi().some((m) => m.name === target.model)) {
      this.selectedModel = target.model;
    }
    this.recomputePlan();
    this.safePost({ type: "sessionLoaded", payload: this.session });
    this.pushPlan();
    this.safePost({
      type: "models",
      payload: { models: this.modelsForUi(), selected: this.selectedModel, ollamaReachable: this.reachable },
    });
  }

  private async persistActiveSession(session: SessionState = this.session): Promise<void> {
    if (session.messages.length === 0) return;
    // Bound in-memory + on-disk growth for very long-running sessions.
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages.splice(0, session.messages.length - MAX_SESSION_MESSAGES);
    }
    session.updatedAt = Date.now();
    await this.sessionStore.upsert(pruneInlineImages(session));
  }

  private pushSessionList(): void {
    this.safePost({
      type: "sessionList",
      payload: { sessions: this.sessionStore.summaries(), activeId: this.session.id },
    });
  }

  private readMcpConfig(): McpServerConfig[] {
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) return [];
      const mcpPath = vscode.Uri.joinPath(root, ".vscode", "mcp.json");
      const fs = require("node:fs") as typeof import("node:fs");
      const raw = fs.readFileSync(mcpPath.fsPath, "utf8");
      const json = JSON.parse(raw) as {
        servers?: Record<
          string,
          { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }
        >;
      };
      const out: McpServerConfig[] = [];
      for (const [id, v] of Object.entries(json.servers ?? {})) {
        if (typeof v.url === "string") {
          out.push({ id, transport: "http", url: v.url, headers: v.headers });
        } else if (typeof v.command === "string") {
          out.push({ id, transport: "stdio", command: v.command, args: v.args, env: v.env });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async runDiagnostics(): Promise<void> {
    const reachable = await this.client.ping();
    this.output.appendLine("=== Photon diagnostics ===");
    this.output.appendLine(`Ollama (${this.client.baseUrl}): ${reachable ? "reachable" : "NOT reachable"}`);
    for (const p of this.providers.all()) {
      const ok = await p.ping().catch(() => false);
      this.output.appendLine(
        `Provider ${p.id} (${p.label}): ${p.enabled ? "enabled" : "disabled"}, ` +
          `${p.isConfigured() ? "configured" : "NOT configured"}, ${ok ? "reachable" : "NOT reachable"}`
      );
    }
    if (this.machine) {
      const g = this.machine.gpu;
      this.output.appendLine(
        `Machine: ${this.machine.tier} tier, ${(this.machine.totalRamBytes / 1024 ** 3).toFixed(1)} GB RAM, ${this.machine.cpuCores} cores` +
          (g ? `, GPU ${g.name}` : ", no GPU detected")
      );
    }
    for (const m of this.models) {
      this.output.appendLine(
        `Model ${m.name}: ${m.tier}, ${m.paramSize ?? "?"}, ctx ${m.contextLength ?? "?"}, tools=${m.toolTrained}`
      );
    }
    if (this.plan) {
      this.output.appendLine(`Active plan: ${JSON.stringify(this.plan, null, 2)}`);
    }
    this.output.show(true);
  }
}
