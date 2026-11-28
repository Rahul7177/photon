import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import Module from "node:module";
import type { HostMessage, ViewMessage } from "../src/shared/protocol";

const PORT = Number(process.env.PHOTON_WORKBENCH_PORT || 4321);
const EXTENSION_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = process.env.PHOTON_WORKSPACE_ROOT
  ? path.resolve(process.env.PHOTON_WORKSPACE_ROOT)
  : EXTENSION_ROOT;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  ".vscode-test",
  ".photon-workbench-state",
]);

function walkWorkspaceFiles(root: string, maxFiles = 2000): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".photon") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(full);
        }
      } else if (entry.isFile()) {
        results.push(full);
        if (results.length >= maxFiles) break;
      }
    }
  }
  return results;
}

function createLiveVscodeHost(workspaceRoot: string, extensionRoot: string) {
  const stateDir = path.join(os.tmpdir(), "photon-live-workbench");
  const globalStorageDir = path.join(stateDir, "global");
  const workspaceStorageDir = path.join(stateDir, "workspace");
  fs.mkdirSync(globalStorageDir, { recursive: true });
  fs.mkdirSync(workspaceStorageDir, { recursive: true });

  const configMap = new Map<string, any>([
    ["defaultMode", "chat"],
    ["interfaceMode", "local"],
    ["tools.autoApprove", true],
    ["adaptive.enabled", true],
    ["intelligence.level", "auto"],
    ["webSearch.provider", "duckduckgo"],
    ["ollama.baseUrl", "http://127.0.0.1:11434"],
    ["llamacpp.baseUrl", "http://127.0.0.1:8080"],
    ["index.enabled", false],
    ["bench.autoRun", false],
  ]);

  const globalStore = new Map<string, any>();
  const workspaceStore = new Map<string, any>();
  const secretStore = new Map<string, string>();
  const outputLines: string[] = [];
  const registeredCommands = new Map<string, (...args: any[]) => any>();
  const registeredViewProviders = new Map<string, any>();
  const statusBarItems: Array<{ text: string; tooltip: string; command: string; shown: boolean }> = [];

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
  const secretEmitter = new EventEmitter<{ key: string }>();

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
      createChatParticipant(id: string, _handler: any) {
        return { id, iconPath: undefined, dispose: () => {} };
      },
    },
    commands: {
      registerCommand(id: string, cb: (...args: any[]) => any) {
        registeredCommands.set(id, cb);
        return { dispose: () => registeredCommands.delete(id) };
      },
      async executeCommand(id: string, ...args: any[]) {
        const fn = registeredCommands.get(id);
        if (fn) return fn(...args);
        return undefined;
      },
    },
    env: {
      async openExternal(_uri: Uri) {
        return true;
      },
    },
    languages: {
      getDiagnostics: () => [],
    },
    window: {
      createOutputChannel(name: string) {
        return {
          name,
          appendLine(s: string) {
            const stamped = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
            outputLines.push(stamped);
            if (outputLines.length > 500) outputLines.shift();
          },
          append(s: string) {
            outputLines.push(s);
            if (outputLines.length > 500) outputLines.shift();
          },
          show() {},
          clear() {
            outputLines.length = 0;
          },
          dispose() {},
        };
      },
      registerWebviewViewProvider(viewType: string, provider: any) {
        registeredViewProviders.set(viewType, provider);
        return { dispose: () => registeredViewProviders.delete(viewType) };
      },
      createStatusBarItem() {
        const item = {
          text: "$(sparkle) Photon",
          tooltip: "Photon AI",
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
      async showInformationMessage(_msg: string) {
        return undefined;
      },
      async showErrorMessage(_msg: string) {
        return undefined;
      },
      async showWarningMessage(_msg: string) {
        return undefined;
      },
      async showTextDocument(doc: any) {
        return { document: doc };
      },
      createTerminal(opts: { name: string }) {
        return {
          name: opts.name,
          show() {},
          sendText(_cmd: string) {},
          dispose() {},
        };
      },
    },
    workspace: {
      workspaceFolders,
      asRelativePath(target: Uri | string) {
        const fsPath = typeof target === "string" ? target : target.fsPath;
        return path.relative(workspaceRoot, fsPath).replace(/\\/g, "/");
      },
      async findFiles(include: any, _exclude?: any, maxResults = 200) {
        const patternStr = typeof include === "string" ? include : include?.pattern || "";
        const needle = patternStr.replace(/[\*\?\{\}]/g, "").toLowerCase();
        const all = walkWorkspaceFiles(workspaceRoot, 2000);
        const matched = all
          .filter((f) => {
            if (!needle) return true;
            const rel = path.relative(workspaceRoot, f).replace(/\\/g, "/").toLowerCase();
            return rel.includes(needle);
          })
          .slice(0, maxResults)
          .map((f) => Uri.file(f));
        return matched;
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

  const context = {
    extensionUri: Uri.file(extensionRoot),
    globalStorageUri: Uri.file(globalStorageDir),
    storageUri: Uri.file(workspaceStorageDir),
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
  };

  return {
    mockVscode,
    context,
    outputLines,
    registeredViewProviders,
    registeredCommands,
    statusBarItems,
  };
}

// Install the live vscode module hook before importing Photon host modules
const host = createLiveVscodeHost(WORKSPACE_ROOT, EXTENSION_ROOT);
const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "vscode") return host.mockVscode;
  return originalLoad.apply(this, [request, parent, isMain]);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { activate } = require("../src/extension") as typeof import("../src/extension");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ChatViewProvider } = require("../src/host/ChatViewProvider") as typeof import("../src/host/ChatViewProvider");

activate(host.context as any);

const provider = host.registeredViewProviders.get(ChatViewProvider.viewType);
if (!provider) {
  throw new Error("ChatViewProvider was not registered by activate()");
}

// SSE client connections and state snapshot cache
const sseClients = new Set<http.ServerResponse>();
const latestStateByType = new Map<string, HostMessage>();
const hostMessageLog: Array<{ ts: string; msg: HostMessage }> = [];
const viewMessageLog: Array<{ ts: string; msg: ViewMessage }> = [];

const SNAPSHOT_TYPES = new Set([
  "init",
  "config",
  "models",
  "planUpdated",
  "sessionLoaded",
  "sessionList",
  "tools",
  "status",
  "tokenUsage",
  "generationStats",
  "decision",
  "benchResults",
  "indexStatus",
  "mcpServers",
  "customizations",
  "modelConfigs",
  "ollamaRuntime",
  "hardwareMetrics",
  "cloudUsage",
  "modelRecommendations",
  "providerRuntimes",
  "providerLifecycle",
  "projectContext",
  "checkpointsList",
  "onboardingStatus",
  "turnTelemetry",
]);

let liveSession: any = { id: "init", title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };

function updateLiveSession(msg: HostMessage) {
  switch (msg.type) {
    case "init":
      if (msg.payload?.session) {
        liveSession = JSON.parse(JSON.stringify(msg.payload.session));
      }
      break;
    case "sessionLoaded":
      if (msg.payload) {
        liveSession = JSON.parse(JSON.stringify(msg.payload));
      }
      break;
    case "messageAppended":
      if (msg.payload) {
        const copy = JSON.parse(JSON.stringify(msg.payload));
        const idx = liveSession.messages.findIndex((m: any) => m.id === copy.id);
        if (idx >= 0) liveSession.messages[idx] = copy;
        else liveSession.messages.push(copy);
      }
      break;
    case "messageDelta":
      if (msg.payload) {
        const target = liveSession.messages.find((m: any) => m.id === msg.payload.id);
        if (target) target.content = (target.content || "") + msg.payload.delta;
      }
      break;
    case "thinkingDelta":
      if (msg.payload) {
        const target = liveSession.messages.find((m: any) => m.id === msg.payload.id);
        if (target) target.thinking = (target.thinking || "") + msg.payload.delta;
      }
      break;
    case "thinkingDone":
      if (msg.payload) {
        const target = liveSession.messages.find((m: any) => m.id === msg.payload.id);
        if (target) target.thinkingElapsedMs = msg.payload.elapsedMs;
      }
      break;
    case "toolUpdate":
      if (msg.payload) {
        const target = liveSession.messages.find((m: any) => m.id === msg.payload.messageId);
        if (target) {
          if (!Array.isArray(target.toolCalls)) target.toolCalls = [];
          const callCopy = JSON.parse(JSON.stringify(msg.payload.call));
          const cIdx = target.toolCalls.findIndex((c: any) => c.id === callCopy.id);
          if (cIdx >= 0) target.toolCalls[cIdx] = callCopy;
          else target.toolCalls.push(callCopy);
        }
      }
      break;
    case "messageRemoved":
      if (msg.payload) {
        liveSession.messages = liveSession.messages.filter((m: any) => m.id !== msg.payload.id);
      }
      break;
  }
  const initSnap = latestStateByType.get("init") as any;
  if (initSnap?.payload) {
    initSnap.payload.session = liveSession;
  }
}

function broadcastHostMessage(msg: HostMessage) {
  updateLiveSession(msg);
  if (SNAPSHOT_TYPES.has(msg.type)) {
    latestStateByType.set(msg.type, msg);
  }
  hostMessageLog.push({ ts: new Date().toISOString(), msg });
  if (hostMessageLog.length > 400) hostMessageLog.shift();

  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

let receiveFromWebview: ((m: ViewMessage) => void) | undefined;

const mockWebviewView: any = {
  viewType: ChatViewProvider.viewType,
  visible: true,
  show() {},
  onDidDispose() {
    return { dispose: () => {} };
  },
  webview: {
    options: {},
    html: "",
    cspSource: "http://127.0.0.1:" + PORT,
    asWebviewUri: (u: any) => u,
    postMessage: async (m: HostMessage) => {
      broadcastHostMessage(m);
      return true;
    },
    onDidReceiveMessage(cb: (m: ViewMessage) => void) {
      receiveFromWebview = cb;
      return { dispose: () => {} };
    },
  },
};

provider.resolveWebviewView(mockWebviewView);

function renderWorkbenchHtml(cleanMode: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Photon Extension Live Workbench</title>
  <link rel="stylesheet" href="/assets/index.css" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #141416;
      color: #eaeaea;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    .wb-shell {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
    }
    .wb-topbar {
      display: ${cleanMode ? "none" : "flex"};
      align-items: center;
      justify-content: space-between;
      height: 34px;
      padding: 0 12px;
      background: #0d0d10;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 12px;
      user-select: none;
      flex-shrink: 0;
    }
    .wb-topbar-left, .wb-topbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .wb-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255, 107, 45, 0.14);
      border: 1px solid rgba(255, 107, 45, 0.35);
      color: #ff9454;
      font-weight: 600;
      font-size: 11px;
    }
    .wb-statusbar {
      color: rgba(234, 234, 234, 0.72);
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 11px;
    }
    .wb-btn {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #eaeaea;
      padding: 3px 9px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
    }
    .wb-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .wb-btn.active {
      background: rgba(255, 107, 45, 0.2);
      border-color: rgba(255, 107, 45, 0.45);
      color: #ffb07c;
    }
    .wb-main {
      display: flex;
      flex: 1;
      min-height: 0;
      justify-content: center;
      background: #111113;
    }
    .wb-extension-frame {
      width: 100%;
      height: 100%;
      background: #181818;
      display: flex;
      flex-direction: column;
      transition: max-width 0.18s ease;
    }
    .wb-extension-frame.sidebar-mode {
      max-width: 460px;
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 0 40px rgba(0, 0, 0, 0.5);
    }
    #root {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
  </style>
  <script>
    (function() {
      let persistedState = undefined;
      try {
        const raw = sessionStorage.getItem("photon_webview_state");
        if (raw) persistedState = JSON.parse(raw);
      } catch (e) {}

      window.__photonEvents = { sent: [], received: [] };

      window.acquireVsCodeApi = function() {
        return {
          postMessage: function(msg) {
            window.__photonEvents.sent.push({ ts: Date.now(), msg: msg });
            fetch("/api/message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(msg)
            }).catch(function(err) {
              console.error("[PhotonWorkbench] postMessage error:", err);
            });
          },
          getState: function() {
            return persistedState;
          },
          setState: function(next) {
            persistedState = next;
            try {
              sessionStorage.setItem("photon_webview_state", JSON.stringify(next));
            } catch (e) {}
            return next;
          }
        };
      };

      const es = new EventSource("/api/events");
      es.onmessage = function(ev) {
        try {
          const msg = JSON.parse(ev.data);
          window.__photonEvents.received.push({ ts: Date.now(), msg: msg });
          if (window.__photonEvents.received.length > 300) {
            window.__photonEvents.received.shift();
          }
          const countEl = document.getElementById("wb-event-count");
          if (countEl) {
            countEl.textContent = "Events: " + window.__photonEvents.received.length;
          }
          if (msg.type === "status" && msg.payload) {
            const stEl = document.getElementById("wb-live-status");
            if (stEl) {
              stEl.textContent = "Status: " + msg.payload.kind + (msg.payload.detail ? " (" + msg.payload.detail + ")" : "");
            }
          }
          window.postMessage(msg, "*");
        } catch (err) {
          console.error("[PhotonWorkbench] SSE parse error:", err);
        }
      };
    })();
  </script>
</head>
<body>
  <div class="wb-shell">
    <div class="wb-topbar">
      <div class="wb-topbar-left">
        <span class="wb-badge">PHOTON LIVE WORKBENCH</span>
        <span class="wb-statusbar" id="wb-live-status">Status: ready</span>
        <span class="wb-statusbar" id="wb-event-count">Events: 0</span>
      </div>
      <div class="wb-topbar-right">
        <button class="wb-btn" id="wb-toggle-width" onclick="(function(){
          const f = document.getElementById('wb-frame');
          const b = document.getElementById('wb-toggle-width');
          f.classList.toggle('sidebar-mode');
          const isSidebar = f.classList.contains('sidebar-mode');
          b.textContent = isSidebar ? 'View: Sidebar (460px)' : 'View: Full Width';
          b.classList.toggle('active', isSidebar);
        })()">View: Full Width</button>
      </div>
    </div>
    <div class="wb-main">
      <div class="wb-extension-frame" id="wb-frame">
        <div id="root"></div>
      </div>
    </div>
  </div>
  <script type="module" src="/assets/index.js"></script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  // CORS headers for tooling
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. SSE Event Stream (/api/events)
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);

    // Replay cached state snapshots immediately so any new/reloaded tab hydrates at once
    for (const msg of latestStateByType.values()) {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    }

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. Receive ViewMessage from browser or automated test (/api/message)
  if (req.method === "POST" && url.pathname === "/api/message") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const msg = JSON.parse(body) as ViewMessage;
        viewMessageLog.push({ ts: new Date().toISOString(), msg });
        if (viewMessageLog.length > 200) viewMessageLog.shift();

        // If a second tab sends "ready" after initial boot, replay all cached snapshots
        // AND still forward to controller so everything stays in sync.
        if (msg.type === "ready" && latestStateByType.size > 0) {
          for (const snap of latestStateByType.values()) {
            broadcastHostMessage(snap);
          }
        }
        receiveFromWebview?.(msg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    });
    return;
  }

  // 3. Live Telemetry & State Inspection API (/api/telemetry)
  if (req.method === "GET" && url.pathname === "/api/telemetry") {
    const snapshots: Record<string, any> = {};
    for (const [k, v] of latestStateByType.entries()) {
      snapshots[k] = v;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          workspaceRoot: WORKSPACE_ROOT,
          statusBar: host.statusBarItems[0] ?? null,
          connectedClients: sseClients.size,
          liveSession,
          snapshots,
          recentViewMessages: viewMessageLog.slice(-40),
          recentHostMessages: hostMessageLog.slice(-60),
          outputLog: host.outputLines.slice(-100),
        },
        null,
        2
      )
    );
    return;
  }

  // 4. Static Webview Assets (/assets/*)
  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    const relAsset = url.pathname.replace(/^\/assets\//, "");
    const assetPath = path.resolve(EXTENSION_ROOT, "dist", "webview", "assets", relAsset);
    if (!assetPath.startsWith(path.resolve(EXTENSION_ROOT, "dist", "webview", "assets"))) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(assetPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(assetPath).toLowerCase();
    const contentType =
      ext === ".js"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".map"
        ? "application/json; charset=utf-8"
        : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    fs.createReadStream(assetPath).pipe(res);
    return;
  }

  // 5. Media icons (/media/*)
  if (req.method === "GET" && url.pathname.startsWith("/media/")) {
    const relMedia = url.pathname.replace(/^\/media\//, "");
    const mediaPath = path.resolve(EXTENSION_ROOT, "media", relMedia);
    if (fs.existsSync(mediaPath)) {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      fs.createReadStream(mediaPath).pipe(res);
      return;
    }
  }

  // 6. Main Workbench Page (/)
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const cleanMode = url.searchParams.get("clean") === "1";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(renderWorkbenchHtml(cleanMode));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Photon Live Workbench] Running at http://127.0.0.1:${PORT}`);
  console.log(`[Photon Live Workbench] Telemetry endpoint: http://127.0.0.1:${PORT}/api/telemetry`);
  // Trigger initial controller ready sequence immediately so models/machine profile are warm
  receiveFromWebview?.({ type: "ready" });
});
