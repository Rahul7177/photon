import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initial, reducer } from "../../webview-ui/src/state/store";
import type {
  LocalRuntimeInfo,
  ProviderLifecycleState,
  RecommendationSet,
  PullProgress,
} from "../../src/shared/types";

describe("UI Store Reducer — Local LLM Lifecycle (Phase 7.5)", () => {
  it("initial state has empty runtimes, recommendations, and lifecycle records", () => {
    assert.deepEqual(initial.localRuntimes, []);
    assert.deepEqual(initial.providerLifecycle, {});
    assert.equal(initial.recommendations, null);
    assert.equal(initial.pullProgress, null);
  });

  it("handles providerRuntimes update", () => {
    const runtimes: LocalRuntimeInfo[] = [
      {
        id: "ollama",
        label: "Ollama",
        state: "installed_stopped",
        port: 11434,
        baseUrl: "http://127.0.0.1:11434",
        binaryPath: "C:\\Program Files\\Ollama\\ollama.exe",
      },
      {
        id: "llamacpp",
        label: "llama.cpp",
        state: "not_installed",
        port: 8080,
        baseUrl: "http://127.0.0.1:8080",
      },
    ];

    const state = reducer(initial, {
      type: "providerRuntimes",
      payload: runtimes,
    });

    assert.equal(state.localRuntimes.length, 2);
    assert.equal(state.localRuntimes[0].id, "ollama");
    assert.equal(state.localRuntimes[0].state, "installed_stopped");
    assert.equal(state.localRuntimes[1].id, "llamacpp");
    assert.equal(state.localRuntimes[1].state, "not_installed");
  });

  it("handles providerLifecycle transitions (stopped -> starting -> running)", () => {
    const s1 = reducer(initial, {
      type: "providerLifecycle",
      payload: {
        id: "ollama",
        phase: "starting",
        message: "Starting Ollama daemon…",
        logs: ["Listening on 127.0.0.1:11434"],
      },
    });

    assert.equal(s1.providerLifecycle["ollama"]?.phase, "starting");
    assert.equal(s1.providerLifecycle["ollama"]?.message, "Starting Ollama daemon…");
    assert.equal(s1.providerLifecycle["ollama"]?.logs?.length, 1);

    const s2 = reducer(s1, {
      type: "providerLifecycle",
      payload: {
        id: "ollama",
        phase: "running",
        message: "Ollama is ready.",
        managed: true,
        pid: 12345,
      },
    });

    assert.equal(s2.providerLifecycle["ollama"]?.phase, "running");
    assert.equal(s2.providerLifecycle["ollama"]?.managed, true);
    assert.equal(s2.providerLifecycle["ollama"]?.pid, 12345);
  });

  it("handles modelRecommendations update", () => {
    const recSet: RecommendationSet = {
      hardware: {
        totalRamGb: 16,
        freeRamGb: 8,
        ramBufferGb: 3.6,
        vramGb: 6,
        gpuName: "GTX 1660 Ti",
        cpuCores: 12,
        tier: "sweet",
        label: "6GB GTX 1660 Ti, 16GB RAM",
      },
      goal: "coding",
      ctxTokens: 8192,
      headline: "qwen2.5-coder:7b — Recommended for your 6GB GTX 1660 Ti",
      recommendedName: "qwen2.5-coder:7b",
      models: [
        {
          name: "qwen2.5-coder:7b",
          label: "Qwen2.5 Coder 7B",
          sizeGb: 4.7,
          blurb: "State-of-the-art coding",
          capabilities: ["coding", "autocomplete"],
          tier: "sweet",
          fit: {
            mode: "gpu",
            badge: "green",
            memRequiredGb: 5.18,
            gpuGb: 5.18,
            ramGb: 0,
            tokPerSec: 55,
            label: "Fits 100% in your GTX 1660 Ti VRAM (~55 tok/s)",
          },
          installed: false,
          recommended: true,
          quality: 70,
        },
      ],
    };

    const state = reducer(initial, {
      type: "modelRecommendations",
      payload: recSet,
    });

    assert.ok(state.recommendations);
    assert.equal(state.recommendations?.recommendedName, "qwen2.5-coder:7b");
    assert.equal(state.recommendations?.models[0].fit.badge, "green");
    assert.equal(state.recommendations?.hardware.vramGb, 6);
  });

  it("handles streaming pullProgress lifecycle (pulling -> done -> null)", () => {
    const pulling: PullProgress = {
      model: "qwen2.5-coder:7b",
      phase: "pulling",
      status: "Downloading layer 2af3b81862c6 — 2.4 GB / 4.7 GB · 28 MB/s · ETA: 45s",
      percent: 51,
      completedBytes: 2400000000,
      totalBytes: 4700000000,
      bytesPerSec: 28000000,
      etaSeconds: 45,
      stage: "Downloading layer 2af3b81862c6",
    };

    const s1 = reducer(initial, {
      type: "pullProgress",
      payload: pulling,
    });

    assert.equal(s1.pullProgress?.phase, "pulling");
    assert.equal(s1.pullProgress?.percent, 51);
    assert.equal(s1.pullProgress?.etaSeconds, 45);

    const s2 = reducer(s1, {
      type: "pullProgress",
      payload: {
        model: "qwen2.5-coder:7b",
        phase: "done",
        status: "qwen2.5-coder:7b installed and ready to code!",
        percent: 100,
      },
    });

    assert.equal(s2.pullProgress?.phase, "done");
    assert.equal(s2.pullProgress?.percent, 100);

    const s3 = reducer(s2, {
      type: "pullProgress",
      payload: null,
    });

    assert.equal(s3.pullProgress, null);
  });

  it("handles pullProgress error and resumable state", () => {
    const errProgress: PullProgress = {
      model: "qwen2.5-coder:7b",
      phase: "error",
      status: "Failed",
      error: "Download interrupted — click Resume. Already-downloaded layers are kept.",
      resumable: true,
    };

    const state = reducer(initial, {
      type: "pullProgress",
      payload: errProgress,
    });

    assert.equal(state.pullProgress?.phase, "error");
    assert.equal(state.pullProgress?.resumable, true);
    assert.match(state.pullProgress?.error || "", /Download interrupted/);
  });
});

