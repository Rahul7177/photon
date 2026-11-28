import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BENCH_TOOLCALL_SAMPLES, BENCH_VERSION, runBench } from "../../src/core/bench/bench";
import { capabilityForModel, shouldUseNativeToolProtocol } from "../../src/core/intelligence/policy";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { ModelInfo } from "../../src/shared/types";
import { runAblationSuite } from "../eval/ablation";
import { evaluateReleaseGate } from "../eval/releaseGate";
import { runBaselineEval } from "../eval/runner";

describe("Phase 4: Bench v5 Probes, Ablations & Release Gate", () => {
  it("runs >= 5 multi-sample block + separate native probes under the real Photon prompt", async () => {
    const requests: LLMChatRequest[] = [];
    const mockProvider: LLMProvider = {
      id: "mock-bench-v5",
      label: "Mock Bench v5",
      enabled: true,
      isConfigured: () => true,
      ping: async () => true,
      listModels: async () => [],
      async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
        requests.push(req);
        const sys = req.messages[0]?.content ?? "";
        const lastUser = req.messages[req.messages.length - 1]?.content ?? "";

        // Native tool-call probe
        if (Array.isArray(req.tools) && req.tools.length > 0) {
          yield {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "tc-1", function: { name: "read_file", arguments: { path: "src/index.ts" } } }],
            },
            done: true,
          };
          return;
        }

        // Photon-block probe under real system prompt
        if (lastUser.includes("Read src/index.ts using the tool.")) {
          assert.ok(sys.includes("PRIMARY FORMAT — use this"), "Block probe must run under real tool instructions");
          yield {
            message: {
              role: "assistant",
              content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nsrc/index.ts\nEND_ARG\n```",
            },
            done: true,
          };
          return;
        }

        let content = "6";
        if (lastUser.includes("Write a TypeScript function add")) content = "export const add = (a: number, b: number) => a + b;";
        else if (lastUser.includes("Inspect the implementation of parseConfig")) content = "Use read_file on src/config/parser.ts";
        else if (lastUser.includes("read_file failed for src/app.ts")) content = "Use find_files for app.ts";
        else if (lastUser.includes("Prepare the smallest safe edit")) content = "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nsrc/pricing.ts\nEND_ARG\nBEGIN_ARG: old_str\nconst value = 1;\nEND_ARG\nBEGIN_ARG: new_str\nconst value = 2;\nEND_ARG\n```";
        else if (lastUser.includes("What is the next verification step?")) content = "diagnostics";
        else if (lastUser.includes("What constraint identifier")) content = "PHOTON_CTX_7429";

        yield { message: { role: "assistant", content }, done: true, eval_count: 16, eval_duration: 160_000_000 };
      },
    };

    const result = await runBench(mockProvider, "qwen2.5-coder:7b", { hardwareClass: "sweet" });
    assert.equal(result.methodologyVersion, BENCH_VERSION);
    assert.equal(BENCH_VERSION, 5);
    assert.equal(result.sampleCount, BENCH_TOOLCALL_SAMPLES);
    assert.ok((result.sampleCount ?? 0) >= 5);
    assert.equal(result.blockToolCallReliability, 1);
    assert.equal(result.nativeToolCallReliability, 1);

    const nativeCalls = requests.filter((r) => Array.isArray(r.tools) && r.tools.length > 0);
    const blockCalls = requests.filter((r) => !r.tools && r.messages.some((m) => m.content.includes("Read src/index.ts using the tool.")));
    assert.equal(nativeCalls.length, 5);
    assert.equal(blockCalls.length, 5);
    assert.ok(result.tasks.some((t) => t.id === "native_toolcall" && t.passed));
  });

  it("gates native protocol using Bench v5 nativeToolCallReliability even when metadata advertises tools (L-6)", () => {
    const model: ModelInfo = {
      name: "qwen2.5-coder:7b",
      provider: "ollama",
      tier: "small",
      capabilities: ["tools"],
      toolTrained: true,
    };
    const caps = capabilityForModel(model);

    const weakNativeBench = {
      model: model.name,
      hardwareClass: "sweet",
      methodologyVersion: 5,
      tokensPerSec: 60,
      firstTokenMs: 120,
      toolCallReliability: 1.0, // Strong block calls!
      blockToolCallReliability: 1.0,
      nativeToolCallReliability: 0.2, // Failing native JSON calls!
      sampleCount: 5,
      reasoningPass: true,
      tasks: [],
      ranAt: Date.now(),
    };
    assert.equal(shouldUseNativeToolProtocol(model, caps, weakNativeBench, "max"), false);

    const strongNativeBench = { ...weakNativeBench, nativeToolCallReliability: 0.8 };
    assert.equal(shouldUseNativeToolProtocol(model, caps, strongNativeBench, "max"), true);
  });

  it("runs ScaffoldProfile ablation suite cleanly and passes Phase 4 release gate without regressions", async () => {
    const ablation = await runAblationSuite({ writeReport: false });
    assert.ok(ablation.rows.length >= 12);

    const tinyFull = ablation.rows.find((r) => r.variantId === "full_phase4" && r.tier === "tiny");
    const tinyLegacy = ablation.rows.find((r) => r.variantId === "legacy_flag_off" && r.tier === "tiny");
    assert.ok(tinyFull && tinyLegacy);
    assert.equal(tinyFull.passRatePct, 100);
    assert.ok(tinyFull.toolsDeltaVsLegacyPct <= -50, `Expected >= 50% tools token drop vs legacy, got ${tinyFull.toolsDeltaVsLegacyPct}%`);

    const evalResults = await runBaselineEval({ writeReport: false });
    const passingGate = evaluateReleaseGate(evalResults);
    assert.equal(passingGate.passed, true, passingGate.summary);

    // Verify gate fails when a tier drops > 2 percentage points
    const regressed = evalResults.map((r, idx) =>
      r.tier === "tiny" && idx === 0 ? { ...r, passed: false } : r
    );
    const failingGate = evaluateReleaseGate(regressed);
    assert.equal(failingGate.passed, false);
    assert.ok(failingGate.checks.some((c) => c.tier === "tiny" && !c.passed));
  });
});
