import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReliabilityGovernor, countDiagnosticErrors } from "../../src/core/adaptive/governor";
import { runUnifiedTurn, type UnifiedEmitter, type UnifiedEngineDeps } from "../../src/core/agent/unifiedEngine";
import { builtinTools } from "../../src/core/tools/builtin";
import type { AdaptivePlan, ChatMessage, TokenUsage, TurnReliabilitySummary } from "../../src/shared/types";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { DiagnosticInfo } from "../../src/core/tools/types";

function createMockProvider(responses: LLMChatChunk[][]): LLMProvider {
  let callIndex = 0;
  return {
    id: "mock-provider",
    label: "Mock Provider",
    enabled: true,
    isConfigured: () => true,
    ping: async () => true,
    listModels: async () => [],
    async *chatStream(_req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
      const chunks = responses[callIndex++] ?? [{ message: { content: "Done." } }, { done: true }];
      for (const c of chunks) yield c;
    },
  };
}

function createHarnessEmitter() {
  const usages: TokenUsage[] = [];
  const telemetries: TurnReliabilitySummary[] = [];
  const errors: string[] = [];
  const contents: string[] = [];

  const emitter: UnifiedEmitter = {
    onAssistantStart: () => {},
    onDelta: () => {},
    onContent: (_id, content) => contents.push(content),
    onAssistantCancel: () => {},
    onPhase: () => {},
    onToolCall: () => {},
    onToolUpdate: () => {},
    onUsage: (u) => usages.push(u),
    onGenerationStats: () => {},
    onTurnTelemetry: (summary) => telemetries.push(summary),
    onDone: () => {},
    onError: (msg) => errors.push(msg),
  };

  return { emitter, usages, telemetries, errors, contents };
}

const basePlan: AdaptivePlan = {
  model: "qwen2.5-coder:3b",
  mode: "agent",
  contextWindow: 8192,
  numCtx: 8192,
  temperature: 0.1,
  topP: 0.9,
  maxOutputTokens: 1024,
  toolProtocol: "photon-block",
  maxTools: 40,
  allowParallelTools: false,
  intelligence: "max",
  intelligenceAuto: true,
  rationale: [],
};

describe("Phase 0: ReliabilityGovernor Unit & UnifiedEngine Integration", () => {
  it("records event counts, caps stored events, formats log line, and parses diagnostics errors", () => {
    const gov = new ReliabilityGovernor({
      model: "qwen2.5-coder:3b",
      mode: "agent",
      protocol: "photon-block",
      intelligence: "max",
      task: { scope: "multi_file", reasoning: "medium", risk: "medium", verification: ["diagnostics"], ambiguity: "low", estimatedSteps: 4 },
      maxEvents: 3,
    });

    assert.equal(gov.rung(), 0);
    assert.deepEqual(gov.record("parse_fail", { step: 0, detail: "bad fence" }), []);
    gov.record("narration", { step: 1, tool: "read_file" });
    gov.record("tool_ok", { step: 2, tool: "read_file" });
    gov.record("verify_ok", { step: 3, tool: "get_diagnostics" });

    assert.equal(gov.count("parse_fail"), 1);
    assert.equal(gov.count("narration"), 1);
    assert.equal(gov.totalIssues(), 2); // parse_fail + narration (excludes tool_ok/verify_ok)

    const summary = gov.summary(4);
    assert.equal(summary.steps, 4);
    assert.equal(summary.events.length, 3); // capped at maxEvents=3
    assert.equal(summary.taskScope, "multi_file");

    const logLine = gov.formatLogLine(4);
    assert.ok(logLine.includes("[governor] model=qwen2.5-coder:3b"));
    assert.ok(logLine.includes("parse_fail=1"));
    assert.ok(logLine.includes("verify_ok=1"));

    assert.equal(
      countDiagnosticErrors("2 diagnostic(s):\nERROR src/a.ts:1:1: bad\nWARNING src/a.ts:2:1: warn\nERROR src/b.ts:3:2: nope"),
      2
    );
  });

  it("emits promptReport on TokenUsage and clean turnTelemetry on a successful runUnifiedTurn", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-gov-clean-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "export const x = 1;\n", "utf8");
      const { emitter, usages, telemetries } = createHarnessEmitter();
      const session: { messages: ChatMessage[] } = {
        messages: [{ id: "u1", role: "user", content: "Read a.ts and verify diagnostics", createdAt: Date.now() }],
      };

      const responses: LLMChatChunk[][] = [
        [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
        [{ message: { content: "```tool\nTOOL_NAME: get_diagnostics\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
        [{ message: { content: "a.ts exports x = 1 and has no diagnostics." } }, { done: true }],
      ];

      const deps: UnifiedEngineDeps = {
        provider: createMockProvider(responses),
        tools: builtinTools(),
        workspaceName: "TestWs",
        buildToolContext: (signal) => ({
          workspaceRoot: tmpDir,
          mode: "agent",
          signal,
          log: () => {},
          webSearchProvider: "none",
          requestApproval: async () => true,
          findFiles: async () => ["a.ts"],
          capability: "max",
          getDiagnostics: async () => [],
          todos: [],
        }),
        reserveOutputTokens: 1024,
      };

      await runUnifiedTurn(session, basePlan, emitter, new AbortController().signal, deps);

      assert.equal(telemetries.length, 1);
      const t = telemetries[0];
      assert.equal(t.rung, 0);
      assert.equal(t.counts.tool_ok, 1);
      assert.equal(t.counts.verify_ok, 1);
      assert.equal(t.counts.parse_fail, undefined);

      assert.ok(usages.length >= 2);
      for (const u of usages) {
        assert.ok(u.promptReport, "Expected promptReport attached to pre-stream and post-stream TokenUsage");
        assert.ok(u.promptReport!.totalTokens > 0);
        assert.ok(u.promptReport!.sections.some((s) => s.id === "tools" && s.tokens > 0));
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records parse_fail, invalid_args/repair, narration, and duplicate events in runUnifiedTurn", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-gov-issues-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "export const a = 1;\n", "utf8");
      const { emitter, telemetries } = createHarnessEmitter();
      const session: { messages: ChatMessage[] } = {
        messages: [{ id: "u1", role: "user", content: "Inspect a.ts", createdAt: Date.now() }],
      };

      const responses: LLMChatChunk[][] = [
        // Step 0: incomplete tool block -> parse_fail
        [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts" } }, { done: true }],
        // Step 1: narration -> narration
        [{ message: { content: "Let me read a.ts right now." } }, { done: true }],
        // Step 2: invalid_args (missing required path for read_file) -> invalid_args + repair
        [{ message: { content: "```tool\nTOOL_NAME: read_file\n```" } }, { done: true }],
        // Step 3: valid read_file -> tool_ok
        [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
        // Step 4: duplicate read_file -> duplicate
        [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
        // Step 5: final answer
        [{ message: { content: "a.ts exports a = 1." } }, { done: true }],
      ];

      const deps: UnifiedEngineDeps = {
        provider: createMockProvider(responses),
        tools: builtinTools(),
        workspaceName: "TestWs",
        buildToolContext: (signal) => ({
          workspaceRoot: tmpDir,
          mode: "agent",
          signal,
          log: () => {},
          webSearchProvider: "none",
          requestApproval: async () => true,
          findFiles: async () => ["a.ts"],
          capability: "max",
          getDiagnostics: async () => [],
          todos: [],
        }),
        reserveOutputTokens: 1024,
      };

      await runUnifiedTurn(session, basePlan, emitter, new AbortController().signal, deps);

      assert.equal(telemetries.length, 1);
      const c = telemetries[0].counts;
      assert.equal(c.parse_fail, 1);
      assert.equal(c.narration, 1);
      assert.equal(c.invalid_args, 1);
      assert.equal(c.repair, 1);
      assert.equal(c.duplicate, 1);
      assert.equal(c.tool_ok, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records mode_violation in chat mode and diag_regression when errors increase after edit", async () => {
    // 1) Chat mode violation
    const chatDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-gov-chat-"));
    try {
      const { emitter, telemetries } = createHarnessEmitter();
      const chatPlan: AdaptivePlan = { ...basePlan, mode: "chat" };
      const session: { messages: ChatMessage[] } = {
        messages: [{ id: "u1", role: "user", content: "Create foo.ts", createdAt: Date.now() }],
      };
      const responses: LLMChatChunk[][] = [
        [{ message: { content: "```tool\nTOOL_NAME: write_file\nBEGIN_ARG: path\nfoo.ts\nEND_ARG\nBEGIN_ARG: content\nexport const x=1;\nEND_ARG\n```" } }, { done: true }],
        [{ message: { content: "Chat mode cannot edit files directly; switch to Agent mode." } }, { done: true }],
      ];
      await runUnifiedTurn(session, chatPlan, emitter, new AbortController().signal, {
        provider: createMockProvider(responses),
        tools: builtinTools(),
        buildToolContext: (signal) => ({
          workspaceRoot: chatDir,
          mode: "chat",
          signal,
          log: () => {},
          webSearchProvider: "none",
          requestApproval: async () => true,
          findFiles: async () => [],
          capability: "max",
          getDiagnostics: async () => [],
          todos: [],
        }),
        reserveOutputTokens: 1024,
      });
      assert.equal(telemetries.length, 1);
      assert.equal(telemetries[0].counts.mode_violation, 1);
    } finally {
      fs.rmSync(chatDir, { recursive: true, force: true });
    }

    // 2) Diagnostics regression after edit
    const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-gov-diag-"));
    try {
      fs.writeFileSync(path.join(diagDir, "b.ts"), "export const b = 1;\n", "utf8");
      const { emitter, telemetries } = createHarnessEmitter();
      const session: { messages: ChatMessage[] } = {
        messages: [{ id: "u1", role: "user", content: "Edit b.ts and verify", createdAt: Date.now() }],
      };
      const responses: LLMChatChunk[][] = [
        [{ message: { content: "```tool\nTOOL_NAME: get_diagnostics\nBEGIN_ARG: path\nb.ts\nEND_ARG\n```" } }, { done: true }],
        [{ message: { content: "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nb.ts\nEND_ARG\nBEGIN_ARG: old_str\nexport const b = 1;\nEND_ARG\nBEGIN_ARG: new_str\nexport const b: number = 'oops';\nEND_ARG\n```" } }, { done: true }],
        [{ message: { content: "```tool\nTOOL_NAME: get_diagnostics\nBEGIN_ARG: path\nb.ts\nEND_ARG\n```" } }, { done: true }],
        [{ message: { content: "Diagnostic error introduced." } }, { done: true }],
      ];
      await runUnifiedTurn(session, basePlan, emitter, new AbortController().signal, {
        provider: createMockProvider(responses),
        tools: builtinTools(),
        buildToolContext: (signal) => ({
          workspaceRoot: diagDir,
          mode: "agent",
          signal,
          log: () => {},
          webSearchProvider: "none",
          requestApproval: async () => true,
          findFiles: async () => ["b.ts"],
          capability: "max",
          getDiagnostics: async (): Promise<DiagnosticInfo[]> => {
            const cur = fs.readFileSync(path.join(diagDir, "b.ts"), "utf8");
            return cur.includes("'oops'")
              ? [{ file: "b.ts", line: 1, col: 14, severity: "error", message: "Type string not assignable to number", source: "ts" }]
              : [];
          },
          todos: [],
        }),
        reserveOutputTokens: 1024,
      });
      assert.equal(telemetries.length, 1);
      assert.equal(telemetries[0].counts.diag_regression, 1);
      assert.equal(telemetries[0].counts.verify_ok, 1);
      assert.equal(telemetries[0].counts.tool_ok, 1);
      assert.equal(telemetries[0].counts.tool_error, 1);
    } finally {
      fs.rmSync(diagDir, { recursive: true, force: true });
    }
  });
});
