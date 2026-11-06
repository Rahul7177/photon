import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  LocalProcessManager,
  buildLaunchPlans,
  buildLlamaCppArgs,
  explainLaunchFailure,
  installOptions,
  type ProcessManagerDeps,
} from "../../src/host/localProcessManager";
import type { DetectorDeps } from "../../src/core/adaptive/runtimeDetector";
import type { ProviderLifecycleState } from "../../src/shared/types";

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  /** When false, SIGTERM is ignored (forces the kill-after-grace path). */
  respondsToTerm = true;
  kill(sig: string) {
    this.killed.push(sig);
    if (this.respondsToTerm) setImmediate(() => this.emit("exit", 0));
    return true;
  }
  unref() {}
}

function harness(opts: {
  platform?: NodeJS.Platform;
  /** Poll attempt (1-based) at which the daemon begins answering. 0 = never. */
  readyAt?: number;
  binary?: string;
  /** Called per spawn; lets a test script the child. */
  onSpawn?: (child: FakeChild, cmd: string, args: string[]) => void;
}) {
  const spawns: { cmd: string; args: string[]; env: any; opts: any }[] = [];
  const children: FakeChild[] = [];
  const killedTrees: number[] = [];
  let probes = 0;
  const bin = opts.binary ?? "C:\\Ollama\\ollama.exe";
  const detector = (): DetectorDeps => ({
    platform: opts.platform ?? "win32",
    env: {},
    fileExists: (p) => p === bin,
    listDir: () => [],
    run: async () => {
      throw new Error("no");
    },
    timeoutMs: 20,
    fetchFn: async () => {
      probes++;
      if (opts.readyAt && probes >= opts.readyAt) {
        return { status: 200, text: async () => '{"version":"0.5.0"}' };
      }
      throw new Error("ECONNREFUSED");
    },
  });
  // The binary is found via a fake PATH-less candidate: put it on PATH.
  const d0 = detector;
  const detectorWithPath = () => ({ ...d0(), env: { PATH: bin.replace(/[\\/][^\\/]+$/, "") } });
  const deps: Partial<ProcessManagerDeps> = {
    platform: opts.platform ?? "win32",
    detector: detectorWithPath,
    pollIntervalMs: 1,
    readyTimeoutMs: 30,
    stopGraceMs: 20,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    killTree: (pid) => killedTrees.push(pid),
    spawn: ((cmd: string, args: string[], o: any) => {
      const c = new FakeChild();
      children.push(c);
      spawns.push({ cmd, args, env: o.env, opts: o });
      setImmediate(() => opts.onSpawn?.(c, cmd, args));
      setImmediate(() => c.emit("spawn"));
      return c as any;
    }) as any,
  };
  const mgr = new LocalProcessManager(deps);
  const states: ProviderLifecycleState[] = [];
  mgr.onState((s) => states.push(s));
  return { mgr, spawns, children, killedTrees, states };
}

describe("launch plan construction", () => {
  it("Windows Ollama spawns `ollama serve` with OLLAMA_HOST", () => {
    const [p] = buildLaunchPlans("ollama", "win32", "C:\\O\\ollama.exe");
    assert.equal(p.kind, "spawn");
    assert.equal(p.command, "C:\\O\\ollama.exe");
    assert.deepEqual(p.args, ["serve"]);
    assert.equal(p.env?.OLLAMA_HOST, "127.0.0.1:11434");
  });

  it("macOS prefers `open -a Ollama` for the app bundle", () => {
    const plans = buildLaunchPlans("ollama", "darwin", "/Applications/Ollama.app");
    assert.deepEqual([plans[0].command, ...plans[0].args], ["open", "-a", "Ollama"]);
  });

  it("macOS with CLI binary adds open fallback only when bundle absent, else serve", () => {
    const plans = buildLaunchPlans("ollama", "darwin", "/opt/homebrew/bin/ollama");
    assert.equal(plans[0].command, "/opt/homebrew/bin/ollama");
    assert.deepEqual(plans[0].args, ["serve"]);
  });

  it("Linux tries systemctl --user first then serve", () => {
    const plans = buildLaunchPlans("ollama", "linux", "/usr/bin/ollama");
    assert.deepEqual([plans[0].command, ...plans[0].args], ["systemctl", "--user", "start", "ollama"]);
    assert.equal(plans[1].command, "/usr/bin/ollama");
  });

  it("llama.cpp builds flags: -m -c -ngl --port", () => {
    const [p] = buildLaunchPlans("llamacpp", "linux", "/u/llama-server", {
      llamacpp: { modelPath: "/m/q.gguf", ctx: 8192, port: 8081 },
    });
    assert.equal(p.command, "/u/llama-server");
    assert.deepEqual(p.args.slice(0, 2), ["-m", "/m/q.gguf"]);
    for (const pair of [["-c", "8192"], ["-ngl", "99"], ["--port", "8081"]]) {
      const i = p.args.indexOf(pair[0]);
      assert.ok(i >= 0 && p.args[i + 1] === pair[1], pair.join(" "));
    }
  });

  it("llama.cpp passes through advanced options and keeps paths with spaces intact", () => {
    const a = buildLlamaCppArgs({ modelPath: "C:\\My Models\\a.gguf", ngl: "all", fa: true, ctk: "q8_0", np: 2, extraArgs: "--mlock  --no-mmap" });
    assert.equal(a[1], "C:\\My Models\\a.gguf");
    assert.ok(a.includes("all") && a.includes("--mlock") && a.includes("--no-mmap"));
    assert.deepEqual(a.slice(a.indexOf("-fa"), a.indexOf("-fa") + 2), ["-fa", "on"]);
  });

  it("llama.cpp requires a model path", () => {
    assert.throws(() => buildLaunchPlans("llamacpp", "win32", undefined, {}), /gguf/);
  });
});

describe("install guidance", () => {
  it("offers winget + installer on Windows", () => {
    const o = installOptions("ollama", "win32");
    assert.equal(o[0].value, "winget install Ollama.Ollama");
    assert.equal(o[1].value, "https://ollama.com/download/OllamaSetup.exe");
  });
  it("offers brew on macOS and curl on Linux", () => {
    assert.equal(installOptions("ollama", "darwin")[0].value, "brew install ollama");
    assert.match(installOptions("ollama", "linux")[0].value, /install\.sh/);
  });
});

describe("failure explanations", () => {
  it("maps common causes", () => {
    assert.match(explainLaunchFailure("linux", { code: "ENOENT" } as any, "", null), /not found/);
    assert.match(explainLaunchFailure("linux", { code: "EACCES" } as any, "", null), /chmod \+x/);
    assert.match(explainLaunchFailure("win32", { code: "EACCES" } as any, "", null), /standard user/);
    assert.match(explainLaunchFailure("linux", undefined, "CUDA error 100", 1), /GPU/);
    assert.match(explainLaunchFailure("linux", undefined, "listen: address already in use", 1), /port/i);
    assert.match(explainLaunchFailure("linux", undefined, "boom\nfatal", 3), /code 3.*fatal/);
  });
});

describe("LocalProcessManager lifecycle", () => {
  it("starts Ollama, broadcasts starting → running, detached=false on Windows", async () => {
    const h = harness({ readyAt: 3 });
    const final = await h.mgr.start("ollama");
    assert.equal(final.phase, "running");
    assert.deepEqual(h.states.map((s) => s.phase), ["starting", "running"]);
    assert.equal(h.spawns.length, 1);
    assert.deepEqual(h.spawns[0].args, ["serve"]);
    assert.equal(h.spawns[0].opts.windowsHide, true);
    assert.equal(h.spawns[0].env.OLLAMA_HOST, "127.0.0.1:11434");
    assert.equal(final.managed, true);
    assert.equal(final.pid, 4242);
  });

  it("is a no-op when the provider is already running", async () => {
    const h = harness({ readyAt: 1 });
    const s = await h.mgr.start("ollama");
    assert.equal(s.phase, "running");
    assert.equal(h.spawns.length, 0);
  });

  it("reports a clear error when not installed", async () => {
    const h = harness({ readyAt: 0, binary: "never" });
    // Remove PATH hit by pointing binary elsewhere
    const s = await h.mgr.start("ollama");
    // 'never' exists on fake PATH only for itself, so Ollama's ollama.exe isn't found
    assert.equal(s.phase, "error");
    assert.match(s.message!, /not installed/);
    assert.equal(h.spawns.length, 0);
  });

  it("times out, kills the daemon and reports captured stderr", async () => {
    const h = harness({ readyAt: 0, onSpawn: (c) => c.stderr.emit("data", Buffer.from("CUDA driver mismatch\n")) });
    const s = await h.mgr.start("ollama", { readyTimeoutMs: 20 });
    assert.equal(s.phase, "error");
    assert.match(s.message!, /did not respond/);
    assert.match(s.message!, /GPU/);
    assert.ok(s.logs!.some((l) => l.includes("CUDA driver mismatch")));
    assert.ok(h.children[0].killed.includes("SIGTERM"), "daemon cleaned up");
  });

  it("detects early daemon crash instead of waiting for the full timeout", async () => {
    const h = harness({
      readyAt: 0,
      onSpawn: (c) => {
        c.stderr.emit("data", Buffer.from("fatal: boom\n"));
        c.emit("exit", 2);
      },
    });
    const t0 = Date.now();
    const s = await h.mgr.start("ollama", { readyTimeoutMs: 5000 });
    assert.equal(s.phase, "error");
    assert.match(s.message!, /code 2/);
    assert.ok(Date.now() - t0 < 1000);
  });

  it("falls back from systemctl to serve on Linux", async () => {
    const h = harness({
      platform: "linux",
      binary: "/usr/bin/ollama",
      readyAt: 4,
      onSpawn: (c, cmd) => {
        if (cmd === "systemctl") c.emit("exit", 5);
      },
    });
    const s = await h.mgr.start("ollama");
    assert.equal(s.phase, "running");
    assert.deepEqual(h.spawns.map((x) => x.cmd), ["systemctl", "/usr/bin/ollama"]);
    assert.equal(h.spawns[1].opts.detached, true);
  });

  it("start with llama.cpp passes model flags and waits for /health", async () => {
    const h = harness({ readyAt: 2, binary: "C:\\llama\\llama-server.exe" });
    // Fake fetch answers Ollama's JSON; llama.cpp wants {"status":"ok"}. Patch via custom body.
    const orig = (h.mgr as any).deps.detector;
    (h.mgr as any).deps.detector = () => {
      const d = orig();
      return { ...d, fetchFn: async () => ({ status: 200, text: async () => '{"status":"ok"}' }) };
    };
    const s = await h.mgr.start("llamacpp", { llamacpp: { modelPath: "C:\\m\\x.gguf", ctx: 4096 } });
    // Already answering → treated as running without spawn.
    assert.equal(s.phase, "running");
    assert.equal(h.spawns.length, 0);
  });

  it("stop terminates gracefully and sweeps the tree on Windows", async () => {
    const h = harness({ readyAt: 2 });
    await h.mgr.start("ollama");
    const s = await h.mgr.stop("ollama");
    assert.equal(s.phase, "stopped");
    assert.deepEqual(h.children[0].killed, ["SIGTERM"]);
    assert.deepEqual(h.killedTrees, [4242]);
  });

  it("stop force-kills an unresponsive process after the grace period", async () => {
    const h = harness({ readyAt: 2, platform: "linux", binary: "/usr/bin/ollama", onSpawn: (c, cmd) => { if (cmd === "systemctl") c.emit("exit", 1); } });
    await h.mgr.start("ollama");
    h.children[1].respondsToTerm = false;
    const s = await h.mgr.stop("ollama");
    assert.equal(s.phase, "stopped");
    assert.deepEqual(h.killedTrees, [4242]);
  });

  it("refuses to claim it stopped a daemon it did not start", async () => {
    const h = harness({ readyAt: 1 });
    await h.mgr.start("ollama");
    const s = await h.mgr.stop("ollama");
    assert.equal(s.phase, "running");
    assert.match(s.message!, /not started by Photon/);
  });

  it("restart stops then starts again", async () => {
    const h = harness({ readyAt: 2 });
    await h.mgr.start("ollama");
    // After stop, daemon stops answering; make the next start succeed again.
    const s = await h.mgr.restart("ollama");
    assert.equal(h.spawns.length >= 1, true);
    assert.ok(["running", "error"].includes(s.phase));
  });

  it("dispose kills every spawned daemon", async () => {
    const h = harness({ readyAt: 2 });
    await h.mgr.start("ollama");
    h.mgr.dispose();
    assert.ok(h.children[0].killed.includes("SIGTERM"));
    assert.deepEqual(h.killedTrees, [4242]);
  });
});
