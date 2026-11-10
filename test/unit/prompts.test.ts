import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCloudSystemPrompt } from "../../src/core/prompts/cloudSystem";
import { buildSystemPrompt } from "../../src/core/prompts/system";
import type { AdaptivePlan, Mode } from "../../src/shared/types";

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
});

