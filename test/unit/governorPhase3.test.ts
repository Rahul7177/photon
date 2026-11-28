import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { ReliabilityGovernor } from "../../src/core/adaptive/governor";
import { buildPlan } from "../../src/core/adaptive/orchestrator";
import {
  blendCapabilitiesWithPassport,
  passportKey,
  passportNativeUnreliable,
  suggestedInitialRung,
  updatePassport,
  type PassportEntry,
} from "../../src/core/adaptive/passport";
import { runUnifiedTurn, type UnifiedEmitter, type UnifiedEngineDeps } from "../../src/core/agent/unifiedEngine";
import { capabilityForModel } from "../../src/core/intelligence/policy";
import { PassportStore } from "../../src/host/passportStore";
import { builtinTools } from "../../src/core/tools/builtin";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { DiagnosticInfo } from "../../src/core/tools/types";
import type { ChatMessage, ModelInfo, TurnReliabilitySummary } from "../../src/shared/types";
import { MountedTree, getText, setupBrowserGlobals } from "../helpers/reactTestRenderer";

function makeRecordingProvider(responses: LLMChatChunk[][]): {
  provider: LLMProvider;
  requests: LLMChatRequest[];
} {
  let idx = 0;
  const requests: LLMChatRequest[] = [];
  const provider: LLMProvider = {
    id: "mock-phase3",
    label: "Mock Phase 3 Provider",
    enabled: true,
    isConfigured: () => true,
    ping: async () => true,
    listModels: async () => [],
    async *chatStream(req: LLMChatRequest): AsyncGenerator<LLMChatChunk> {
      requests.push(req);
      const chunks = responses[idx++] ?? [{ message: { content: "Done." } }, { done: true }];
      for (const c of chunks) yield c;
    },
  };
  return { provider, requests };
}

function makeTelemetryEmitter() {
  const telemetries: TurnReliabilitySummary[] = [];
  const contents: string[] = [];
  const emitter: UnifiedEmitter = {
    onAssistantStart: () => {},
    onDelta: () => {},
    onContent: (_id, content) => contents.push(content),
    onAssistantCancel: () => {},
    onPhase: () => {},
    onToolCall: () => {},
    onToolUpdate: () => {},
    onUsage: () => {},
    onGenerationStats: () => {},
    onTurnTelemetry: (summary) => telemetries.push(summary),
    onDone: () => {},
    onError: () => {},
  };
  return { emitter, telemetries, contents };
}

const smallModel: ModelInfo = {
  name: "qwen2.5-coder:7b",
  provider: "ollama",
  paramsB: 7.6,
  tier: "small",
  contextLength: 32768,
  toolTrained: true,
  capabilities: ["tools"],
};

const largeModel: ModelInfo = {
  name: "qwen2.5-coder:32b",
  provider: "ollama",
  paramsB: 32.5,
  tier: "large",
  contextLength: 65536,
  toolTrained: true,
};

describe("Phase 3: Reliability Governor, Native Downgrade, Host Auto-Revert & Capability Passport", () => {
  it("3.1 transitions rungs 0 -> 1 -> 2 -> 4 with hysteresis de-escalation and honors freeze", () => {
    const gov = new ReliabilityGovernor({
      model: smallModel.name,
      mode: "agent",
      protocol: "photon-block",
      intelligence: "max",
      adaptive: true,
    });

    assert.equal(gov.rung(), 0);
    // 1 parse_fail -> rung 1 (failing_example)
    const a1 = gov.record("parse_fail", { step: 0, tool: "edit_file" });
    assert.equal(a1.length, 1);
    assert.equal(a1[0].toRung, 1);
    assert.equal(a1[0].effect, "failing_example");
    assert.equal(gov.rung(), 1);

    // 2 clean calls aren't enough to leave rung 1 (hysteresis needs 3)
    assert.deepEqual(gov.record("tool_ok", { step: 1 }), []);
    assert.deepEqual(gov.record("tool_ok", { step: 2 }), []);
    assert.equal(gov.rung(), 1);
    const relax1 = gov.record("tool_ok", { step: 3 });
    assert.equal(relax1[0].type, "deescalate");
    assert.equal(relax1[0].toRung, 0);

    // 2 failure steps inside 4 steps -> rung 2 (state_card)
    gov.record("narration", { step: 5 });
    const a2 = gov.record("invalid_args", { step: 7, tool: "edit_file" });
    assert.equal(a2.length, 1);
    assert.equal(a2[0].toRung, 2);
    assert.equal(a2[0].effect, "state_card");
    assert.equal(gov.rung(), 2);

    // 4 distinct clean steps -> relaxes to rung 1
    gov.record("tool_ok", { step: 8 });
    gov.record("tool_ok", { step: 9 });
    gov.record("tool_ok", { step: 10 });
    assert.equal(gov.rung(), 2);
    const relax2 = gov.record("tool_ok", { step: 11 });
    assert.equal(relax2[0].toRung, 1);
    assert.equal(gov.rung(), 1);

    // 3 failure steps inside 6 steps -> rung 4 (host_takeover), sticky for rest of turn
    gov.record("parse_fail", { step: 12 });
    gov.record("narration", { step: 13 });
    const a4 = gov.record("empty", { step: 14 });
    assert.equal(a4[0].toRung, 4);
    assert.equal(a4[0].effect, "host_takeover");
    assert.equal(gov.consumeTakeover(), true);
    assert.equal(gov.consumeTakeover(), false);
    for (let s = 15; s <= 20; s++) assert.deepEqual(gov.record("tool_ok", { step: s }), []);
    assert.equal(gov.rung(), 4);

    // Frozen / non-adaptive governor observes without transitioning
    const frozenGov = new ReliabilityGovernor({
      model: smallModel.name,
      mode: "agent",
      protocol: "photon-block",
      intelligence: "max",
      adaptive: false,
    });
    assert.deepEqual(frozenGov.record("parse_fail", { step: 0 }), []);
    assert.deepEqual(frozenGov.record("parse_fail", { step: 1 }), []);
    assert.deepEqual(frozenGov.record("parse_fail", { step: 2 }), []);
    assert.equal(frozenGov.rung(), 0);
    assert.equal(frozenGov.totalIssues(), 3);
  });

  it("3.1 forces stateCard + cooler tool temp at rung 2 and stops tool calls on rung 4 takeover in runUnifiedTurn", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-p3-takeover-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "export const a = 1;\n", "utf8");
      const plan = buildPlan({
        model: largeModel,
        machine: null,
        mode: "agent",
        prompt: "Update a.ts",
        userNumCtx: 16384,
        intelligence: "high",
        reserveOutputTokens: 1024,
        adaptiveEnabled: true,
      });
      // Large model starts with stateCard: "off"
      assert.equal(plan.scaffoldProfile?.stateCard, "off");
      const baseTemp = plan.scaffoldProfile!.sampling.toolTurnTemp;

      const { provider, requests } = makeRecordingProvider([
        // Step 0: incomplete block -> parse_fail -> rung 1 (failing example)
        [{ message: { content: "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path" } }, { done: true }],
        // Step 1: narration -> 2nd failure in 4 steps -> rung 2 (forced compact state card + temp -0.05)
        [{ message: { content: "Let me edit a.ts now." } }, { done: true }],
        // Step 2: 3rd failure in 6 steps -> rung 4 takeover -> host stops tools & asks for final answer
        [{ message: { content: "Let me check again first." } }, { done: true }],
        // Step 3: even if model emits a tool block after takeover, host strips tools & ignores it
        [
          {
            message: {
              content:
                "Summary of what happened.\n```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```",
            },
          },
          { done: true },
        ],
      ]);

      const { emitter, telemetries } = makeTelemetryEmitter();
      const session: { messages: ChatMessage[] } = {
        messages: [{ id: "u1", role: "user", content: "Update a.ts", createdAt: Date.now() }],
      };
      const deps: UnifiedEngineDeps = {
        provider,
        tools: builtinTools(),
        workspaceName: "TakeoverWs",
        buildToolContext: (signal) => ({
          workspaceRoot: tmpDir,
          mode: "agent",
          signal,
          log: () => {},
          webSearchProvider: "none",
          requestApproval: async () => true,
          findFiles: async () => ["a.ts"],
          capability: "high",
          getDiagnostics: async () => [],
          todos: [{ id: 1, task: "Edit a.ts", status: "pending" }],
        }),
        reserveOutputTokens: 1024,
      };

      await runUnifiedTurn(session, plan, emitter, new AbortController().signal, deps);

      assert.equal(requests.length, 4);
      // Step 1 (rung 1): edit_file worked example injected into system prompt
      assert.ok(requests[1].messages[0].content.includes("TOOL_NAME: edit_file"));
      // Step 2 (rung 2): stateCard forced active & toolTurnTemp dropped by 0.05
      assert.ok(requests[2].messages[requests[2].messages.length - 1].content.includes("<working_memory>"));
      assert.equal(requests[2].options?.temperature, Math.max(0, baseTemp - 0.05));

      assert.equal(telemetries.length, 1);
      const t = telemetries[0];
      assert.equal(t.rung, 4);
      assert.equal(t.peakRung, 4);
      assert.ok((t.timeline ?? []).some((e) => e.type === "force_conclude"));
      assert.equal(t.counts.tool_ok, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3.2 downgrades local native tool calling to photon-block mid-turn after repeated native failures", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-p3-downgrade-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "export const x = 42;\n", "utf8");
      const plan = buildPlan({
        model: smallModel,
        machine: null,
        mode: "agent",
        prompt: "Read a.ts",
        userNumCtx: 16384,
        intelligence: "max",
        reserveOutputTokens: 1024,
        adaptiveEnabled: true,
      });
      assert.equal(plan.toolProtocol, "native");

      const { provider, requests } = makeRecordingProvider([
        // Step 0: malformed native JSON args -> native failure #1
        [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c1", function: { name: "read_file", arguments: { __malformedToolArgs: true, __parseError: "Unexpected token" } } }],
            },
          },
          { done: true },
        ],
        // Step 1: malformed native JSON args -> native failure #2 -> Rung 3 downgrade triggered
        [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c2", function: { name: "read_file", arguments: { __malformedToolArgs: true, __parseError: "Invalid JSON" } } }],
            },
          },
          { done: true },
        ],
        // Step 2: now running photon-block without native tools -> succeeds!
        [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
        // Step 3: final answer
        [{ message: { content: "a.ts exports x = 42." } }, { done: true }],
      ]);

      const { emitter, telemetries, contents } = makeTelemetryEmitter();
      await runUnifiedTurn(
        { messages: [{ id: "u1", role: "user", content: "Read a.ts", createdAt: Date.now() }] },
        plan,
        emitter,
        new AbortController().signal,
        {
          provider,
          tools: builtinTools(),
          workspaceName: "DowngradeWs",
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
        }
      );

      assert.equal(requests.length, 4);
      assert.ok(Array.isArray(requests[0].tools) && requests[0].tools.length > 0);
      // Step 2 switched to photon-block: native tools removed, PRIMARY FORMAT instruction present
      assert.equal(requests[2].tools, undefined);
      assert.ok(requests[2].messages[0].content.includes("PRIMARY FORMAT"));

      assert.equal(telemetries.length, 1);
      const t = telemetries[0];
      assert.equal(t.protocol, "photon-block");
      assert.equal(t.protocolDowngraded, true);
      assert.equal(t.counts.tool_ok, 1);
      assert.ok((t.timeline ?? []).some((e) => e.type === "protocol_downgrade"));
      assert.ok(contents.some((c) => c.includes("42")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3.3 runs host verification after edits, reports N→M, and auto-reverts file on diagnostics regression", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-p3-revert-"));
    try {
      const target = path.join(tmpDir, "b.ts");
      fs.writeFileSync(target, "export const b = 1;\n", "utf8");
      const plan = buildPlan({
        model: smallModel,
        machine: null,
        mode: "agent",
        prompt: "Update b.ts to export 2",
        userNumCtx: 16384,
        intelligence: "max",
        reserveOutputTokens: 1024,
        adaptiveEnabled: true,
      });
      // Force photon-block for deterministic text tool call test
      const blockPlan = { ...plan, toolProtocol: "photon-block" as const };

      const { provider, requests } = makeRecordingProvider([
        // Step 0: introduce syntax/type error `'oops'`
        [
          {
            message: {
              content:
                "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nb.ts\nEND_ARG\nBEGIN_ARG: old_str\nexport const b = 1;\nEND_ARG\nBEGIN_ARG: new_str\nexport const b: number = 'oops';\nEND_ARG\n```",
            },
          },
          { done: true },
        ],
        // Step 1: after host auto-revert & N→M feedback, apply valid edit matching original text!
        [
          {
            message: {
              content:
                "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\nb.ts\nEND_ARG\nBEGIN_ARG: old_str\nexport const b = 1;\nEND_ARG\nBEGIN_ARG: new_str\nexport const b = 2;\nEND_ARG\n```",
            },
          },
          { done: true },
        ],
        // Step 2: finish cleanly
        [{ message: { content: "Updated b.ts cleanly to export b = 2 with 0 diagnostics errors." } }, { done: true }],
      ]);

      const { emitter, telemetries } = makeTelemetryEmitter();
      await runUnifiedTurn(
        { messages: [{ id: "u1", role: "user", content: "Update b.ts to export 2", createdAt: Date.now() }] },
        blockPlan,
        emitter,
        new AbortController().signal,
        {
          provider,
          tools: builtinTools(),
          workspaceName: "RevertWs",
          buildToolContext: (signal) => ({
            workspaceRoot: tmpDir,
            mode: "agent",
            signal,
            log: () => {},
            webSearchProvider: "none",
            requestApproval: async () => true,
            findFiles: async () => ["b.ts"],
            capability: "max",
            getDiagnostics: async (): Promise<DiagnosticInfo[]> => {
              const cur = fs.readFileSync(target, "utf8");
              return cur.includes("'oops'")
                ? [{ file: "b.ts", line: 1, col: 14, severity: "error", message: "Type 'string' is not assignable to type 'number'", source: "ts" }]
                : [];
            },
            todos: [],
          }),
          reserveOutputTokens: 1024,
        }
      );

      // Step 1 received host verify N→M revert feedback
      const step1Msgs = requests[1].messages.map((m) => m.content).join("\n");
      assert.ok(step1Msgs.includes("0→1"));
      assert.ok(step1Msgs.includes("AUTOMATICALLY REVERTED"));

      // Step 2 saw clean host diagnostics feedback and final file content is `export const b = 2;`
      const step2Msgs = requests[2].messages.map((m) => m.content).join("\n");
      assert.ok(step2Msgs.includes("get_diagnostics(b.ts): no errors"));
      assert.equal(fs.readFileSync(target, "utf8"), "export const b = 2;\n");

      // Telemetry captured autoReverted + timeline + kept turn alive (not rung 4)
      assert.equal(telemetries.length, 1);
      const t = telemetries[0];
      assert.deepEqual(t.autoReverted, ["b.ts"]);
      assert.ok((t.timeline ?? []).some((e) => e.type === "auto_revert"));
      assert.equal(t.counts.diag_regression, 1);
      assert.ok(t.rung <= 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3.4 updates Capability Passport with shrinkage (one bad turn < 0.05 shift), learns initialRung & gates native", async () => {
    const id = { model: smallModel.name, quantization: "Q4_K_M", runtime: "ollama" };
    const baseCaps = capabilityForModel(smallModel);

    // One terrible turn (0/5 valid, 5 parse failures) must move caps < 0.05 because K=100 caps weight <= 5/105
    const badSummary: TurnReliabilitySummary = {
      model: smallModel.name,
      mode: "agent",
      protocol: "native",
      intelligence: "max",
      rung: 4,
      steps: 5,
      counts: { parse_fail: 5, repair: 5 },
      events: [],
      protocolDowngraded: true,
      completedAt: Date.now(),
    };
    const now = Date.now();
    const p1 = updatePassport(undefined, id, badSummary, now - 5000)!;
    assert.equal(p1.key, passportKey(id));
    assert.equal(p1.evidence, 5);
    const shifted = blendCapabilitiesWithPassport(baseCaps, p1);
    assert.ok(
      Math.abs(shifted.toolCalling - baseCaps.toolCalling) < 0.05,
      `Expected < 0.05 shift after one bad turn, got ${Math.abs(shifted.toolCalling - baseCaps.toolCalling)}`
    );
    assert.equal(suggestedInitialRung(p1), 0); // needs >= 10 evidence units before raising start rung

    // Multiple poor turns build evidence and learn initial rung + mark native unreliable
    let cur: PassportEntry | undefined = p1;
    for (let i = 0; i < 3; i++) {
      cur = updatePassport(cur, id, badSummary, now - 3000 + i)!;
    }
    assert.ok(cur!.evidence >= 10);
    assert.equal(suggestedInitialRung(cur), 2);
    assert.equal(passportNativeUnreliable(cur, now), true);

    const nextPlan = buildPlan({
      model: smallModel,
      machine: null,
      mode: "agent",
      prompt: "Fix src/a.ts",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
      passport: cur,
    });
    assert.equal(nextPlan.initialRung, 2);
    assert.equal(nextPlan.toolProtocol, "photon-block");
    assert.ok(nextPlan.rationale.some((r) => r.includes("starting at governor rung 2")));

    // Freezing adaptivity ignores the passport & leaves initialRung unset
    const frozenPlan = buildPlan({
      model: smallModel,
      machine: null,
      mode: "agent",
      prompt: "Fix src/a.ts",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
      passport: cur,
      freezeAdaptivity: true,
    });
    assert.equal(frozenPlan.adaptivityFrozen, true);
    assert.equal(frozenPlan.initialRung, undefined);
    assert.equal(frozenPlan.toolProtocol, "native");

    // Host PassportStore persistence, lookup, cloud exclusion & clear
    const storeState = new Map<string, unknown>();
    const mockCtx = {
      globalState: {
        get: <T>(k: string, d: T) => (storeState.has(k) ? (storeState.get(k) as T) : d),
        update: async (k: string, v: unknown) => {
          storeState.set(k, v);
        },
      },
    } as any;
    const store = new PassportStore(mockCtx);
    const savedLocal = await store.recordTurn({ name: smallModel.name, quantization: "Q4_K_M", provider: "ollama" }, badSummary);
    assert.ok(savedLocal);
    assert.equal(store.forModel({ name: smallModel.name, quantization: "Q4_K_M", provider: "ollama" })?.evidence, 5);
    assert.equal(store.byModel([smallModel]).get(smallModel.name)?.model, smallModel.name);
    const skippedCloud = await store.recordTurn({ name: "anthropic:claude-3-5-sonnet", provider: "anthropic" }, badSummary);
    assert.equal(skippedCloud, undefined);
    await store.clear();
    assert.equal(store.all().length, 0);
  });

  it("3.3b auto-reverts by unlinking a newly created file via write_file when diagnostics regress", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-p3-unlink-"));
    try {
      const target = path.join(tmpDir, "newBroken.ts");
      const plan = {
        ...buildPlan({
          model: smallModel,
          machine: null,
          mode: "agent",
          prompt: "Create newBroken.ts",
          userNumCtx: 16384,
          intelligence: "max",
          reserveOutputTokens: 1024,
          adaptiveEnabled: true,
        }),
        toolProtocol: "photon-block" as const,
      };
      const { provider, requests } = makeRecordingProvider([
        [
          {
            message: {
              content:
                "```tool\nTOOL_NAME: write_file\nBEGIN_ARG: path\nnewBroken.ts\nEND_ARG\nBEGIN_ARG: content\nexport const broken: number = 'bad';\nEND_ARG\n```",
            },
          },
          { done: true },
        ],
        [{ message: { content: "Stopped after write_file was reverted." } }, { done: true }],
      ]);
      const { emitter, telemetries } = makeTelemetryEmitter();
      await runUnifiedTurn(
        { messages: [{ id: "u1", role: "user", content: "Create newBroken.ts", createdAt: Date.now() }] },
        plan,
        emitter,
        new AbortController().signal,
        {
          provider,
          tools: builtinTools(),
          buildToolContext: (signal) => ({
            workspaceRoot: tmpDir,
            mode: "agent",
            signal,
            log: () => {},
            webSearchProvider: "none",
            requestApproval: async () => true,
            findFiles: async () => [],
            capability: "max",
            getDiagnostics: async (): Promise<DiagnosticInfo[]> =>
              fs.existsSync(target)
                ? [{ file: "newBroken.ts", line: 1, col: 1, severity: "error", message: "Type mismatch", source: "ts" }]
                : [],
            todos: [],
          }),
          reserveOutputTokens: 1024,
        }
      );
      assert.equal(fs.existsSync(target), false, "Newly created broken file should be unlinked cleanly on regression");
      assert.ok(requests[1].messages.map((m) => m.content).join("\n").includes("AUTOMATICALLY REVERTED"));
      assert.deepEqual(telemetries[0].autoReverted, ["newBroken.ts"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3.5 freezes governor/host actions when adaptivityFrozen=true and renders timeline + freeze toggle in TransparencyPanel", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "photon-p3-frozen-"));
    try {
      const target = path.join(tmpDir, "c.ts");
      fs.writeFileSync(target, "export const c = 1;\n", "utf8");
      const plan = buildPlan({
        model: smallModel,
        machine: null,
        mode: "agent",
        prompt: "Edit c.ts",
        userNumCtx: 16384,
        intelligence: "max",
        reserveOutputTokens: 1024,
        adaptiveEnabled: true,
        freezeAdaptivity: true,
      });
      const { provider, requests } = makeRecordingProvider([
        [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c1", function: { name: "read_file", arguments: { __malformedToolArgs: true, __parseError: "bad" } } }],
            },
          },
          { done: true },
        ],
        [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c2", function: { name: "read_file", arguments: { __malformedToolArgs: true, __parseError: "bad" } } }],
            },
          },
          { done: true },
        ],
        [{ message: { content: "Stopped trying." } }, { done: true }],
      ]);

      const { emitter, telemetries } = makeTelemetryEmitter();
      await runUnifiedTurn(
        { messages: [{ id: "u1", role: "user", content: "Edit c.ts", createdAt: Date.now() }] },
        plan,
        emitter,
        new AbortController().signal,
        {
          provider,
          tools: builtinTools(),
          buildToolContext: (signal) => ({
            workspaceRoot: tmpDir,
            mode: "agent",
            signal,
            log: () => {},
            webSearchProvider: "none",
            requestApproval: async () => true,
            findFiles: async () => ["c.ts"],
            capability: "max",
            getDiagnostics: async () => [],
            todos: [],
          }),
          reserveOutputTokens: 1024,
        }
      );

      // Frozen turn kept native tools all 3 steps and stayed at rung 0
      assert.ok(Array.isArray(requests[2].tools) && requests[2].tools.length > 0);
      assert.equal(telemetries[0].rung, 0);
      assert.equal(telemetries[0].adaptive, false);
      assert.equal(telemetries[0].counts.invalid_args, 2);
      assert.equal(telemetries[0].timeline?.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // UI TransparencyPanel timeline + freeze adaptivity toggle check
    setupBrowserGlobals();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TransparencyPanel } = require("../../webview-ui/src/components/TransparencyPanel") as typeof import("../../webview-ui/src/components/TransparencyPanel");
    let frozenCalledWith: boolean | undefined;
    const mockState: any = {
      config: { autoSelectModel: true, adaptiveEnabled: true, adaptivityFrozen: false },
      decision: null,
      usage: null,
      turnTelemetry: {
        model: smallModel.name,
        mode: "agent",
        protocol: "photon-block",
        intelligence: "max",
        rung: 2,
        peakRung: 3,
        steps: 4,
        counts: { parse_fail: 1, tool_ok: 2 },
        events: [],
        protocolDowngraded: true,
        autoReverted: ["b.ts"],
        timeline: [
          { step: 0, type: "escalate", fromRung: 0, toRung: 1, reason: "parse_fail → add failing example", at: 1 },
          { step: 2, type: "protocol_downgrade", fromRung: 3, toRung: 3, reason: "Switched to Photon block protocol", at: 2 },
        ],
      },
    };
    const tree = new MountedTree(() =>
      React.createElement(TransparencyPanel, {
        state: mockState,
        actions: {
          setAutoSelect: () => {},
          pinModel: () => {},
          setAdaptivityFrozen: (frozen: boolean) => {
            frozenCalledWith = frozen;
          },
        } as any,
        onClose: () => {},
      })
    );
    const rendered = getText(tree.findByClass("transparency"));
    assert.ok(rendered.includes("downgraded"));
    assert.ok(rendered.includes("peak 3"));
    assert.ok(rendered.includes("parse_fail → add failing example"));
    assert.ok(rendered.includes("Auto-reverted on diagnostics regression: b.ts"));

    const switches = tree.findAll((n) => n.tag === "button" && n.props.role === "switch");
    assert.equal(switches.length, 2); // [0] = Auto-Select Model, [1] = Freeze adaptivity
    tree.click(switches[1]);
    assert.equal(frozenCalledWith, true);
  });
});
