import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProjectConfig, summarizeProjectConfig } from "../../src/host/projectConfig";
import { ModelConfigStore } from "../../src/host/modelConfigStore";
import { buildPlan } from "../../src/core/adaptive/orchestrator";
import { runCloudTurn } from "../../src/core/agent/cloudEngine";
import type { LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { ToolContext } from "../../src/core/tools/types";

class MockMemento {
  private map = new Map<string, any>();
  get<T>(key: string, fallback?: T): T {
    return this.map.has(key) ? this.map.get(key) : (fallback as T);
  }
  async update(key: string, val: any): Promise<void> {
    this.map.set(key, val);
  }
}

describe("Project Configuration & Per-Model Settings", () => {
  it("validates ProjectConfig safely including ngl=0, sampling bounds, and invalid versions", () => {
    const parsed = validateProjectConfig({
      version: 1,
      model: "  qwen2.5-coder:7b ",
      intelligence: "high",
      numCtx: 16384,
      indexing: true,
      autoApprove: true,
      modelConfigs: {
        "llamacpp:model.gguf": {
          numCtx: 32768,
          llamacpp: { ngl: "0", fa: true },
          sampling: { temp: 0.25, topP: 0.85, seed: 42 },
          note: "Deterministic coding",
        },
        badSampling: {
          sampling: { temp: 99, topP: 5, seed: -3 },
        },
      },
    });

    assert.equal(parsed.model, "qwen2.5-coder:7b");
    assert.equal(parsed.intelligence, "high");
    assert.equal(parsed.numCtx, 16384);
    assert.equal(parsed.indexing, true);
    assert.equal(parsed.modelConfigs?.["llamacpp:model.gguf"]?.llamacpp?.ngl, 0);
    assert.deepEqual(parsed.modelConfigs?.["llamacpp:model.gguf"]?.sampling, {
      temp: 0.25,
      topP: 0.85,
      seed: 42,
    });
    assert.equal(parsed.modelConfigs?.badSampling, undefined);

    assert.throws(() => validateProjectConfig({ version: 0 }), /unsupported config version/);
    assert.throws(() => validateProjectConfig({ version: 2 }), /unsupported config version/);

    const summary = summarizeProjectConfig(
      { config: parsed, modelConfigs: parsed.modelConfigs, path: "/repo/.photon/config.json" },
      "/repo"
    );
    assert.equal(summary.loaded, true);
    assert.equal(summary.relativePath, ".photon/config.json");
    assert.equal(summary.autoApproveIgnored, true);
    assert.deepEqual(summary.modelConfigKeys, ["llamacpp:model.gguf"]);
  });

  it("merges file overrides via allEffective without mutating globalState", async () => {
    const store = new ModelConfigStore({ globalState: new MockMemento() } as any);
    await store.set("qwen2.5-coder:7b", {
      numCtx: 8192,
      sampling: { temp: 0.4, seed: 7 },
      note: "Global note",
    });

    const merged = store.allEffective({
      "qwen2.5-coder:7b": { numCtx: 32768, sampling: { temp: 0.1 } },
      "anthropic:claude-sonnet-4": { sampling: { topP: 0.9 } },
    });

    assert.equal(merged["qwen2.5-coder:7b"]?.numCtx, 32768);
    assert.equal(merged["qwen2.5-coder:7b"]?.sampling?.temp, 0.1);
    assert.equal(merged["qwen2.5-coder:7b"]?.sampling?.seed, 7);
    assert.equal(merged["qwen2.5-coder:7b"]?.note, "Global note");
    assert.equal(merged["anthropic:claude-sonnet-4"]?.sampling?.topP, 0.9);

    // Underlying globalState must remain untouched by workspace project overrides
    assert.equal(store.get("qwen2.5-coder:7b")?.numCtx, 8192);
    assert.equal(store.get("anthropic:claude-sonnet-4"), undefined);

    const cmd = ModelConfigStore.launchCommand(
      "llamacpp:C:/My Models/coder.gguf",
      "http://localhost:8081",
      { llamacpp: { ctx: 16384, ngl: 0 } }
    );
    assert.ok(cmd.includes('"C:/My Models/coder.gguf"'));
    assert.ok(cmd.includes("-ngl 0"));
    assert.ok(cmd.includes("--port 8081"));
  });

  it("applies per-model sampling in buildPlan and forwards options in runCloudTurn", async () => {
    const plan = buildPlan({
      model: { name: "qwen2.5-coder:7b", provider: "ollama", contextLength: 32768 },
      machine: null,
      mode: "agent",
      intelligence: "auto",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
      sampling: { temp: 0.05, topP: 0.8, seed: 123 },
    });
    assert.equal(plan.temperature, 0.05);
    assert.equal(plan.topP, 0.8);
    assert.equal(plan.seed, 123);

    const captured: LLMChatRequest[] = [];
    const mockProvider: LLMProvider = {
      id: "openai",
      label: "OpenAI",
      enabled: true,
      isConfigured: () => true,
      ping: async () => true,
      listModels: async () => [],
      async *chatStream(req) {
        captured.push(req);
        yield { message: { role: "assistant", content: "OK" }, done: true };
      },
    };
    const mockCtx: ToolContext = {
      signal: new AbortController().signal,
      log: () => {},
      webSearchProvider: "none",
      requestApproval: async () => true,
      findFiles: async () => [],
      capability: "high",
      getDiagnostics: async () => [],
      todos: [],
    };

    await runCloudTurn({
      provider: mockProvider,
      model: "openai:gpt-4o",
      system: "Be concise.",
      history: [{ role: "user", content: "Hi" }],
      tools: [],
      contextWindow: 128_000,
      ctx: mockCtx,
      emitter: {
        onAssistantStart: () => {},
        onDelta: () => {},
        onContent: () => {},
        onAssistantCancel: () => {},
        onToolCall: () => {},
        onToolUpdate: () => {},
        onPhase: () => {},
        onUsage: () => {},
        onGenerationStats: () => {},
        onDone: () => {},
        onError: () => {},
      },
      signal: new AbortController().signal,
      options: { temperature: 0.15, top_p: 0.82, seed: 99 },
    });

    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].options, { temperature: 0.15, top_p: 0.82, seed: 99 });
  });
});
