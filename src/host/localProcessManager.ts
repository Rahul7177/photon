import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  RUNTIME_SPECS,
  defaultDeps,
  detectRuntime,
  probeRuntime,
  type DetectorDeps,
} from "../core/adaptive/runtimeDetector";
import type {
  InstallOption,
  LocalRuntimeId,
  LocalRuntimeInfo,
  ProviderLifecycleState,
} from "../shared/types";

/** Providers Photon knows how to launch. */
export type StartableId = Extract<LocalRuntimeId, "ollama" | "llamacpp">;

export interface LlamaCppLaunchOptions {
  modelPath: string;
  ctx?: number;
  /** GPU layers; defaults to 99 (offload everything that fits). */
  ngl?: number | "all";
  port?: number;
  fa?: boolean;
  ctk?: string;
  ctv?: string;
  np?: number;
  extraArgs?: string;
}

export interface StartOptions {
  llamacpp?: LlamaCppLaunchOptions;
  /** Override the 15 s readiness window. */
  readyTimeoutMs?: number;
}

/** A single way of launching a provider. Plans are tried in order. */
export interface LaunchPlan {
  /** "spawn" = long-lived daemon we own; "exec" = helper that exits (open -a, systemctl). */
  kind: "spawn" | "exec";
  command: string;
  args: string[];
  env?: Record<string, string>;
  description: string;
}

// ---------------------------------------------------------------------------
// Pure command construction (2.1 / 2.2)
// ---------------------------------------------------------------------------

export function buildLlamaCppArgs(o: LlamaCppLaunchOptions): string[] {
  const args = ["-m", o.modelPath, "--host", "127.0.0.1", "--port", String(o.port ?? 8080)];
  if (o.ctx && o.ctx > 0) args.push("-c", String(o.ctx));
  args.push("-ngl", String(o.ngl ?? 99));
  if (o.np !== undefined) args.push("-np", String(o.np));
  if (o.fa !== undefined) args.push("-fa", o.fa ? "on" : "off");
  if (o.ctk) args.push("-ctk", o.ctk);
  if (o.ctv) args.push("-ctv", o.ctv);
  if (o.extraArgs) args.push(...o.extraArgs.split(/\s+/).filter(Boolean));
  return args;
}

export function buildLaunchPlans(
  id: StartableId,
  platform: NodeJS.Platform,
  binaryPath: string | undefined,
  opts: StartOptions = {}
): LaunchPlan[] {
  if (id === "llamacpp") {
    if (!opts.llamacpp?.modelPath) throw new Error("llama.cpp needs a .gguf model path to start.");
    return [
      {
        kind: "spawn",
        command: binaryPath ?? (platform === "win32" ? "llama-server.exe" : "llama-server"),
        args: buildLlamaCppArgs(opts.llamacpp),
        description: "llama-server",
      },
    ];
  }

  // Ollama
  const env = { OLLAMA_HOST: "127.0.0.1:11434" };
  const serve = (cmd: string): LaunchPlan => ({
    kind: "spawn",
    command: cmd,
    args: ["serve"],
    env,
    description: "ollama serve",
  });
  const bin = binaryPath && !binaryPath.startsWith("systemd:") ? binaryPath : undefined;

  if (platform === "darwin") {
    const plans: LaunchPlan[] = [];
    if (binaryPath?.endsWith(".app") || !bin) {
      plans.push({ kind: "exec", command: "open", args: ["-a", "Ollama"], description: "open -a Ollama" });
    }
    if (bin && !bin.endsWith(".app")) plans.push(serve(bin));
    else if (!plans.length) plans.push(serve("ollama"));
    return plans;
  }
  if (platform === "linux") {
    const plans: LaunchPlan[] = [
      { kind: "exec", command: "systemctl", args: ["--user", "start", "ollama"], description: "systemctl --user start ollama" },
    ];
    plans.push(serve(bin ?? "ollama"));
    return plans;
  }
  return [serve(bin ?? "ollama.exe")];
}

/** Install guidance for a provider that is `not_installed` (2.5). */
export function installOptions(id: LocalRuntimeId, platform: NodeJS.Platform): InstallOption[] {
  if (id === "ollama") {
    if (platform === "win32")
      return [
        { label: "Install via Winget", kind: "terminal", value: "winget install Ollama.Ollama" },
        { label: "Download Official Installer", kind: "url", value: "https://ollama.com/download/OllamaSetup.exe" },
      ];
    if (platform === "darwin")
      return [
        { label: "Install via Homebrew", kind: "terminal", value: "brew install ollama" },
        { label: "Download for macOS", kind: "url", value: "https://ollama.com/download/mac" },
      ];
    return [
      { label: "Install via Terminal", kind: "terminal", value: "curl -fsSL https://ollama.com/install.sh | sh" },
      { label: "Download page", kind: "url", value: "https://ollama.com/download/linux" },
    ];
  }
  if (id === "llamacpp")
    return [{ label: "llama.cpp releases", kind: "url", value: "https://github.com/ggml-org/llama.cpp/releases" }];
  if (id === "lmstudio")
    return [{ label: "Download LM Studio", kind: "url", value: "https://lmstudio.ai/download" }];
  return [{ label: "vLLM install guide", kind: "url", value: "https://docs.vllm.ai/en/latest/getting_started/installation.html" }];
}

/** Turn raw spawn failures / stderr into an actionable explanation (Phase 6 seeds). */
export function explainLaunchFailure(
  platform: NodeJS.Platform,
  error: NodeJS.ErrnoException | undefined,
  stderr: string,
  exitCode: number | null
): string {
  if (error?.code === "ENOENT") return "The executable was not found. Reinstall the provider or check your PATH.";
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return platform === "win32"
      ? "Permission denied launching the executable. Photon runs it with standard user privileges; check antivirus/policy."
      : `Permission denied. Try: chmod +x <binary>`;
  }
  if (/address already in use|bind: only one usage|eaddrinuse/i.test(stderr))
    return "The port is already in use by another process.";
  if (/cuda|nvml|driver/i.test(stderr))
    return "The daemon failed during GPU initialisation (CUDA/driver problem). See the log for details.";
  const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
  return exitCode !== null
    ? `Process exited with code ${exitCode}${tail ? `: ${tail}` : ""}`
    : tail || "The provider did not become ready in time.";
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface ProcessManagerDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  detector: () => DetectorDeps;
  sleep: (ms: number) => Promise<void>;
  /** Force-kill a whole process tree (Windows `ollama serve` spawns runners). */
  killTree: (pid: number) => void;
  platform: NodeJS.Platform;
  pollIntervalMs: number;
  readyTimeoutMs: number;
  stopGraceMs: number;
}

export function defaultProcessDeps(): ProcessManagerDeps {
  return {
    spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
    detector: defaultDeps,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    killTree: (pid) => {
      try {
        if (process.platform === "win32") {
          nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        /* already gone */
      }
    },
    platform: process.platform,
    pollIntervalMs: 500,
    readyTimeoutMs: 15_000,
    stopGraceMs: 3_000,
  };
}

const MAX_LOG_LINES = 200;

interface Managed {
  child: ChildProcess;
  exited: boolean;
  exitCode: number | null;
}

export class LocalProcessManager {
  private readonly deps: ProcessManagerDeps;
  private readonly managed = new Map<LocalRuntimeId, Managed>();
  private readonly states = new Map<LocalRuntimeId, ProviderLifecycleState>();
  private readonly logs = new Map<LocalRuntimeId, string[]>();
  private readonly lastStart = new Map<LocalRuntimeId, { id: StartableId; opts?: StartOptions }>();
  private readonly listeners = new Set<(s: ProviderLifecycleState) => void>();
  private readonly inflight = new Set<LocalRuntimeId>();

  constructor(deps: Partial<ProcessManagerDeps> = {}) {
    this.deps = { ...defaultProcessDeps(), ...deps };
  }

  onState(fn: (s: ProviderLifecycleState) => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  getState(id: LocalRuntimeId): ProviderLifecycleState {
    return this.states.get(id) ?? { id, phase: "stopped" };
  }

  private setState(id: LocalRuntimeId, patch: Omit<ProviderLifecycleState, "id" | "logs" | "managed" | "pid">): void {
    const m = this.managed.get(id);
    const state: ProviderLifecycleState = {
      id,
      ...patch,
      logs: [...(this.logs.get(id) ?? [])].slice(-50),
      managed: !!m && !m.exited,
      pid: m && !m.exited ? m.child.pid : undefined,
    };
    this.states.set(id, state);
    for (const l of this.listeners) {
      try {
        l(state);
      } catch {
        /* listener errors must not break lifecycle */
      }
    }
  }

  private pushLog(id: LocalRuntimeId, chunk: string): void {
    const lines = this.logs.get(id) ?? [];
    for (const l of chunk.split(/\r?\n/)) if (l.trim()) lines.push(l);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    this.logs.set(id, lines);
  }

  /**
   * One-click start. Resolves with the final lifecycle state ("running" or "error").
   * 2.3: broadcasts "starting", polls readiness every 500 ms up to 15 s.
   */
  async start(id: StartableId, opts: StartOptions = {}): Promise<ProviderLifecycleState> {
    if (this.inflight.has(id)) return this.getState(id);
    this.inflight.add(id);
    try {
      return await this.startInner(id, opts);
    } finally {
      this.inflight.delete(id);
    }
  }

  private async startInner(id: StartableId, opts: StartOptions): Promise<ProviderLifecycleState> {
    const spec = RUNTIME_SPECS.find((s) => s.id === id)!;
    const dd = this.deps.detector();
    this.lastStart.set(id, { id, opts });
    this.logs.set(id, []);

    const already = await probeRuntime(spec, dd);
    if (already.kind === "match") {
      this.setState(id, { phase: "running", message: `${spec.label} is already running.` });
      return this.getState(id);
    }
    if (already.kind === "occupied") {
      const info = await detectRuntime(spec, dd);
      this.setState(id, { phase: "error", message: info.message ?? `Port ${spec.port} is in use.` });
      return this.getState(id);
    }

    const info = await detectRuntime(spec, dd);
    if (info.state === "not_installed" && id === "ollama") {
      this.setState(id, { phase: "error", message: "Ollama is not installed." });
      return this.getState(id);
    }

    let plans: LaunchPlan[];
    try {
      plans = buildLaunchPlans(id, this.deps.platform, info.binaryPath, opts);
    } catch (e) {
      this.setState(id, { phase: "error", message: (e as Error).message });
      return this.getState(id);
    }

    this.setState(id, { phase: "starting", message: `Starting ${spec.label}…` });
    const timeoutMs = opts.readyTimeoutMs ?? this.deps.readyTimeoutMs;
    let lastError = "";

    for (const plan of plans) {
      const launched = await this.launch(id, plan);
      if (!launched.ok) {
        lastError = launched.error;
        continue; // try the next plan
      }
      const ready = await this.waitReady(id, spec, dd, timeoutMs);
      if (ready.ok) {
        this.setState(id, { phase: "running", message: `${spec.label} is ready.` });
        return this.getState(id);
      }
      lastError = ready.error;
      if (plan.kind === "spawn") await this.stop(id).catch(() => undefined);
    }

    this.setState(id, { phase: "error", message: lastError || "Failed to start." });
    return this.getState(id);
  }

  /** Run one plan. For "exec" plans success = exit code 0; for "spawn" = process alive after spawn event. */
  private launch(id: LocalRuntimeId, plan: LaunchPlan): Promise<{ ok: true } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      const options: SpawnOptions = {
        env: { ...process.env, ...plan.env },
        windowsHide: true,
        detached: plan.kind === "spawn" && this.deps.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      };
      try {
        child = this.deps.spawn(plan.command, plan.args, options);
      } catch (e) {
        return resolve({ ok: false, error: explainLaunchFailure(this.deps.platform, e as NodeJS.ErrnoException, "", null) });
      }
      let stderr = "";
      child.stdout?.on("data", (d) => this.pushLog(id, String(d)));
      child.stderr?.on("data", (d) => {
        stderr += String(d);
        this.pushLog(id, String(d));
      });

      if (plan.kind === "exec") {
        child.once("error", (err) =>
          resolve({ ok: false, error: explainLaunchFailure(this.deps.platform, err as NodeJS.ErrnoException, stderr, null) })
        );
        child.once("exit", (code) =>
          resolve(code === 0 ? { ok: true } : { ok: false, error: explainLaunchFailure(this.deps.platform, undefined, stderr, code) })
        );
        return;
      }

      const entry: Managed = { child, exited: false, exitCode: null };
      this.managed.set(id, entry);
      child.once("error", (err) => {
        entry.exited = true;
        this.managed.delete(id);
        resolve({ ok: false, error: explainLaunchFailure(this.deps.platform, err as NodeJS.ErrnoException, stderr, null) });
      });
      child.once("exit", (code) => {
        entry.exitCode = code;
        entry.exited = true;
        const cur = this.states.get(id)?.phase;
        // Unexpected death after we reported ready → surface it; during start the watchdog reports.
        if (cur === "running") {
          this.setState(id, { phase: "error", message: explainLaunchFailure(this.deps.platform, undefined, stderr, code) });
        } else if (cur === "stopping") {
          this.setState(id, { phase: "stopped" });
        }
      });
      if (this.deps.platform !== "win32") child.unref?.();
      // Spawned: readiness watchdog decides success.
      child.once("spawn", () => resolve({ ok: true }));
      // Some stubs/old runtimes never emit "spawn"; fall back to pid presence.
      if (child.pid) resolve({ ok: true });
    });
  }

  private async waitReady(
    id: LocalRuntimeId,
    spec: (typeof RUNTIME_SPECS)[number],
    dd: DetectorDeps,
    timeoutMs: number
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { pollIntervalMs } = this.deps;
    let waited = 0;
    for (;;) {
      const probe = await probeRuntime(spec, dd);
      if (probe.kind === "match") return { ok: true };
      const m = this.managed.get(id);
      if (m?.exited) {
        return { ok: false, error: explainLaunchFailure(this.deps.platform, undefined, (this.logs.get(id) ?? []).join("\n"), m.exitCode) };
      }
      if (waited >= timeoutMs) {
        return {
          ok: false,
          error: `${spec.label} did not respond within ${Math.round(timeoutMs / 1000)}s. ${explainLaunchFailure(
            this.deps.platform, undefined, (this.logs.get(id) ?? []).join("\n"), null
          )}`.trim(),
        };
      }
      await this.deps.sleep(pollIntervalMs);
      waited += pollIntervalMs;
    }
  }

  /** 2.4: graceful stop (SIGTERM → force after grace). Only stops daemons Photon spawned. */
  async stop(id: LocalRuntimeId): Promise<ProviderLifecycleState> {
    const m = this.managed.get(id);
    if (!m || m.exited) {
      this.managed.delete(id);
      const msg =
        this.getState(id).phase === "running"
          ? "This provider was not started by Photon — quit it from its own app/tray."
          : undefined;
      if (msg) this.setState(id, { phase: "running", message: msg });
      else this.setState(id, { phase: "stopped" });
      return this.getState(id);
    }
    this.setState(id, { phase: "stopping", message: "Stopping…" });
    const exited = new Promise<void>((resolve) => {
      if (m.exited) return resolve();
      m.child.once("exit", () => resolve());
    });
    try {
      m.child.kill("SIGTERM");
    } catch {
      /* fall through to force */
    }
    const timedOut = await Promise.race([
      exited.then(() => false),
      this.deps.sleep(this.deps.stopGraceMs).then(() => true),
    ]);
    if (timedOut && !m.exited && m.child.pid) {
      this.deps.killTree(m.child.pid);
      await Promise.race([exited, this.deps.sleep(1000)]);
    } else if (this.deps.platform === "win32" && m.child.pid) {
      // Windows SIGTERM kills only the parent; sweep any orphaned runner children.
      this.deps.killTree(m.child.pid);
    }
    this.managed.delete(id);
    this.setState(id, { phase: "stopped" });
    return this.getState(id);
  }

  async restart(id: StartableId): Promise<ProviderLifecycleState> {
    await this.stop(id);
    const prev = this.lastStart.get(id);
    return this.start(id, prev?.opts);
  }

  /** Detection snapshot reused by the controller. */
  detect(): Promise<LocalRuntimeInfo[]> {
    const dd = this.deps.detector();
    return Promise.all(RUNTIME_SPECS.map((s) => detectRuntime(s, dd)));
  }

  /** Kill everything we spawned (extension deactivation). */
  dispose(): void {
    for (const [id, m] of this.managed) {
      if (m.exited) continue;
      try {
        m.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      if (m.child.pid) this.deps.killTree(m.child.pid);
      this.managed.delete(id);
    }
    this.listeners.clear();
  }
}
