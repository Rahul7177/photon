import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { detectRuntime, RUNTIME_SPECS, type DetectorDeps } from "../../src/core/adaptive/runtimeDetector";
import { LocalProcessManager, type ProcessManagerDeps } from "../../src/host/localProcessManager";
import { recommendModels } from "../../src/core/adaptive/modelAdvisor";
import { ModelInstaller, type PullChunk, checkDiskSpace } from "../../src/core/ollama/modelInstaller";
import { initial, reducer } from "../../webview-ui/src/state/store";
import type { MachineProfile, PullProgress } from "../../src/shared/types";

class MockChild extends EventEmitter {
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

describe("E2E Local LLM Lifecycle (Phase 7.6)", () => {
  it("full user journey: detect -> start daemon -> recommend model -> pull with progress -> select model", async () => {
    let uiState = initial;

    // -------------------------------------------------------------------------
    // Step 1: Sensing / Detection (stopped provider with binary on disk)
    // -------------------------------------------------------------------------
    let daemonResponding = false;
    const fakeBinary = "C:\\Users\\dev\\AppData\\Local\\Programs\\Ollama\\ollama.exe";

    const detectorDeps: DetectorDeps = {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local", PATH: "" },
      fileExists: (p) => p === fakeBinary,
      listDir: () => [],
      timeoutMs: 50,
      run: async () => "",
      fetchFn: async () => {
        if (daemonResponding) {
          return { status: 200, text: async () => JSON.stringify({ version: "0.5.1" }) };
        }
        throw new Error("ECONNREFUSED");
      },
    };

    const spec = RUNTIME_SPECS.find((s) => s.id === "ollama")!;
    const detection = await detectRuntime(spec, detectorDeps);

    assert.equal(detection.state, "installed_stopped");
    assert.equal(detection.binaryPath, fakeBinary);

    // Update UI state with detected runtimes
    uiState = reducer(uiState, {
      type: "providerRuntimes",
      payload: [detection],
    });
    assert.equal(uiState.localRuntimes[0].state, "installed_stopped");

    // -------------------------------------------------------------------------
    // Step 2: One-Click Start & Readiness Watchdog
    // -------------------------------------------------------------------------
    let pollCount = 0;
    const procDeps: Partial<ProcessManagerDeps> = {
      platform: "win32",
      pollIntervalMs: 5,
      readyTimeoutMs: 100,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      killTree: () => {},
      detector: () => ({
        ...detectorDeps,
        fetchFn: async () => {
          pollCount++;
          if (pollCount >= 2) {
            daemonResponding = true;
            return { status: 200, text: async () => JSON.stringify({ version: "0.5.1" }) };
          }
          throw new Error("ECONNREFUSED");
        },
      }),
      spawn: () => {
        const c = new MockChild();
        setImmediate(() => c.emit("spawn"));
        return c as any;
      },
    };

    const procMgr = new LocalProcessManager(procDeps);
    procMgr.onState((lifecycle) => {
      uiState = reducer(uiState, { type: "providerLifecycle", payload: lifecycle });
    });

    const startOutcome = await procMgr.start("ollama");
    assert.equal(startOutcome.phase, "running");
    assert.equal(uiState.providerLifecycle["ollama"]?.phase, "running");

    // Provider is now running in UI
    uiState = reducer(uiState, {
      type: "models",
      payload: { models: [], selected: "", ollamaReachable: true },
    });
    assert.equal(uiState.ollamaReachable, true);

    // -------------------------------------------------------------------------
    // Step 3: Hardware Profiling & Model Advisor Recommendation
    // -------------------------------------------------------------------------
    const devMachine: MachineProfile = {
      totalRamBytes: 16 * 1024 ** 3,
      freeRamBytes: 10 * 1024 ** 3,
      cpuCores: 8,
      cpuModel: "Intel i7",
      platform: "win32",
      arch: "x64",
      gpu: {
        name: "NVIDIA GeForce RTX 4060",
        vramBytes: 8 * 1024 ** 3,
        vendor: "nvidia",
      },
      tier: "mid",
    };

    const recs = recommendModels(devMachine, { goal: "coding" });
    assert.equal(recs.recommendedName, "qwen2.5-coder:7b");
    const topRec = recs.models.find((m) => m.name === recs.recommendedName)!;
    assert.equal(topRec.fit.mode, "gpu");
    assert.equal(topRec.fit.badge, "green");
    assert.match(topRec.fit.label, /Fits 100% in your RTX 4060 VRAM/);

    // Dispatch recommendations to UI
    uiState = reducer(uiState, {
      type: "modelRecommendations",
      payload: recs,
    });
    assert.equal(uiState.recommendations?.recommendedName, "qwen2.5-coder:7b");

    // -------------------------------------------------------------------------
    // Step 4: Pre-flight Disk Check
    // -------------------------------------------------------------------------
    const diskCheck = checkDiskSpace("C:\\Users\\dev\\.ollama\\models", 4.7 * 1024 ** 3, () => 50 * 1024 ** 3);
    assert.equal(diskCheck.ok, true);

    // -------------------------------------------------------------------------
    // Step 5: One-Click Model Install & Streaming Progress
    // -------------------------------------------------------------------------
    const progressHistory: PullProgress[] = [];

    const simulatedChunks: PullChunk[] = [
      { status: "pulling manifest" },
      { status: "downloading layer abc", digest: "abc", total: 4.7 * 1024 ** 3, completed: 1.2 * 1024 ** 3 },
      { status: "downloading layer abc", digest: "abc", total: 4.7 * 1024 ** 3, completed: 3.5 * 1024 ** 3 },
      { status: "downloading layer abc", digest: "abc", total: 4.7 * 1024 ** 3, completed: 4.7 * 1024 ** 3 },
      { status: "verifying sha256 digest" },
      { status: "success" },
    ];

    const installer = new ModelInstaller({
      modelsDir: "C:\\Users\\dev\\.ollama\\models",
      freeSpace: () => 50 * 1024 ** 3,
      minProgressIntervalMs: 0,
      pull: async (_model, onChunk) => {
        for (const chunk of simulatedChunks) {
          onChunk(chunk);
        }
      },
    });

    const installResult = await installer.install("qwen2.5-coder:7b", {
      estimatedSizeBytes: 4.7 * 1024 ** 3,
      onProgress: (p) => {
        progressHistory.push(p);
        uiState = reducer(uiState, { type: "pullProgress", payload: p });
      },
    });

    assert.equal(installResult.status, "done");
    assert.ok(progressHistory.length >= 3);
    assert.ok(progressHistory.some((p) => p.stage === "Verifying sha256"));
    assert.equal(uiState.pullProgress?.percent, 100);

    // -------------------------------------------------------------------------
    // Step 6: Post-Install Activation & Model Selection
    // -------------------------------------------------------------------------
    const installedModel = {
      name: "qwen2.5-coder:7b",
      paramSize: "7B",
      contextLength: 32768,
      sizeBytes: 4.7 * 1024 ** 3,
      toolTrained: true,
    };

    uiState = reducer(uiState, {
      type: "models",
      payload: {
        models: [installedModel],
        selected: "qwen2.5-coder:7b",
        ollamaReachable: true,
      },
    });

    assert.equal(uiState.selectedModel, "qwen2.5-coder:7b");
    assert.equal(uiState.models.length, 1);
    assert.equal(uiState.models[0].toolTrained, true);

    // Clean up
    procMgr.dispose();
  });
});
