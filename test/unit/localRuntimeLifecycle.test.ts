import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import {
  OllamaClient,
  OllamaError,
  validateClientOptions,
  isLocalEndpoint,
} from "../../src/core/ollama/client";
import {
  ModelInstaller,
  classifyPullError,
  checkDiskSpace,
  PullTracker,
} from "../../src/core/ollama/modelInstaller";
import {
  LocalProcessManager,
  buildLlamaCppArgs,
  buildLaunchPlans,
} from "../../src/host/localProcessManager";

class FakeProcess extends EventEmitter {
  pid = 9999;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(sig: string) {
    this.killed.push(sig);
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

describe("Phase 7.3: Ollama & Local Runtime Lifecycle Integrity", () => {
  describe("Client Configuration, Timeout & Endpoint Validation", () => {
    it("validates and sanitizes timeout and keepAlive settings at runtime", () => {
      // 1. Valid settings
      const valid = validateClientOptions({
        baseUrl: "http://127.0.0.1:11434",
        timeoutMs: 120_000,
        connectTimeoutMs: 300_000,
        keepAlive: "30m",
      });
      assert.equal(valid.timeoutMs, 120_000);
      assert.equal(valid.connectTimeoutMs, 300_000);
      assert.equal(valid.keepAlive, "30m");

      // 2. Out-of-bounds or malformed settings fall back to safe defaults
      const sanitized = validateClientOptions({
        baseUrl: "http://127.0.0.1:11434",
        timeoutMs: 0, // too low
        connectTimeoutMs: 2000, // below MIN_CONNECT_TIMEOUT_MS (15000)
        keepAlive: "invalid-keepalive-string!@#",
      });
      assert.equal(sanitized.timeoutMs, 1000, "Must clamp to minimum 1s");
      assert.equal(sanitized.connectTimeoutMs, 15_000, "Must clamp to minimum 15s");
      assert.equal(sanitized.keepAlive, "5m", "Must fall back to 5m on malformed keepAlive");
    });

    it("verifies local loopback endpoints and detects remote endpoints", () => {
      assert.equal(isLocalEndpoint("http://localhost:11434"), true);
      assert.equal(isLocalEndpoint("http://127.0.0.1:11434"), true);
      assert.equal(isLocalEndpoint("http://[::1]:11434"), true);

      assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
      assert.equal(isLocalEndpoint("http://192.168.1.100:11434"), false);
      assert.equal(isLocalEndpoint("http://remote-server.com:11434"), false);
    });
  });

  describe("Active Turn Protection: Warmup & Unload Safety", () => {
    it("preload / warmup skips preloading a different model if an active turn is in progress", async () => {
      let warmupFetchCount = 0;
      const originalFetch = globalThis.fetch;

      try {
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
          if (url.includes("/api/chat")) {
            warmupFetchCount++;
            return new Response('{"message":{"content":"ok"},"done":true}', { status: 200 });
          }
          return new Response("{}", { status: 200 });
        }) as any;

        const client = new OllamaClient({
          baseUrl: "http://127.0.0.1:11434",
          timeoutMs: 10000,
        });

        // Simulate an active turn with model "qwen2.5-coder:7b"
        const activeTurnStream = client.chatStream({
          model: "qwen2.5-coder:7b",
          messages: [{ role: "user", content: "write code" }],
        });

        // Start reading the stream to engage turn lock
        assert.equal(client.isTurnActive(), false);
        const iterPromise = activeTurnStream.next();

        // While turn is active, attempt warmup with a DIFFERENT model "llama3:8b"
        // In client.ts, chatStream sets activeStreams++ on invocation
        const warmupSame = await client.warmup("qwen2.5-coder:7b");
        assert.equal(warmupSame, true, "Warmup of same model is permitted");

        const warmupDifferent = await client.warmup("llama3:8b");
        assert.equal(
          warmupDifferent,
          false,
          "Warmup of different model during active turn must be rejected to prevent evicting runner"
        );

        // Finish stream
        await iterPromise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("unloadModel is blocked when model is currently in an active turn", async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => new Response("{}", { status: 200 })) as any;

        const client = new OllamaClient({
          baseUrl: "http://127.0.0.1:11434",
          timeoutMs: 10000,
        });

        // Turn active on model A
        const stream = client.chatStream({
          model: "active-model:latest",
          messages: [{ role: "user", content: "test" }],
        });
        const turnPromise = stream.next();

        // Attempt unload of active-model
        const unloadResult = await client.unloadModel("active-model:latest");
        assert.equal(unloadResult, false, "Must refuse to unload active model during active turn");

        await turnPromise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Lifecycle State Discernment: Reachable, Installed, Loaded", () => {
    it("distinguishes daemon unreachable, not installed, installed, and loaded", async () => {
      const originalFetch = globalThis.fetch;
      try {
        let reachable = true;
        let installedList = ["qwen2.5-coder:7b", "llama3:8b"];
        let runningList = [{ name: "qwen2.5-coder:7b" }];

        globalThis.fetch = (async (url: string) => {
          if (!reachable) throw new Error("ECONNREFUSED");
          if (url.includes("/api/version")) {
            return new Response('{"version":"0.5.1"}', { status: 200 });
          }
          if (url.includes("/api/tags")) {
            return new Response(JSON.stringify({ models: installedList.map((m) => ({ name: m })) }), { status: 200 });
          }
          if (url.includes("/api/ps")) {
            return new Response(JSON.stringify({ models: runningList }), { status: 200 });
          }
          return new Response("{}", { status: 200 });
        }) as any;

        const client = new OllamaClient({
          baseUrl: "http://127.0.0.1:11434",
          timeoutMs: 10000,
        });

        // 1. Loaded model
        const state1 = await client.getModelLifecycleState("qwen2.5-coder:7b");
        assert.equal(state1, "loaded");

        // 2. Installed but not loaded model
        const state2 = await client.getModelLifecycleState("llama3:8b");
        assert.equal(state2, "installed");

        // 3. Not installed model
        const state3 = await client.getModelLifecycleState("mistral:7b");
        assert.equal(state3, "not_installed");

        // 4. Daemon unreachable
        reachable = false;
        const state4 = await client.getModelLifecycleState("qwen2.5-coder:7b");
        assert.equal(state4, "daemon_unreachable");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("Model Installer: Cancellation, Lockout & Error Classification", () => {
    it("cancellation immediately aborts in-flight pull without leaving lock", async () => {
      let pullStarted = false;
      let abortedSignal = false;

      const mockPull = async (_model: string, _onChunk: any, signal: AbortSignal) => {
        pullStarted = true;
        signal.addEventListener("abort", () => {
          abortedSignal = true;
        });
        await new Promise((r) => setTimeout(r, 1000));
      };

      const installer = new ModelInstaller({
        pull: mockPull,
        freeSpace: () => 100 * 1024 ** 3,
      });

      const installPromise = installer.install("qwen2.5-coder:7b", {
        estimatedSizeBytes: 4 * 1024 ** 3,
        onProgress: () => {},
      });

      // Wait a tick for install to start
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(pullStarted, true);
      assert.equal(installer.activeModel, "qwen2.5-coder:7b");

      // Cancel install
      const cancelled = installer.cancel();
      assert.equal(cancelled, true);

      const outcome = await installPromise;
      assert.equal(outcome.status, "cancelled");
      assert.equal(abortedSignal, true);
      assert.equal(installer.activeModel, undefined, "Lock must be released after cancel");
    });

    it("blocks second parallel installation while another is active", async () => {
      const mockPull = async (_m: string, _c: any, signal: AbortSignal) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
      };

      const installer = new ModelInstaller({
        pull: mockPull,
        freeSpace: () => 100 * 1024 ** 3,
      });

      const p1 = installer.install("model-a", { onProgress: () => {} });
      await new Promise((r) => setTimeout(r, 10));

      const p2Outcome = await installer.install("model-b", { onProgress: () => {} });
      assert.equal(p2Outcome.status, "blocked");
      assert.ok(p2Outcome.message.includes("model-a"));

      installer.cancel();
      await p1;
    });

    it("classifies disk full, network failure, and missing models cleanly", () => {
      const diskErr = classifyPullError(new Error("write /models: no space left on device"));
      assert.equal(diskErr.kind, "disk_full");
      assert.equal(diskErr.resumable, true);

      const netErr = classifyPullError(new Error("stream error: read ECONNRESET"));
      assert.equal(netErr.kind, "network");
      assert.equal(netErr.resumable, true);

      const notFoundErr = classifyPullError(new Error("pull model manifest: file does not exist"));
      assert.equal(notFoundErr.kind, "not_found");
      assert.equal(notFoundErr.resumable, false);
    });

    it("pre-checks disk space and blocks download if insufficient headroom", () => {
      const check = checkDiskSpace("C:\\.ollama\\models", 4 * 1024 ** 3, () => 2 * 1024 ** 3);
      assert.equal(check.ok, false);
      assert.ok(check.message?.includes("Insufficient disk space"));
    });
  });

  describe("Process Tree Teardown & Llama.cpp CLI Configuration", () => {
    it("buildLlamaCppArgs configures context window, GPU layers offload, and ports", () => {
      const args = buildLlamaCppArgs({
        modelPath: "B:\\models\\qwen2.5-coder-7b.gguf",
        ctx: 32768,
        ngl: 99,
        port: 8080,
        fa: true,
      });

      assert.deepEqual(args, [
        "-m", "B:\\models\\qwen2.5-coder-7b.gguf",
        "--host", "127.0.0.1",
        "--port", "8080",
        "-c", "32768",
        "-ngl", "99",
        "-fa", "on",
      ]);
    });

    it("LocalProcessManager kills entire process tree and clears managed entries on dispose", () => {
      const killedTrees: number[] = [];
      const fakeChild = new FakeProcess();

      const mgr = new LocalProcessManager({
        spawn: () => fakeChild as any,
        killTree: (pid) => killedTrees.push(pid),
      });

      // Inject a managed process entry
      (mgr as any).managed.set("ollama", { child: fakeChild, exited: false, exitCode: null });
      assert.equal((mgr as any).managed.size, 1);

      mgr.dispose();

      assert.equal(fakeChild.killed.includes("SIGTERM"), true);
      assert.equal(killedTrees.includes(9999), true, "killTree must be invoked for child pid");
      assert.equal((mgr as any).managed.size, 0, "Managed map must be empty after dispose");
    });
  });
});

