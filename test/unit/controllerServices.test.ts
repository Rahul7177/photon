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
import type { ModelInfo, SessionState, ToolCall } from "../../src/shared/types";
import type { LLMProvider } from "../../src/core/llm/types";

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

    // Cap at 10 messages (excess 11 messages archived into digest)
    const compacted = enforceSessionMessageCap(session, 10);
    assert.equal(compacted, true);
    // 1 archive message + 10 retained messages = 11 messages
    assert.equal(session.messages.length, 11);
    const archiveMsg = session.messages[0];
    assert.equal(archiveMsg.role, "assistant");
    assert.equal(archiveMsg.isCompacted, true);
    assert.ok(archiveMsg.content.includes("[Context Compaction Summary]"));
    assert.ok(archiveMsg.content.includes("Initial task: build the auth and billing systems"));
    assert.ok(archiveMsg.notice?.includes("Context archived"));
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
});


