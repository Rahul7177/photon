import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import { runEvalTask } from "./harness";
import { BASELINE_MOCK_MODELS, createCompliantMockProvider } from "./runner";
import { EVAL_TASKS } from "./tasks";

function createCustomMockProvider(responses: LLMChatChunk[][]): LLMProvider {
  let idx = 0;
  return {
    id: "mock-eval-fail",
    label: "Mock Failure Provider",
    enabled: true,
    isConfigured: () => true,
    ping: async () => true,
    listModels: async () => [],
    async *chatStream(_req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
      const chunks = responses[idx++] ?? [{ message: { content: "Done." } }, { done: true }];
      for (const c of chunks) yield c;
    },
  };
}

describe("Phase 0: Behavioral Baseline Eval Suite", () => {
  const machine = {
    totalRamBytes: 16 * 1024 ** 3,
    freeRamBytes: 10 * 1024 ** 3,
    cpuCores: 8,
    cpuModel: "Laptop 8-core",
    platform: "win32",
    arch: "x64",
    gpu: { name: "Laptop 6GB GPU", vramBytes: 6 * 1024 ** 3, vendor: "nvidia" },
    tier: "mid" as const,
  };

  it("passes all 12 baseline tasks on compliant trajectories with zero governor issues and cleans sandboxes", async () => {
    const model = BASELINE_MOCK_MODELS[0]; // qwen2.5-coder:3b (tiny -> max scaffolding)
    for (const task of EVAL_TASKS) {
      const res = await runEvalTask(task, {
        model,
        machine,
        providerFactory: createCompliantMockProvider,
      });

      assert.equal(res.passed, true, `Task ${task.id} failed: ${res.detail}`);
      assert.equal(res.totalIssues, 0, `Task ${task.id} recorded unexpected issues: ${JSON.stringify(res.governorCounts)}`);
      assert.ok(res.promptTokens > 0, `Task ${task.id} expected non-zero promptTokens`);
      assert.ok(res.promptSections.length >= 4, `Task ${task.id} expected section breakdown`);
      assert.equal(res.cleanedUp, true, `Task ${task.id} temp directory was not cleaned up`);
    }
  });

  it("fails objective postconditions and records governor signals on flawed trajectories", async () => {
    const model = BASELINE_MOCK_MODELS[0];

    // 1) Bug not fixed + parse_fail + narration + duplicate
    const pricingTask = EVAL_TASKS.find((t) => t.id === "fix-discount-sign")!;
    const badPricing = await runEvalTask(pricingTask, {
      model,
      machine,
      providerFactory: () =>
        createCustomMockProvider([
          [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path" } }, { done: true }],
          [{ message: { content: "Let me read src/pricing.ts next." } }, { done: true }],
          [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nsrc/pricing.ts\nEND_ARG\n```" } }, { done: true }],
          [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\nsrc/pricing.ts\nEND_ARG\n```" } }, { done: true }],
          [{ message: { content: "I finished reviewing the file without editing it." } }, { done: true }],
        ]),
    });

    assert.equal(badPricing.passed, false);
    assert.equal(badPricing.governorCounts.parse_fail, 1);
    assert.equal(badPricing.governorCounts.narration, 1);
    assert.equal(badPricing.governorCounts.duplicate, 1);
    assert.equal(badPricing.cleanedUp, true);

    // 2) Chat mode write attempt -> mode_violation, disk remains untouched
    const chatGuardTask = EVAL_TASKS.find((t) => t.id === "chat-readonly-guard")!;
    const badChat = await runEvalTask(chatGuardTask, {
      model,
      machine,
      providerFactory: () =>
        createCustomMockProvider([
          [
            {
              message: {
                content:
                  "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nsrc/config.ts\nEND_ARG\nBEGIN_ARG: old_str\nexport const RETRIES = 2;\nEND_ARG\nBEGIN_ARG: new_str\nexport const RETRIES = 5;\nEND_ARG\n```",
              },
            },
            { done: true },
          ],
          [{ message: { content: "Done." } }, { done: true }],
        ]),
    });

    assert.equal(badChat.passed, false);
    assert.equal(badChat.governorCounts.mode_violation, 1);
    assert.equal(badChat.cleanedUp, true);
  });
});
