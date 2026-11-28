import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { after, describe, it } from "node:test";
import type { HostMessage, ViewMessage } from "../../src/shared/protocol";

interface MockContextBundle {
  context: any;
  globalStore: Map<string, any>;
  workspaceStore: Map<string, any>;
  secretStore: Map<string, string>;
}

function createMockVscodeEnv(workspaceRoot: string, extensionRoot: string) {
  const configMap = new Map<string, any>([
    ["defaultMode", "chat"],
    ["interfaceMode", "local"],
    ["tools.autoApprove", false],
    ["adaptive.enabled", true],
    ["intelligence.level", "auto"],
    ["webSearch.provider", "google"],
    ["ollama.baseUrl", "http://127.0.0.1:11434"],
    ["llamacpp.baseUrl", "http://127.0.0.1:8080"],
    ["index.enabled", false],
    ["bench.autoRun", false],
  ]);

  const infoMessages: string[] = [];
  const errorMessages: string[] = [];
  const warningMessages: string[] = [];
  const openedDocs: string[] = [];
  const executedCommands: Array<{ cmd: string; args: any[] }> = [];
  const registeredCommands = new Map<string, (...args: any[]) => any>();
  const registeredViewProviders = new Map<string, any>();
  const registeredParticipants = new Map<string, { participant: any; handler: any }>();
  const statusBarItems: any[] = [];
  const createdTerminals: Array<{ name: string; lines: string[]; shown: boolean }> = [];
  const openedUrls: string[] = [];

  class EventEmitter<T = any> {
    private listeners = new Set<(e: T) => void>();
    event = (listener: (e: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(data: T) {
      for (const l of this.listeners) l(data);
    }
    dispose() {
      this.listeners.clear();
    }
  }

  const configEmitter = new EventEmitter<{ affectsConfiguration: (s: string) => boolean }>();

  class Uri {
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    constructor(scheme: string, fsPathOrPath: string) {
      this.scheme = scheme;
      this.fsPath = scheme === "file" ? path.resolve(fsPathOrPath) : fsPathOrPath;
      this.path = this.fsPath.replace(/\\/g, "/");
    }
    static file(p: string) {
      return new Uri("file", path.resolve(p));
    }
    static parse(str: string) {
      if (str.startsWith("file://")) {
        const raw = decodeURIComponent(str.replace(/^file:\/\//, ""));
        return Uri.file(/^\/[a-zA-Z]:/.test(raw) ? raw.slice(1) : raw);
      }
      return new Uri("https", str);
    }
    static joinPath(base: Uri, ...segments: string[]) {
      return Uri.file(path.join(base.fsPath, ...segments));
    }
    toString() {
      return this.scheme === "file" ? `file:///${this.path.replace(/^\/+/, "")}` : this.path;
    }
  }

  class Position {
    constructor(public line: number, public character: number) {}
  }

  class Range {
    constructor(public start: Position, public end: Position) {}
  }

  class Location {
    constructor(public uri: Uri, public range: Range) {}
  }

  class RelativePattern {
    constructor(public base: any, public pattern: string) {}
  }

  const folderUri = Uri.file(workspaceRoot);
  const workspaceFolders = [{ uri: folderUri, name: path.basename(workspaceRoot), index: 0 }];

  const mockVscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    EventEmitter,
    Uri,
    Position,
    Range,
    Location,
    RelativePattern,
    chat: {
      createChatParticipant(id: string, handler: any) {
        const participant: any = { id, iconPath: undefined, dispose: () => {} };
        registeredParticipants.set(id, { participant, handler });
        return participant;
      },
    },
    commands: {
      registerCommand(id: string, cb: (...args: any[]) => any) {
        registeredCommands.set(id, cb);
        return { dispose: () => registeredCommands.delete(id) };
      },
      async executeCommand(id: string, ...args: any[]) {
        executedCommands.push({ cmd: id, args });
        const fn = registeredCommands.get(id);
        if (fn) return fn(...args);
        return undefined;
      },
    },
    env: {
      async openExternal(uri: Uri) {
        openedUrls.push(uri.toString());
        return true;
      },
    },
    languages: {
      getDiagnostics: () => [],
    },
    window: {
      createOutputChannel(name: string) {
        const lines: string[] = [];
        return {
          name,
          lines,
          appendLine(s: string) {
            lines.push(s);
          },
          append(s: string) {
            lines.push(s);
          },
          show() {},
          clear() {
            lines.length = 0;
          },
          dispose() {},
        };
      },
      registerWebviewViewProvider(viewType: string, provider: any, _opts?: any) {
        registeredViewProviders.set(viewType, provider);
        return { dispose: () => registeredViewProviders.delete(viewType) };
      },
      createStatusBarItem(_align?: number, _priority?: number) {
        const item = {
          text: "",
          tooltip: "",
          command: "",
          shown: false,
          show() {
            this.shown = true;
          },
          hide() {
            this.shown = false;
          },
          dispose() {},
        };
        statusBarItems.push(item);
        return item;
      },
      async showInformationMessage(msg: string) {
        infoMessages.push(msg);
        return undefined;
      },
      async showErrorMessage(msg: string) {
        errorMessages.push(msg);
        return undefined;
      },
      async showWarningMessage(msg: string) {
        warningMessages.push(msg);
        return undefined;
      },
      async showTextDocument(doc: any) {
        openedDocs.push(doc.uri?.fsPath ?? doc.fileName ?? String(doc));
        return { document: doc };
      },
      createTerminal(opts: { name: string }) {
        const term = {
          name: opts.name,
          lines: [] as string[],
          shown: false,
          show() {
            this.shown = true;
          },
          sendText(cmd: string) {
            this.lines.push(cmd);
          },
          dispose() {},
        };
        createdTerminals.push(term);
        return term;
      },
    },
    workspace: {
      workspaceFolders,
      asRelativePath(target: Uri | string) {
        const fsPath = typeof target === "string" ? target : target.fsPath;
        return path.relative(workspaceRoot, fsPath).replace(/\\/g, "/");
      },
      getConfiguration(section?: string) {
        const prefix = section && section !== "photon" ? `${section}.` : "";
        return {
          get<T>(key: string, defaultValue?: T): T {
            const fullKey = `${prefix}${key}`;
            return configMap.has(fullKey) ? (configMap.get(fullKey) as T) : (defaultValue as T);
          },
          async update(key: string, value: any) {
            const fullKey = `${prefix}${key}`;
            configMap.set(fullKey, value);
            configEmitter.fire({
              affectsConfiguration: (s: string) => s === "photon" || `photon.${fullKey}`.startsWith(s),
            });
          },
        };
      },
      createFileSystemWatcher() {
        return {
          onDidCreate: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          dispose: () => {},
        };
      },
      onDidChangeConfiguration: configEmitter.event,
      async openTextDocument(uri: Uri) {
        const text = fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, "utf8") : "";
        return { uri, fileName: uri.fsPath, getText: () => text };
      },
      fs: {
        async stat(uri: Uri) {
          const st = await fs.promises.stat(uri.fsPath);
          return {
            type: st.isDirectory() ? 2 : 1,
            size: st.size,
            ctime: st.ctimeMs,
            mtime: st.mtimeMs,
          };
        },
        async readFile(uri: Uri) {
          return new Uint8Array(await fs.promises.readFile(uri.fsPath));
        },
      },
    },
  };

  const makeContext = (suffix: string): MockContextBundle => {
    const globalStore = new Map<string, any>();
    const workspaceStore = new Map<string, any>();
    const secretStore = new Map<string, string>();
    const secretEmitter = new EventEmitter<{ key: string }>();

    const gStorage = path.join(workspaceRoot, `.mock-global-${suffix}`);
    const wStorage = path.join(workspaceRoot, `.mock-ws-${suffix}`);
    fs.mkdirSync(gStorage, { recursive: true });
    fs.mkdirSync(wStorage, { recursive: true });

    return {
      globalStore,
      workspaceStore,
      secretStore,
      context: {
        extensionUri: Uri.file(extensionRoot),
        globalStorageUri: Uri.file(gStorage),
        storageUri: Uri.file(wStorage),
        subscriptions: [] as Array<{ dispose: () => any }>,
        globalState: {
          get: (k: string, d?: any) => (globalStore.has(k) ? globalStore.get(k) : d),
          update: async (k: string, v: any) => {
            if (v === undefined) globalStore.delete(k);
            else globalStore.set(k, v);
          },
          keys: () => [...globalStore.keys()],
          setKeysForSync: () => {},
        },
        workspaceState: {
          get: (k: string, d?: any) => (workspaceStore.has(k) ? workspaceStore.get(k) : d),
          update: async (k: string, v: any) => {
            if (v === undefined) workspaceStore.delete(k);
            else workspaceStore.set(k, v);
          },
          keys: () => [...workspaceStore.keys()],
        },
        secrets: {
          get: async (k: string) => secretStore.get(k),
          store: async (k: string, v: string) => {
            secretStore.set(k, v);
            secretEmitter.fire({ key: k });
          },
          delete: async (k: string) => {
            secretStore.delete(k);
            secretEmitter.fire({ key: k });
          },
          onDidChange: secretEmitter.event,
        },
      },
    };
  };

  return {
    mockVscode,
    configMap,
    infoMessages,
    errorMessages,
    warningMessages,
    openedDocs,
    executedCommands,
    registeredCommands,
    registeredViewProviders,
    registeredParticipants,
    statusBarItems,
    createdTerminals,
    openedUrls,
    makeContext,
    Uri,
  };
}

function installFetchMock(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    const jsonResp = (data: any, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/api/tags")) {
      return jsonResp({
        models: [
          {
            name: "qwen2.5-coder:7b",
            model: "qwen2.5-coder:7b",
            size: 4700000000,
            details: { parameter_size: "7B", quantization_level: "Q4_K_M", family: "qwen2" },
          },
          {
            name: "nomic-embed-text:latest",
            model: "nomic-embed-text:latest",
            size: 300000000,
            details: { parameter_size: "137M" },
          },
        ],
      });
    }
    if (url.includes("/api/ps")) {
      return jsonResp({ models: [] });
    }
    if (url.includes("/api/show")) {
      return jsonResp({
        capabilities: ["completion", "tools"],
        template: "{{ .Tools }}",
        model_info: { "general.context_length": 32768 },
      });
    }
    if (url.includes("/v1/models")) {
      return jsonResp({
        data: [{ id: "qa-model-1" }, { id: "qa-model-2" }],
      });
    }
    if (url.includes("/chat/completions")) {
      return jsonResp({
        id: "cmpl-qa-1",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    }
    if (url.includes("/v1/messages")) {
      return jsonResp({
        id: "msg-qa-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return jsonResp({ models: [{ name: "models/gemini-2.5-flash" }] });
    }
    return jsonResp({}, 404);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function createMockWebviewView() {
  const posted: HostMessage[] = [];
  let onReceive: ((m: ViewMessage) => void) | undefined;
  let onDispose: (() => void) | undefined;

  const view: any = {
    viewType: "photon.chat",
    visible: true,
    showCalls: 0,
    show() {
      view.showCalls++;
    },
    onDidDispose(cb: () => void) {
      onDispose = cb;
      return { dispose: () => {} };
    },
    webview: {
      options: {} as any,
      html: "",
      cspSource: "vscode-webview://mock",
      asWebviewUri: (u: any) => u,
      postMessage: async (m: HostMessage) => {
        posted.push(m);
        return true;
      },
      onDidReceiveMessage(cb: (m: ViewMessage) => void) {
        onReceive = cb;
        return { dispose: () => {} };
      },
    },
  };

  return {
    view,
    posted,
    triggerReceive: (m: ViewMessage) => onReceive?.(m),
    triggerDispose: () => onDispose?.(),
  };
}

describe("Extension Host, ChatViewProvider, ChatParticipant & PhotonController Full Integration E2E", () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "photon-ctrl-e2e-"));
  const extensionRoot = path.resolve(__dirname, "../..");
  fs.mkdirSync(path.join(tmpWorkspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpWorkspace, "src", "sample.ts"), "export const qaValue = 42;\n", "utf8");
  fs.writeFileSync(path.join(tmpWorkspace, "README.md"), "# Photon QA Workspace\n", "utf8");

  const env = createMockVscodeEnv(tmpWorkspace, extensionRoot);
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
    if (request === "vscode") return env.mockVscode;
    return originalLoad.apply(this, arguments);
  };
  const restoreFetch = installFetchMock();

  // Require extension host modules after hooking "vscode"
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { activate, deactivate } = require("../../src/extension") as typeof import("../../src/extension");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ChatViewProvider } = require("../../src/host/ChatViewProvider") as typeof import("../../src/host/ChatViewProvider");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PhotonController } = require("../../src/host/PhotonController") as typeof import("../../src/host/PhotonController");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LocalProcessManager } = require("../../src/host/localProcessManager") as typeof import("../../src/host/localProcessManager");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { _resetProjectContextManagersForTesting } = require("../../src/core/context/projectContext") as typeof import("../../src/core/context/projectContext");

  const origDetectProto = LocalProcessManager.prototype.detect;
  LocalProcessManager.prototype.detect = async () => [
    { id: "ollama", label: "Ollama", state: "running", port: 11434, baseUrl: "http://127.0.0.1:11434", version: "0.5.7" },
    { id: "llamacpp", label: "llama.cpp", state: "installed_stopped", port: 8080, baseUrl: "http://127.0.0.1:8080" },
  ];

  after(() => {
    LocalProcessManager.prototype.detect = origDetectProto;
    _resetProjectContextManagersForTesting();
    restoreFetch();
    (Module as any)._load = originalLoad;
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  function stubControllerBackgroundProbes(ctrl: any) {
    ctrl.localProcs.detect = async () => [
      { id: "ollama", label: "Ollama", state: "running", port: 11434, baseUrl: "http://127.0.0.1:11434", version: "0.5.7" },
      { id: "llamacpp", label: "llama.cpp", state: "installed_stopped", port: 8080, baseUrl: "http://127.0.0.1:8080" },
    ];
    ctrl.localProcs.start = async (id: string) => ({ id, phase: "running", message: "Started" });
    ctrl.localProcs.stop = async () => {};
    ctrl.localProcs.restart = async () => {};
    ctrl.pushHardwareMetrics = async () => {};
  }

  it("1. activate(), ChatViewProvider HTML/CSP/post, extension commands, and ChatParticipant #file attachment", async () => {
    const bundle = env.makeContext("ext");
    activate(bundle.context);

    try {
      // WebviewViewProvider, StatusBar, ChatParticipant, and 4 commands registered
      const provider = env.registeredViewProviders.get(ChatViewProvider.viewType);
      assert.ok(provider instanceof ChatViewProvider, "ChatViewProvider should register on photon.chat");
      assert.equal(env.statusBarItems.length, 1);
      assert.equal(env.statusBarItems[0].command, "photon.openChat");
      assert.equal(env.statusBarItems[0].shown, true);

      for (const cmd of ["photon.openChat", "photon.newSession", "photon.refreshModels", "photon.runDiagnostics"]) {
        assert.ok(env.registeredCommands.has(cmd), `Command ${cmd} registered`);
      }

      const part = env.registeredParticipants.get("photon");
      assert.ok(part, "@photon chat participant registered");
      assert.ok(String(part.participant.iconPath.fsPath).endsWith(path.join("media", "photon-activity.svg")));

      stubControllerBackgroundProbes(provider.controller);

      // Resolve webview view & inspect generated HTML/CSP
      const wv = createMockWebviewView();
      provider.resolveWebviewView(wv.view);
      assert.equal(wv.view.webview.options.enableScripts, true);
      assert.match(wv.view.webview.html, /Content-Security-Policy/);
      assert.match(wv.view.webview.html, /script-src 'nonce-/);
      assert.match(wv.view.webview.html, /index\.js\?v=/);
      assert.match(wv.view.webview.html, /index\.css\?v=/);

      // Send ready through webview message listener -> verify full init state posted
      wv.triggerReceive({ type: "ready" });
      for (let i = 0; i < 200; i++) {
        if (wv.posted.some((m) => m.type === "init")) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await (provider.controller as any).initPromise;

      assert.ok(wv.posted.some((m) => m.type === "init"), "Controller posts init on ready");
      assert.ok(wv.posted.some((m) => m.type === "tools"), "Controller posts tools on ready");
      assert.ok(wv.posted.some((m) => m.type === "modelRecommendations"), "Controller posts recommendations");

      // Execute commands
      wv.posted.length = 0;
      await env.mockVscode.commands.executeCommand("photon.openChat");
      assert.ok(env.executedCommands.some((c) => c.cmd === "photon.chat.focus"));
      assert.ok(wv.view.showCalls >= 1);

      await env.mockVscode.commands.executeCommand("photon.newSession");
      for (let i = 0; i < 40 && !wv.posted.some((m) => m.type === "sessionLoaded"); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(wv.posted.some((m) => m.type === "sessionLoaded"));

      wv.posted.length = 0;
      await env.mockVscode.commands.executeCommand("photon.refreshModels");
      for (let i = 0; i < 40 && !wv.posted.some((m) => m.type === "models"); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(wv.posted.some((m) => m.type === "models"));

      await env.mockVscode.commands.executeCommand("photon.runDiagnostics");

      // Invoke ChatParticipant with a workspace file reference & spy on controller.sendPrompt
      let capturedPrompt = "";
      let capturedAttachments: any[] | undefined;
      const origSendPrompt = provider.controller.sendPrompt.bind(provider.controller);
      (provider.controller as any).sendPrompt = async (txt: string, atts?: any[]) => {
        capturedPrompt = txt;
        capturedAttachments = atts;
      };
      try {
        const mdChunks: string[] = [];
        await part.handler(
          {
            prompt: "Explain this file",
            references: [{ value: env.Uri.file(path.join(tmpWorkspace, "src", "sample.ts")) }],
          },
          {},
          { markdown: (s: string) => mdChunks.push(s) },
          {}
        );
        assert.equal(capturedPrompt, "Explain this file");
        assert.equal(capturedAttachments?.length, 1);
        assert.equal(capturedAttachments?.[0].name, "sample.ts");
        assert.ok(capturedAttachments?.[0].text?.includes("qaValue = 42"));
        assert.ok(mdChunks.some((c) => c.includes("Sending to Photon")));
      } finally {
        (provider.controller as any).sendPrompt = origSendPrompt;
      }

      // Disposing view unsubscribes & keeps controller cleanly disposable
      wv.triggerDispose();
    } finally {
      for (const s of bundle.context.subscriptions) {
        s.dispose();
      }
      deactivate();
    }
  });

  it("2. PhotonController.handleMessage covers config, sessions, models, providers, customizations, MCP, project context & dispose", async () => {
    const bundle = env.makeContext("ctrl");
    const output = env.mockVscode.window.createOutputChannel("Photon-QA");
    const ctrl = new PhotonController(bundle.context, output as any);
    stubControllerBackgroundProbes(ctrl);

    const posted: HostMessage[] = [];
    ctrl.setPost((m) => posted.push(m));

    try {
      // 1) Initial load via ready
      await ctrl.handleMessage({ type: "ready" });
      const initMsg = posted.find((m) => m.type === "init");
      assert.ok(initMsg && initMsg.type === "init");
      assert.ok(initMsg.payload.models.some((m) => m.name === "qwen2.5-coder:7b"));

      // 2) Settings & Mode routes
      posted.length = 0;
      await ctrl.handleMessage({ type: "setMode", payload: { mode: "agent" } });
      await ctrl.handleMessage({ type: "setModel", payload: { model: "qwen2.5-coder:7b" } });
      await ctrl.handleMessage({ type: "setAutoSelect", payload: { enabled: true } });
      await ctrl.handleMessage({ type: "pinModel", payload: { model: "qwen2.5-coder:7b" } });
      await ctrl.handleMessage({ type: "setContextWindow", payload: { numCtx: 16384 } });
      await ctrl.handleMessage({ type: "setAutoApprove", payload: { enabled: true } });
      await ctrl.handleMessage({ type: "setAdaptiveEnabled", payload: { enabled: false } });
      await ctrl.handleMessage({ type: "setAdaptivityFrozen", payload: { frozen: true } });
      await ctrl.handleMessage({ type: "setIntelligence", payload: { level: "high" } });
      await ctrl.handleMessage({ type: "setWebSearchProvider", payload: { provider: "duckduckgo" } });
      await ctrl.handleMessage({ type: "setThinkingLevel", payload: { level: "medium" } });
      await ctrl.handleMessage({ type: "setThinkingEnabled", payload: { enabled: false } });
      await ctrl.handleMessage({ type: "setIndexingEnabled", payload: { enabled: false } });
      await ctrl.handleMessage({ type: "setEmbeddingModel", payload: { model: "bge-m3" } });

      const lastConfig = [...posted].reverse().find((m) => m.type === "config");
      assert.ok(lastConfig && lastConfig.type === "config");
      assert.equal(lastConfig.payload.autoApprove, true);
      assert.equal(lastConfig.payload.adaptiveEnabled, false);
      assert.equal(lastConfig.payload.adaptivityFrozen, true);
      assert.equal(lastConfig.payload.intelligence, "high");
      assert.equal(lastConfig.payload.webSearchProvider, "duckduckgo");
      assert.equal(lastConfig.payload.numCtxOverride, 16384);
      assert.equal(lastConfig.payload.embeddingModel, "bge-m3");
      assert.equal(lastConfig.payload.thinkingLevel, "off");

      // 3) Onboarding & recommendations
      await ctrl.handleMessage({ type: "completeOnboarding" });
      assert.equal(bundle.globalStore.get("photon.onboardingCompleted"), true);
      assert.ok(posted.some((m) => m.type === "onboardingStatus" && m.payload.show === false));

      await ctrl.handleMessage({ type: "openOnboarding" });
      assert.ok(posted.some((m) => m.type === "onboardingStatus" && m.payload.show === true));

      await ctrl.handleMessage({ type: "requestRecommendations", payload: { goal: "coding" } });
      assert.ok(posted.some((m) => m.type === "modelRecommendations"));

      // 4) Session Lifecycle + 3-pin cap
      // Seed active session with a message so newSession persists it to sessionStore
      const activeSess = (ctrl as any).session;
      activeSess.messages.push({ id: "u1", role: "user", content: "Session One", createdAt: Date.now() });
      const s1Id = activeSess.id;

      await ctrl.handleMessage({ type: "newSession" });
      const s2 = (ctrl as any).session;
      s2.messages.push({ id: "u2", role: "user", content: "Session Two", createdAt: Date.now() });
      await ctrl.handleMessage({ type: "newSession" });
      const s3 = (ctrl as any).session;
      s3.messages.push({ id: "u3", role: "user", content: "Session Three", createdAt: Date.now() });
      await ctrl.handleMessage({ type: "newSession" });
      const s4 = (ctrl as any).session;
      s4.messages.push({ id: "u4", role: "user", content: "Session Four", createdAt: Date.now() });
      await ctrl.handleMessage({ type: "newSession" });

      await ctrl.handleMessage({ type: "renameSession", payload: { id: s1Id, title: "Renamed QA Session" } });
      for (const sid of [s1Id, s2.id, s3.id]) {
        await ctrl.handleMessage({ type: "togglePinSession", payload: { id: sid } });
      }
      const beforeMsgCount = env.infoMessages.length;
      await ctrl.handleMessage({ type: "togglePinSession", payload: { id: s4.id } });
      assert.ok(env.infoMessages.length > beforeMsgCount, "Pinning a 4th session shows pin cap message");

      await ctrl.handleMessage({ type: "switchSession", payload: { id: s1Id } });
      assert.equal((ctrl as any).session.title, "Renamed QA Session");

      await ctrl.handleMessage({ type: "deleteSession", payload: { id: s2.id } });
      const listMsg = [...posted].reverse().find((m) => m.type === "sessionList");
      assert.ok(listMsg && listMsg.type === "sessionList");
      assert.equal(listMsg.payload.sessions.some((s) => s.id === s2.id), false);

      // 5) Per-Model Configs
      await ctrl.handleMessage({
        type: "setPerModelConfig",
        payload: { model: "qwen2.5-coder:7b", config: { numCtx: 24576, sampling: { temp: 0.15 }, note: "strict" } },
      });
      const mcMsg = [...posted].reverse().find((m) => m.type === "modelConfigs");
      assert.ok(mcMsg && mcMsg.type === "modelConfigs");
      assert.equal(mcMsg.payload["qwen2.5-coder:7b"]?.numCtx, 24576);
      await ctrl.handleMessage({ type: "removePerModelConfig", payload: { model: "qwen2.5-coder:7b" } });

      // 6) Cloud & Custom Providers + Interface Mode switching + Model Ping
      await ctrl.handleMessage({
        type: "addCustomProvider",
        payload: { label: "Local vLLM QA", baseUrl: "http://127.0.0.1:8000/v1", requireApiKey: false },
      });
      const cfgWithCustom = [...posted].reverse().find((m) => m.type === "config");
      const customProvider = cfgWithCustom?.type === "config"
        ? cfgWithCustom.payload.providers.find((p) => p.label === "Local vLLM QA")
        : undefined;
      assert.ok(customProvider, "Custom provider created in config");

      await ctrl.handleMessage({
        type: "addAvailableModel",
        payload: { providerId: customProvider.id, model: { name: "qa-model-1" } },
      });
      await ctrl.handleMessage({ type: "setInterfaceMode", payload: { mode: "cloud" } });
      assert.equal((ctrl as any).interfaceMode, "cloud");

      posted.length = 0;
      await ctrl.handleMessage({
        type: "testModel",
        payload: { providerId: customProvider.id, model: { name: "qa-model-1" } },
      });
      const pingMsg = posted.find((m) => m.type === "modelTestResult");
      assert.ok(pingMsg && pingMsg.type === "modelTestResult" && pingMsg.payload.ok === true);

      await ctrl.handleMessage({
        type: "updateCustomProvider",
        payload: { id: customProvider.id, label: "Local vLLM Renamed", baseUrl: "http://127.0.0.1:8000/v1", requireApiKey: false },
      });
      await ctrl.handleMessage({
        type: "removeAvailableModel",
        payload: { name: `${customProvider.id}:qa-model-1` },
      });
      await ctrl.handleMessage({ type: "setInterfaceMode", payload: { mode: "local" } });
      await ctrl.handleMessage({ type: "removeCustomProvider", payload: { id: customProvider.id } });

      // 7) Customizations hidden & disabled while CUSTOMIZATIONS_ENABLED === false
      assert.deepEqual(initMsg.payload.customizations, {
        skills: [],
        instructions: [],
        agents: [],
        activeAgentId: null,
      });
      assert.equal((ctrl as any).buildActiveCustomizationsPrompt(), undefined);
      await ctrl.handleMessage({
        type: "saveSkill",
        payload: { scope: "workspace", name: "QA Skill", description: "Checks quality", content: "Inspect carefully." },
      });
      await ctrl.handleMessage({
        type: "saveInstruction",
        payload: { scope: "workspace", name: "TS Rules", applyTo: "**/*.ts", content: "No implicit any." },
      });
      await ctrl.handleMessage({
        type: "saveCustomAgent",
        payload: { scope: "workspace", name: "QA Architect", description: "Plans carefully", instructions: "Design first.", preferredMode: "plan" },
      });
      await ctrl.handleMessage({
        type: "addMcpServer",
        payload: { scope: "workspace", id: "qa-http", transport: "http", url: "https://mcp.example.com/sse", connectNow: false },
      });
      assert.equal(fs.existsSync(path.join(tmpWorkspace, ".photon", "skills", "qa-skill", "SKILL.md")), false);
      assert.equal(fs.existsSync(path.join(tmpWorkspace, ".vscode", "mcp.json")), false);

      // 8) Project Config, Project Context/Notes, openFile security boundary, Cloud Usage, Checkpoints & Cleanup
      await ctrl.handleMessage({ type: "createProjectConfig" });
      assert.ok(fs.existsSync(path.join(tmpWorkspace, ".photon", "config.json")));
      assert.ok(env.openedDocs.some((d) => d.endsWith(path.join(".photon", "config.json"))));

      await ctrl.handleMessage({ type: "requestProjectContext" });
      await ctrl.handleMessage({ type: "refreshProjectContext" });
      await ctrl.handleMessage({
        type: "addProjectNote",
        payload: { category: "decision", title: "Controller E2E", content: "Verified all handlers." },
      });
      const ctxNotes = (ctrl as any).ctxMgr.getSummary().notes;
      assert.ok(ctxNotes.some((n: any) => n.title === "Controller E2E"));
      const noteId = ctxNotes.find((n: any) => n.title === "Controller E2E").id;
      await ctrl.handleMessage({ type: "deleteProjectNote", payload: { id: noteId } });
      await ctrl.handleMessage({ type: "clearWorkingMemory" });

      env.openedDocs.length = 0;
      await ctrl.handleMessage({ type: "openFile", payload: { path: "src/sample.ts", line: 1 } });
      assert.equal(env.openedDocs.length, 1);
      await ctrl.handleMessage({ type: "openFile", payload: { path: "../outside-escape.txt" } });
      assert.equal(env.openedDocs.length, 1, "Path outside workspace must be refused");

      await ctrl.handleMessage({ type: "resetCloudUsage" });
      await ctrl.handleMessage({ type: "getCheckpoints" });
      await ctrl.handleMessage({ type: "toolApproval", payload: { callId: "none", approved: true } });
      await ctrl.handleMessage({ type: "cancel" });

      ctrl.dispose();
      assert.equal((ctrl as any).disposed, true);
      assert.equal((ctrl as any).ctxMgr.disposed, true, "ctxMgr disposed on controller.dispose()");
    } finally {
      ctrl.dispose();
      for (const s of bundle.context.subscriptions) {
        s.dispose();
      }
    }
  });
});
