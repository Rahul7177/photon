import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initial, reducer } from "../../webview-ui/src/state/store";
import type { ChatMessage, HardwareMetrics, ProjectContextSummary, ToolCall } from "../../src/shared/types";

describe("Webview UI State Store Reducer", () => {
  it("initializes with default clean state", () => {
    assert.equal(initial.ready, false);
    assert.equal(initial.status, "idle");
    assert.equal(initial.mode, "chat");
    assert.equal(initial.messages.length, 0);
    assert.equal(initial.error, null);
    assert.equal(initial.pendingApproval, null);
  });

  it("handles 'init' action from extension host", () => {
    const s1 = reducer(initial, {
      type: "init",
      payload: {
        ollamaReachable: true,
        models: [{ name: "gemma-4", provider: "ollama", contextLength: 8192 }],
        selectedModel: "gemma-4",
        mode: "agent",
        machine: null,
        plan: null,
        session: {
          id: "sess-1",
          title: "Session 1",
          messages: [{ id: "m1", role: "user", content: "Hi", createdAt: 100 }],
          createdAt: 100,
          updatedAt: 100,
        },
        sessions: [{ id: "sess-1", title: "Session 1", createdAt: 100, updatedAt: 100, messageCount: 1 }],
        config: initial.config,
        tools: [],
        benchResults: [],
        indexStatus: { phase: "idle", filesIndexed: 0, chunks: 0, pending: 0 },
        mcpServers: [],
      },
    });

    assert.equal(s1.ready, true);
    assert.equal(s1.ollamaReachable, true);
    assert.equal(s1.selectedModel, "gemma-4");
    assert.equal(s1.mode, "agent");
    assert.equal(s1.activeSessionId, "sess-1");
    assert.equal(s1.messages.length, 1);
  });

  it("handles mode transitions and model changes", () => {
    const s1 = reducer(initial, { type: "_setMode", mode: "plan" });
    assert.equal(s1.mode, "plan");

    const s2 = reducer(s1, { type: "_setModel", model: "claude-3-5-sonnet" });
    assert.equal(s2.selectedModel, "claude-3-5-sonnet");
  });

  it("streams assistant messages with messageDelta and messageDone", () => {
    const baseMsg: ChatMessage = {
      id: "asst-1",
      role: "assistant",
      content: "",
      createdAt: 200,
    };
    const s1 = reducer(initial, { type: "messageAppended", payload: baseMsg });
    assert.equal(s1.messages.length, 1);

    const s2 = reducer(s1, {
      type: "messageDelta",
      payload: { id: "asst-1", delta: "Hello " },
    });
    assert.equal(s2.messages[0].content, "Hello ");
    assert.equal(s2.messages[0].streaming, true);

    const s3 = reducer(s2, {
      type: "messageDelta",
      payload: { id: "asst-1", delta: "world!" },
    });
    assert.equal(s3.messages[0].content, "Hello world!");

    const s4 = reducer(s3, {
      type: "messageDone",
      payload: { id: "asst-1" },
    });
    assert.equal(s4.messages[0].streaming, false);
  });

  it("records reasoning thoughts with thinkingDelta and thinkingDone", () => {
    const baseMsg: ChatMessage = {
      id: "asst-2",
      role: "assistant",
      content: "Answer",
      createdAt: 300,
    };
    const s1 = reducer(initial, { type: "messageAppended", payload: baseMsg });

    const s2 = reducer(s1, {
      type: "thinkingDelta",
      payload: { id: "asst-2", delta: "Thinking about the solution..." },
    });
    assert.equal(s2.messages[0].thinking, "Thinking about the solution...");

    const s3 = reducer(s2, {
      type: "thinkingDone",
      payload: { id: "asst-2", elapsedMs: 1450 },
    });
    assert.equal(s3.messages[0].thinkingElapsedMs, 1450);
  });

  it("handles tool execution and approval flow", () => {
    const call: ToolCall = {
      id: "c1",
      name: "write_file",
      args: { path: "test.txt", content: "data" },
      status: "pending",
    };

    const s1 = reducer(initial, {
      type: "toolApprovalRequest",
      payload: { call },
    });
    assert.equal(s1.pendingApproval?.id, "c1");

    const s2 = reducer(s1, {
      type: "toolUpdate",
      payload: {
        messageId: "asst-tool",
        call: { ...call, status: "done", result: "Created file" },
      },
    });
    // Pending approval should be automatically cleared when tool finishes
    assert.equal(s2.pendingApproval, null);
    assert.equal(s2.messages.length, 1);
    assert.equal(s2.messages[0].toolCalls?.[0].status, "done");
  });

  it("handles errors gracefully via chat bubbles and clears them", () => {
    const errPayload = { message: "Model request timed out" };
    const s1 = reducer(initial, { type: "error", payload: errPayload });

    assert.equal(s1.error, "Model request timed out");
    assert.equal(s1.status, "idle");
    assert.equal(s1.messages.length, 1);
    assert.ok(s1.messages[0].notice?.includes("Model request timed out"));

    // Does not duplicate identical error message
    const s2 = reducer(s1, { type: "error", payload: errPayload });
    assert.equal(s2.messages.length, 1);

    const s3 = reducer(s2, { type: "_clearError" });
    assert.equal(s3.error, null);
  });

  it("updates live hardware metrics and project context", () => {
    const metrics: HardwareMetrics = {
      gpuName: "RTX 4090",
      gpuUtilPercent: 45,
      vramUsedBytes: 6 * 1024 ** 3,
      vramTotalBytes: 24 * 1024 ** 3,
      ramUsedBytes: 12 * 1024 ** 3,
      ramTotalBytes: 32 * 1024 ** 3,
      ramFreeBytes: 20 * 1024 ** 3,
      ramUsedPercent: 38,
      updatedAt: 500,
    };

    const s1 = reducer(initial, { type: "hardwareMetrics", payload: metrics });
    assert.equal(s1.hardwareMetrics?.gpuName, "RTX 4090");
    assert.equal(s1.hardwareMetrics?.vramTotalBytes, 24 * 1024 ** 3);

    const projectContext: ProjectContextSummary = {
      workspaceName: "Photon",
      totalFiles: 135,
      totalSymbols: 656,
      totalLines: 31600,
      lastUpdatedAt: 600,
      languages: ["TypeScript", "Python"],
      frameworks: ["React", "Vite"],
      scripts: { build: "npm run build" },
      entryPoints: ["src/extension.ts"],
      topDirectories: [],
      recentFiles: [],
      notes: [],
      latestHandoff: null,
      estimatedTokensSaved: 12800,
      queryHits: 5,
    };

    const s2 = reducer(s1, { type: "projectContext", payload: projectContext });
    assert.equal(s2.projectContext?.workspaceName, "Photon");
    assert.equal(s2.projectContext?.totalFiles, 135);
    assert.equal(s2.projectContext?.estimatedTokensSaved, 12800);
  });
});

