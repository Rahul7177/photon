import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  matchInstalledModelName,
  type AdaptivePlan,
  type Attachment,
  type AutoDecision,
  type ChatMessage,
  type CloudUsageSummary,
  type HardwareMetrics,
  type IndexStatus,
  type IntelligenceSetting,
  type MachineProfile,
  type Mode,
  type ModelCapability,
  type ModelInfo,
  type OllamaRuntimeModel,
  type SessionState,
  type ThinkingLevel,
  type ToolCall,
} from "../shared/types";
import type { HostMessage, PhotonConfig, ToolSummary, ViewMessage } from "../shared/protocol";
import { OllamaClient } from "../core/ollama/client";
import { profileMachine, sampleHardwareMetrics } from "../core/adaptive/machineProfiler";
import { CloudUsageTracker } from "../core/telemetry/cloudUsage";
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
import { compactSessionMessages, shouldAutoCompact } from "../core/agent/compactor";
import { CheckpointManager, getCheckpointManager } from "../core/checkpoints/checkpointManager";
import type { DiagnosticInfo, ToolContext } from "../core/tools/types";
import { ProviderManager } from "../core/llm/providerManager";
import { OllamaProvider } from "../core/llm/providers/ollamaProvider";
import type { OpenAICompatConfig } from "../core/llm/providers/openaiCompatProvider";
import type { LLMProvider } from "../core/llm/types";
import { SessionStore } from "./sessionStore";
import { BenchStore } from "./benchStore";
import { ProjectStore } from "./projectStore";
import { IndexService } from "./indexService";
import { ModelConfigStore } from "./modelConfigStore";
import { getProjectContextManager, ProjectContextManager } from "../core/context/projectContext";
import { LocalProcessManager, installOptions, type StartableId } from "./localProcessManager";
import { recommendModels, MODEL_CATALOG } from "../core/adaptive/modelAdvisor";
import { scanDiskOllamaModels } from "../core/adaptive/runtimeDetector";
import { ModelInstaller } from "../core/ollama/modelInstaller";
import { loadProjectConfig, type ProjectConfig } from "./projectConfig";
import {
  ProviderCatalogService,
  deriveCustomProviderId,
} from "./providerCatalogService";
import { ApprovalService, parseMcpConfigJson } from "./approvalService";
import {
  MAX_SESSION_MESSAGES,
  enforceSessionMessageCap,
  finalizeTurnMessages,
  pruneInlineImages,
  rewindMessagesToCheckpoint,
} from "./sessionCoordinator";

const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

type Post = (msg: HostMessage) => void;

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
  /** Extended thinking level for supported models. */
  private thinkingLevel: ThinkingLevel = "off";
  private plan: AdaptivePlan | null = null;
  private userNumCtx: number | undefined;
  private session: SessionState;

  private turnAbort?: AbortController;
  /** Cancels an in-flight benchmark run. */
  private benchAbort?: AbortController;
  private reachable = false;
  private rawPost: Post = () => {};
  /** Manages tool execution approval lifecycles and auto-approve state. */
  private readonly approvals: ApprovalService;
  /** Manages cloud/local provider catalogs, custom models, and live model caching. */
  private readonly providerCatalog: ProviderCatalogService;
  /** One-click start/stop of local providers (Ollama, llama-server). */
  private readonly localProcs = new LocalProcessManager();
  /** Streams ollama pull with progress, disk pre-check and cancel. */
  private readonly installer = new ModelInstaller({
    pull: (model, onChunk, signal) => this.client.pullModel(model, onChunk, signal),
  });
  /** Updates the status-bar item (active model + reachability). */
  private statusUpdater?: (text: string, tooltip: string) => void;
  /** Guards the one-time expensive setup so a webview re-mount can't re-run it. */
  private initPromise?: Promise<void>;
  /** Maintains project-wide symbol index, file outlines, smart path resolution and cross-model handoff. */
  private ctxMgr?: ProjectContextManager;
  /** Checkpoint Manager tracks pre-mutation file states for 1-click turn rollbacks. */
  private checkpointMgr?: CheckpointManager;
  /** Live hardware metrics (GPU util, VRAM, RAM, temperature). */
  private latestHardwareMetrics: HardwareMetrics | null = null;
  /** Models currently loaded in Ollama's memory. */
  private latestOllamaRuntime: OllamaRuntimeModel[] = [];
  /** Concurrency guard for hardware sampling. */
  private samplingHardware = false;
  /** Tracks session and cumulative cloud token usage and cost. */
  private cloudUsageTracker: CloudUsageTracker;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    const persistedCloudUsage = this.context.globalState.get<CloudUsageSummary>("photon.cloudUsage.total");
    this.cloudUsageTracker = new CloudUsageTracker(persistedCloudUsage);
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
    this.approvals = new ApprovalService(cfg.get<boolean>("tools.autoApprove", false));
    this.providerCatalog = new ProviderCatalogService({
      getAddedModels: () => this.context.globalState.get<ModelInfo[]>("photon.customModels") ?? [],
      setAddedModels: async (models) => {
        await this.context.globalState.update("photon.customModels", models);
      },
      getCachedLiveModels: () =>
        this.context.globalState.get<Record<string, ModelInfo[]>>("photon.cachedProviderModels") ?? {},
      setCachedLiveModels: async (cache) => {
        await this.context.globalState.update("photon.cachedProviderModels", cache);
      },
      getProviderEnabled: (id) =>
        vscode.workspace.getConfiguration("photon").get<boolean>(`providers.${id}.enabled`, false),
      setProviderEnabled: async (id, enabled) => {
        await vscode.workspace
          .getConfiguration("photon")
          .update(`providers.${id}.enabled`, enabled, vscode.ConfigurationTarget.Global);
      },
      getSecretApiKey: async (id) =>
        (await this.context.secrets.get(`photon.provider.${id}.apiKey`)) ?? "",
      setSecretApiKey: async (id, apiKey) => {
        await this.context.secrets.store(`photon.provider.${id}.apiKey`, apiKey);
      },
      deleteSecretApiKey: async (id) => {
        await this.context.secrets.delete(`photon.provider.${id}.apiKey`);
      },
      getLlamaCppBaseUrl: () =>
        vscode.workspace.getConfiguration("photon").get<string>("llamacpp.baseUrl", "http://localhost:8080"),
      getCustomProviders: () =>
        vscode.workspace.getConfiguration("photon").get<OpenAICompatConfig[]>("providers.custom", []),
      setCustomProviders: async (providers) => {
        await vscode.workspace
          .getConfiguration("photon")
          .update("providers.custom", providers, vscode.ConfigurationTarget.Global);
      },
    });
    this.sessionStore = new SessionStore(context);
    this.benchStore = new BenchStore(context);
    this.projectStore = new ProjectStore(context);
    this.modelConfigs = new ModelConfigStore(context);
    this.mcp = new McpManager(this.registry, (m) => this.output.appendLine(`[mcp] ${m}`));
    this.index = new IndexService(
      context,
      this.client,
      (m) => this.output.appendLine(m),
      (status) => this.safePost({ type: "indexStatus", payload: status })
    );
    this.registry.registerAll(builtinTools());
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

    // Wire up Project Context Manager: maintains symbol index, smart paths, and cross-model memory
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      this.ctxMgr = getProjectContextManager(root);
      if (this.ctxMgr) {
        this.ctxMgr.onDidUpdate((summary) => {
          this.safePost({ type: "projectContext", payload: summary });
        });
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) {
        const ctxWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            folder,
            "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,c,cpp,h,cs,rb,php,swift,kt,vue,svelte,md,json,yaml,yml}"
          )
        );
        const onFileChange = (uri: vscode.Uri) => {
          const rel = vscode.workspace.asRelativePath(uri, false);
          void this.ctxMgr?.indexSingleFile(rel);
        };
        ctxWatcher.onDidCreate(onFileChange);
        ctxWatcher.onDidChange(onFileChange);
        ctxWatcher.onDidDelete((uri) => {
          const rel = vscode.workspace.asRelativePath(uri, false);
          this.ctxMgr?.removeFile(rel);
        });
        this.context.subscriptions.push(ctxWatcher);
      }
      this.checkpointMgr = getCheckpointManager(root);
      if (this.checkpointMgr) {
        void this.checkpointMgr.ensureInitialized();
      }
    }

    // Deterministic teardown on extension deactivate — abort work, close every
    // MCP connection, dispose the index watcher. Prevents process/connection leaks.
    this.context.subscriptions.push({
      dispose: () => {
        this.turnAbort?.abort();
        this.benchAbort?.abort();
        this.index.dispose();
        this.installer.cancel();
        this.localProcs.dispose();
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
          this.approvals.autoApprove = c.get<boolean>("tools.autoApprove", false);
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
    this.sendRecommendations();
    void this.detectProviders();
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

    // Restore cached provider models from globalState so they are instantly visible on startup
    this.providerCatalog.restoreLiveModelCache();

    this.machine = await profileMachine().catch(() => null);
    void this.pushHardwareMetrics();
    await this.rebuildProviders();
    await this.connectAndLoad();
    void this.autoRefreshConfiguredProviders();
    await this.setupMcp();
    await this.configureIndex();
    if (this.ctxMgr) {
      await this.ctxMgr.ensureInitialized().catch(() => undefined);
      void this.ctxMgr.scanWorkspace(false);
    }
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
    // Security boundary: Repository configuration (.photon/config) MUST NOT silently
    // disable user approval protections. Auto-approval is strictly a user-level setting.
    if (this.projectConfig?.autoApprove) {
      this.output.appendLine(
        "[security] Repository configuration (.photon/config) requested autoApprove=true. Ignored: tool auto-approval is a user-controlled security decision."
      );
    }

    // Phase 1.4: Sync file-based per-model configs → ModelConfigStore (file wins).
    // The file is the source of truth for team-shared overrides; the extension's
    // globalState is the fallback for user-only overrides not in the file.
    if (result.modelConfigs && Object.keys(result.modelConfigs).length > 0) {
      for (const [model, fileCfg] of Object.entries(result.modelConfigs)) {
        const effective = this.modelConfigs.effective(model, result.modelConfigs);
        if (effective) {
          // Write the file-wins merged result to globalState so the rest of the
          // codebase can read it via modelConfigs.get(model) without knowing
          // about the file layer.
          void this.modelConfigs.set(model, effective);
        }
      }
      this.output.appendLine(`[config] Synced ${Object.keys(result.modelConfigs).length} per-model config(s) from project file`);
    }
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
    this.pushSessionCheckpoints();
    if (this.lastDecision) this.safePost({ type: "decision", payload: this.lastDecision });
    // Repaint cached provider model lists so settings cards don't look empty
    // after a panel close/reopen.
    for (const [id, models] of this.providerCatalog.liveModelCache) {
      this.safePost({ type: "providerModels", payload: { id, models } });
    }
    this.updateStatusBar();
    this.sendRecommendations();
    void this.detectProviders();
  }

  /** Ping Ollama and load all available models across local and cloud providers. */
  private async connectAndLoad(): Promise<void> {
    this.syncClientConfig();
    this.reachable = await this.client.ping().catch(() => false);
    await this.loadModels();
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
      payload: { models: this.models, selected: this.selectedModel, ollamaReachable: this.reachable },
    });
    this.pushPlan();
    this.pushConfig();
    this.updateStatusBar();
    this.sendRecommendations();
    void this.detectProviders();
  }

  /** Push recommendations to the webview based on the latest hardware profile & installed models. */
  private sendRecommendations(goal?: ModelCapability, ctxTokens?: number): void {
    if (this.machine) this.machine = { ...this.machine, freeRamBytes: os.freemem() };
    const installed = this.models.map((m) => m.name);
    this.safePost({
      type: "modelRecommendations",
      payload: recommendModels(this.machine, { goal, ctxTokens, installed, installedModels: this.models }),
    });
  }

  /** Detect local runtimes and push them (with install guidance) to the webview. */
  private async detectProviders(reloadModels = false): Promise<void> {
    const runtimes = await this.localProcs.detect();
    for (const r of runtimes) {
      if (r.state === "not_installed") r.installOptions = installOptions(r.id, process.platform);
    }
    this.safePost({ type: "providerRuntimes", payload: runtimes });
    if (reloadModels) {
      await this.connectAndLoad();
      this.recomputePlan();
      this.safePost({
        type: "models",
        payload: {
          models: this.models,
          selected: this.selectedModel,
          ollamaReachable: this.reachable,
        },
      });
      this.pushPlan();
      this.sendRecommendations();
    }
  }

  /** One-click provider start; refreshes the model catalog once it is ready. */
  private async startLocalProvider(id: StartableId, modelPath?: string): Promise<void> {
    const sub = this.localProcs.onState((s) => this.safePost({ type: "providerLifecycle", payload: s }));
    try {
      let llamacpp;
      if (id === "llamacpp") {
        const selected = this.selectedModel ?? "";
        const path = modelPath ?? (selected.startsWith("llamacpp:") ? selected.replace(/^llamacpp:/, "") : "");
        const lc = this.modelConfigs.effective(selected)?.llamacpp;
        const cfg = vscode.workspace.getConfiguration("photon");
        let port: number | undefined;
        try { port = Number(new URL(cfg.get<string>("llamacpp.baseUrl", "http://localhost:8080")).port) || undefined; } catch { /* default */ }
        llamacpp = { modelPath: path, ctx: lc?.ctx ?? this.modelConfigs.effective(selected)?.numCtx, ngl: lc?.ngl, np: lc?.np, fa: lc?.fa, ctk: lc?.ctk, ctv: lc?.ctv, extraArgs: lc?.extraArgs, port };
      }
      const state = await this.localProcs.start(id, { llamacpp });
      if (state.phase === "running") {
        await this.refresh();
        void vscode.window.showInformationMessage(`Photon: ${id === "ollama" ? "Ollama" : "llama.cpp"} is running.`);
      } else if (state.phase === "error") {
        this.output.appendLine(`[local] Failed to start ${id}: ${state.message}`);
        void vscode.window.showErrorMessage(`Photon: Failed to start ${id === "ollama" ? "Ollama" : "llama.cpp"}: ${state.message}`);
      }
    } finally {
      sub.dispose();
      await this.detectProviders();
    }
  }

  /** One-click model install: pre-flight disk check, live progress, cancel support, then auto-activation. */
  private async installModel(modelName: string): Promise<void> {
    try {
      const sizeGb = MODEL_CATALOG.find((m) => m.name.toLowerCase() === modelName.toLowerCase())?.sizeGb;
      const outcome = await this.installer.install(modelName, {
        estimatedSizeBytes: sizeGb ? Math.round(sizeGb * 1024 ** 3) : undefined,
        onProgress: (p) => this.safePost({ type: "pullProgress", payload: p }),
      });
      switch (outcome.status) {
        case "done": {
          this.safePost({
            type: "pullProgress",
            payload: { model: modelName, phase: "done", status: `${modelName} installed and ready to code!`, percent: 100 },
          });
          await this.refresh();
          this.activateInstalledModel(modelName);
          void vscode.window.showInformationMessage(`Photon: ${modelName} installed and ready to code!`);
          setTimeout(() => this.safePost({ type: "pullProgress", payload: null }), 4000);
          return;
        }
        case "cancelled":
          this.safePost({ type: "pullProgress", payload: null });
          return;
        case "blocked":
          this.safePost({
            type: "pullProgress",
            payload: { model: modelName, phase: "error", status: "Cannot start download", error: outcome.message },
          });
          return;
        case "error":
          this.safePost({
            type: "pullProgress",
            payload: { model: modelName, phase: "error", status: "Failed", error: outcome.message, resumable: outcome.resumable },
          });
          return;
      }
    } catch (e) {
      this.safePost({
        type: "pullProgress",
        payload: { model: modelName, phase: "error", status: "Failed", error: (e as Error).message },
      });
    }
  }

  /** Select a freshly pulled model. */
  private activateInstalledModel(modelName: string): void {
    try {
      const matchedName = matchInstalledModelName(modelName, this.models.map((m) => m.name));
      const match = matchedName
        ? this.models.find((m) => m.name === matchedName)
        : this.models.find((m) => m.name.toLowerCase() === modelName.toLowerCase());
      if (!match) return;
      this.autoSelect = false;
      this.selectedModel = match.name;
      this.recomputePlan();
      this.pushPlan();
      this.pushConfig();
      this.safePost({
        type: "models",
        payload: { models: this.models, selected: this.selectedModel, ollamaReachable: this.reachable },
      });
    } catch {}
  }

  /** Re-check the connection + reload models, then notify the webview. */
  private async refresh(): Promise<void> {
    await this.connectAndLoad();
    this.recomputePlan();
    this.safePost({
      type: "models",
      payload: {
        models: this.models,
        selected: this.selectedModel,
        ollamaReachable: this.reachable,
      },
    });
    this.pushPlan();
    this.sendRecommendations();
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

      // Also sense local Ollama models on disk so installed models are visible
      // even when the Ollama server daemon is stopped or starting up.
      const diskModels = scanDiskOllamaModels();
      const existingNames = all.map((m) => m.name);
      for (const dm of diskModels) {
        if (!matchInstalledModelName(dm.name, existingNames)) {
          all.push(dm);
          existingNames.push(dm.name);
        }
      }

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
      this.models = scanDiskOllamaModels();
      this.output.appendLine(`[models] ${(e as Error).message}`);
    }
  }

  /* --------------------------- cloud providers ---------------------------- */

  /** Fetch the models a provider's API exposes for THIS account's key and push
   *  them to the webview. A failed fetch (bad key, no quota, network) is
   *  reported through the providerModels error field so the settings card can
   *  show exactly why the connection didn't validate. */
  private async pushLiveModels(id: string): Promise<void> {
    const p = this.providers.all().find((x) => x.id === id);
    if (!p || !p.fetchLiveModels || !p.isConfigured()) return;
    try {
      const { models, autoAddedCount } = await this.providerCatalog.fetchAndCacheLiveModels(p);
      this.safePost({ type: "providerModels", payload: { id, models } });
      this.output.appendLine(`[providers] ${id}: ${models.length} model(s) available to this key.`);

      if (autoAddedCount > 0) {
        await this.rebuildProviders();
        await this.refresh();
        this.pushConfig();
        this.output.appendLine(`[providers] ${id}: Auto-added ${autoAddedCount} top model(s) to picker.`);
      }
    } catch (e) {
      this.safePost({
        type: "providerModels",
        payload: { id, models: [], error: (e as Error).message },
      });
      this.output.appendLine(`[providers] ${id} live model list failed: ${(e as Error).message}`);
    }
  }

  /** Background-refresh models for every configured and enabled cloud provider. */
  private async autoRefreshConfiguredProviders(): Promise<void> {
    for (const p of this.providers.all()) {
      if (p.id !== "ollama" && p.isConfigured() && p.fetchLiveModels) {
        void this.pushLiveModels(p.id);
      }
    }
  }

  /** Rebuild the provider set from settings + stored API keys. Keeps the same
   *  ProviderManager instance so the engine's reference stays valid. */
  private async rebuildProviders(): Promise<void> {
    const cloud = await this.providerCatalog.buildCloudProviders();
    const llamacpp = await this.providerCatalog.buildLlamaCppProvider();
    const locals: LLMProvider[] = [this.ollamaProvider];
    if (llamacpp) locals.push(llamacpp);
    this.providers.setProviders([...locals, ...cloud]);
    this.output.appendLine(
      `[providers] active: ${this.providers.active().map((p) => p.id).join(", ") || "none"}`
    );
  }

  /** Status of every provider for the settings UI. */
  private providerStatuses() {
    return this.providerCatalog.providerStatuses(this.providers.all(), this.models);
  }

  /* --------------------------------- MCP (M11) -------------------------------- */

  /** Register configured MCP servers, connecting only those matching previously approved trust fingerprints. */
  private async setupMcp(): Promise<void> {
    const servers = this.readMcpConfig();
    await this.mcp.setConfigs(servers);
    for (const s of servers) {
      if (this.projectStore.isMcpConfigApproved(s)) {
        await this.mcp.connect(s.id);
      }
    }
    this.pushMcpServers();
    this.pushTools();
  }

  private pushMcpServers(): void {
    this.safePost({ type: "mcpServers", payload: this.mcp.list() });
  }

  private async approveMcpServer(id: string): Promise<void> {
    const server = this.readMcpConfig().find((s) => s.id === id);
    if (server) {
      await this.projectStore.approveMcpConfig(server);
    } else {
      await this.projectStore.approveMcp(id);
    }
    await this.mcp.connect(id);
    this.pushMcpServers();
    this.pushTools();
  }

  private async revokeMcpServer(id: string): Promise<void> {
    await this.projectStore.revokeMcpConfig(id);
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
        this.approvals.autoApprove = msg.payload.enabled;
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
          // Auto-enable provider when an API key is connected
          await vscode.workspace
            .getConfiguration("photon")
            .update(`providers.${msg.payload.id}.enabled`, true, vscode.ConfigurationTarget.Global);
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
          this.providerCatalog.liveModelCache.delete(msg.payload.id);
          this.safePost({ type: "providerModels", payload: { id: msg.payload.id, models: [] } });
        }
        return;
      case "setInterfaceMode":
        await this.setInterfaceMode(msg.payload.mode);
        return;
      case "setThinkingEnabled":
        this.thinkingLevel = msg.payload.enabled ? "medium" : "off";
        this.pushConfig();
        return;
      case "setThinkingLevel":
        this.thinkingLevel = msg.payload.level;
        this.pushConfig();
        return;
      case "newSession": {
        // Swap the session SYNCHRONOUSLY, before any await. Message handlers
        // run fire-and-forget and interleave at their await points, so awaiting
        // the persistence write first allowed a fast-follow `sendPrompt` to pin
        // the OLD session — e.g. "Hi" in a fresh chat continuing a previous
        // conversation invisibly.
        this.cancelActiveTurn();
        const { autoApproveChanged } = this.approvals.clearSessionApprovals();
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
        this.pushSessionCheckpoints();
        if (autoApproveChanged) {
          this.pushConfig();
        }
        return;
      }
      case "switchSession":
        await this.switchSession(msg.payload.id);
        return;
      case "deleteSession":
        await this.deleteSession(msg.payload.id);
        return;
      case "detectProviders":
        return this.detectProviders(true);
      case "completeOnboarding":
        await this.context.globalState.update("photon.onboardingCompleted", true);
        this.safePost({ type: "onboardingStatus", payload: { show: false } });
        return;
      case "openOnboarding":
        this.safePost({ type: "onboardingStatus", payload: { show: true } });
        await this.detectProviders(true);
        return;
      case "requestRecommendations":
        this.sendRecommendations(msg.payload?.goal, msg.payload?.ctxTokens);
        return;
      case "startProvider":
        return this.startLocalProvider(msg.payload.id, msg.payload.modelPath);
      case "stopProvider":
        await this.localProcs.stop(msg.payload.id);
        return this.detectProviders();
      case "restartProvider":
        await this.localProcs.restart(msg.payload.id);
        return this.detectProviders();
      case "installProvider": {
        const opt = installOptions(msg.payload.id, process.platform)[msg.payload.optionIndex];
        if (!opt) return;
        if (opt.kind === "url") {
          void vscode.env.openExternal(vscode.Uri.parse(opt.value));
        } else {
          const term = vscode.window.createTerminal({ name: "Photon: install" });
          term.show();
          term.sendText(opt.value, true);
        }
        return;
      }
      case "pullModel":
        void this.installModel(msg.payload.model);
        return;
      case "cancelPull":
        this.installer.cancel();
        return;
      case "refreshModels":
        return this.refresh();
      case "toolApproval": {
        const { autoApproveChanged } = this.approvals.resolveApproval(
          msg.payload.callId,
          msg.payload.approved,
          msg.payload.remember,
          msg.payload.toolName
        );
        if (autoApproveChanged) {
          this.pushConfig();
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
        const p = this.providers.all().find((x) => x.id === providerId);
        const testRes = await this.providerCatalog.testProviderModel(p, providerId, model);
        this.safePost({
          type: "modelTestResult",
          payload: testRes,
        });
        return;
      }
      case "addAvailableModel": {
        const { providerId, model } = msg.payload;
        const { bare } = await this.providerCatalog.addModelToPicker(providerId, model);
        await this.rebuildProviders();
        await this.refresh();
        this.pushConfig();
        void vscode.window.showInformationMessage(`Photon: Added ${bare} to ${providerId} model picker.`);
        return;
      }
      case "removeAvailableModel": {
        const name = msg.payload.name;
        const removed = await this.providerCatalog.removeModelFromPicker(name);
        if (removed) {
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
        const id = deriveCustomProviderId(label, existing.map((c) => c.id));
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
        await this.providerCatalog.setAddedModels(
          this.providerCatalog.addedModels().filter((m) => m.provider !== id)
        );
        this.providerCatalog.liveModelCache.delete(id);
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
      case "requestProjectContext":
        if (this.ctxMgr) {
          this.safePost({ type: "projectContext", payload: this.ctxMgr.getSummary() });
        }
        return;
      case "refreshProjectContext":
        if (this.ctxMgr) {
          await this.ctxMgr.scanWorkspace(true);
          this.safePost({ type: "projectContext", payload: this.ctxMgr.getSummary() });
        }
        return;
      case "addProjectNote":
        if (this.ctxMgr) {
          this.ctxMgr.addNote(msg.payload);
        }
        return;
      case "deleteProjectNote":
        if (this.ctxMgr) {
          this.ctxMgr.deleteNote(msg.payload.id);
        }
        return;
      case "clearWorkingMemory":
        if (this.ctxMgr) {
          this.ctxMgr.clearWorkingMemory();
        }
        return;
      case "requestHardwareMetrics":
        await this.pushHardwareMetrics();
        return;
      case "resetCloudUsage":
        this.cloudUsageTracker.reset();
        void this.context.globalState.update("photon.cloudUsage.total", undefined);
        this.pushCloudUsage();
        return;
      case "unloadModel":
        if (msg.payload.model) {
          await this.client.unloadModel(msg.payload.model).catch((e) => {
            this.output.appendLine(`[unloadModel] Error unloading ${msg.payload.model}: ${(e as Error).message}`);
          });
        }
        await this.pushHardwareMetrics();
        return;
      case "compactContext":
        await this.runCompactCommand(msg.payload?.focus, false);
        return;
      case "rollbackCheckpoint":
        await this.handleRollbackCheckpoint(msg.payload.checkpointId, msg.payload.rewindChat);
        return;
      case "revertToNumber":
        await this.handleRevertToNumber(String(msg.payload.checkpointNumber));
        return;
      case "getCheckpoints":
        this.pushSessionCheckpoints();
        return;
      case "openFile":
        await this.openWorkspaceFile(msg.payload.path, msg.payload.line);
        return;
    }
  }

  private async openWorkspaceFile(targetPath: string, line?: number): Promise<void> {
    if (!targetPath || !targetPath.trim()) return;
    const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return;
    const pathMod = require("node:path") as typeof import("node:path");
    const rootFs = pathMod.resolve(rootUri.fsPath);
    const cleaned = targetPath.trim().replace(/^[/\\]+/, "");
    const absPath = pathMod.resolve(rootFs, cleaned);
    const rel = pathMod.relative(rootFs, absPath);
    if (rel.startsWith("..") || pathMod.isAbsolute(rel)) {
      this.output.appendLine(`[openFile] Refused path outside workspace: ${targetPath}`);
      return;
    }
    try {
      const uri = vscode.Uri.file(absPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const lineIdx = typeof line === "number" && line > 0 ? Math.max(0, line - 1) : 0;
      const pos = new vscode.Position(lineIdx, 0);
      await vscode.window.showTextDocument(doc, {
        preview: true,
        selection: line ? new vscode.Range(pos, pos) : undefined,
      });
    } catch (e) {
      this.output.appendLine(`[openFile] Could not open ${targetPath}: ${(e as Error).message}`);
    }
  }

  /* -------------------------------- turns --------------------------------- */

  /** Abort the in-flight turn and release any awaited approval promises. */
  private cancelActiveTurn(): void {
    this.turnAbort?.abort();
    // Resolve any pending approval prompts as "denied" so the tool call that is
    // awaiting them unwinds instead of hanging forever.
    this.approvals.cancelAllPending();
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
    try {
      await this.runPrompt(text, attachments);
    } finally {
      // Drain queued prompts (preserves order, like harness Inbox.claim)
      if (this.promptQueue.length && !this.drainingQueue) {
        this.drainingQueue = true;
        try {
          while (this.promptQueue.length) {
            const next = this.promptQueue.shift()!;
            try {
              await this.runPrompt(next.text, next.attachments);
            } catch (err) {
              this.output.appendLine(`[queue] Prompt failed: ${(err as Error).message}`);
            }
          }
        } finally {
          this.drainingQueue = false;
        }
      }
    }
  }
  private async runPrompt(text: string, attachments?: Attachment[]): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
      const focus = trimmed.slice(8).trim() || undefined;
      await this.runCompactCommand(focus, false);
      return;
    }
    if (trimmed === "/rewind") {
      await this.handleRewindLatest();
      return;
    }
    if (trimmed === "/revert") {
      const summaries = this.checkpointMgr?.getSessionCheckpointSummaries(this.session.id) ?? [];
      this.safePost({ type: "openRevertModal", payload: { checkpoints: summaries } });
      return;
    }
    if (trimmed.startsWith("/revert ")) {
      const arg = trimmed.slice(8).trim();
      if (arg) {
        await this.handleRevertToNumber(arg);
      } else {
        const summaries = this.checkpointMgr?.getSessionCheckpointSummaries(this.session.id) ?? [];
        this.safePost({ type: "openRevertModal", payload: { checkpoints: summaries } });
      }
      return;
    }

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

    this.safePost({
      type: "status",
      payload: { kind: "thinking", detail: "Selecting model & execution plan" },
    });

    // Auto Mode (M8): choose the model + plan for THIS request. When the user
    // has a model pinned/selected, that wins but is still ranked for transparency.
    const cfg = vscode.workspace.getConfiguration("photon");
    // Per-model ctx: if a model has a stored numCtx/llamacpp.ctx, honor it for THIS turn.
    const perModelCtx = (m: string) => this.effectiveNumCtxFor(m);
    const prevModel = this.selectedModel || undefined;
    let { decision, plan } = planRequest({
      prompt: text,
      mode: this.mode,
      attachmentCount: attachments?.length ?? 0,
      models: this.modelsForUi(),
      machine: this.machine,
      benchByModel: this.benchStore.byModel(),
      pinnedModel: this.autoSelect ? undefined : this.selectedModel || undefined,
      previousModel: prevModel,
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
      const targetModelName = plan.model;
      const m = this.models.find((x) => x.name === targetModelName) ?? this.modelsForUi()[0];
      if (m) {
        const cPlan = this.cloudPlan(m, this.mode);
        const pCtx = this.modelConfigs.get(m.name)?.numCtx ?? this.modelConfigs.get(m.name)?.llamacpp?.ctx;
        if (pCtx && pCtx > 0) { cPlan.numCtx = pCtx; cPlan.contextWindow = pCtx; }
        plan = cPlan;
        this.plan = cPlan;
      }
    }
    this.lastDecision = decision;
    if (decision.escalationNotice) {
      this.output.appendLine(`[routing] ${decision.escalationNotice}`);
    }
    this.safePost({ type: "decision", payload: decision });
    this.pushPlan();
    this.updateStatusBar();

    // Auto context compaction: if conversation tokens reach >= 75% of the active model's context window,
    // compact history before running the turn (like GitHub Copilot & Claude Code).
    const activeCtxWindow = this.getActiveContextLimit(plan.model);
    if (shouldAutoCompact(this.session.messages, activeCtxWindow, plan.model, 0.75)) {
      this.output.appendLine(
        `[compactor] Context usage >= 75% of ${activeCtxWindow} tokens (model=${plan.model}) — auto-compacting session before turn.`
      );
      await this.runCompactCommand(undefined, true);
    }

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
    this.checkpointMgr?.beginTurn(session.id, userMsg.id, text);

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
      let touched = finalizeTurnMessages(session);
      if (this.ctxMgr) {
        const lastUserMsg = [...session.messages].reverse().find((m) => m.role === "user");
        const lastAsstMsg = [...session.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
        const toolsUsed: { name: string; args: Record<string, unknown>; ok: boolean }[] = [];
        for (const m of session.messages) {
          if (m.role === "assistant" && m.toolCalls) {
            for (const tc of m.toolCalls) {
              toolsUsed.push({
                name: tc.name,
                args: tc.args ?? {},
                ok: tc.status === "done",
              });
            }
          }
        }
        if (lastUserMsg && lastAsstMsg) {
          this.ctxMgr.recordTurnHandoff({
            fromModel: plan.model,
            userPrompt: lastUserMsg.content,
            assistantResponse: lastAsstMsg.content,
            toolsUsed,
          });
        }
      }

      if (this.checkpointMgr) {
        const cp = await this.checkpointMgr.commitTurn(userMsg.id);
        if (cp && cp.modifiedFilesCount > 0) {
          userMsg.checkpointId = cp.id;
          userMsg.checkpointFiles = Object.keys(cp.files);
          userMsg.checkpointNumber = cp.checkpointNumber;
          const lastAsst = [...session.messages].reverse().find((m) => m.role === "assistant");
          if (lastAsst) {
            lastAsst.checkpointId = cp.id;
            lastAsst.checkpointFiles = Object.keys(cp.files);
            lastAsst.checkpointNumber = cp.checkpointNumber;
          }
          touched = true;
          this.pushSessionCheckpoints();
        }
      }

      await this.persistActiveSession(session);
      if (touched) this.safePost({ type: "sessionLoaded", payload: session });
      this.pushSessionList();
      void this.pushHardwareMetrics();
    }
  }

  /**
   * Resolve the active model's effective context limit (in tokens).
   * Checks per-model configuration overrides, active execution plan, and model catalog metadata.
   */
  private getActiveContextLimit(modelName?: string): number {
    const mName = modelName || this.plan?.model || this.selectedModel;
    if (mName) {
      const cfg = this.modelConfigs.get(mName);
      const cfgCtx = cfg?.numCtx ?? cfg?.llamacpp?.ctx;
      if (cfgCtx && cfgCtx > 0) return cfgCtx;
    }
    const planCtx = (this.plan as any)?.contextWindow || this.plan?.numCtx;
    if (planCtx && planCtx > 0) return planCtx;
    if (mName) {
      const m = this.models.find((x) => x.name === mName);
      if (m?.contextLength && m.contextLength > 0) return m.contextLength;
    }
    return this.interfaceMode === "cloud" ? 128_000 : 32_768;
  }

  /**
   * Compact the active session's context window (automatic or user-triggered).
   * Follows GitHub Copilot and Claude Code compaction architecture.
   */
  private async runCompactCommand(focus?: string, isAuto = false): Promise<void> {
    const session = this.session;
    const model = this.plan?.model || this.selectedModel;
    const window = this.getActiveContextLimit(model);

    this.output.appendLine(
      `[compactor] Running ${isAuto ? "automatic" : "manual"} context compaction (messages=${session.messages.length}, window=${window}, model=${model})`
    );

    // Notify the UI that context compaction is actively running in the chat
    this.safePost({ type: "compactingStatus", payload: { active: true } });
    this.safePost({
      type: "status",
      payload: {
        kind: "running",
        detail: "Compacting context window",
      },
    });

    let resultCompacted = false;
    try {
      const result = await compactSessionMessages({
        messages: session.messages,
        contextWindow: window,
        model,
        provider: this.providers,
        force: !isAuto,
        focus,
        threshold: 0.75,
      });

      if (!result.compacted) {
        if (!isAuto) {
          vscode.window.showInformationMessage(
            "Photon: Context window is already optimal. Compaction requires at least 4 conversation turns."
          );
        }
        return;
      }

      resultCompacted = true;

      session.messages = result.newMessages;
      session.updatedAt = Date.now();
      await this.persistActiveSession(session);

      const newUsed = result.tokensAfter;
      this.safePost({
        type: "tokenUsage",
        payload: {
          used: newUsed,
          window,
          breakdown: [
            { label: "Compacted Context", tokens: newUsed },
          ],
        },
      });

      this.safePost({ type: "sessionLoaded", payload: session });
      this.safePost({
        type: "contextCompacted",
        payload: {
          tokensSaved: result.tokensSaved,
          pctSaved: result.pctSaved,
          totalTokens: result.tokensAfter,
          window,
        },
      });

      this.output.appendLine(
        `[compactor] Compacted: ${result.messagesBefore} -> ${result.messagesAfter} messages. Saved ${result.tokensSaved} tokens (${result.pctSaved}% of window) using ${result.strategy}.`
      );
    } finally {
      this.safePost({ type: "compactingStatus", payload: { active: false } });
      if (!isAuto && !resultCompacted) {
        this.safePost({
          type: "status",
          payload: {
            kind: "idle",
            detail: "Context window is already clean and optimal. No compaction needed yet.",
          },
        });
      } else {
        this.safePost({ type: "status", payload: { kind: "idle" } });
      }
    }
  }

  /**
   * Rollback workspace files and conversation to the state before a specific checkpoint.
   * Mirrors GitHub Copilot & Claude Code checkpoint restoration.
   */
  private async handleRollbackCheckpoint(checkpointId: string, rewindChat = true): Promise<void> {
    if (!this.checkpointMgr) return;
    this.output.appendLine(
      `[checkpoint] Rolling back to checkpoint "${checkpointId}" (rewindChat=${rewindChat})`
    );

    const targetCp = this.checkpointMgr.getCheckpoint(checkpointId);
    const cpNum = targetCp?.checkpointNumber;
    const cpNumLabel = cpNum ? `Checkpoint #${cpNum}` : `checkpoint`;

    const result = await this.checkpointMgr.rollbackToCheckpoint(checkpointId);
    if (!result.success && result.revertedFiles.length === 0 && result.deletedFiles.length === 0) {
      this.safePost({
        type: "error",
        payload: { message: `Rollback aborted (checkpoint preserved): ${result.errors.join("; ")}` },
      });
      return;
    } else if (!result.success) {
      const failedOrConflict = result.fileResults.filter(
        (f) => f.status === "failed" || f.status === "conflict"
      );
      const detail = failedOrConflict
        .map((f) => `${f.relativePath} (${f.status}: ${f.reason || "unknown"})`)
        .join("; ");
      this.safePost({
        type: "error",
        payload: {
          message: `Rollback partially completed: ${detail}. Checkpoint preserved for retry.`,
        },
      });
    }

    // Refresh symbol index for reverted/deleted files
    if (this.ctxMgr) {
      for (const f of result.revertedFiles) void this.ctxMgr.indexSingleFile(f);
      for (const f of result.deletedFiles) this.ctxMgr.removeFile(f);
    }

    let restoredPrompt: string | undefined;

    if (rewindChat) {
      const session = this.session;
      const rewound = rewindMessagesToCheckpoint(
        session.messages,
        checkpointId,
        result.targetTurnMessageId,
        result.label || ""
      );
      restoredPrompt = rewound.restoredPrompt;
      session.messages = rewound.rewoundMessages;
      session.updatedAt = Date.now();
      await this.persistActiveSession(session);
      this.safePost({ type: "sessionLoaded", payload: session });
    }

    const summaries = this.checkpointMgr.getSessionCheckpointSummaries(this.session.id);

    this.safePost({
      type: "checkpointRollbackDone",
      payload: {
        checkpointId: result.checkpointId,
        revertedFiles: result.revertedFiles,
        deletedFiles: result.deletedFiles,
        rewindChat,
        restoredPrompt,
        messages: this.session.messages,
        checkpoints: summaries,
      },
    });

    const fileSummary =
      result.revertedFiles.length > 0
        ? `Reverted ${result.revertedFiles.length} file(s)`
        : `Restored workspace`;
    const rewindSuffix = rewindChat ? " and rewound chat" : "";
    vscode.window.showInformationMessage(`Photon: ${fileSummary}${rewindSuffix} to ${cpNumLabel}.`);
  }

  private async handleRevertToNumber(arg: string): Promise<void> {
    if (!this.checkpointMgr) return;
    const clean = arg.replace(/#/g, "").trim();
    const num = parseInt(clean, 10);
    if (isNaN(num)) {
      this.safePost({
        type: "error",
        payload: { message: `Invalid checkpoint number: "${arg}". Use /revert or e.g. /revert 1.` },
      });
      return;
    }
    const cp = this.checkpointMgr.getCheckpointByNumber(this.session.id, num);
    if (!cp) {
      this.safePost({
        type: "error",
        payload: { message: `Checkpoint #${num} not found in this chat session.` },
      });
      return;
    }
    await this.handleRollbackCheckpoint(cp.id, true);
  }

  private async handleRewindLatest(): Promise<void> {
    if (!this.checkpointMgr) return;
    const latest = this.checkpointMgr.getLatestCheckpoint(this.session.id);
    if (!latest) {
      this.safePost({
        type: "error",
        payload: { message: "No checkpoints recorded in this conversation yet." },
      });
      return;
    }
    await this.handleRollbackCheckpoint(latest.id, true);
  }

  private pushSessionCheckpoints(): void {
    if (this.checkpointMgr) {
      const summaries = this.checkpointMgr.getSessionCheckpointSummaries(this.session.id);
      this.safePost({ type: "checkpointsList", payload: { checkpoints: summaries } });
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
        // Surface the error in the chat as an assistant notice so it's
        // visible even after the banner is dismissed.
        if (isLive()) {
          if (!current) {
            current = {
              id: randomUUID(),
              role: "assistant",
              content: "",
              toolCalls: [],
              createdAt: Date.now(),
              streaming: false,
            };
            session.messages.push(current);
          }
          current.streaming = false;
          current.notice = message;
          this.safePost({ type: "messageAppended", payload: { ...current } });
        }
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
    emitter.onPhase("thinking", "Retrieving project context");
    const workspaceMap = await buildWorkspaceMap(root).catch(() => undefined);
    // Classify tool policy here too so the system prompt matches the actual
    // tool surface. The unifiedRuntime monkey-patch also sets it, but the
    // system prompt is built before that patch runs.
    const lastUser = [...session.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const toolPolicy = classifyCloudToolPolicyForPrompt(plan.mode, String(lastUser));
    const projectContextDigest = this.ctxMgr?.buildPromptDigest({
      userQuery: String(lastUser),
      activeModel: plan.model,
      maxTokens: 2000,
    });
    const system = buildCloudSystemPrompt({
      mode: plan.mode,
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
      workspaceMap,
      toolPolicy,
      projectContextDigest,
    });
    await runCloudTurn({
      provider: this.providers,
      model: plan.model,
      system,
      history: cloudHistoryFromSession(session.messages),
      tools: cloudTools(plan.mode),
      contextWindow: model.contextLength ?? 128_000,
      ctx: this.buildToolContext(signal),
      emitter,
      signal,
      onStepUsage: (usage) => {
        this.cloudUsageTracker.recordStep(usage);
        void this.context.globalState.update(
          "photon.cloudUsage.total",
          this.cloudUsageTracker.getSummary()
        );
        this.pushCloudUsage();
      },
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
      checkpointTracker: {
        recordBeforeChange: (relPath: string) => this.checkpointMgr?.recordBeforeChange(relPath) ?? Promise.resolve(),
      },
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
    return this.approvals.requestApproval(call, (pendingCall) => {
      this.safePost({
        type: "status",
        payload: { kind: "running", detail: `Waiting for approval: ${pendingCall.name}` },
      });
      this.safePost({
        type: "toolApprovalRequest",
        payload: { messageId: "", call: pendingCall },
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
      autoApprove: this.approvals.autoApprove,
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
      thinkingLevel: this.thinkingLevel,
    };
  }

  private pushConfig(): void {
    this.safePost({ type: "config", payload: this.buildConfig() });
    this.updateStatusBar();
    this.sendRecommendations();
    void this.detectProviders();
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

  private pushCloudUsage(): void {
    this.safePost({ type: "cloudUsage", payload: this.cloudUsageTracker.getSummary() });
  }

  private async pushHardwareMetrics(): Promise<void> {
    if (this.samplingHardware) return;
    this.samplingHardware = true;
    try {
      const hw = await sampleHardwareMetrics(this.machine?.gpu).catch(() => null);
      if (hw) {
        this.latestHardwareMetrics = hw;
        this.safePost({ type: "hardwareMetrics", payload: hw });
      }

      if (this.reachable) {
        const psModels = await this.client.listRunning().catch(() => []);
        const runtimeModels: OllamaRuntimeModel[] = psModels.map((m) => {
          const size = m.size ?? 0;
          const vram = m.size_vram ?? 0;
          const gpuPercent = size > 0 ? Math.min(100, Math.round((vram / size) * 100)) : (vram > 0 ? 100 : 0);
          return {
            name: m.name ?? m.model,
            sizeBytes: size,
            vramBytes: vram,
            gpuPercent,
            contextLength: m.context_length ?? 0,
            expiresAt: m.expires_at,
          };
        });
        this.latestOllamaRuntime = runtimeModels;
        this.safePost({ type: "ollamaRuntime", payload: runtimeModels });
      } else {
        this.latestOllamaRuntime = [];
        this.safePost({ type: "ollamaRuntime", payload: [] });
      }

      this.pushCloudUsage();
    } finally {
      this.samplingHardware = false;
    }
  }

  private buildInitPayload() {
    return {
      session: this.session,
      sessions: this.sessionStore.summaries(),
      models: this.models,
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
      projectContext: this.ctxMgr?.getSummary() ?? null,
      hardwareMetrics: this.latestHardwareMetrics,
      ollamaRuntime: this.latestOllamaRuntime,
      cloudUsage: this.cloudUsageTracker.getSummary(),
      showOnboarding: !this.context.globalState.get<boolean>("photon.onboardingCompleted", false),
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
    const { autoApproveChanged } = this.approvals.clearSessionApprovals();
    const target = this.sessionStore.get(id);
    if (!target) return;
    const previous = this.session;
    // Reassign synchronously (same rule as newSession): a prompt sent while we
    // persist must land in the TARGET session, not the one switched away from.
    this.loadSession(target);
    await this.persistActiveSession(previous);
    this.pushSessionList();
    if (autoApproveChanged) {
      this.pushConfig();
    }
  }

  private async deleteSession(id: string): Promise<void> {
    // Move off the doomed session BEFORE awaiting its removal — otherwise a
    // prompt arriving during the await would target (and re-persist) a deleted
    // session as a zombie.
    if (id === this.session.id) {
      this.cancelActiveTurn();
      const { autoApproveChanged } = this.approvals.clearSessionApprovals();
      const next = this.sessionStore.loadAll().find((s) => s.id !== id);
      if (next) {
        this.loadSession(next);
      } else {
        this.mode = "chat";
        this.loadSession(this.freshSession());
      }
      if (autoApproveChanged) {
        this.pushConfig();
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
      payload: { models: this.models, selected: this.selectedModel, ollamaReachable: this.reachable },
    });
    this.pushSessionCheckpoints();
  }

  private async persistActiveSession(session: SessionState = this.session): Promise<void> {
    if (session.messages.length === 0) return;
    // Bound in-memory + on-disk growth for very long-running sessions by archiving older messages into a compact digest.
    enforceSessionMessageCap(session, MAX_SESSION_MESSAGES);
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
      return parseMcpConfigJson(raw);
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

  /** Public method for Chat Participant to send a prompt directly */
  async sendPrompt(text: string, attachments?: Attachment[]): Promise<void> {
    return this.onPrompt(text, attachments);
  }
}

/** Classify cloud tool policy for the system prompt — mirrors unifiedRuntime's logic. */
function classifyCloudToolPolicyForPrompt(mode: unknown, text: string): "all" | "web" | "none" {
  const t = text.trim().toLowerCase();
  if (!t) return "all";
  if (/^(hi|hello|hey|hiya|yo|thanks|thank you|thx|ok|okay|great|cool|nice|good morning|good afternoon|good evening)[\s,!.?]*$/i.test(t)) {
    return "none";
  }
  if (mode === "agent" || mode === "plan") return "all";
  const workspaceIntent = /\b(file|files|folder|directory|workspace|repo|repository|codebase|code|class|function|symbol|bug|error|stack trace|edit|modify|change|implement|refactor|debug|fix|write|read|search files|list files|build|test|compile|lint|run command|search|find|show|open|list|get|create|add|remove|delete|rename|move|copy|update|set|configure|install|uninstall|run|start|stop|restart|check|test|debug|format|lint|deploy|push|pull|commit|merge|branch|clone|init|setup)\b/i.test(t);
  const externalIntent = /\b(weather|temperature|forecast|news|current|today|tonight|latest|live|recent|price|prices|stock|stocks|market|release|version|time|date|traffic|search|lookup|find out|what is|what are|how to|who is|where is)\b/i.test(t);
  if (externalIntent && !workspaceIntent) return "web";
  return "all";
}
