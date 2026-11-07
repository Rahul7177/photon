import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { LocalRuntimeId, LocalRuntimeInfo, LocalRuntimeState, ModelInfo, PortOwner } from "../../shared/types";

const execAsync = promisify(exec);

export type { LocalRuntimeId, LocalRuntimeState, LocalRuntimeInfo, PortOwner };

export interface RuntimeSpec {
  id: LocalRuntimeId;
  label: string;
  port: number;
  /** Health paths tried in order; first one that matches the signature wins. */
  healthPaths: string[];
  /** Returns true when an HTTP response body looks like this provider. */
  signature: (body: string, status: number) => boolean;
  /** Binary names searched on PATH. */
  binaries: Record<"win32" | "darwin" | "linux", string[]>;
}

export const RUNTIME_SPECS: RuntimeSpec[] = [
  {
    id: "ollama",
    label: "Ollama",
    port: 11434,
    healthPaths: ["/api/version"],
    signature: (body, status) => status === 200 && /"version"/.test(body),
    binaries: { win32: ["ollama.exe"], darwin: ["ollama"], linux: ["ollama"] },
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    port: 8080,
    healthPaths: ["/health", "/props"],
    signature: (body, status) =>
      status === 200 && (/"status"\s*:\s*"ok"/.test(body) || /default_generation_settings|model_path/.test(body)),
    binaries: {
      win32: ["llama-server.exe", "server.exe"],
      darwin: ["llama-server"],
      linux: ["llama-server"],
    },
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    port: 1234,
    healthPaths: ["/v1/models"],
    signature: (body, status) => status === 200 && /"data"/.test(body),
    binaries: { win32: ["lms.exe"], darwin: ["lms"], linux: ["lms"] },
  },
  {
    id: "vllm",
    label: "vLLM / Custom Local",
    port: 8000,
    healthPaths: ["/v1/models"],
    signature: (body, status) => status === 200 && /"data"/.test(body),
    // vLLM is a python package; there is no reliable binary to sense.
    binaries: { win32: ["vllm.exe"], darwin: ["vllm"], linux: ["vllm"] },
  },
];

/** Injectable side effects so detection is testable without touching the OS. */
export interface DetectorDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists: (p: string) => boolean;
  listDir: (p: string) => string[];
  fetchFn: (url: string, init?: { signal?: AbortSignal }) => Promise<{
    status: number;
    text: () => Promise<string>;
  }>;
  run: (cmd: string) => Promise<string>;
  timeoutMs: number;
}

export function defaultDeps(): DetectorDeps {
  return {
    platform: process.platform,
    env: process.env,
    fileExists: (p) => {
      try {
        return fs.statSync(p).isFile() || fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    listDir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    fetchFn: (url, init) => fetch(url, init),
    run: async (cmd) => {
      const { stdout } = await execAsync(cmd, { timeout: 3000, windowsHide: true });
      return stdout;
    },
    timeoutMs: 2000,
  };
}

// ---------------------------------------------------------------------------
// 1.1 Binary discovery
// ---------------------------------------------------------------------------

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(platform === "win32" ? ";" : ":").filter(Boolean);
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === "win32" ? path.win32 : path.posix).join(...parts);
}

/** Candidate absolute paths (besides PATH) for a given runtime. */
export function candidatePaths(
  id: LocalRuntimeId,
  deps: Pick<DetectorDeps, "platform" | "env" | "listDir">
): string[] {
  const { platform, env } = deps;
  const out: string[] = [];
  const j = (...p: string[]) => joinFor(platform, ...p);

  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? env.LocalAppData ?? (env.USERPROFILE ? j(env.USERPROFILE, "AppData", "Local") : undefined);
    const pf = env.PROGRAMFILES ?? env.ProgramFiles;
    if (id === "ollama") {
      if (local) {
        out.push(j(local, "Programs", "Ollama", "ollama.exe"));
        out.push(j(local, "Programs", "Ollama", "ollama app.exe"));
      }
      if (pf) {
        out.push(j(pf, "Ollama", "ollama.exe"));
        out.push(j(pf, "Ollama", "ollama app.exe"));
      }
    } else if (id === "lmstudio" && local) {
      const root = j(local, "LM-Studio");
      for (const d of deps.listDir(root)) {
        if (d.startsWith("app-")) out.push(j(root, d, "resources", "app", "bin", "lms.exe"));
      }
      out.push(j(local, "Programs", "LM Studio", "LM Studio.exe"));
      const home = env.USERPROFILE;
      if (home) out.push(j(home, ".lmstudio", "bin", "lms.exe"));
    }
  } else if (platform === "darwin") {
    if (id === "ollama") {
      out.push(
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/Applications/Ollama.app"
      );
    } else if (id === "lmstudio") {
      out.push("/Applications/LM Studio.app");
      if (env.HOME) out.push(j(env.HOME, ".lmstudio", "bin", "lms"));
    } else if (id === "llamacpp") {
      out.push("/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server");
    }
  } else {
    if (id === "ollama") out.push("/usr/local/bin/ollama", "/usr/bin/ollama");
    else if (id === "llamacpp") out.push("/usr/local/bin/llama-server", "/usr/bin/llama-server");
    else if (id === "lmstudio" && env.HOME) out.push(j(env.HOME, ".lmstudio", "bin", "lms"));
  }
  return out;
}

async function registryOllamaPath(deps: DetectorDeps): Promise<string | undefined> {
  if (deps.platform !== "win32") return undefined;
  const queries = [
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /v InstallLocation /f Ollama',
    'reg query "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /v InstallLocation /f Ollama',
  ];
  for (const cmd of queries) {
    try {
      const out = await deps.run(cmd);
      const lines = out.split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
        if (m) {
          const dir = m[1].trim();
          const cand1 = path.win32.join(dir, "ollama.exe");
          if (deps.fileExists(cand1)) return cand1;
          const cand2 = path.win32.join(dir, "ollama app.exe");
          if (deps.fileExists(cand2)) return cand2;
        }
      }
    } catch {
      /* key absent — try next */
    }
  }
  return undefined;
}

/** Locate the binary for one runtime, or undefined. */
export async function findBinary(
  spec: RuntimeSpec,
  deps: DetectorDeps
): Promise<string | undefined> {
  const platform = deps.platform === "win32" || deps.platform === "darwin" ? deps.platform : "linux";
  for (const dir of pathDirs(deps.env, deps.platform)) {
    for (const name of spec.binaries[platform]) {
      const p = joinFor(deps.platform, dir, name);
      if (deps.fileExists(p)) return p;
    }
  }
  for (const p of candidatePaths(spec.id, deps)) {
    if (deps.fileExists(p)) return p;
  }
  if (spec.id === "ollama") {
    if (deps.platform === "win32") {
      try {
        const whereOut = await deps.run("where.exe ollama.exe");
        const match = whereOut.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith(".exe"));
        if (match && deps.fileExists(match)) return match;
      } catch {
        /* not in where.exe */
      }
    } else {
      try {
        const whichOut = await deps.run("which ollama");
        const match = whichOut.split(/\r?\n/).map((l) => l.trim())[0];
        if (match && deps.fileExists(match)) return match;
      } catch {
        /* not in which */
      }
    }
    const reg = await registryOllamaPath(deps);
    if (reg) return reg;
    if (deps.platform === "linux") {
      try {
        const out = (await deps.run("systemctl is-active ollama")).trim();
        // The service unit exists even if the binary lives somewhere unusual.
        if (out === "active" || out === "inactive" || out === "failed") return "systemd:ollama";
      } catch {
        /* systemctl missing or unit unknown */
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1.2 Health probing
// ---------------------------------------------------------------------------

type ProbeResult =
  | { kind: "match"; body: string }
  | { kind: "occupied" }
  | { kind: "closed" };

/** Probe one runtime's health endpoint(s) within the ultra-low timeout. */
export async function probeRuntime(
  spec: RuntimeSpec,
  deps: DetectorDeps,
  host = "127.0.0.1"
): Promise<ProbeResult> {
  let occupied = false;
  for (const p of spec.healthPaths) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
    try {
      const res = await deps.fetchFn(`http://${host}:${spec.port}${p}`, { signal: ctrl.signal });
      const body = await res.text().catch(() => "");
      occupied = true; // something answered HTTP
      if (spec.signature(body, res.status)) return { kind: "match", body };
    } catch {
      /* refused / timed out */
    } finally {
      clearTimeout(timer);
    }
  }
  return occupied ? { kind: "occupied" } : { kind: "closed" };
}

// ---------------------------------------------------------------------------
// 1.3 Port conflict inspection
// ---------------------------------------------------------------------------

/** Parse `netstat -ano` output for the PID LISTENING on `port`. */
export function parseNetstat(out: string, port: number): number | undefined {
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0])) continue;
    if (!/LISTENING/i.test(cols[3])) continue;
    if (cols[1].endsWith(`:${port}`)) {
      const pid = parseInt(cols[4], 10);
      if (Number.isFinite(pid)) return pid;
    }
  }
  return undefined;
}

/** Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` output. */
export function parseLsof(out: string): PortOwner | undefined {
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    if (/^COMMAND\s/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = parseInt(cols[1], 10);
    if (Number.isFinite(pid)) return { pid, processName: cols[0] };
  }
  return undefined;
}

export async function findPortOwner(
  port: number,
  deps: DetectorDeps
): Promise<PortOwner | undefined> {
  try {
    if (deps.platform === "win32") {
      const pid = parseNetstat(await deps.run("netstat -ano -p TCP"), port);
      if (pid === undefined) return undefined;
      let processName: string | undefined;
      try {
        const out = await deps.run(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
        const m = out.match(/^"([^"]+)"/m);
        processName = m?.[1];
      } catch {
        /* name is optional */
      }
      return { pid, processName };
    }
    return parseLsof(await deps.run(`lsof -nP -iTCP:${port} -sTCP:LISTEN`));
  } catch {
    return undefined;
  }
}

export function portConflictMessage(label: string, port: number, owner?: PortOwner): string {
  const who = owner
    ? `PID ${owner.pid}${owner.processName ? ` (${owner.processName})` : ""}`
    : "another process";
  return `Port ${port} is in use by ${who}, and it is not ${label}. Terminate it or use a different port.`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function detectRuntime(
  spec: RuntimeSpec,
  deps: DetectorDeps
): Promise<LocalRuntimeInfo> {
  const base: LocalRuntimeInfo = {
    id: spec.id,
    label: spec.label,
    state: "not_installed",
    port: spec.port,
    baseUrl: `http://127.0.0.1:${spec.port}`,
  };
  const [probe, binaryPath] = await Promise.all([
    probeRuntime(spec, deps),
    findBinary(spec, deps),
  ]);
  base.binaryPath = binaryPath;

  if (probe.kind === "match") {
    base.state = "running";
    if (spec.id === "ollama") {
      try {
        base.version = JSON.parse(probe.body).version;
      } catch {
        /* version is cosmetic */
      }
    }
    return base;
  }
  if (probe.kind === "occupied") {
    base.state = "port_conflict";
    base.portOwner = await findPortOwner(spec.port, deps);
    base.message = portConflictMessage(spec.label, spec.port, base.portOwner);
    return base;
  }
  // Port closed. Could still be held by a non-HTTP process; check cheaply.
  if (binaryPath) {
    base.state = "installed_stopped";
    return base;
  }
  return base;
}

/** Detect all known local runtimes in parallel. */
export async function detectLocalRuntimes(
  overrides: Partial<DetectorDeps> = {}
): Promise<LocalRuntimeInfo[]> {
  const deps = { ...defaultDeps(), ...overrides };
  return Promise.all(RUNTIME_SPECS.map((s) => detectRuntime(s, deps)));
}

/**
 * Sense installed Ollama models directly from disk manifests (`~/.ollama/models/manifests`
 * or `OLLAMA_MODELS/manifests`) so Photon knows which models are already downloaded even
 * before the Ollama server daemon is started or if it's temporarily unreachable.
 */
export function scanDiskOllamaModels(
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): ModelInfo[] {
  try {
    const modelsRoot = env.OLLAMA_MODELS
      ? env.OLLAMA_MODELS.trim()
      : path.join(homedir, ".ollama", "models");
    const manifestsRoot = path.join(modelsRoot, "manifests");
    if (!fs.existsSync(manifestsRoot)) return [];

    const results: ModelInfo[] = [];
    const seen = new Set<string>();

    const walk = (dir: string, relParts: string[]) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, [...relParts, entry.name]);
        } else if (entry.isFile() && relParts.length >= 2) {
          // Typical layout: registry.ollama.ai / library / <model> / <tag>
          // or registry.ollama.ai / <namespace> / <model> / <tag>
          const tag = entry.name;
          const withoutRegistry =
            relParts[0].includes(".") ? relParts.slice(1) : relParts;
          if (withoutRegistry.length === 0) continue;
          const modelPath =
            withoutRegistry[0] === "library" && withoutRegistry.length >= 2
              ? withoutRegistry.slice(1).join("/")
              : withoutRegistry.join("/");
          const name = `${modelPath}:${tag}`;
          if (seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());

          let sizeBytes: number | undefined;
          try {
            const raw = fs.readFileSync(fullPath, "utf8");
            const parsed = JSON.parse(raw) as {
              layers?: Array<{ mediaType?: string; size?: number }>;
            };
            if (Array.isArray(parsed.layers)) {
              const total = parsed.layers.reduce((acc, l) => acc + (typeof l.size === "number" ? l.size : 0), 0);
              if (total > 0) sizeBytes = total;
            }
          } catch {
            /* ignore malformed manifest */
          }

          results.push({
            name,
            sizeBytes,
            provider: "ollama",
          });
        }
      }
    };

    walk(manifestsRoot, []);
    return results;
  } catch {
    return [];
  }
}


