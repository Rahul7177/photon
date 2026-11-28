import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPlan, deriveScaffoldProfile } from "../../src/core/adaptive/orchestrator";
import { buildStepStateCard } from "../../src/core/adaptive/stateCard";
import { runUnifiedTurn, type UnifiedEmitter, type UnifiedEngineDeps } from "../../src/core/agent/unifiedEngine";
import { analyzeTask, capabilityForModel, inferStepPhase, looksLikeWebLinkDeflection, selectToolSpecs, shouldUseNativeToolProtocol } from "../../src/core/intelligence/policy";
import { buildSystemPrompt, buildSystemPromptWithReport } from "../../src/core/prompts/system";
import { parsePhotonBlocks } from "../../src/core/protocol/parse";
import { renderToolInstructions, renderToolInstructionsWithMeta } from "../../src/core/protocol/serialize";
import { builtinTools } from "../../src/core/tools/builtin";
import type { LLMChatChunk, LLMChatRequest, LLMProvider } from "../../src/core/llm/types";
import type { AdaptivePlan, ChatMessage, IntelligenceLevel, Mode, ModelInfo } from "../../src/shared/types";

const tinyModel: ModelInfo = {
  name: "qwen2.5-coder:3b",
  provider: "ollama",
  paramsB: 3.1,
  tier: "tiny",
  contextLength: 32768,
  toolTrained: true,
};

const smallModel: ModelInfo = {
  name: "qwen2.5-coder:7b",
  provider: "ollama",
  paramsB: 7.6,
  tier: "small",
  contextLength: 32768,
  toolTrained: true,
};

const largeModel: ModelInfo = {
  name: "qwen2.5-coder:32b",
  provider: "ollama",
  paramsB: 32.5,
  tier: "large",
  contextLength: 65536,
  toolTrained: true,
};

function makeRecordingProvider(responses: LLMChatChunk[][]): {
  provider: LLMProvider;
  requests: LLMChatRequest[];
} {
  let idx = 0;
  const requests: LLMChatRequest[] = [];
  const provider: LLMProvider = {
    id: "mock-phase2",
    label: "Mock Phase 2 Provider",
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

function createNoopEmitter(): UnifiedEmitter {
  return {
    onAssistantStart: () => {},
    onDelta: () => {},
    onContent: () => {},
    onAssistantCancel: () => {},
    onPhase: () => {},
    onToolCall: () => {},
    onToolUpdate: () => {},
    onUsage: () => {},
    onGenerationStats: () => {},
    onDone: () => {},
    onError: () => {},
  };
}

describe("Phase 2: Scaffold Profile, Budget Clamp, Phase Surface & State Card", () => {
  it("2.1 flag-off (scaffoldOptimizations=false) produces byte-identical prompts to legacy plans", () => {
    const specs = builtinTools().map((t) => t.spec);
    const levels: IntelligenceLevel[] = ["low", "medium", "high", "max"];
    const modes: Mode[] = ["chat", "plan", "agent"];

    for (const intelligence of levels) {
      for (const mode of modes) {
        const flaggedOff = buildPlan({
          model: smallModel,
          machine: null,
          mode,
          prompt: "Fix bug in src/app.ts",
          userNumCtx: 16384,
          intelligence,
          reserveOutputTokens: 1024,
          adaptiveEnabled: true,
          scaffoldOptimizations: false,
        });
        assert.equal(flaggedOff.scaffoldProfile?.toolCards, "full");
        assert.equal(flaggedOff.scaffoldProfile?.stateCard, "off");

        const legacyPlan: AdaptivePlan = {
          model: flaggedOff.model,
          mode,
          contextWindow: flaggedOff.contextWindow,
          numCtx: flaggedOff.numCtx,
          temperature: flaggedOff.temperature,
          topP: flaggedOff.topP,
          maxOutputTokens: flaggedOff.maxOutputTokens,
          toolProtocol: flaggedOff.toolProtocol,
          maxTools: flaggedOff.maxTools,
          allowParallelTools: flaggedOff.allowParallelTools,
          intelligence,
          intelligenceAuto: flaggedOff.intelligenceAuto,
          rationale: [],
        };

        const selected = selectToolSpecs(specs, flaggedOff, "orient", false);
        const aTools = renderToolInstructions(selected, flaggedOff);
        const bTools = renderToolInstructions(selected, legacyPlan);
        assert.equal(aTools, bTools, `Tool instructions differed with flag off (level=${intelligence}, mode=${mode})`);

        const aPrompt = buildSystemPrompt({
          mode,
          plan: flaggedOff,
          toolInstructions: aTools,
          workspaceName: "TestRepo",
          workspaceMap: "src/app.ts\nsrc/util.ts",
          projectContextDigest: "# Digest\nEntry: src/app.ts",
          retrievedContext: "export const a = 1;",
          toolSpecs: selected,
        });
        const bPrompt = buildSystemPrompt({
          mode,
          plan: legacyPlan,
          toolInstructions: bTools,
          workspaceName: "TestRepo",
          workspaceMap: "src/app.ts\nsrc/util.ts",
          projectContextDigest: "# Digest\nEntry: src/app.ts",
          retrievedContext: "export const a = 1;",
          toolSpecs: selected,
        });
        assert.equal(aPrompt, bPrompt, `System prompt differed with flag off (level=${intelligence}, mode=${mode})`);
      }
    }
  });

  it("2.2 clamps prompt budget across 8k and 64k windows so digest & map are not squeezed to zero on 8k", () => {
    const specs = builtinTools().map((t) => t.spec);
    const plan8k = buildPlan({
      model: smallModel,
      machine: null,
      mode: "agent",
      prompt: "Inspect and fix src/app.ts",
      userNumCtx: 8192,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
    });
    const selected = selectToolSpecs(specs, plan8k, "orient", false);
    const toolRender = renderToolInstructionsWithMeta(selected, plan8k, { phase: "orient" });
    const hugeDigest = Array.from({ length: 45 }, (_, i) => `Project note ${i}: core architecture module detail`).join("\n");
    const hugeMap = Array.from({ length: 120 }, (_, i) => `src/module_${i}/index.ts`).join("\n");

    const { text: text8k, report: report8k } = buildSystemPromptWithReport({
      mode: "agent",
      plan: plan8k,
      toolInstructions: toolRender.text,
      workspaceName: "Window8kRepo",
      workspaceMap: hugeMap,
      projectContextDigest: hugeDigest,
      toolSpecs: selected,
      toolMeta: { exampleToolNames: toolRender.exampleToolNames, toolCount: selected.length },
    });

    const sec8k = new Map(report8k.sections.map((s) => [s.id, s]));
    assert.ok(["kept", "trimmed"].includes(sec8k.get("project_digest")?.status ?? ""), "digest should survive on 8k");
    assert.ok(["kept", "trimmed"].includes(sec8k.get("workspace_map")?.status ?? ""), "workspace map should survive on 8k");
    assert.ok((sec8k.get("workspace_map")?.tokens ?? 0) > 0, "workspace map tokens should be > 0 on 8k");
    assert.ok(text8k.includes("Language Integrity: Always reply strictly in the user's language"));

    // 64k window budget should be clamped to maxTokens (5600), not raw 42% = 27,525
    const plan64k = buildPlan({
      model: largeModel,
      machine: null,
      mode: "agent",
      prompt: "Audit codebase architecture",
      userNumCtx: 65536,
      intelligence: "max",
      reserveOutputTokens: 2048,
      adaptiveEnabled: true,
    });
    const { report: report64k } = buildSystemPromptWithReport({
      mode: "agent",
      plan: plan64k,
      toolInstructions: "",
      workspaceName: "Window64kRepo",
      toolSpecs: selected,
    });
    assert.ok((report64k.budgetTokens ?? 0) <= 5600, `Expected clamped 64k budget <= 5600, got ${report64k.budgetTokens}`);

    // Priority trimming under tight 4k window preserves critical boundaries while trimming workflow
    const tight4k = buildPlan({
      model: tinyModel,
      machine: null,
      mode: "agent",
      prompt: "Fix bug",
      userNumCtx: 4096,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
    });
    const { text: text4k, report: report4k } = buildSystemPromptWithReport({
      mode: "agent",
      plan: tight4k,
      toolInstructions: toolRender.text,
      workspaceName: "Tight4k",
      workspaceMap: hugeMap,
      projectContextDigest: hugeDigest,
      toolSpecs: selected,
    });
    const sec4k = new Map(report4k.sections.map((s) => [s.id, s]));
    assert.equal(sec4k.get("identity")?.status, "kept");
    assert.equal(sec4k.get("mode")?.status, "kept");
    assert.equal(sec4k.get("tools")?.status, "kept");
    assert.equal(sec4k.get("formatting")?.status, "kept");
    assert.ok(text4k.includes("Language Integrity: Always reply strictly in the user's language"));
  });

  it("2.3 inferStepPhase & shortlist surface cut tools section >= 50%, keep all tools callable, and show edit examples", () => {
    assert.equal(inferStepPhase("agent", []), "orient");
    assert.equal(inferStepPhase("agent", [{ name: "find_files", ok: true }]), "orient");
    assert.equal(inferStepPhase("agent", [{ name: "read_file", ok: true }]), "edit");
    assert.equal(
      inferStepPhase("agent", [
        { name: "read_file", ok: true },
        { name: "edit_file", ok: true, sideEffecting: true },
      ]),
      "verify"
    );
    assert.equal(
      inferStepPhase("agent", [
        { name: "read_file", ok: true },
        { name: "edit_file", ok: true, sideEffecting: true },
        { name: "get_diagnostics", ok: true },
      ]),
      "final"
    );
    assert.equal(
      inferStepPhase(
        "agent",
        [
          { name: "read_file", ok: true },
          { name: "edit_file", ok: true, sideEffecting: true },
          { name: "get_diagnostics", ok: true },
        ],
        true
      ),
      "edit"
    );

    const specs = builtinTools().map((t) => t.spec);
    const fullPlan = buildPlan({
      model: tinyModel,
      machine: null,
      mode: "agent",
      prompt: "Fix bug in src/pricing.ts",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
      scaffoldOptimizations: false,
    });
    const shortlistPlan = buildPlan({
      model: tinyModel,
      machine: null,
      mode: "agent",
      prompt: "Fix bug in src/pricing.ts",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
      scaffoldOptimizations: true,
    });

    const orientSpecsFull = selectToolSpecs(specs, fullPlan, "orient", false);
    const orientSpecsShort = selectToolSpecs(specs, shortlistPlan, "orient", false);
    const fullMeta = renderToolInstructionsWithMeta(orientSpecsFull, fullPlan);
    const shortMeta = renderToolInstructionsWithMeta(orientSpecsShort, shortlistPlan, { phase: "orient" });

    const fullTok = Math.ceil(fullMeta.text.length / 4);
    const shortTok = Math.ceil(shortMeta.text.length / 4);
    assert.ok(
      shortTok <= fullTok * 0.5,
      `Expected shortlist tools <= 50% of full (${shortTok} vs ${fullTok})`
    );
    assert.ok(shortMeta.text.includes("Other callable tools"));
    assert.ok(shortMeta.text.includes("move_path(from, to)"));

    // Secondary tools remain completely callable by parsePhotonBlocks
    const moveCall = parsePhotonBlocks(
      "```tool\nTOOL_NAME: move_path\nBEGIN_ARG: from\nsrc/a.ts\nEND_ARG\nBEGIN_ARG: to\nsrc/b.ts\nEND_ARG\n```",
      orientSpecsShort
    );
    assert.equal(moveCall.calls.length, 1);
    assert.equal(moveCall.calls[0].errors.length, 0);
    assert.equal(moveCall.calls[0].name, "move_path");

    // Edit phase promotes edit_file & append_file worked examples, and failingTools adds recovery example
    const editSpecs = selectToolSpecs(specs, shortlistPlan, "edit", false);
    const editMeta = renderToolInstructionsWithMeta(editSpecs, shortlistPlan, {
      phase: "edit",
      failingTools: ["run_command"],
    });
    assert.ok(editMeta.exampleToolNames.includes("edit_file"));
    assert.ok(editMeta.exampleToolNames.includes("append_file"));
    assert.ok(editMeta.exampleToolNames.includes("run_command"));
  });

  it("2.4 applies split sampling & tiny thinking policy while honoring user sampling override, plus 2.5 stateCard", async () => {
    // Profile derivation checks
    const lowTask = analyzeTask("Fix typo in src/a.ts", "agent");
    const highTask = analyzeTask("Debug concurrency race across codebase", "agent");
    const caps = {
      reasoning: 0.5,
      coding: 0.5,
      toolCalling: 0.7,
      schemaAdherence: 0.7,
      contextRetention: 0.5,
      editFidelity: 0.5,
      recovery: 0.5,
      verification: 0.5,
      speed: 0.5,
    };
    assert.equal(deriveScaffoldProfile("tiny", caps, lowTask, "agent", 8192, "max").thinking, "off");
    assert.equal(deriveScaffoldProfile("tiny", caps, highTask, "agent", 8192, "max").thinking, "low");

    const tools = builtinTools().filter((t) =>
      ["read_file", "edit_file", "get_diagnostics"].includes(t.spec.name)
    );
    const { provider, requests } = makeRecordingProvider([
      [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
      [
        {
          message: {
            content:
              "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\na.ts\nEND_ARG\nBEGIN_ARG: old_str\nconst a = 1;\nEND_ARG\nBEGIN_ARG: new_str\nconst a = 2;\nEND_ARG\n```",
          },
        },
        { done: true },
      ],
      [{ message: { content: "```tool\nTOOL_NAME: get_diagnostics\n```" } }, { done: true }],
      [{ message: { content: "Fixed a.ts and verified diagnostics." } }, { done: true }],
    ]);

    const files = new Map<string, string>([["a.ts", "const a = 1;"]]);
    const stepTools = tools.map((t) => {
      if (t.spec.name === "read_file") {
        return { spec: t.spec, execute: async () => ({ ok: true, output: files.get("a.ts")! }) };
      }
      if (t.spec.name === "edit_file") {
        return {
          spec: t.spec,
          execute: async (args: Record<string, unknown>) => {
            files.set("a.ts", String(args.new_str));
            return { ok: true, output: "Edited a.ts" };
          },
        };
      }
      return { spec: t.spec, execute: async () => ({ ok: true, output: "No diagnostics problems found." }) };
    });

    const plan = buildPlan({
      model: tinyModel,
      machine: null,
      mode: "agent",
      prompt: "Fix a.ts and do not rename exports",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
    });
    assert.equal(plan.scaffoldProfile?.stateCard, "rich");
    assert.equal(plan.scaffoldProfile?.sampling.toolTurnTemp, 0.05);
    assert.equal(plan.scaffoldProfile?.sampling.answerTurnTemp, 0.2);

    const session = {
      messages: [
        {
          id: "u1",
          role: "user" as const,
          content: "Fix a.ts and do not rename exports",
          createdAt: Date.now(),
        },
      ] as ChatMessage[],
    };
    const deps: UnifiedEngineDeps = {
      provider,
      tools: stepTools,
      workspaceName: "Phase2Workspace",
      buildToolContext: () =>
        ({
          capability: "max",
          todos: [{ id: 1, task: "Update a.ts", status: "in_progress" }],
          signal: new AbortController().signal,
          log: () => {},
        }) as any,
      reserveOutputTokens: 1024,
    };

    await runUnifiedTurn(session, plan, createNoopEmitter(), new AbortController().signal, deps);

    assert.equal(requests.length, 4);
    // Step 0: orient, toolTurnTemp=0.05, thinkingLevel="off"
    assert.equal(requests[0].options?.temperature, 0.05);
    assert.equal(requests[0].options?.thinkingLevel, "off");
    assert.ok(requests[0].messages[0].content.includes("TOOL_NAME: read_file"));

    // Step 1: read_file succeeded -> phase rebuilt to edit (edit_file example present, transient state card injected)
    assert.equal(requests[1].options?.temperature, 0.05);
    assert.ok(requests[1].messages[0].content.includes("TOOL_NAME: edit_file"));
    const step1LastMsg = requests[1].messages[requests[1].messages.length - 1];
    assert.ok(step1LastMsg.content.includes("<working_memory>"));
    assert.ok(step1LastMsg.content.includes("GOAL: Fix a.ts and do not rename exports"));
    assert.ok(step1LastMsg.content.includes("read=[a.ts]"));
    assert.ok(step1LastMsg.content.includes("PHASE: edit"));

    // Step 3 (after verify with todos done / final synthesis):
    // Note todo remained in_progress in mock, so verify->edit vs if we test buildStepStateCard directly:
    // Also verify session.messages was NOT polluted with <working_memory>
    assert.ok(!session.messages.some((m) => m.content.includes("<working_memory>")));

    // Check explicit final answerTurnTemp and user sampling override
    const cleanFinalPlan = buildPlan({
      model: tinyModel,
      machine: null,
      mode: "agent",
      prompt: "Fix a.ts",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
    });
    const { provider: pFinal, requests: reqFinal } = makeRecordingProvider([
      [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
      [
        {
          message: {
            content:
              "```tool\nTOOL_NAME: edit_file\nBEGIN_ARG: path\na.ts\nEND_ARG\nBEGIN_ARG: old_str\nconst a = 2;\nEND_ARG\nBEGIN_ARG: new_str\nconst a = 3;\nEND_ARG\n```",
          },
        },
        { done: true },
      ],
      [{ message: { content: "```tool\nTOOL_NAME: get_diagnostics\n```" } }, { done: true }],
      [{ message: { content: "All done." } }, { done: true }],
    ]);
    await runUnifiedTurn(
      { messages: [{ id: "u2", role: "user", content: "Fix a.ts", createdAt: Date.now() }] },
      cleanFinalPlan,
      createNoopEmitter(),
      new AbortController().signal,
      { ...deps, provider: pFinal, buildToolContext: () => ({ capability: "max", todos: [], signal: new AbortController().signal, log: () => {} }) as any }
    );
    assert.equal(reqFinal[2].options?.temperature, 0.05); // verify phase
    assert.equal(reqFinal[3].options?.temperature, 0.2); // final phase switches to answerTurnTemp

    // User sampling override wins over split sampling
    const pinnedSamplingPlan = buildPlan({
      model: tinyModel,
      machine: null,
      mode: "agent",
      prompt: "Fix a.ts",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
      sampling: { temp: 0.42 },
    });
    assert.equal(pinnedSamplingPlan.samplingOverridden, true);
    const { provider: pPinned, requests: reqPinned } = makeRecordingProvider([
      [{ message: { content: "```tool\nTOOL_NAME: read_file\nBEGIN_ARG: path\na.ts\nEND_ARG\n```" } }, { done: true }],
      [{ message: { content: "Read complete." } }, { done: true }],
    ]);
    await runUnifiedTurn(
      { messages: [{ id: "u3", role: "user", content: "Fix a.ts", createdAt: Date.now() }] },
      pinnedSamplingPlan,
      createNoopEmitter(),
      new AbortController().signal,
      { ...deps, provider: pPinned }
    );
    assert.equal(reqPinned[0].options?.temperature, 0.42);
    assert.equal(reqPinned[1].options?.temperature, 0.42);

    // Direct buildStepStateCard verification
    const card = buildStepStateCard({
      goal: "Update pricing without changing currency rounding",
      mode: "agent",
      phase: "edit",
      style: "rich",
      todos: [
        { id: 1, task: "Inspect pricing.ts", status: "done" },
        { id: 2, task: "Patch formula", status: "in_progress" },
      ],
      messages: [
        { id: "m1", role: "user", content: "Update pricing and never change currency rounding", createdAt: Date.now() },
      ],
      executedTools: [{ name: "read_file", args: { path: "src/pricing.ts" }, ok: true }],
    });
    assert.ok(card?.includes("<working_memory>"));
    assert.ok(card?.includes("CONSTRAINTS:"));
    assert.ok(card?.includes("[x] Inspect pricing.ts | [>] Patch formula"));
    assert.ok(card?.includes("read=[src/pricing.ts]"));
  });

  it("2.6 keeps chat mode in orient phase after web_search and intercepts web-link deflections with a web_fetch nudge", async () => {
    assert.equal(inferStepPhase("chat", [{ name: "web_search", ok: true }]), "orient");
    assert.equal(
      inferStepPhase("chat", [
        { name: "web_search", ok: true },
        { name: "web_fetch", ok: true },
      ]),
      "final"
    );
    assert.equal(
      looksLikeWebLinkDeflection(
        "I found several sources for the Nifty 50 price. To get the most accurate, real-time price, I recommend checking one of the live tracking pages:\n- Moneycontrol: https://www.moneycontrol.com/indian-indices/nifty-50-9.html\nSince I cannot provide a live, second-by-second quote, please use one of those links."
      ),
      true
    );
    assert.equal(
      looksLikeWebLinkDeflection("The Nifty 50 is currently trading at 25,607.20 (-1.07%) according to Moneycontrol."),
      false
    );

    const webTools = builtinTools()
      .filter((t) => ["web_search", "web_fetch"].includes(t.spec.name))
      .map((t) => {
        if (t.spec.name === "web_search") {
          return {
            spec: t.spec,
            execute: async () => ({
              ok: true,
              output:
                "1. Nifty 50 Live — https://www.moneycontrol.com/indian-indices/nifty-50-9.html\n   Track NIFTY 50 chart and components.",
            }),
          };
        }
        return {
          spec: t.spec,
          execute: async () => ({
            ok: true,
            output: "Title: NIFTY 50 Live\nNIFTY 50 25,607.20 -277.30 (-1.07%) As on 27 Nov, 2026 | 16:10 IST",
          }),
        };
      });

    const { provider, requests } = makeRecordingProvider([
      [
        {
          message: {
            content: "```tool\nTOOL_NAME: web_search\nBEGIN_ARG: query\nNifty 50 price today\nEND_ARG\n```",
          },
        },
        { done: true },
      ],
      [
        {
          message: {
            content:
              "I found several sources for the Nifty 50 price. Here are a few links where you can check the live price:\n- Moneycontrol: https://www.moneycontrol.com/indian-indices/nifty-50-9.html\nSince I cannot provide a live quote, please use one of those links.",
          },
        },
        { done: true },
      ],
      [
        {
          message: {
            content:
              "```tool\nTOOL_NAME: web_fetch\nBEGIN_ARG: url\nhttps://www.moneycontrol.com/indian-indices/nifty-50-9.html\nEND_ARG\n```",
          },
        },
        { done: true },
      ],
      [
        {
          message: {
            content: "The Nifty 50 is currently at **25,607.20**, down 277.30 points (-1.07%).",
          },
        },
        { done: true },
      ],
    ]);

    const chatPlan = buildPlan({
      model: smallModel,
      machine: null,
      mode: "chat",
      prompt: "Whats the price of Nifty 50 as of now?",
      userNumCtx: 16384,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
    });

    const session = {
      messages: [
        {
          id: "u-nifty",
          role: "user" as const,
          content: "Whats the price of Nifty 50 as of now?",
          createdAt: Date.now(),
        },
      ] as ChatMessage[],
    };

    let finalContent = "";
    const emitter: UnifiedEmitter = {
      ...createNoopEmitter(),
      onContent: (_id, c) => {
        finalContent = c;
      },
    };

    await runUnifiedTurn(session, chatPlan, emitter, new AbortController().signal, {
      provider,
      tools: webTools,
      workspaceName: "Phase2Workspace",
      buildToolContext: () =>
        ({
          capability: "max",
          todos: [],
          signal: new AbortController().signal,
          log: () => {},
        }) as any,
      reserveOutputTokens: 1024,
    });

    assert.equal(requests.length, 4, "Expected web_search -> deflected answer intercepted -> web_fetch -> final answer");
    assert.ok(finalContent.includes("25,607.20"), `Expected final answer to include fetched price, got: ${finalContent}`);
  });

  it("2.7 handles small-model tool syntax quirks, intra-response repetition floods, and duplicate-call circuit breaking", async () => {
    const specs = builtinTools().map((t) => t.spec);

    // 1. Tiny models (<4.5B) default to photon-block even when Ollama advertises capabilities: ["tools"]
    const phiMini: ModelInfo = {
      name: "phi4-mini:latest",
      provider: "ollama",
      paramsB: 3.8,
      tier: "tiny",
      contextLength: 16384,
      toolTrained: true,
      capabilities: ["completion", "tools"],
    };
    assert.equal(shouldUseNativeToolProtocol(phiMini, capabilityForModel(phiMini), undefined, "max"), false);

    // 2. BEGIN_ARG with positional value directly on header line (phi4-mini pattern)
    const posParse = parsePhotonBlocks("```tool\nTOOL_NAME: web_search\nBEGIN_ARG: weather in Mysore today\nEND_ARG\n```", specs);
    assert.equal(posParse.calls.length, 1);
    assert.equal(posParse.calls[0].errors.length, 0);
    assert.deepEqual(posParse.calls[0].args, { query: "weather in Mysore today" });

    // 3. Degenerate small-model output: [SYS]...[/SYS], truncated JSON fence, array-wrapped tool calls, split JSON [{"name":"web_search"}]{"query":"..."}, and trailing truncated JSON
    const degenerateOutput = [
      "To provide you with the current weather of Mysore, I will need to perform a web search for the latest weather conditions. Please wait a moment while I retrieve this information for you.",
      "",
      '[SYS]web_search: "Mysore weather today"[/SYS]',
      "",
      "```json",
      '{"type":"function","function":',
      "```",
      "```json",
      '{"type":"function","function":{"name":"web_search","arguments":{"query":"Mysore weather today"}}}',
      "```",
      '[{"name":"web_search","arguments":{"query":"Mysore weather today"}}]',
      '[{"name":"web_search","arguments":{"query":"Mysore weather today"}}]',
      '[{"name":"web_search"}]{"query":"Mysore weather today"}',
      '[{"name":"web_search","arguments":{"query',
    ].join("\n");

    const degParsed = parsePhotonBlocks(degenerateOutput, specs);
    assert.ok(degParsed.calls.length >= 1);
    assert.ok(degParsed.calls.every((c) => c.name === "web_search" && c.errors.length === 0 && c.args.query === "Mysore weather today"));
    assert.ok(!degParsed.cleanedText.includes("[SYS]"));
    assert.ok(!degParsed.cleanedText.includes("[]"));
    assert.ok(!degParsed.cleanedText.includes('"type":"function"'));
    assert.ok(!degParsed.cleanedText.includes('[{"name"'));

    // 4. End-to-end runUnifiedTurn with degenerate multi-duplicate response + duplicate retry step -> collapses to 1 web_search call and forces clean text conclusion
    let webSearchExecCount = 0;
    const webTools = builtinTools()
      .filter((t) => ["web_search", "web_fetch"].includes(t.spec.name))
      .map((t) => {
        if (t.spec.name === "web_search") {
          return {
            spec: t.spec,
            execute: async () => {
              webSearchExecCount++;
              return {
                ok: true,
                output:
                  "Current weather for Maisuru, Karnataka, India: Patchy rain nearby. Temperature: 24°C. Feels like: 25°C. Humidity: 75%.\n\n[Live data retrieved directly. Do NOT call web_search or web_fetch again — answer the user's question now in plain text using the data above.]",
              };
            },
          };
        }
        return t;
      });

    const { provider, requests } = makeRecordingProvider([
      // Step 0: small model emits broken call + 5 duplicate calls in one response
      [{ message: { content: degenerateOutput } }, { done: true }],
      // Step 1: small model stubbornly tries to call the exact same web_search again -> engine intercepts duplicate and forces conclusion
      [{ message: { content: '[{"name":"web_search","arguments":{"query":"Mysore weather today"}}]' } }, { done: true }],
      // Step 2: forced conclusion produces clean final answer
      [{ message: { content: "The weather in Mysore today is 24°C with patchy rain nearby and 75% humidity." } }, { done: true }],
    ]);

    const chatPlan = buildPlan({
      model: phiMini,
      machine: null,
      mode: "chat",
      prompt: "Tell me the weather of mysore today",
      userNumCtx: 8192,
      intelligence: "max",
      reserveOutputTokens: 1024,
      adaptiveEnabled: true,
    });

    const toolUpdates: { name: string; status: string; error?: string }[] = [];
    let finalAnswer = "";
    const emitter: UnifiedEmitter = {
      ...createNoopEmitter(),
      onContent: (_id, c) => {
        finalAnswer = c;
      },
      onToolUpdate: (_id, tc) => {
        toolUpdates.push({ name: tc.name, status: tc.status, error: tc.error });
      },
    };

    await runUnifiedTurn(
      { messages: [{ id: "u-mysore", role: "user", content: "Tell me the weather of mysore today", createdAt: Date.now() }] },
      chatPlan,
      emitter,
      new AbortController().signal,
      {
        provider,
        tools: webTools,
        workspaceName: "Phase2Workspace",
        buildToolContext: () =>
          ({
            capability: "max",
            todos: [],
            signal: new AbortController().signal,
            log: () => {},
          }) as any,
        reserveOutputTokens: 1024,
      }
    );

    assert.equal(webSearchExecCount, 1, "Expected web_search to execute only once despite intra-response and cross-step duplicates");
    assert.equal(
      toolUpdates.filter((u) => u.status === "error").length,
      0,
      "Expected zero Duplicate call error cards in Chat mode after web_search succeeded"
    );
    assert.equal(requests.length, 3);
    assert.ok(finalAnswer.includes("24°C"), `Expected final answer to report Mysore weather, got: ${finalAnswer}`);
  });
});
