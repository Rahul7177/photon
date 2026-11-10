import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderCatalogService,
  deriveCustomProviderId,
  selectInitialPickerModels,
  toProviderModels,
  type ProviderCatalogStorage,
} from "../../src/host/providerCatalogService";
import { ApprovalService, parseMcpConfigJson } from "../../src/host/approvalService";
import {
  enforceSessionMessageCap,
  finalizeTurnMessages,
  pruneInlineImages,
  rewindMessagesToCheckpoint,
} from "../../src/host/sessionCoordinator";
import { computeStatusInfo } from "../../webview-ui/src/components/StatusIndicator";
import { computeSummary } from "../../webview-ui/src/components/TurnProcess";
import { splitFences, computeCodeBlockPreview } from "../../webview-ui/src/components/Markdown";
import { shouldShowTurnThinking } from "../../webview-ui/src/components/AssistantTurn";
import type { ModelInfo, SessionState, ToolCall } from "../../src/shared/types";
import type { LLMProvider } from "../../src/core/llm/types";
import { CheckpointCoordinator } from "../../src/host/checkpointCoordinator";
import { McpCoordinator } from "../../src/host/mcpCoordinator";
import { TurnCoordinator } from "../../src/host/turnCoordinator";
import { ProviderService } from "../../src/host/providerService";
import { ProviderManager } from "../../src/core/llm/providerManager";
import type { HostMessage } from "../../src/shared/protocol";

function makeInMemoryCatalogStorage(): ProviderCatalogStorage & {
  added: ModelInfo[];
  cached: Record<string, ModelInfo[]>;
  enabledMap: Record<string, boolean>;
  secrets: Record<string, string>;
} {
  const state = {
    added: [] as ModelInfo[],
    cached: {} as Record<string, ModelInfo[]>,
    enabledMap: {} as Record<string, boolean>,
    secrets: {} as Record<string, string>,
    customProviders: [] as any[],
  };
  return {
    get added() {
      return state.added;
    },
    get cached() {
      return state.cached;
    },
    get enabledMap() {
      return state.enabledMap;
    },
    get secrets() {
      return state.secrets;
    },
    getAddedModels: () => [...state.added],
    setAddedModels: async (models) => {
      state.added = [...models];
    },
    getCachedLiveModels: () => ({ ...state.cached }),
    setCachedLiveModels: async (cache) => {
      state.cached = { ...cache };
    },
    getProviderEnabled: (id) => !!state.enabledMap[id],
    setProviderEnabled: async (id, enabled) => {
      state.enabledMap[id] = enabled;
    },
    getSecretApiKey: async (id) => state.secrets[id] ?? "",
    setSecretApiKey: async (id, apiKey) => {
      state.secrets[id] = apiKey;
    },
    deleteSecretApiKey: async (id) => {
      delete state.secrets[id];
    },
    getLlamaCppBaseUrl: () => "http://localhost:8080",
    getCustomProviders: () => state.customProviders,
    setCustomProviders: async (providers) => {
      state.customProviders = [...providers];
    },
  };
}

describe("ProviderCatalogService (Item 12)", () => {
  it("adds and removes models in the picker and auto-enables the provider", async () => {
    const storage = makeInMemoryCatalogStorage();
    const service = new ProviderCatalogService(storage);

    const model: ModelInfo = {
      name: "meta/llama-3.1-70b-instruct",
      tier: "large",
      capabilities: ["chat", "code", "tools"],
    };

    const res = await service.addModelToPicker("nvidia", model);
    assert.equal(res.bare, "meta/llama-3.1-70b-instruct");
    assert.equal(res.prefixed, "nvidia:meta/llama-3.1-70b-instruct");
    assert.equal(storage.enabledMap["nvidia"], true);
    assert.equal(service.addedModels().length, 1);
    assert.equal(service.addedModels()[0].name, "nvidia:meta/llama-3.1-70b-instruct");

    // Duplicate add is idempotent
    await service.addModelToPicker("nvidia", model);
    assert.equal(service.addedModels().length, 1);

    // Remove model
    const removed = await service.removeModelFromPicker("nvidia:meta/llama-3.1-70b-instruct");
    assert.equal(removed, true);
    assert.equal(service.addedModels().length, 0);
  });

  it("caches live models and auto-selects initial flagship models when picker is empty", async () => {
    const storage = makeInMemoryCatalogStorage();
    const service = new ProviderCatalogService(storage);

    const mockProvider: LLMProvider = {
      id: "nvidia",
      label: "NVIDIA NIM",
      enabled: true,
      isConfigured: () => true,
      ping: async () => true,
      listModels: async () => [],
      fetchLiveModels: async () => [
        { name: "nvidia:deepseek-ai/deepseek-r1", tier: "large", provider: "nvidia" },
        { name: "nvidia:some-other-model", tier: "medium", provider: "nvidia" },
      ],
      chatStream: async function* () {
        yield { message: { role: "assistant", content: "ok" }, done: true };
      },
    };

    const { models, autoAddedCount } = await service.fetchAndCacheLiveModels(mockProvider);
    assert.equal(models.length, 2);
    assert.ok(autoAddedCount >= 1);
    assert.equal(service.liveModelCache.get("nvidia")?.length, 2);
    assert.equal(storage.cached["nvidia"]?.length, 2);
    assert.ok(service.addedModels().some((m) => m.name === "nvidia:deepseek-ai/deepseek-r1"));
  });

  it("derives unique custom provider IDs and converts added models to ProviderModel records", () => {
    assert.equal(deriveCustomProviderId("My Local vLLM!", []), "my-local-vllm");
    assert.equal(
      deriveCustomProviderId("My Local vLLM!", ["my-local-vllm", "my-local-vllm-2"]),
      "my-local-vllm-2-2"
    );

    const converted = toProviderModels(
      [
        {
          name: "openai:gpt-4o",
          provider: "openai",
          tier: "large",
          contextLength: 128000,
          toolTrained: true,
        },
      ],
      "openai"
    );
    assert.equal(converted.length, 1);
    assert.equal(converted[0].id, "gpt-4o");
    assert.equal(converted[0].name, "openai:gpt-4o");
  });
});

describe("ApprovalService & parseMcpConfigJson (Item 12)", () => {
  it("resolves side-effecting tool approvals and cancels pending approvals on turn abort", async () => {
    const approvals = new ApprovalService(false);
    const posted: ToolCall[] = [];

    const readOnlyCall: ToolCall = {
      id: "c1",
      name: "read_file",
      args: { path: "README.md" },
      status: "pending",
      sideEffecting: false,
    };
    assert.equal(await approvals.requestApproval(readOnlyCall, (c) => posted.push(c)), true);
    assert.equal(posted.length, 0);

    const writeCall: ToolCall = {
      id: "c2",
      name: "write_file",
      args: { path: "a.txt", content: "hi" },
      status: "pending",
      sideEffecting: true,
    };
    const p = approvals.requestApproval(writeCall, (c) => posted.push(c));
    assert.equal(approvals.pendingCount, 1);
    assert.equal(posted.length, 1);

    const resolution = approvals.resolveApproval("c2", true, true, "write_file");
    assert.equal(resolution.resolved, true);
    assert.equal(resolution.autoApproveChanged, true);
    assert.equal(await p, true);
    assert.equal(approvals.autoApprove, true);
    assert.equal(approvals.isSessionAutoApprove, true);
    assert.equal(approvals.isUserConfiguredAutoApprove, false);

    // Session clearing resets session-level autoApprove cleanly
    const clearResult = approvals.clearSessionApprovals();
    assert.equal(clearResult.autoApproveChanged, true);
    assert.equal(approvals.autoApprove, false);
    assert.equal(approvals.isSessionAutoApprove, false);

    // If user configured global auto-approval, it is preserved across session clearing
    approvals.autoApprove = true;
    assert.equal(approvals.isUserConfiguredAutoApprove, true);
    const clearResult2 = approvals.clearSessionApprovals();
    assert.equal(clearResult2.autoApproveChanged, false);
    assert.equal(approvals.autoApprove, true);
    assert.equal(approvals.isUserConfiguredAutoApprove, true);

    // Reset user preference for following test
    approvals.autoApprove = false;
    const p2 = approvals.requestApproval({ ...writeCall, id: "c3" }, () => {});
    assert.equal(approvals.pendingCount, 1);
    assert.equal(approvals.cancelAllPending(), 1);
    assert.equal(await p2, false);
    assert.equal(approvals.pendingCount, 0);
  });

  it("parses .vscode/mcp.json with http and stdio transports and permissions", () => {
    const raw = JSON.stringify({
      servers: {
        localDocs: {
          url: "http://127.0.0.1:4100/mcp",
          allowLocalNetwork: true,
          permissions: { readOnlyOnly: true },
        },
        gitServer: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-git"],
          permissions: { blockedTools: ["git_push"] },
        },
      },
    });
    const parsed = parseMcpConfigJson(raw);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, "localDocs");
    assert.equal(parsed[0].transport, "http");
    if (parsed[0].transport === "http") {
      assert.equal(parsed[0].allowLocalNetwork, true);
      assert.equal(parsed[0].permissions?.readOnlyOnly, true);
    }
    assert.equal(parsed[1].id, "gitServer");
    assert.equal(parsed[1].transport, "stdio");
  });
});

describe("SessionCoordinator (Item 12)", () => {
  it("prunes older inline base64 images while keeping recent ones", () => {
    const session: SessionState = {
      id: "s1",
      title: "Test",
      mode: "chat",
      model: "qwen2.5-coder:7b",
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "first",
          createdAt: 1,
          attachments: [{ name: "old.png", kind: "image", dataBase64: "AAA" }],
        },
        {
          id: "m2",
          role: "user",
          content: "second",
          createdAt: 2,
          attachments: [
            { name: "recent1.png", kind: "image", dataBase64: "BBB" },
            { name: "recent2.png", kind: "image", dataBase64: "CCC" },
          ],
        },
      ],
    };
    const pruned = pruneInlineImages(session, 2);
    assert.equal(pruned.messages[0].attachments?.[0].dataBase64, undefined);
    assert.equal(pruned.messages[1].attachments?.[0].dataBase64, "BBB");
    assert.equal(pruned.messages[1].attachments?.[1].dataBase64, "CCC");
  });

  it("finalizes mid-stream messages and removes empty assistant bubbles", () => {
    const session: SessionState = {
      id: "s1",
      title: "Test",
      mode: "chat",
      model: "qwen2.5-coder:7b",
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { id: "u1", role: "user", content: "hello", createdAt: 1 },
        { id: "a1", role: "assistant", content: "partial", createdAt: 2, streaming: true },
        { id: "a2", role: "assistant", content: "   ", createdAt: 3, streaming: false },
      ],
    };
    const touched = finalizeTurnMessages(session);
    assert.equal(touched, true);
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[1].streaming, false);
    assert.equal(session.messages[1].notice, "Stopped.");
  });

  it("rewinds messages to the user turn associated with a checkpoint", () => {
    const messages = [
      { id: "u1", role: "user" as const, content: "First prompt", createdAt: 1 },
      { id: "a1", role: "assistant" as const, content: "First reply", createdAt: 2 },
      { id: "u2", role: "user" as const, content: "Second prompt", createdAt: 3, checkpointId: "cp-2" },
      { id: "a2", role: "assistant" as const, content: "Second reply", createdAt: 4, checkpointId: "cp-2" },
    ];
    const res = rewindMessagesToCheckpoint(messages, "cp-2");
    assert.equal(res.userMessageIndex, 2);
    assert.equal(res.restoredPrompt, "Second prompt");
    assert.equal(res.rewoundMessages.length, 2);
    assert.equal(res.rewoundMessages[1].id, "a1");
  });

  it("compacts older turns into an archive digest before truncating when exceeding max messages", () => {
    const messages = [];
    // User task anchor
    messages.push({
      id: "u_anchor",
      role: "user" as const,
      content: "Initial task: build the auth and billing systems",
      createdAt: 1000,
    });
    // Intermediate turns with file edits and commands
    for (let i = 1; i <= 10; i++) {
      messages.push({
        id: `a_${i}`,
        role: "assistant" as const,
        content: `Step ${i} completed.`,
        toolCalls: [
          {
            id: `call_${i}`,
            name: "write_to_file",
            args: { path: `src/mod${i}.ts`, content: "export {}" },
            status: "done" as const,
          },
        ],
        createdAt: 1000 + i * 10,
      });
      messages.push({
        id: `u_${i}`,
        role: "user" as const,
        content: `Continue to step ${i + 1}`,
        createdAt: 1000 + i * 10 + 5,
      });
    }

    const session: SessionState = {
      id: "s_overflow",
      title: "Long Session",
      mode: "agent",
      model: "qwen2.5-coder:7b",
      createdAt: 1000,
      updatedAt: 2000,
      messages,
    };

    // Cap at 10 messages (1 archive digest message + 9 retained messages = 10 messages)
    const compacted = enforceSessionMessageCap(session, 10);
    assert.equal(compacted, true);
    assert.equal(session.messages.length, 10, "Post-cap total messages must not exceed maxMessages");
    const archiveMsg = session.messages[0];
    assert.equal(archiveMsg.role, "assistant");
    assert.equal(archiveMsg.isCompacted, true);
    assert.ok(archiveMsg.content.includes("[Context Compaction Summary]"));
    assert.ok(archiveMsg.content.includes("Initial task: build the auth and billing systems"));
    assert.ok(archiveMsg.notice?.includes("Context archived"));

    // Repeated archive cycle: add 5 new messages and re-cap at 10
    for (let i = 21; i <= 25; i++) {
      session.messages.push({
        id: `msg-${i}`,
        role: i % 2 === 1 ? "user" : "assistant",
        content: `Follow-up message ${i}`,
        createdAt: 3000 + i,
      });
    }
    assert.equal(session.messages.length, 15);
    const recap = enforceSessionMessageCap(session, 10);
    assert.equal(recap, true);
    assert.equal(session.messages.length, 10, "Total messages after second archive cycle must still be exactly 10");
    const secondArchive = session.messages[0];
    assert.ok(secondArchive.isCompacted);
    // Verify no double-nested headers
    const bannerMatches = secondArchive.content.match(/⚡ \*\*\[Context Compaction Summary\]\*\*/g);
    assert.equal(bannerMatches?.length, 1, "Compaction summary banner must not be nested");
    // Verify initial task objective is still preserved!
    assert.ok(secondArchive.content.includes("Initial task: build the auth and billing systems"));
  });
});

describe("Agent Activity Visibility & TurnProcess Summary (Item 13)", () => {
  it("maps runtime phases and pending approvals to distinct stage badges in StatusIndicator", () => {
    const baseState: any = {
      status: "thinking",
      statusDetail: undefined,
      isCompacting: false,
      pendingApproval: null,
      messages: [],
    };

    assert.deepEqual(
      computeStatusInfo({ ...baseState, statusDetail: "Retrieving project context..." }),
      {
        kind: "thinking",
        stage: "Context",
        label: "Retrieving project context",
      }
    );

    assert.deepEqual(
      computeStatusInfo({ ...baseState, statusDetail: "Selecting model & execution plan..." }),
      {
        kind: "thinking",
        stage: "Routing",
        label: "Selecting model & execution plan",
      }
    );

    assert.deepEqual(
      computeStatusInfo({
        ...baseState,
        status: "running",
        statusDetail: "Verifying changes (get_diagnostics)...",
      }),
      {
        kind: "verifying",
        stage: "Verifying",
        label: "Verifying changes (get_diagnostics)",
      }
    );

    assert.deepEqual(
      computeStatusInfo({
        ...baseState,
        status: "running",
        pendingApproval: { id: "t1", name: "run_command", args: {}, status: "pending" },
      }),
      {
        kind: "approval",
        stage: "Awaiting Approval",
        label: "Waiting for approval to run run_command",
      }
    );
  });

  it("distinguishes tool execution, verification, errors, and cancellation in TurnProcess", () => {
    const writeCall: ToolCall = {
      id: "t1",
      name: "write_file",
      args: { path: "index.ts" },
      status: "running",
    };

    const runSummary = computeSummary([writeCall], 0, true, false, false);
    assert.equal(runSummary.state, "running");
    assert.equal(runSummary.badge, "Running");

    const diagCall: ToolCall = {
      id: "t2",
      name: "get_diagnostics",
      args: {},
      status: "running",
    };
    const verifySummary = computeSummary([diagCall], 0, true, false, false);
    assert.equal(verifySummary.state, "running");
    assert.equal(verifySummary.badge, "Verifying");

    const deniedCall: ToolCall = { ...writeCall, status: "denied" };
    const deniedSummary = computeSummary([deniedCall], 1200, false, false, null, false);
    assert.equal(deniedSummary.state, "cancelled");
    assert.equal(deniedSummary.badge, "Denied");

    const errCall: ToolCall = { ...writeCall, status: "error" };
    const errSummary = computeSummary([errCall], 2000, false, true, null, false);
    assert.equal(errSummary.state, "error");
    assert.equal(errSummary.badge, "Failed");
  });

  it("keeps live thinking indicator active during generation even after partial prose arrives", () => {
    assert.equal(shouldShowTurnThinking({ turnActive: true, activeHasRunningTool: false }), true);
    assert.equal(shouldShowTurnThinking({ turnActive: true, activeHasRunningTool: true }), false);
    assert.equal(shouldShowTurnThinking({ turnActive: false, activeHasRunningTool: false }), false);
  });

  it("keeps full Markdown/README files in one block across 4-backtick and nested 3-backtick fences", () => {
    const fourTickReadme = [
      "Here is the complete README:",
      "",
      "````markdown",
      "# Photon",
      "",
      "## Quickstart",
      "```bash",
      "npm install",
      "```",
      "",
      "## Structure",
      "```",
      "src/",
      "```",
      "````",
      "",
      "Done!",
    ].join("\n");

    const fourBlocks = splitFences(fourTickReadme);
    assert.equal(fourBlocks.filter((b) => b.type === "code").length, 1);
    const fourCode = fourBlocks.find((b) => b.type === "code");
    assert.equal(fourCode?.lang, "markdown");
    assert.ok(fourCode?.content.includes("```bash\nnpm install\n```"));
    assert.ok(fourCode?.content.includes("```\nsrc/\n```"));

    const threeTickReadme = [
      "Here is the README:",
      "",
      "```markdown",
      "# Photon",
      "```bash",
      "npm test",
      "```",
      "```",
      "src/",
      "```",
      "## Footer",
      "```",
    ].join("\n");

    const threeBlocks = splitFences(threeTickReadme);
    const codeBlocks = threeBlocks.filter((b) => b.type === "code");
    assert.equal(codeBlocks.length, 1, "Legacy 3-backtick markdown block must not fragment on nested code fences");
    assert.ok(codeBlocks[0].content.includes("## Footer"));

    // Separate markdown blocks stay distinct when not nested
    const twoSeparate = splitFences("```markdown\n# A\n```\n\nMiddle text.\n\n```markdown\n# B\n```");
    assert.equal(twoSeparate.filter((b) => b.type === "code").length, 2);

    // Unclosed streaming code fence renders as a code block instead of raw jumping prose
    const streamingFence = splitFences("````markdown\n# Streaming README\n```bash\nnpm run build");
    assert.equal(streamingFence.length, 1);
    assert.equal(streamingFence[0].type, "code");
    assert.equal(streamingFence[0].closed, false);
  });

  it("collapses large file code blocks into a preview with See more line counts", () => {
    const shortPreview = computeCodeBlockPreview("line 1\nline 2\nline 3");
    assert.equal(shortPreview.isBig, false);
    assert.equal(shortPreview.hiddenLines, 0);

    const longContent = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
    const longPreview = computeCodeBlockPreview(longContent);
    assert.equal(longPreview.isBig, true);
    assert.equal(longPreview.lineCount, 45);
    assert.equal(longPreview.hiddenLines, 45 - 14);
    assert.equal(longPreview.previewText.split("\n").length, 14);
  });
});

describe("Phase 9: Architecture & Focused Services", () => {
  describe("TurnCoordinator", () => {
    it("manages active turn lifecycle, aborts, and sequential prompt queueing", async () => {
      const posted: HostMessage[] = [];
      const turnCoord = new TurnCoordinator({
        post: (msg) => posted.push(msg),
        output: { appendLine: () => {} },
      });

      assert.equal(turnCoord.isTurnActive(), false);

      const executedPrompts: string[] = [];
      let finishTurn1!: () => void;
      const turn1Promise = new Promise<void>((r) => (finishTurn1 = r));

      // Launch turn 1 which sets active signal and stays running until finishTurn1 is called
      const p1 = turnCoord.enqueueOrRun({ text: "turn 1" }, async (t) => {
        turnCoord.createTurnSignal();
        executedPrompts.push(t);
        await turn1Promise;
      });

      // Allow microtask to run so turn 1 starts
      await new Promise((r) => setImmediate(r));
      assert.equal(turnCoord.isTurnActive(), true);

      // Queue turn 2 and turn 3 while turn 1 is active
      const p2 = turnCoord.enqueueOrRun({ text: "turn 2" }, async (t) => {
        executedPrompts.push(t);
      });
      const p3 = turnCoord.enqueueOrRun({ text: "turn 3" }, async (t) => {
        executedPrompts.push(t);
      });

      assert.equal(turnCoord.getQueueLength(), 2);
      assert.deepEqual(executedPrompts, ["turn 1"]);
      assert.ok(posted.some((m) => m.type === "status" && (m.payload as any).detail?.includes("Queued (1)")));
      assert.ok(posted.some((m) => m.type === "status" && (m.payload as any).detail?.includes("Queued (2)")));

      // Resolve turn 1 naturally (without abortTurn), allowing queue to drain
      finishTurn1();
      await Promise.all([p1, p2, p3]);

      assert.deepEqual(executedPrompts, ["turn 1", "turn 2", "turn 3"]);
      assert.equal(turnCoord.getQueueLength(), 0);
      assert.equal(turnCoord.isTurnActive(), false);

      // Sending a subsequent turn after previous turns finished must execute immediately (not queue!)
      await turnCoord.enqueueOrRun({ text: "turn 4" }, async (t) => {
        const sig = turnCoord.createTurnSignal();
        executedPrompts.push(t);
        turnCoord.finishTurn(sig);
      });
      assert.deepEqual(executedPrompts, ["turn 1", "turn 2", "turn 3", "turn 4"]);
      assert.equal(turnCoord.isTurnActive(), false);
    });

    it("clears queued prompts when requested", () => {
      const turnCoord = new TurnCoordinator({
        post: () => {},
        output: { appendLine: () => {} },
      });
      turnCoord.createTurnSignal();
      void turnCoord.enqueueOrRun({ text: "q1" }, async () => {});
      void turnCoord.enqueueOrRun({ text: "q2" }, async () => {});
      assert.equal(turnCoord.getQueueLength(), 2);
      turnCoord.clearQueue();
      assert.equal(turnCoord.getQueueLength(), 0);
    });
  });

  describe("CheckpointCoordinator", () => {
    it("handles rollback execution, updates session, and posts checkpointRollbackDone", async () => {
      const posted: HostMessage[] = [];
      let savedSession: SessionState | null = null;
      const mockSession: SessionState = {
        id: "sess_cp1",
        title: "Test Session",
        mode: "chat",
        model: "test-model",
        createdAt: 1000,
        updatedAt: 1000,
        messages: [
          { id: "u1", role: "user", content: "Prompt 1", createdAt: 1001 },
          { id: "a1", role: "assistant", content: "Response 1", checkpointId: "cp_1", createdAt: 1002 },
          { id: "u2", role: "user", content: "Prompt 2", createdAt: 1003 },
        ],
      };

      const indexedFiles: string[] = [];
      const removedFiles: string[] = [];
      const mockCtxMgr = {
        indexSingleFile: async (f: string) => { indexedFiles.push(f); },
        removeFile: (f: string) => { removedFiles.push(f); },
      };

      const mockCheckpointMgr = {
        beginTurn: () => {},
        recordBeforeChange: async () => {},
        commitTurn: async () => ({ id: "cp_1", checkpointNumber: 1, modifiedFilesCount: 1, files: { "file.ts": "hash" } }),
        cancelTurn: () => {},
        getCheckpoint: (id: string) => ({ id, checkpointNumber: 1 }),
        getCheckpointByNumber: (sessId: string, num: number) => (num === 1 ? { id: "cp_1", checkpointNumber: 1 } : undefined),
        getLatestCheckpoint: () => ({ id: "cp_1", checkpointNumber: 1 }),
        getSessionCheckpointSummaries: () => [{ id: "cp_1", checkpointNumber: 1, modifiedFilesCount: 1 }],
        rollbackToCheckpoint: async (id: string) => ({
          success: true,
          checkpointId: id,
          targetTurnMessageId: "u2",
          label: "Rollback to #1",
          revertedFiles: ["src/app.ts"],
          deletedFiles: ["temp.ts"],
          fileResults: [],
          errors: [],
        }),
      };

      const coord = new CheckpointCoordinator({
        getCheckpointManager: () => mockCheckpointMgr as any,
        getContextManager: () => mockCtxMgr as any,
        getSession: () => mockSession,
        post: (msg) => posted.push(msg),
        persistSession: async (s) => { savedSession = s; },
        output: { appendLine: () => {} },
        showInfo: () => {},
      });

      const success = await coord.rollbackToCheckpoint("cp_1", true);
      assert.equal(success, true);
      assert.deepEqual(indexedFiles, ["src/app.ts"]);
      assert.deepEqual(removedFiles, ["temp.ts"]);
      assert.ok(posted.some((m) => m.type === "checkpointRollbackDone"));
      assert.ok(posted.some((m) => m.type === "sessionLoaded"));
      assert.ok(savedSession !== null);

      // Revert to number with invalid argument
      const invalidRes = await coord.revertToNumber("abc");
      assert.equal(invalidRes, false);
      assert.ok(posted.some((m) => m.type === "error" && (m.payload as any).message?.includes("Invalid checkpoint number")));
    });
  });

  describe("McpCoordinator", () => {
    it("handles setup, fingerprint verification, and trust revocation", async () => {
      const posted: HostMessage[] = [];
      let toolsPushed = false;
      const connectedServers: string[] = [];
      const disconnectedServers: string[] = [];
      const serverMessages: Record<string, string> = {};

      const mockMcpManager = {
        setConfigs: async () => {},
        connect: async (id: string) => { connectedServers.push(id); },
        disconnect: async (id: string) => { disconnectedServers.push(id); },
        setServerMessage: (id: string, msg: string) => { serverMessages[id] = msg; },
        list: () => [{ id: "git", status: "connected" }],
      };

      const approvedFingerprints: Record<string, string> = { git: "fp_old" };
      const mockProjectStore = {
        pruneStaleMcpApprovals: async () => {},
        isMcpConfigApproved: (server: any) => server.id === "git_approved",
        approvedMcpFingerprints: () => approvedFingerprints,
        approveMcpConfig: async () => {},
        revokeMcpConfig: async () => {},
      };

      const mcpCoord = new McpCoordinator({
        mcpManager: mockMcpManager as any,
        projectStore: mockProjectStore as any,
        getWorkspaceRoot: () => undefined,
        post: (msg) => posted.push(msg),
        pushTools: () => { toolsPushed = true; },
        output: { appendLine: () => {} },
      });

      // Revoking server trust
      await mcpCoord.revokeMcpServer("git");
      assert.deepEqual(disconnectedServers, ["git"]);
      assert.ok(serverMessages["git"]?.includes("Server trust revoked"));
      assert.equal(toolsPushed, true);
      assert.ok(posted.some((m) => m.type === "mcpServers"));
    });
  });

  describe("ProviderService", () => {
    it("preserves active providers when rebuilding fails and reports status cleanly", async () => {
      const posted: HostMessage[] = [];
      const outputLines: string[] = [];
      const mockOllama = { id: "ollama", label: "Ollama", enabled: true, isConfigured: () => true, listModels: async () => [] };
      const manager = new ProviderManager([mockOllama as any]);

      const mockCatalog = {
        buildCloudProviders: async () => { throw new Error("Network failure during provider catalog build"); },
        buildLlamaCppProvider: async () => null,
        providerStatuses: () => [{ id: "ollama", label: "Ollama", configured: true, enabled: true }],
      };

      const service = new ProviderService({
        providers: manager,
        ollamaProvider: mockOllama as any,
        catalog: mockCatalog as any,
        post: (msg) => posted.push(msg),
        output: { appendLine: (l) => outputLines.push(l) },
      });

      await service.rebuildProviders();
      // Should preserve active provider without throwing
      assert.equal(manager.all().length, 1);
      assert.equal(manager.all()[0].id, "ollama");
      assert.ok(outputLines.some((l) => l.includes("Provider refresh failed")));

      const statuses = service.providerStatuses();
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].id, "ollama");
    });
  });
});



