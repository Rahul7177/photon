import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCloudSystemPrompt, buildCloudSystemPromptWithReport } from "../../src/core/prompts/cloudSystem";
import { buildSystemPrompt, buildSystemPromptWithReport } from "../../src/core/prompts/system";
import { renderToolInstructions, renderToolInstructionsWithMeta } from "../../src/core/protocol/serialize";
import { selectToolSpecs } from "../../src/core/intelligence/policy";
import { builtinTools } from "../../src/core/tools/builtin";
import { estimateTokens } from "../../src/core/adaptive/tokens";
import type { AdaptivePlan, IntelligenceLevel, Mode } from "../../src/shared/types";

describe("System Prompt Assembly & Language Integrity", () => {
  const basePlan: AdaptivePlan = {
    model: "qwen2.5-coder:7b",
    mode: "agent",
    intelligence: "max",
    contextWindow: 16384,
    numCtx: 16384,
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 2048,
    toolProtocol: "photon-block",
    maxTools: 10,
  };

  describe("buildSystemPrompt Scaffolding Levels & Modes", () => {
    it("includes cognitive workflow and result framing for max scaffolding", () => {
      const prompt = buildSystemPrompt({
        mode: "agent",
        plan: { ...basePlan, intelligence: "max" },
        toolInstructions: "```tool\nTOOL_NAME: read_file\n```",
        workspaceName: "MyProject",
      });

      assert.ok(prompt.includes("Workspace: MyProject."));
      assert.ok(prompt.includes("structured cognitive workflow"));
      assert.ok(prompt.includes("How to Frame Your Answer After a Tool Result"));
      assert.ok(prompt.includes("Structured Engineering Workflow"));
      assert.ok(prompt.includes("Synthesize, Don't Dump"));
    });

    it("uses lean autonomous scaffolding for low intelligence", () => {
      const prompt = buildSystemPrompt({
        mode: "agent",
        plan: { ...basePlan, intelligence: "low" },
        toolInstructions: "```tool\nTOOL_NAME: read_file\n```",
        workspaceName: "MyProject",
      });

      assert.ok(prompt.includes("precise, practical coding"));
      assert.ok(!prompt.includes("structured cognitive workflow"));
    });

    it("configures Chat mode with read-only & web tools guidance and disables workspace file edits", () => {
      const prompt = buildSystemPrompt({
        mode: "chat",
        plan: { ...basePlan, mode: "chat" },
        toolInstructions: "",
        workspaceName: "MyProject",
      });

      assert.ok(prompt.includes("You are in CHAT mode."));
      assert.ok(prompt.includes("Workspace editing and terminal command tools are disabled in Chat mode"));
      assert.ok(prompt.includes("read_file"));
      assert.ok(prompt.includes("web_search"));
      assert.ok(prompt.includes("Agent"));
    });

    it("configures Plan mode as interactive read-only investigation and forbids edits", () => {
      const prompt = buildSystemPrompt({
        mode: "plan",
        plan: { ...basePlan, mode: "plan" },
        toolInstructions: "```tool\nTOOL_NAME: read_file\n```",
        workspaceName: "MyProject",
      });

      assert.ok(prompt.includes("You are in PLAN mode (read-only)."));
      assert.ok(prompt.includes("Never edit or create files in Plan mode."));
      assert.ok(!prompt.includes("Apply minimal, accurate changes with `edit_file`"));
    });

    it("injects fresh info directive when freshInfoRequest is set", () => {
      const prompt = buildSystemPrompt({
        mode: "chat",
        plan: { ...basePlan, mode: "chat" },
        toolInstructions: "",
        workspaceName: "MyProject",
        freshInfoRequest: true,
      });

      assert.ok(prompt.includes("CRITICAL — LIVE / EXTERNAL INFORMATION REQUIRED"));
      assert.ok(prompt.includes("You MUST call `web_search` FIRST before answering"));
    });

    it("injects native tool coaching when model uses native tool calling protocol", () => {
      const prompt = buildSystemPrompt({
        mode: "agent",
        plan: { ...basePlan, toolProtocol: "native" },
        toolInstructions: "",
        workspaceName: "MyProject",
      });

      assert.ok(prompt.includes("Tool Calling Discipline (Strict)"));
      assert.ok(prompt.includes("Action over Narration"));
      assert.ok(prompt.includes("Zero Hallucination"));
    });

    it("strictly preserves the Language Integrity clause across all scaffolding levels", () => {
      const levels = ["low", "medium", "high", "max"] as const;
      const modes: Mode[] = ["chat", "plan", "agent"];

      for (const level of levels) {
        for (const mode of modes) {
          const prompt = buildSystemPrompt({
            mode,
            plan: { ...basePlan, intelligence: level, mode },
            toolInstructions: "",
            workspaceName: "TestWorkspace",
          });

          assert.ok(
            prompt.includes("Language Integrity: Always reply strictly in the user's language"),
            `Language Integrity clause missing in level=${level}, mode=${mode}`
          );
          assert.ok(
            prompt.includes("Never insert unsolicited parenthetical Chinese, Japanese, or other foreign language translations/glosses"),
            `Unsolicited glosses restriction missing in level=${level}, mode=${mode}`
          );
        }
      }
    });
  });

  describe("buildCloudSystemPrompt Token-Optimization & Cache Stability", () => {
    it("returns ultra-compact prompt for greeting/conversational turns (toolPolicy='none')", () => {
      const prompt = buildCloudSystemPrompt({
        mode: "chat",
        workspaceName: "CloudWorkspace",
        toolPolicy: "none",
      });

      assert.ok(prompt.includes("Reply directly and naturally without calling tools."));
      assert.ok(prompt.includes("Language Integrity: Always respond strictly in the same language"));
      assert.ok(!prompt.includes("web_search"));
    });

    it("configures web-only tools when toolPolicy='web'", () => {
      const prompt = buildCloudSystemPrompt({
        mode: "chat",
        toolPolicy: "web",
      });

      assert.ok(prompt.includes("# Web Tools"));
      assert.ok(prompt.includes("web_search"));
      assert.ok(prompt.includes("web_fetch"));
      assert.ok(!prompt.includes("read_file"));
    });

    it("preserves stable prompt prefix across cloud modes for prompt caching", () => {
      const chatPrompt = buildCloudSystemPrompt({ mode: "chat", workspaceName: "Shared" });
      const agentPrompt = buildCloudSystemPrompt({ mode: "agent", workspaceName: "Shared" });

      const prefix = 'You are Photon, an expert software engineer working inside VS Code in the "Shared" workspace.';
      assert.ok(chatPrompt.startsWith(prefix));
      assert.ok(agentPrompt.startsWith(prefix));
    });
  });

  describe("Phase 0: Prompt Section Breakdown & S-2 Worked Examples Audit", () => {
    it("buildSystemPromptWithReport matches buildSystemPrompt byte-for-byte across all levels × modes × protocols", () => {
      const levels: IntelligenceLevel[] = ["low", "medium", "high", "max"];
      const modes: Mode[] = ["chat", "plan", "agent"];
      const protocols = ["photon-block", "native"] as const;
      const allSpecs = builtinTools().map((t) => t.spec);

      for (const intelligence of levels) {
        for (const mode of modes) {
          for (const toolProtocol of protocols) {
            const plan: AdaptivePlan = { ...basePlan, intelligence, mode, toolProtocol };
            const specs = selectToolSpecs(allSpecs, plan, "orient", false);
            const toolRender = toolProtocol === "native" ? undefined : renderToolInstructionsWithMeta(specs, plan);
            if (toolRender) {
              assert.equal(toolRender.text, renderToolInstructions(specs, plan));
            }

            const input = {
              mode,
              plan,
              toolInstructions: toolRender?.text ?? "",
              workspaceName: "AuditRepo",
              workspaceMap: "src/index.ts\nsrc/app.ts\npackage.json",
              projectContextDigest: "Maintained Project Context: TypeScript VS Code extension.",
              retrievedContext: "export function add(a: number, b: number) { return a + b; }",
              customizationsPrompt: "Follow strict TypeScript style.",
              freshInfoRequest: mode === "chat",
              toolMeta: toolRender ? { exampleToolNames: toolRender.exampleToolNames, toolCount: specs.length } : undefined,
            };

            const legacy = buildSystemPrompt(input);
            const withReport = buildSystemPromptWithReport(input);
            assert.equal(withReport.text, legacy, `Mismatch for level=${intelligence} mode=${mode} protocol=${toolProtocol}`);
            assert.equal(withReport.report.totalTokens, estimateTokens(withReport.text));
            assert.ok(withReport.report.sections.length >= 4);
          }
        }
      }
    });

    it("tracks kept, trimmed, and dropped section statuses under tight context budgets", () => {
      const allSpecs = builtinTools().map((t) => t.spec);
      const tightPlan: AdaptivePlan = {
        ...basePlan,
        mode: "agent",
        intelligence: "max",
        numCtx: 2048,
        contextWindow: 2048,
        toolProtocol: "photon-block",
      };
      const specs = selectToolSpecs(allSpecs, tightPlan, "orient", false);
      const toolRender = renderToolInstructionsWithMeta(specs, tightPlan);
      const hugeBlock = Array.from({ length: 160 }, (_, i) => `src/module_${i}/file_${i}.ts — detailed architectural summary line ${i}`).join("\n");

      const { report } = buildSystemPromptWithReport({
        mode: "agent",
        plan: tightPlan,
        toolInstructions: toolRender.text,
        workspaceName: "TightRepo",
        workspaceMap: hugeBlock,
        projectContextDigest: hugeBlock,
        customizationsPrompt: hugeBlock,
        retrievedContext: hugeBlock,
        toolMeta: { exampleToolNames: toolRender.exampleToolNames, toolCount: specs.length },
      });

      const byId = new Map(report.sections.map((s) => [s.id, s]));
      assert.equal(byId.get("identity")?.status, "kept");
      assert.equal(byId.get("tools")?.status, "kept");
      // With ~1700+ core tokens and 42% of 2048 = 860 budgetTokens, optional extras cannot fit and are dropped/trimmed.
      assert.ok(
        ["trimmed", "dropped"].includes(byId.get("workspace_map")?.status ?? ""),
        `Expected workspace_map to be trimmed or dropped under tight budget, got ${byId.get("workspace_map")?.status}`
      );
      assert.equal(byId.get("retrieved_rag")?.status, "dropped");
    });

    it("audits S-2: orient-phase ordering omits edit_file/append_file from max worked examples while edit-phase promotes them", () => {
      const allSpecs = builtinTools().map((t) => t.spec);
      const maxAgentPlan: AdaptivePlan = {
        ...basePlan,
        mode: "agent",
        intelligence: "max",
        numCtx: 8192,
        contextWindow: 8192,
        toolProtocol: "photon-block",
      };

      const orientSpecs = selectToolSpecs(allSpecs, maxAgentPlan, "orient", false);
      const orientRender = renderToolInstructionsWithMeta(orientSpecs, maxAgentPlan);
      assert.equal(orientRender.exampleToolNames.length, 5);
      // Confirms S-2: because unifiedEngine passes phase="orient", read/search/verify tools (+35) fill all 5 worked example slots.
      assert.ok(!orientRender.exampleToolNames.includes("edit_file"), `orient examples unexpectedly included edit_file: ${orientRender.exampleToolNames.join(",")}`);
      assert.ok(!orientRender.exampleToolNames.includes("append_file"), `orient examples unexpectedly included append_file: ${orientRender.exampleToolNames.join(",")}`);

      const editSpecs = selectToolSpecs(allSpecs, maxAgentPlan, "edit", false);
      const editRender = renderToolInstructionsWithMeta(editSpecs, maxAgentPlan);
      assert.ok(editRender.exampleToolNames.includes("edit_file"), `edit-phase examples should include edit_file: ${editRender.exampleToolNames.join(",")}`);
      assert.ok(editRender.exampleToolNames.includes("append_file"), `edit-phase examples should include append_file: ${editRender.exampleToolNames.join(",")}`);
    });

    it("buildCloudSystemPromptWithReport matches buildCloudSystemPrompt byte-for-byte across policies and modes", () => {
      const policies = ["none", "web", "all"] as const;
      const modes: Mode[] = ["chat", "plan", "agent"];
      for (const toolPolicy of policies) {
        for (const mode of modes) {
          const input = {
            mode,
            workspaceName: "CloudRepo",
            workspaceMap: "src/a.ts\nsrc/b.ts",
            projectContextDigest: "# Digest\nEntry: src/a.ts",
            retrievedContext: "export const x = 1;",
            customizationsPrompt: "# Custom Agent\nBe concise.",
            toolPolicy,
          };
          const legacy = buildCloudSystemPrompt(input);
          const withReport = buildCloudSystemPromptWithReport(input);
          assert.equal(withReport.text, legacy);
          assert.equal(withReport.report.totalTokens, estimateTokens(withReport.text));
          assert.ok(withReport.report.sections.length >= 1);
        }
      }
    });
  });

  describe("Phase 1: Rulebook Deduplication & Tool Arg Contract (S-1, S-3)", () => {
    it("uses ToolSpec-derived old_str/new_str arg names with zero find/replace contradictions across all levels × modes × protocols", () => {
      const specs = builtinTools().map((t) => t.spec);
      const specByName = new Map(specs.map((s) => [s.name, s]));
      const levels: IntelligenceLevel[] = ["low", "medium", "high", "max"];
      const modes: Mode[] = ["chat", "plan", "agent"];
      const protocols = ["photon-block", "native"] as const;

      for (const intelligence of levels) {
        for (const mode of modes) {
          for (const toolProtocol of protocols) {
            const plan: AdaptivePlan = { ...basePlan, intelligence, mode, toolProtocol };
            const selected = selectToolSpecs(specs, plan, "orient", false);
            const toolRender = toolProtocol === "native" ? undefined : renderToolInstructionsWithMeta(selected, plan);
            const prompt = buildSystemPrompt({
              mode,
              plan,
              toolInstructions: toolRender?.text ?? "",
              workspaceName: "ContractRepo",
              toolSpecs: specs,
            });

            assert.ok(!prompt.includes("`find`"), `Prompt leaked deprecated arg \`find\` (level=${intelligence}, mode=${mode}, protocol=${toolProtocol})`);
            assert.ok(!prompt.includes("`replace`"), `Prompt leaked deprecated arg \`replace\` (level=${intelligence}, mode=${mode}, protocol=${toolProtocol})`);

            if (mode === "agent") {
              assert.ok(prompt.includes("old_str"), `Agent prompt missing old_str (level=${intelligence}, protocol=${toolProtocol})`);
              assert.ok(prompt.includes("new_str"), `Agent prompt missing new_str (level=${intelligence}, protocol=${toolProtocol})`);
            }

            // Every BEGIN_ARG inside rendered worked ```tool blocks must belong to that tool's ToolSpec.params
            const blockRe = /```tool\s*\nTOOL_NAME:\s*([a-z0-9_]+)\n([\s\S]*?)```/gi;
            for (const m of prompt.matchAll(blockRe)) {
              const toolName = m[1];
              const spec = specByName.get(toolName);
              assert.ok(spec, `Unknown tool ${toolName} in worked example`);
              const allowed = new Set(spec.params.map((p) => p.name));
              for (const argMatch of m[2].matchAll(/^BEGIN_ARG:\s*([a-z0-9_]+)/gm)) {
                assert.ok(
                  allowed.has(argMatch[1]),
                  `Example for ${toolName} referenced unknown arg ${argMatch[1]}`
                );
              }
            }
          }
        }
      }
    });

    it("cuts non-tool core scaffolding tokens by >= 20% in max Agent mode via rulebook deduplication", () => {
      const specs = builtinTools().map((t) => t.spec);
      const maxPlan: AdaptivePlan = { ...basePlan, mode: "agent", intelligence: "max", toolProtocol: "photon-block" };
      const selected = selectToolSpecs(specs, maxPlan, "orient", false);
      const toolRender = renderToolInstructionsWithMeta(selected, maxPlan);
      const { text, report } = buildSystemPromptWithReport({
        mode: "agent",
        plan: maxPlan,
        toolInstructions: toolRender.text,
        workspaceName: "EvalSandbox",
        toolSpecs: specs,
        toolMeta: { exampleToolNames: toolRender.exampleToolNames, toolCount: selected.length },
      });

      const nonToolCoreIds = new Set(["identity", "mode", "result_framing", "workflow", "formatting"]);
      const nonToolCoreTokens = report.sections
        .filter((s) => nonToolCoreIds.has(s.id))
        .reduce((sum, s) => sum + s.tokens, 0);

      // Phase 0 baseline non-tool core was 962 tokens (80+302+201+201+178); >=20% reduction requires <= 769
      assert.ok(
        nonToolCoreTokens <= 769,
        `Expected deduplicated non-tool core <= 769 tokens (>=20% below 962), got ${nonToolCoreTokens}`
      );
      assert.ok(text.includes("Structured Engineering Workflow"));
      assert.ok(text.includes("How to Frame Your Answer After a Tool Result"));
      assert.ok(text.includes("Language Integrity:"));
    });
  });
});

