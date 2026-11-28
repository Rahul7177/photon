import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import {
  MountedTree,
  createHostDispatcher,
  getText,
  setupBrowserGlobals,
  type VNode,
} from "../helpers/reactTestRenderer";
import type { HostMessage, InitPayload, PhotonConfig } from "../../src/shared/protocol";
import type {
  CloudUsageSummary,
  CustomizationsSnapshot,
  HardwareMetrics,
  LocalRuntimeInfo,
  McpServerInfo,
  ModelInfo,
  ProjectContextSummary,
  RecommendationSet,
  SessionSummary,
} from "../../src/shared/types";

setupBrowserGlobals();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { App } = require("../../webview-ui/src/App") as typeof import("../../webview-ui/src/App");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ErrorBoundary } = require("../../webview-ui/src/components/ErrorBoundary") as typeof import("../../webview-ui/src/components/ErrorBoundary");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ErrorBanner } = require("../../webview-ui/src/components/ErrorBanner") as typeof import("../../webview-ui/src/components/ErrorBanner");

function makeBaseConfig(overrides: Partial<PhotonConfig> = {}): PhotonConfig {
  return {
    autoApprove: false,
    adaptiveEnabled: true,
    webSearchProvider: "google",
    ollamaBaseUrl: "http://localhost:11434",
    llamacppBaseUrl: "http://localhost:8080",
    numCtxOverride: 0,
    intelligence: "auto",
    autoSelectModel: false,
    indexingEnabled: true,
    embeddingModel: "nomic-embed-text",
    interfaceMode: "local",
    thinkingLevel: "auto",
    providers: [
      { id: "gemini", label: "Google Gemini", enabled: false, configured: false, modelCount: 0, requireApiKey: true, supportsLiveModels: true },
      { id: "claude", label: "Anthropic Claude", enabled: true, configured: true, modelCount: 1, requireApiKey: true, supportsLiveModels: true },
      { id: "openai", label: "OpenAI", enabled: false, configured: false, modelCount: 0, requireApiKey: true, supportsLiveModels: true },
      { id: "openrouter", label: "OpenRouter", enabled: false, configured: false, modelCount: 0, requireApiKey: true, supportsLiveModels: true },
      {
        id: "custom:lmstudio",
        label: "Custom LM Studio",
        enabled: true,
        configured: true,
        modelCount: 1,
        isCustom: true,
        baseUrl: "http://localhost:1234/v1",
        requireApiKey: false,
        supportsLiveModels: true,
      },
    ],
    projectConfig: {
      loaded: false,
      fields: [],
      modelConfigKeys: [],
    },
    fileModelConfigKeys: [],
    ...overrides,
  };
}

function makeModels(): ModelInfo[] {
  return [
    {
      name: "qwen2.5-coder:7b",
      provider: "ollama",
      tier: "medium",
      contextLength: 32768,
      sizeBytes: 4.7 * 1024 ** 3,
      toolTrained: true,
      vision: true,
      thinking: true,
      thinkingLevels: ["off", "low", "medium", "high", "xtrahigh"],
    },
    {
      name: "llama3.2:3b",
      provider: "ollama",
      tier: "small",
      contextLength: 16384,
      sizeBytes: 2.0 * 1024 ** 3,
      toolTrained: true,
      vision: false,
      thinking: false,
    },
    {
      name: "llamacpp:deepseek-r1.gguf",
      provider: "llamacpp",
      tier: "medium",
      contextLength: 32768,
      sizeBytes: 5.0 * 1024 ** 3,
      toolTrained: true,
      vision: false,
      thinking: true,
      thinkingLevels: ["off", "low", "medium", "high"],
    },
    {
      name: "claude:claude-sonnet-4",
      provider: "claude",
      tier: "large",
      contextLength: 200000,
      toolTrained: true,
      vision: true,
      thinking: true,
      thinkingLevels: ["off", "low", "medium", "high"],
    },
  ];
}

function makeRecommendations(): RecommendationSet {
  return {
    hardware: {
      totalRamBytes: 16 * 1024 ** 3,
      freeRamBytes: 10 * 1024 ** 3,
      ramBufferGb: 2,
      vramGb: 8,
      gpuName: "NVIDIA RTX 4060",
      gpuVendor: "NVIDIA",
      cpuCores: 8,
      tier: "sweet",
      label: "RTX 4060 (8 GB VRAM)",
    } as any,
    goal: "coding",
    ctxTokens: 8192,
    bestInstalledName: "qwen2.5-coder:7b",
    recommendedName: "qwen2.5-coder:7b",
    headline: "Best fit for coding on 8 GB VRAM",
    evaluatedInstalled: [
      {
        name: "qwen2.5-coder:7b",
        label: "Qwen 2.5 Coder 7B",
        sizeGb: 4.7,
        capabilities: ["coding"],
        recommended: true,
        quality: 90,
        reason: "Fits cleanly in 8 GB VRAM",
        fit: {
          mode: "gpu",
          badge: "green",
          memRequiredGb: 5.2,
          gpuGb: 5.2,
          ramGb: 0,
          label: "Fits in VRAM",
          tokPerSec: 64,
          isEstimate: true,
        },
      },
    ],
    models: [
      {
        name: "qwen2.5-coder:7b",
        label: "Qwen 2.5 Coder 7B",
        sizeGb: 4.7,
        blurb: "Fast local coding model",
        capabilities: ["coding"],
        tier: "sweet",
        installed: true,
        installedName: "qwen2.5-coder:7b",
        recommended: true,
        quality: 90,
        fit: {
          mode: "gpu",
          badge: "green",
          memRequiredGb: 5.2,
          gpuGb: 5.2,
          ramGb: 0,
          label: "Fits in VRAM",
          tokPerSec: 64,
          isEstimate: true,
        },
      },
      {
        name: "qwen3:8b",
        label: "Qwen 3 8B",
        sizeGb: 5.4,
        blurb: "Reasoning & coding",
        capabilities: ["coding", "reasoning"],
        tier: "sweet",
        installed: false,
        recommended: false,
        quality: 88,
        fit: {
          mode: "gpu",
          badge: "green",
          memRequiredGb: 5.8,
          gpuGb: 5.8,
          ramGb: 0,
          label: "Fits in VRAM",
          tokPerSec: 52,
          isEstimate: true,
        },
      },
    ],
  };
}

function makeProjectContext(): ProjectContextSummary {
  return {
    workspaceName: "Photon",
    totalFiles: 42,
    totalSymbols: 310,
    totalLines: 4500,
    lastUpdatedAt: Date.now(),
    languages: ["TypeScript"],
    frameworks: ["React", "VS Code API"],
    scripts: { test: "tsx --test", build: "node esbuild.mjs" },
    entryPoints: ["src/extension.ts"],
    topDirectories: [{ path: "src/host", fileCount: 12, purpose: "Extension host & controller" }],
    recentFiles: [
      {
        path: "src/host/PhotonController.ts",
        summary: "Main controller",
        lineCount: 2800,
        symbolCount: 45,
        lastAction: "edited",
        timestamp: Date.now(),
      },
    ],
    notes: [
      {
        id: "note-1",
        category: "architecture",
        title: "Keep protocol typed",
        content: "Sync ViewMessage and HostMessage.",
        createdBy: "user",
        updatedAt: Date.now(),
      },
    ],
    latestHandoff: {
      fromModel: "claude:claude-sonnet-4",
      toModel: "qwen2.5-coder:7b",
      timestamp: Date.now(),
      taskSummary: "QA full UI wiring",
      activeFiles: ["src/host/PhotonController.ts"],
      recentEdits: [{ path: "webview-ui/src/App.tsx", summary: "Reviewed handlers", timestamp: Date.now() }],
      pendingTodos: ["Run tests"],
      keyFindings: ["All typed"],
    },
    estimatedTokensSaved: 18500,
    queryHits: 7,
  };
}

function makeCustomizations(): CustomizationsSnapshot {
  return {
    skills: [
      {
        id: "skill-1",
        slug: "qa-audit",
        name: "QA Audit",
        description: "Run thorough UI & host QA checks",
        content: "Check every button and handler.",
        scope: "workspace",
        filePath: "/workspace/.photon/skills/qa-audit/SKILL.md",
        relPath: ".photon/skills/qa-audit/SKILL.md",
        enabled: true,
      },
    ],
    instructions: [
      {
        id: "inst-1",
        slug: "ts-strict",
        name: "Strict TypeScript",
        applyTo: "**/*.ts",
        content: "Avoid any casts where possible.",
        scope: "user",
        filePath: "/home/.photon/instructions/ts-strict.instructions.md",
        relPath: "ts-strict.instructions.md",
        enabled: true,
      },
    ],
    agents: [
      {
        id: "agent-1",
        slug: "reviewer",
        name: "Code Reviewer",
        description: "Focuses on bugs and regressions",
        instructions: "Review carefully before approval.",
        preferredMode: "plan",
        scope: "workspace",
        filePath: "/workspace/.photon/agents/reviewer.agent.md",
        relPath: ".photon/agents/reviewer.agent.md",
        enabled: true,
      },
    ],
    activeAgentId: "agent-1",
  };
}

function makeMcpServers(): McpServerInfo[] {
  return [
    {
      id: "filesystem",
      transport: "stdio",
      target: "npx -y @modelcontextprotocol/server-filesystem .",
      status: "pending",
      toolCount: 0,
      fingerprint: "fp-fs-1",
      scope: "workspace",
      sourcePath: "/workspace/.vscode/mcp.json",
    },
    {
      id: "docs-http",
      transport: "http",
      target: "https://mcp.example.com/sse",
      status: "connected",
      toolCount: 4,
      fingerprint: "fp-http-1",
      scope: "user",
      sourcePath: "/home/.photon/mcp.json",
    },
  ];
}

function makeRuntimes(): LocalRuntimeInfo[] {
  return [
    {
      id: "ollama",
      label: "Ollama",
      state: "installed_stopped",
      port: 11434,
      baseUrl: "http://127.0.0.1:11434",
      version: "0.5.7",
    },
    {
      id: "llamacpp",
      label: "llama.cpp",
      state: "port_conflict",
      port: 8080,
      baseUrl: "http://127.0.0.1:8080",
      portOwner: { pid: 1234, processName: "other" },
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      state: "not_installed",
      port: 1234,
      baseUrl: "http://127.0.0.1:1234",
      installOptions: [{ label: "Install LM Studio", kind: "url", value: "https://lmstudio.ai" }],
    },
  ];
}

function makeInitPayload(overrides: Partial<InitPayload> = {}): InitPayload {
  const models = makeModels();
  const sessions: SessionSummary[] = [
    { id: "sess-1", title: "Alpha Bugfix", mode: "agent", model: "qwen2.5-coder:7b", updatedAt: Date.now() - 1000, messageCount: 2, pinned: false },
    { id: "sess-2", title: "Architecture Plan", mode: "plan", model: "claude:claude-sonnet-4", updatedAt: Date.now() - 2000, messageCount: 4, pinned: true, pinnedAt: 10 },
    { id: "sess-3", title: "Quick Chat", mode: "chat", model: "llama3.2:3b", updatedAt: Date.now() - 3000, messageCount: 1, pinned: true, pinnedAt: 20 },
    { id: "sess-4", title: "Release QA", mode: "agent", model: "qwen2.5-coder:7b", updatedAt: Date.now() - 4000, messageCount: 5, pinned: true, pinnedAt: 30 },
    { id: "sess-5", title: "Unpinned Fifth", mode: "chat", model: "llama3.2:3b", updatedAt: Date.now() - 5000, messageCount: 1, pinned: false },
  ];

  return {
    session: {
      id: "sess-1",
      title: "Alpha Bugfix",
      mode: "agent",
      model: "qwen2.5-coder:7b",
      messages: [],
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      usage: {
        used: 3200,
        window: 32768,
        breakdown: [
          { label: "System", tokens: 1200 },
          { label: "History", tokens: 2000 },
        ],
      },
    },
    sessions,
    models,
    selectedModel: "qwen2.5-coder:7b",
    mode: "agent",
    machine: {
      totalRamBytes: 16 * 1024 ** 3,
      freeRamBytes: 8 * 1024 ** 3,
      cpuCores: 8,
      cpuModel: "Ryzen 7",
      platform: "win32",
      arch: "x64",
      gpu: { name: "NVIDIA RTX 4060", vramBytes: 8 * 1024 ** 3, vendor: "NVIDIA" },
      tier: "mid",
    },
    plan: {
      model: "qwen2.5-coder:7b",
      mode: "agent",
      contextWindow: 32768,
      numCtx: 8192,
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 2048,
      toolProtocol: "native",
      maxTools: 16,
      allowParallelTools: true,
      intelligence: "high",
      intelligenceAuto: true,
      rationale: ["Balanced for 8 GB VRAM"],
    },
    ollamaReachable: true,
    config: makeBaseConfig(),
    tools: [
      { name: "read_file", summary: "Read file contents", sideEffecting: false },
      { name: "write_file", summary: "Write file to disk", sideEffecting: true },
      { name: "run_command", summary: "Execute shell command", sideEffecting: true },
    ],
    benchResults: [
      {
        model: "qwen2.5-coder:7b",
        hardwareClass: "8gb-vram",
        methodologyVersion: 2,
        tokensPerSec: 64,
        firstTokenMs: 140,
        toolCallReliability: 0.95,
        reasoningPass: true,
        tasks: [{ id: "throughput", passed: true, detail: "64 tok/s" }],
        ranAt: Date.now(),
      },
    ],
    indexStatus: { phase: "ready", filesIndexed: 42, chunks: 180, pending: 0, embeddingModel: "nomic-embed-text" },
    mcpServers: makeMcpServers(),
    modelConfigs: {
      "qwen2.5-coder:7b": { numCtx: 8192, sampling: { temp: 0.2 }, note: "Default coding" },
    },
    ollamaRuntime: [
      { name: "qwen2.5-coder:7b", sizeBytes: 4.7 * 1024 ** 3, vramBytes: 4.7 * 1024 ** 3, gpuPercent: 100, contextLength: 8192 },
    ],
    hardwareMetrics: {
      gpuName: "NVIDIA RTX 4060",
      gpuUtilPercent: 42,
      vramUsedBytes: 4.7 * 1024 ** 3,
      vramTotalBytes: 8 * 1024 ** 3,
      vramFreeBytes: 3.3 * 1024 ** 3,
      gpuTempC: 58,
      ramUsedBytes: 8 * 1024 ** 3,
      ramTotalBytes: 16 * 1024 ** 3,
      ramFreeBytes: 8 * 1024 ** 3,
      ramUsedPercent: 50,
      updatedAt: Date.now(),
    } as HardwareMetrics,
    cloudUsage: {
      sessionInputTokens: 2500,
      sessionOutputTokens: 800,
      sessionCachedTokens: 1000,
      sessionSavedTokens: 1000,
      sessionEstimatedCostUsd: 0.012,
      totalInputTokens: 12000,
      totalOutputTokens: 4000,
      totalCachedTokens: 5000,
      totalSavedTokens: 5000,
      totalEstimatedCostUsd: 0.056,
      byModel: [
        { model: "claude:claude-sonnet-4", turns: 3, inputTokens: 12000, outputTokens: 4000, cachedTokens: 5000, savedTokens: 5000, estimatedCostUsd: 0.056 },
      ],
    } as CloudUsageSummary,
    projectContext: makeProjectContext(),
    customizations: makeCustomizations(),
    showOnboarding: false,
    ...overrides,
  };
}

function mountApp(initOverrides: Partial<InitPayload> = {}, extraHostMessages: HostMessage[] = []) {
  const { env, posted, sendHost } = createHostDispatcher();
  const tree = new MountedTree(() =>
    React.createElement(ErrorBoundary, null, React.createElement(App))
  );
  // App posts ready on mount
  assert.ok(posted.some((m) => m.type === "ready"), "App should post 'ready' on mount");
  posted.length = 0;

  sendHost({ type: "init", payload: makeInitPayload(initOverrides) }, tree);
  for (const m of extraHostMessages) sendHost(m, tree);
  return { env, posted, sendHost, tree };
}

describe("Complete UI & Every-Button E2E Suite", () => {
  it("1. OnboardingModal covers Step 1, Step 2A Local, Step 2B Cloud, Custom Endpoint, and Skip/Finish", async () => {
    const { posted, sendHost, tree } = mountApp({ showOnboarding: true, ollamaReachable: false });
    try {
      sendHost({ type: "providerRuntimes", payload: makeRuntimes() }, tree);
      sendHost({ type: "modelRecommendations", payload: makeRecommendations() }, tree);

      assert.ok(tree.findByClass("onboarding-modal"), "Onboarding modal visible");

      // Step 1 -> Local Model Provider
      tree.click(tree.findButton(/Set Up Local Models/));
      assert.ok(posted.some((m) => m.type === "setInterfaceMode" && m.payload.mode === "local"));
      assert.ok(posted.some((m) => m.type === "detectProviders"));
      assert.ok(posted.some((m) => m.type === "refreshModels"));
      assert.ok(posted.some((m) => m.type === "requestRecommendations"));

      posted.length = 0;
      // Start stopped Ollama runtime
      tree.click(tree.findButton("Start"));
      assert.deepEqual(posted.find((m) => m.type === "startProvider"), { type: "startProvider", payload: { id: "ollama", modelPath: undefined } });

      // Install missing LM Studio runtime
      tree.click(tree.findButton("Install LM Studio"));
      assert.deepEqual(posted.find((m) => m.type === "installProvider"), { type: "installProvider", payload: { id: "lmstudio", optionIndex: 0 } });

      // Capability goal filter chips
      for (const goalLabel of ["Reasoning", "Vision", "Fast", "Coding"] as const) {
        posted.length = 0;
        tree.click(tree.findButton(goalLabel));
        assert.ok(posted.some((m) => m.type === "requestRecommendations"));
      }

      // Change selectedModel away so "Use Recommended" and "Select Model" render
      sendHost({ type: "models", payload: { models: makeModels(), selected: "llama3.2:3b", ollamaReachable: true } }, tree);
      posted.length = 0;
      tree.click(tree.findButton("Use Recommended"));
      assert.deepEqual(posted.find((m) => m.type === "setModel"), { type: "setModel", payload: { model: "qwen2.5-coder:7b" } });

      // Toggle downloadable catalog open & click Download & Use
      tree.click(tree.findButton("Browse More Hardware-Recommended Models to Download"));
      posted.length = 0;
      tree.click(tree.findButton("Download & Use"));
      assert.deepEqual(posted.find((m) => m.type === "pullModel"), { type: "pullModel", payload: { model: "qwen3:8b" } });

      // Back to Step 1
      tree.click(tree.findButton("Back"));
      assert.ok(tree.findButton(/Set Up Cloud Providers/));

      // Step 1 -> Cloud Model Providers
      posted.length = 0;
      tree.click(tree.findButton(/Set Up Cloud Providers/));
      assert.ok(posted.some((m) => m.type === "setInterfaceMode" && m.payload.mode === "cloud"));

      // Select Google Gemini chip, enter API key, click Save Key & Fetch Models
      tree.click(tree.findButton(/Google Gemini/));
      const keyInput = tree.findByPlaceholder("Enter Google Gemini API key…");
      tree.change(keyInput, "AIzaSyMockKeyForTesting1234567890");
      posted.length = 0;
      tree.click(tree.findButton("Save Key & Fetch Models"));
      assert.deepEqual(posted.find((m) => m.type === "setProviderApiKey"), {
        type: "setProviderApiKey",
        payload: { id: "gemini", apiKey: "AIzaSyMockKeyForTesting1234567890" },
      });

      // Switch to configured Anthropic Claude chip, fetch models, Auto-Ping, filter, manual Ping, Select & Use
      tree.click(tree.findButton(/Anthropic Claude/));
      const cloudModels: ModelInfo[] = [
        { name: "claude:claude-3-5-haiku", provider: "claude", toolTrained: true },
        { name: "claude:claude-sonnet-4", provider: "claude", toolTrained: true, vision: true },
      ];
      sendHost({ type: "providerModels", payload: { id: "claude", models: cloudModels } }, tree);

      posted.length = 0;
      tree.click(tree.findButton("Fetch Models"));
      assert.deepEqual(posted.find((m) => m.type === "fetchProviderModels"), {
        type: "fetchProviderModels",
        payload: { id: "claude" },
      });

      posted.length = 0;
      tree.click(tree.findButton("Auto-Ping Models"));
      await tree.tick(20);
      assert.equal(posted.filter((m) => m.type === "testModel").length, 2, "Auto-Ping should test both models");
      for (const m of cloudModels) {
        sendHost({ type: "modelTestResult", payload: { providerId: "claude", model: m, ok: true, latencyMs: 35 } }, tree);
      }

      const filterInput = tree.findByPlaceholder(/Filter 2 Anthropic Claude models/);
      tree.change(filterInput, "haiku");
      posted.length = 0;
      tree.click(tree.findButton("Ping"));
      assert.equal(posted.filter((m) => m.type === "testModel").length, 1);

      posted.length = 0;
      tree.click(tree.findButton("Select & Use"));
      assert.ok(posted.some((m) => m.type === "addAvailableModel"));
      assert.ok(posted.some((m) => m.type === "setModel" && m.payload.model === "claude:claude-3-5-haiku"));

      // Custom endpoint flow in onboarding
      tree.click(tree.findButton("+ Custom Endpoint"));
      tree.click(tree.findButton("Groq"));
      const nameInput = tree.findByPlaceholder(/Provider Name/);
      const urlInput = tree.findByPlaceholder(/Base URL/);
      tree.change(nameInput, "Groq Cloud");
      tree.change(urlInput, "https://api.groq.com/openai/v1");
      posted.length = 0;
      tree.click(tree.findButton("Connect & Fetch Models"));
      assert.deepEqual(posted.find((m) => m.type === "addCustomProvider"), {
        type: "addCustomProvider",
        payload: {
          label: "Groq Cloud",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey: undefined,
          requireApiKey: true,
        },
      });

      // Top Skip & Footer Finish
      posted.length = 0;
      tree.click(tree.findButton("Skip"));
      assert.ok(posted.some((m) => m.type === "completeOnboarding"));

      sendHost({ type: "onboardingStatus", payload: { show: true } }, tree);
      posted.length = 0;
      tree.click(tree.findByClass("onboarding-finish-btn", "button"));
      assert.ok(posted.some((m) => m.type === "completeOnboarding"));
    } finally {
      tree.unmount();
    }
  });

  it("2. Header, TransparencyPanel, SessionHistory (search, filters, rename, pin limit, 2-step delete), and pull cancel pill", async () => {
    const { posted, sendHost, tree } = mountApp();
    try {
      // Handoff dot in header when latestHandoff.fromModel !== selectedModel
      assert.ok(tree.findByClass("ctx-handoff-dot"), "Cross-model handoff dot should show in header");

      // Header pull cancel pill
      sendHost({ type: "pullProgress", payload: { model: "qwen3:8b", phase: "pulling", status: "downloading", percent: 45 } }, tree);
      posted.length = 0;
      tree.click(tree.findByClass("header-pull-cancel", "button"));
      assert.ok(posted.some((m) => m.type === "cancelPull"));
      sendHost({ type: "pullProgress", payload: null }, tree);

      // TransparencyPanel via Lightbulb button
      sendHost({ type: "config", payload: makeBaseConfig({ autoSelectModel: true }) }, tree);
      sendHost({
        type: "decision",
        payload: {
          chosenModel: "qwen2.5-coder:7b",
          auto: true,
          pinned: false,
          complexity: { level: "moderate", minContextTokens: 8192, signals: { filesReferenced: 2, estimatedSteps: 2, keywords: ["refactor"], promptTokens: 20 } },
          reason: "Best coding match",
          scores: [
            { model: "qwen2.5-coder:7b", score: 95, fits: true, reasons: ["VRAM fit"] },
            { model: "llama3.2:3b", score: 78, fits: false, reasons: ["Smaller"] },
          ],
        },
      }, tree);

      tree.click(tree.findByAriaLabel("Inspect auto-routing model selection", "button"));
      assert.ok(tree.findByClass("transparency"));
      posted.length = 0;
      tree.click(tree.findButton("Pin"));
      assert.deepEqual(posted.find((m) => m.type === "pinModel"), { type: "pinModel", payload: { model: "llama3.2:3b" } });
      posted.length = 0;
      const autoSwitch = tree.findAll((n) => n.tag === "button" && n.props.role === "switch")[0];
      tree.click(autoSwitch);
      assert.deepEqual(posted.find((m) => m.type === "setAutoSelect"), { type: "setAutoSelect", payload: { enabled: false } });

      // SessionHistory popover
      tree.click(tree.findByAriaLabel("Session history", "button"));
      assert.ok(tree.findByClass("history-pop"));

      // Filter tabs & search clear & Reset filters
      const searchInput = tree.findByClass("history-search-input");
      tree.change(searchInput, "nonexistent-xyz");
      assert.ok(tree.findButton("Reset filters"));
      tree.click(tree.findByAriaLabel("Clear filter", "button"));
      assert.equal(tree.findAllByClass("history-row").length, 5);

      for (const tabText of [/^Pinned/, /^Agent$/, /^Plan$/, /^Chat$/, /^All/]) {
        tree.click(tree.findByText(tabText, "button"));
      }

      // Empty query + Reset filters check when filter = "Chat" & search misses
      tree.click(tree.findByText(/^Chat$/, "button"));
      tree.change(tree.findByClass("history-search-input"), "zzz");
      tree.click(tree.findButton("Reset filters"));
      assert.equal(tree.findAllByClass("history-row").length, 5);

      // Pin cap: 3 sessions are already pinned, so unpinned session's pin button is disabled
      const pinButtons = tree.findAll((n) => n.tag === "button" && n.props["aria-label"] === "Pin conversation");
      assert.ok(pinButtons.length >= 1);
      assert.equal(pinButtons[0].props.disabled, true, "4th unpinned session cannot be pinned beyond MAX_PINNED_CHATS");

      // Unpin a pinned session works
      posted.length = 0;
      tree.click(tree.findAll((n) => n.tag === "button" && n.props["aria-label"] === "Unpin conversation")[0]);
      assert.ok(posted.some((m) => m.type === "togglePinSession"));

      // Rename via Escape cancel then Enter commit
      const renameBtn = tree.findAll((n) => n.tag === "button" && n.props["aria-label"] === "Rename conversation")[0];
      tree.click(renameBtn);
      const renameInput = tree.findByClass("history-rename-input");
      tree.change(renameInput, "Ignored Name");
      tree.keyDown(renameInput, { key: "Escape" });
      assert.equal(tree.findAllByClass("history-rename-input").length, 0);

      // Double-click title to rename & commit with Enter
      tree.doubleClick(tree.findAllByClass("history-title")[0]);
      const renameInput2 = tree.findByClass("history-rename-input");
      tree.change(renameInput2, "Renamed Alpha");
      posted.length = 0;
      tree.keyDown(renameInput2, { key: "Enter" });
      assert.ok(posted.some((m) => m.type === "renameSession" && m.payload.title === "Renamed Alpha"));

      // 2-step Delete confirmation
      const delBtn = tree.findAll((n) => n.tag === "button" && n.props.className?.includes("history-delete"))[0];
      posted.length = 0;
      tree.click(delBtn);
      assert.equal(posted.filter((m) => m.type === "deleteSession").length, 0, "First click only arms delete");
      const confirmDelBtn = tree.findAll((n) => n.tag === "button" && n.props.className?.includes("history-delete confirming"))[0];
      tree.click(confirmDelBtn);
      assert.equal(posted.filter((m) => m.type === "deleteSession").length, 1, "Second click deletes session");

      // New button inside SessionHistory closes popover & starts new session
      posted.length = 0;
      tree.click(tree.findByClass("history-new-btn", "button"));
      assert.ok(posted.some((m) => m.type === "newSession"));

      // Reopen history and click a row to switchSession
      tree.click(tree.findByAriaLabel("Session history", "button"));
      posted.length = 0;
      tree.click(tree.findAllByClass("history-row")[1]);
      assert.ok(posted.some((m) => m.type === "switchSession"));

      // Header '+' button and Gear button and Brain button
      posted.length = 0;
      tree.click(tree.findByAriaLabel("Start new session", "button"));
      assert.ok(posted.some((m) => m.type === "newSession"));

      posted.length = 0;
      tree.click(tree.findByClass("ctx-header-btn", "button"));
      assert.ok(posted.some((m) => m.type === "requestProjectContext"));
      assert.ok(tree.findByAriaLabel("Project Context and Memory"));
      tree.click(tree.findByAriaLabel("Close Project Context modal", "button"));

      tree.click(tree.findByAriaLabel("Settings and Providers", "button"));
      assert.ok(tree.findByClass("settings"));
    } finally {
      tree.unmount();
    }
  });

  it("3. Hero suggestion cards send expected prompts", async () => {
    const { posted, tree } = mountApp();
    try {
      const suggestions = tree.findAllByClass("hero-suggestion-item", "button");
      assert.equal(suggestions.length, 3);
      const expectedPrompts = [
        "Explain project architecture & key files",
        "Find potential bugs and edge cases",
        "Help me refactor and optimize code",
      ];
      for (let i = 0; i < expectedPrompts.length; i++) {
        posted.length = 0;
        tree.click(tree.findAllByClass("hero-suggestion-item", "button")[i]);
        assert.deepEqual(posted[0], { type: "sendPrompt", payload: { text: expectedPrompts[i], attachments: undefined } });
      }
    } finally {
      tree.unmount();
    }
  });

  it("4. Composer covers ModeDropdown, Local/Cloud toggle, ModelDropdown, Tuning Popover, ContextWarningModal, Attachments, Paste, Drag/Drop, Slash Menu, Agent Bar, Send & Stop", async () => {
    const { posted, sendHost, tree } = mountApp({ mode: "chat" });
    sendHost({ type: "modelRecommendations", payload: makeRecommendations() }, tree);
    try {
      // ModeDropdown
      tree.click(tree.findByClass("mode-dropdown-trigger", "button"));
      posted.length = 0;
      tree.click(tree.findButton(/PlanInteractive plan/i));
      assert.deepEqual(posted.find((m) => m.type === "setMode"), { type: "setMode", payload: { mode: "plan" } });

      tree.click(tree.findByClass("mode-dropdown-trigger", "button"));
      posted.length = 0;
      tree.click(tree.findButton(/AgentEdits & commands/i));
      assert.deepEqual(posted.find((m) => m.type === "setMode"), { type: "setMode", payload: { mode: "agent" } });

      // ModelDropdown: Auto-Select, Installed Local, Uninstalled Install Prompt (Cancel + Install Now), Cloud model
      tree.click(tree.findByClass("model-dropdown-trigger", "button"));
      posted.length = 0;
      tree.click(tree.findButton(/Auto-Select/));
      assert.deepEqual(posted.find((m) => m.type === "setAutoSelect"), { type: "setAutoSelect", payload: { enabled: true } });

      tree.click(tree.findByClass("model-dropdown-trigger", "button"));
      posted.length = 0;
      tree.click(tree.findButton(/llama3\.2:3b/));
      assert.deepEqual(posted.find((m) => m.type === "setModel"), { type: "setModel", payload: { model: "llama3.2:3b" } });

      // Uninstalled recommended model triggers confirm banner when no local models are installed -> test Cancel then Install Now
      const cloudOnly = makeModels().filter((m) => m.provider === "claude");
      sendHost({ type: "models", payload: { models: cloudOnly, selected: "" } }, tree);
      tree.click(tree.findByClass("model-dropdown-trigger", "button"));
      tree.click(tree.findButton(/\+ qwen3:8b/));
      assert.ok(tree.findByClass("model-install-prompt-banner"));
      tree.click(tree.findButton("Cancel"));
      assert.equal(tree.findAllByClass("model-install-prompt-banner").length, 0);

      tree.click(tree.findByClass("model-dropdown-trigger", "button"));
      tree.click(tree.findButton(/\+ qwen3:8b/));
      posted.length = 0;
      tree.click(tree.findButton("Install Now"));
      assert.deepEqual(posted.find((m) => m.type === "pullModel"), { type: "pullModel", payload: { model: "qwen3:8b" } });
      sendHost({ type: "models", payload: { models: makeModels(), selected: "llama3.2:3b" } }, tree);

      // Switch to Cloud interface mode and select Cloud model
      posted.length = 0;
      tree.click(tree.findButton("Cloud"));
      assert.deepEqual(posted.find((m) => m.type === "setInterfaceMode"), { type: "setInterfaceMode", payload: { mode: "cloud" } });
      sendHost({ type: "config", payload: makeBaseConfig({ interfaceMode: "cloud" }) }, tree);
      tree.click(tree.findByClass("model-dropdown-trigger", "button"));
      posted.length = 0;
      tree.click(tree.findButton("claude-sonnet-4"));
      assert.deepEqual(posted.find((m) => m.type === "setModel"), { type: "setModel", payload: { model: "claude:claude-sonnet-4" } });

      // Back to Local vision model with thinkingLevels
      sendHost({ type: "config", payload: makeBaseConfig({ interfaceMode: "local" }) }, tree);
      sendHost({ type: "models", payload: { models: makeModels(), selected: "qwen2.5-coder:7b", ollamaReachable: true } }, tree);

      // Tuning Popover
      tree.click(tree.findByClass("ctx-icon-trigger", "button"));
      assert.ok(tree.findByClass("tuning-popover"));

      posted.length = 0;
      tree.click(tree.findByAriaLabel("Refresh available models", "button"));
      assert.ok(posted.some((m) => m.type === "refreshModels"));

      posted.length = 0;
      tree.click(tree.findByClass("ctx-compact-btn", "button"));
      assert.ok(posted.some((m) => m.type === "compactContext"));

      // Reopen tuning popover -> Telemetry button
      tree.click(tree.findByClass("ctx-icon-trigger", "button"));
      tree.click(tree.findByClass("hw-chart-btn", "button"));
      assert.ok(tree.findByAriaLabel("Hardware & Telemetry".slice(0, 8)) || tree.findByClass("hw-modal"));
      tree.click(tree.findByAriaLabel("Close Hardware and Telemetry modal", "button"));

      // Reopen tuning popover -> Context Limit safe + overflow ContextWarningModal -> Reasoning select -> Close
      tree.click(tree.findByClass("ctx-icon-trigger", "button"));
      const ctxSelect = tree.findOne((n) => n.tag === "select" && n.props.id === "photon-ctx-limit-select");
      posted.length = 0;
      tree.change(ctxSelect, "8192");
      assert.deepEqual(posted.find((m) => m.type === "setContextWindow"), { type: "setContextWindow", payload: { numCtx: 8192 } });

      // Overflow triggers ContextWarningModal on 131072 for 8GB VRAM / 16GB RAM machine
      tree.change(ctxSelect, "131072");
      assert.ok(tree.findByClass("ctx-warn-modal"));
      tree.click(tree.findButton("Keep Selection"));
      assert.equal(tree.findAllByClass("ctx-warn-modal").length, 0);

      tree.change(ctxSelect, "131072");
      assert.ok(tree.findByClass("ctx-warn-modal"));
      posted.length = 0;
      tree.click(tree.findButton(/Use Recommended/));
      assert.ok(posted.some((m) => m.type === "setContextWindow"));

      const reasonSelect = tree.findOne((n) => n.tag === "select" && n.props.id === "photon-reasoning-select");
      posted.length = 0;
      tree.change(reasonSelect, "high");
      assert.deepEqual(posted.find((m) => m.type === "setThinkingSetting"), { type: "setThinkingSetting", payload: { level: "high" } });

      tree.click(tree.findByAriaLabel("Close context and runtime popover", "button"));
      assert.equal(tree.findAllByClass("tuning-popover").length, 0);

      // File Input Attachment & Remove Chip
      const fileInput = tree.findOne((n) => n.tag === "input" && n.props.type === "file");
      tree.change(fileInput, "", {
        files: [{ name: "snippet.ts", type: "text/plain", size: 12, _content: "const x = 1;" }],
      });
      await tree.tick(20);
      assert.equal(tree.findAllByClass("attach-chip").length, 1);
      tree.click(tree.findByClass("attach-remove", "button"));
      assert.equal(tree.findAllByClass("attach-chip").length, 0);

      // Clipboard Paste Image (vision model succeeds, non-vision rejects)
      const textarea = tree.findOne((n) => n.tag === "textarea");
      const mockPngFile = { name: "screen.png", type: "image/png", size: 100, _content: "png-bytes" };
      tree.paste(textarea, {
        items: [{ kind: "file", getAsFile: () => mockPngFile }],
        files: [mockPngFile],
      });
      await tree.tick(20);
      assert.equal(tree.findAllByClass("attach-chip").length, 1);
      tree.click(tree.findByClass("attach-remove", "button"));

      // Non-vision rejects image paste
      sendHost({ type: "models", payload: { models: makeModels(), selected: "llama3.2:3b", ollamaReachable: true } }, tree);
      tree.paste(tree.findOne((n) => n.tag === "textarea"), {
        items: [{ kind: "file", getAsFile: () => mockPngFile }],
        files: [mockPngFile],
      });
      await tree.tick(20);
      assert.ok(tree.findByClass("attach-error"));

      // Switch back to vision model
      sendHost({ type: "models", payload: { models: makeModels(), selected: "qwen2.5-coder:7b", ollamaReachable: true } }, tree);

      // Drag Enter / Leave / Drop (resourceurls + empty error diagnostic) + host attachmentsAdded
      const appDiv = tree.findByClass("app", "div");
      tree.dragEnter(appDiv, { types: ["resourceurls"] });
      assert.ok(tree.findByText("Drop files to attach as context"));
      tree.dragLeave(appDiv);
      assert.equal(tree.findAllByClass("drop-overlay").length, 0);

      posted.length = 0;
      tree.drop(appDiv, {
        types: ["resourceurls"],
        files: [],
        getData: (fmt: string) => (fmt === "resourceurls" ? JSON.stringify(["file:///b:/Photon/README.md"]) : ""),
      });
      assert.deepEqual(posted.find((m) => m.type === "attachPaths"), {
        type: "attachPaths",
        payload: { paths: ["file:///b:/Photon/README.md"] },
      });

      sendHost({
        type: "attachmentsAdded",
        payload: {
          attachments: [{ id: "att-h1", kind: "text", name: "README.md", mime: "text/plain", size: 100, text: "# Hi" }],
          errors: [],
        },
      }, tree);
      assert.equal(tree.findAllByClass("attach-chip").length, 1);

      // Empty drop shows diagnostic
      tree.drop(appDiv, { types: ["text/plain"], files: [], getData: () => "not a path" });
      assert.ok(tree.findByClass("attach-error"));

      // Customizations feature hidden: active custom agent bar must not render even if snapshot has activeAgentId
      assert.equal(tree.findAllByClass("composer-agent-bar").length, 0);

      // Slash Command Menu: navigation, /compact, /rewind, /revert, /revert 2 (customization commands hidden)
      const ta = tree.findOne((n) => n.tag === "textarea");
      tree.change(ta, "/");
      assert.ok(tree.findByClass("slash-menu-popover"));
      assert.equal(tree.findAllByClass("slash-menu-item", "button").length, 3);
      assert.equal(tree.findAllByText("/mcp", "button").length, 0);
      assert.equal(tree.findAllByText("/skills", "button").length, 0);
      assert.equal(tree.findAllByText("/customizations", "button").length, 0);
      tree.keyDown(ta, { key: "ArrowDown" });
      tree.keyDown(ta, { key: "ArrowUp" });
      tree.keyDown(ta, { key: "Escape" });
      assert.equal(tree.findAllByClass("slash-menu-popover").length, 0);

      tree.change(ta, "/comp");
      posted.length = 0;
      tree.keyDown(tree.findOne((n) => n.tag === "textarea"), { key: "Enter" });
      assert.ok(posted.some((m) => m.type === "compactContext"));

      tree.change(tree.findOne((n) => n.tag === "textarea"), "/rew");
      posted.length = 0;
      tree.click(tree.findByText("/rewind", "button"));
      assert.deepEqual(posted.find((m) => m.type === "sendPrompt"), { type: "sendPrompt", payload: { text: "/rewind", attachments: undefined } });

      tree.change(tree.findOne((n) => n.tag === "textarea"), "/rev");
      posted.length = 0;
      tree.click(tree.findByText("/revert", "button"));
      assert.ok(posted.some((m) => m.type === "getCheckpoints"));
      assert.ok(tree.findByClass("revert-modal"));
      tree.click(tree.findByAriaLabel("Close Revert to Checkpoint modal", "button"));

      // Explicit /revert 2 Enter submit
      tree.change(tree.findOne((n) => n.tag === "textarea"), "/revert 2");
      posted.length = 0;
      tree.keyDown(tree.findOne((n) => n.tag === "textarea"), { key: "Enter" });
      assert.deepEqual(posted.find((m) => m.type === "revertToNumber"), { type: "revertToNumber", payload: { checkpointNumber: 2 } });

      // Shift+Enter does NOT send; Enter / Send button sends; Stop button cancels when running
      const taSend = tree.findOne((n) => n.tag === "textarea");
      tree.change(taSend, "Hello Photon QA");
      posted.length = 0;
      tree.keyDown(tree.findOne((n) => n.tag === "textarea"), { key: "Enter", shiftKey: true });
      assert.equal(posted.filter((m) => m.type === "sendPrompt").length, 0);

      tree.click(tree.findByClass("send-btn", "button"));
      const sendMsg = posted.find((m) => m.type === "sendPrompt");
      assert.ok(sendMsg && sendMsg.type === "sendPrompt" && sendMsg.payload.text === "Hello Photon QA");

      sendHost({ type: "status", payload: { kind: "running", detail: "Working..." } }, tree);
      posted.length = 0;
      tree.click(tree.findByClass("send-btn", "button"));
      assert.ok(posted.some((m) => m.type === "cancel"));
    } finally {
      tree.unmount();
    }
  });

  it("5. SettingsPanel covers Header, General tab (Theme, Intelligence, Adaptive, Context, ProjectConfig states), Models tab (Unload, Scan, Catalog, ModelConfigs, Benchmarks)", async () => {
    const { env, posted, sendHost, tree } = mountApp();
    try {
      tree.click(tree.findByAriaLabel("Settings and Providers", "button"));

      // Settings Header: Setup Wizard + Back
      posted.length = 0;
      tree.click(tree.findButton("Setup Wizard"));
      assert.ok(posted.some((m) => m.type === "openOnboarding"));
      sendHost({ type: "onboardingStatus", payload: { show: false } }, tree);

      // Reopen Settings
      tree.click(tree.findByAriaLabel("Settings and Providers", "button"));

      // General Tab: Appearance Themes
      tree.click(tree.findButton("Soft Dark"));
      assert.equal(env.storage.get("photon.theme"), "dark");
      assert.equal(env.bodyDataset.theme, "dark");

      tree.click(tree.findButton("Soft Light"));
      assert.equal(env.storage.get("photon.theme"), "light");
      assert.equal(env.bodyDataset.theme, "light");

      tree.click(tree.findButton("Auto (VS Code)"));
      assert.equal(env.storage.get("photon.theme"), "auto");

      // General Tab: Adaptive Scaffolding + Adaptive Engine toggle
      for (const [label, level] of [
        [/^Max$/, "max"],
        [/^High$/, "high"],
        [/^Balanced$/, "medium"],
        [/^Minimal$/, "low"],
        [/^Auto$/, "auto"],
      ] as const) {
        posted.length = 0;
        tree.click(tree.findAllByText(label, "button")[0]);
        assert.deepEqual(posted.find((m) => m.type === "setIntelligence"), { type: "setIntelligence", payload: { level } });
      }

      posted.length = 0;
      const adaptiveSwitch = tree.findOne((n) => n.tag === "button" && n.props.role === "switch");
      tree.click(adaptiveSwitch);
      assert.deepEqual(posted.find((m) => m.type === "setAdaptiveEnabled"), { type: "setAdaptiveEnabled", payload: { enabled: false } });

      // General Tab: Context Limit presets & custom input + ContextWarningModal
      posted.length = 0;
      tree.click(tree.findButton("16k"));
      assert.deepEqual(posted.find((m) => m.type === "setContextWindow"), { type: "setContextWindow", payload: { numCtx: 16384 } });

      const customCtxInput = tree.findByPlaceholder("auto");
      tree.change(customCtxInput, "131072");
      tree.blur(tree.findByPlaceholder("auto"));
      assert.ok(tree.findByClass("ctx-warn-modal"));
      tree.click(tree.findButton(/Use Recommended/));

      // Project Configuration: Create -> Loaded Edit File -> Error Fix Config File
      posted.length = 0;
      tree.click(tree.findButton("Create Config"));
      assert.ok(posted.some((m) => m.type === "createProjectConfig"));

      sendHost({
        type: "config",
        payload: makeBaseConfig({
          projectConfig: {
            loaded: true,
            relativePath: ".photon/config.json",
            fields: ["intelligence", "numCtxOverride"],
            modelConfigKeys: ["qwen2.5-coder:7b"],
            autoApproveIgnored: true,
          },
        }),
      }, tree);
      posted.length = 0;
      tree.click(tree.findButton("Edit File"));
      assert.ok(posted.some((m) => m.type === "openProjectConfig"));

      sendHost({
        type: "config",
        payload: makeBaseConfig({
          projectConfig: {
            loaded: false,
            relativePath: ".photon/config.json",
            error: "Invalid JSON at line 2",
            fields: [],
            modelConfigKeys: [],
          },
        }),
      }, tree);
      posted.length = 0;
      tree.click(tree.findButton("Fix Config File"));
      assert.ok(posted.some((m) => m.type === "openProjectConfig"));

      // Models Tab
      tree.click(tree.findByText("Models", "button"));
      sendHost({ type: "modelRecommendations", payload: makeRecommendations() }, tree);

      // Active Model Unload (Cancel then Unload)
      tree.click(tree.findButton("Unload"));
      tree.click(tree.findButton("Cancel"));
      tree.click(tree.findButton("Unload"));
      posted.length = 0;
      const unloadBtns = tree.findAllByText("Unload", "button");
      tree.click(unloadBtns[unloadBtns.length - 1]);
      assert.deepEqual(posted.find((m) => m.type === "unloadModel"), { type: "unloadModel", payload: { model: "qwen2.5-coder:7b" } });

      // Installed Local Models: Scan Models + Use Model
      posted.length = 0;
      tree.click(tree.findButton("Scan Models"));
      assert.ok(posted.some((m) => m.type === "detectProviders"));
      assert.ok(posted.some((m) => m.type === "refreshModels"));

      posted.length = 0;
      tree.click(tree.findAllByText("Use Model", "button")[0]);
      assert.ok(posted.some((m) => m.type === "setModel"));

      // Recommended Catalog: Goal chips + Pull + Custom pull
      for (const chip of ["Reason", "Vision", "Fast", "Code"]) {
        posted.length = 0;
        tree.click(tree.findButton(chip));
        assert.ok(posted.some((m) => m.type === "requestRecommendations"));
      }
      posted.length = 0;
      tree.click(tree.findAllByText("Pull", "button")[0]);
      assert.deepEqual(posted.find((m) => m.type === "pullModel"), { type: "pullModel", payload: { model: "qwen3:8b" } });

      const customPull = tree.findByPlaceholder(/Pull custom model/);
      tree.change(customPull, "phi4:14b");
      posted.length = 0;
      tree.keyDown(tree.findByPlaceholder(/Pull custom model/), { key: "Enter" });
      assert.deepEqual(posted.find((m) => m.type === "pullModel"), { type: "pullModel", payload: { model: "phi4:14b" } });

      // Model Parameters (ModelConfigs) expand + llamacpp editor + Copy + Save + Clear
      tree.click(tree.findByText("Model Parameters", "button"));
      const llamaHead = tree.findAllByClass("model-config-head").find((n) => getText(n).includes("llamacpp:deepseek-r1.gguf"));
      assert.ok(llamaHead);
      tree.click(llamaHead);
      tree.change(tree.findByPlaceholder("e.g. 32768"), "16384");
      tree.change(tree.findByPlaceholder("all"), "all");
      tree.change(tree.findByPlaceholder("e.g. Low temp for strict edits"), "QA test note");
      tree.click(tree.findButton("Copy"));
      assert.ok(env.copiedTexts[0]?.includes("llama-server"));

      posted.length = 0;
      tree.click(tree.findButton("Save"));
      assert.ok(posted.some((m) => m.type === "setPerModelConfig" && m.payload.model === "llamacpp:deepseek-r1.gguf"));

      // Simulate host update then test Cancel & Clear
      sendHost({
        type: "modelConfigs",
        payload: { "llamacpp:deepseek-r1.gguf": { numCtx: 16384, note: "QA test note" } },
      }, tree);
      const llamaHead2 = tree.findAllByClass("model-config-head").find((n) => getText(n).includes("llamacpp:deepseek-r1.gguf"));
      assert.ok(llamaHead2);
      tree.click(llamaHead2);
      posted.length = 0;
      tree.click(tree.findButton("Clear"));
      assert.deepEqual(posted.find((m) => m.type === "removePerModelConfig"), {
        type: "removePerModelConfig",
        payload: { model: "llamacpp:deepseek-r1.gguf" },
      });

      // Speed & Reliability Test expand -> Run Test + Re-run
      tree.click(tree.findByText("Speed & Reliability Test", "button"));
      posted.length = 0;
      tree.click(tree.findButton("Run Test"));
      assert.ok(posted.some((m) => m.type === "runBench"));
      posted.length = 0;
      tree.click(tree.findByTitle("Re-run benchmark", "button"));
      assert.deepEqual(posted.find((m) => m.type === "runBench"), { type: "runBench", payload: { model: "qwen2.5-coder:7b" } });
    } finally {
      tree.unmount();
    }
  });

  it("6. SettingsPanel Providers tab covers LocalProviderHub (Ollama + llama.cpp + logs), Detected Runtimes, CloudProviderCard, and AddCustomEndpoint", async () => {
    const { posted, sendHost, tree } = mountApp();
    try {
      tree.click(tree.findByAriaLabel("Settings and Providers", "button"));
      tree.click(tree.findByText("Providers", "button"));

      // LocalProviderHub & Runtimes with Ollama running+managed+logs and llamacpp port_conflict
      sendHost({ type: "providerRuntimes", payload: makeRuntimes() }, tree);
      sendHost({
        type: "providerLifecycle",
        payload: { id: "ollama", phase: "running", managed: true, pid: 4444, logs: ["ollama serve started", "listening on 11434"] },
      }, tree);

      // Logs toggle in LocalProviderHub
      tree.click(tree.findByClass("hub-logs-toggle", "button"));
      assert.ok(tree.findByClass("hub-log-output"));

      // Ollama running: Unload, Stop, Refresh in LocalProviderHub
      posted.length = 0;
      tree.click(tree.findByTitle("Unload model from VRAM", "button"));
      assert.deepEqual(posted.find((m) => m.type === "unloadModel"), { type: "unloadModel", payload: { model: "qwen2.5-coder:7b" } });

      posted.length = 0;
      tree.click(tree.findByTitle("Stop Ollama", "button"));
      assert.deepEqual(posted.find((m) => m.type === "stopProvider"), { type: "stopProvider", payload: { id: "ollama" } });

      posted.length = 0;
      tree.click(tree.findByTitle("Refresh status", "button"));
      assert.ok(posted.some((m) => m.type === "detectProviders"));

      // Switch LocalProviderHub tab to llama.cpp (port_conflict -> Free Port)
      tree.click(tree.findByText("llama.cpp", "button"));
      posted.length = 0;
      tree.click(tree.findByTitle("Free port 8080 and start llama.cpp", "button"));
      assert.deepEqual(posted.find((m) => m.type === "restartProvider"), { type: "restartProvider", payload: { id: "llamacpp" } });

      // Detected Local Runtimes: Rescan
      posted.length = 0;
      tree.click(tree.findButton("Rescan"));
      assert.ok(posted.some((m) => m.type === "detectProviders"));

      // CloudProviderCard: expand Claude, reveal key, Save & Connect, Fetch/Refresh, Auto Ping, Category pills, Search & Clear, Manual add, Ping, In Picker/Add, Edit/Remove Custom
      const providerHeaders = tree.findAllByClass("provider-header");
      // 0: gemini, 1: claude, 4: custom:lmstudio
      tree.click(providerHeaders[0]); // Gemini
      const gemKeyInput = tree.findByPlaceholder("Paste API key…");
      tree.change(gemKeyInput, "AIzaSyTest123");
      tree.click(tree.findByTitle("Show key", "button"));
      assert.equal(tree.findByPlaceholder("Paste API key…").props.type, "text");
      posted.length = 0;
      tree.click(tree.findButton("Save & Connect"));
      assert.deepEqual(posted.find((m) => m.type === "setProviderApiKey"), {
        type: "setProviderApiKey",
        payload: { id: "gemini", apiKey: "AIzaSyTest123" },
      });

      // Expand Claude (configured) and populate 6 live models so search & all category pills show
      tree.click(tree.findAllByClass("provider-header")[1]);
      const liveClaude: ModelInfo[] = [
        { name: "claude:claude-sonnet-4", provider: "claude", vision: true, thinking: true, toolTrained: true },
        { name: "claude:claude-opus-4", provider: "claude", vision: true, thinking: true, toolTrained: true },
        { name: "claude:claude-3-5-haiku", provider: "claude", vision: true, toolTrained: true },
        { name: "claude:claude-3-7-sonnet", provider: "claude", vision: true, thinking: true },
        { name: "claude:claude-2-mini", provider: "claude" },
      ];
      sendHost({ type: "providerModels", payload: { id: "claude", models: liveClaude } }, tree);

      // Clear Key button on Claude
      posted.length = 0;
      tree.click(tree.findButton("Clear Key"));
      assert.deepEqual(posted.find((m) => m.type === "setProviderApiKey"), { type: "setProviderApiKey", payload: { id: "claude", apiKey: "" } });

      // Refresh live models & Auto Ping
      posted.length = 0;
      tree.click(tree.findByClass("refresh-models-btn", "button"));
      assert.deepEqual(posted.find((m) => m.type === "fetchProviderModels"), { type: "fetchProviderModels", payload: { id: "claude" } });

      posted.length = 0;
      tree.click(tree.findByClass("autoping-btn", "button"));
      await tree.tick(20);
      assert.equal(posted.filter((m) => m.type === "testModel").length, 5);
      for (const m of liveClaude) {
        sendHost({ type: "modelTestResult", payload: { providerId: "claude", model: m, ok: true, latencyMs: 42 } }, tree);
      }

      // Category pills
      for (const pill of [/^Recommended/, /^In Picker/, /^Reasoning/, /^Vision/, /^Fast/, /^All/]) {
        tree.click(tree.findByText(pill, "button"));
      }

      // Search & clear
      const mSearch = tree.findByClass("model-search-input");
      tree.change(mSearch, "haiku");
      tree.click(tree.findByClass("search-clear-btn", "button"));

      // Manual model add
      const manualInput = tree.findByPlaceholder(/Or enter any model ID directly/);
      tree.change(manualInput, "claude-instant-test");
      posted.length = 0;
      tree.click(tree.findButton("+ Add Model"));
      assert.deepEqual(posted.find((m) => m.type === "addAvailableModel"), {
        type: "addAvailableModel",
        payload: { providerId: "claude", model: { name: "claude-instant-test" } },
      });

      // Single ping + Add/Remove in picker
      posted.length = 0;
      tree.click(tree.findAllByClass("model-card-ping-btn", "button")[0]);
      assert.equal(posted.filter((m) => m.type === "testModel").length, 1);

      posted.length = 0;
      tree.click(tree.findAllByClass("model-add-to-picker-btn", "button")[0]);
      assert.ok(posted.some((m) => m.type === "addAvailableModel"));

      posted.length = 0;
      tree.click(tree.findByClass("model-in-picker-btn", "button"));
      assert.ok(posted.some((m) => m.type === "removeAvailableModel"));

      // Custom endpoint: Edit Endpoint -> Save Endpoint -> Remove
      tree.click(tree.findAllByClass("provider-header")[4]);
      tree.click(tree.findButton("Edit Endpoint"));
      posted.length = 0;
      tree.click(tree.findButton("Save Endpoint"));
      assert.ok(posted.some((m) => m.type === "updateCustomProvider"));

      posted.length = 0;
      tree.click(tree.findByClass("provider-remove-btn", "button"));
      assert.deepEqual(posted.find((m) => m.type === "removeCustomProvider"), {
        type: "removeCustomProvider",
        payload: { id: "custom:lmstudio" },
      });

      // AddCustomEndpoint: open, filter presets, click preset, Cancel, reopen & Save & Connect
      tree.click(tree.findByClass("add-endpoint-btn", "button"));
      tree.change(tree.findByPlaceholder("Filter presets…"), "DeepSeek");
      tree.click(tree.findButton("DeepSeek"));
      tree.click(tree.findButton("Cancel"));
      assert.ok(tree.findByClass("add-endpoint-btn"));

      tree.click(tree.findByClass("add-endpoint-btn", "button"));
      tree.change(tree.findByPlaceholder("Filter presets…"), "");
      tree.click(tree.findByText("vLLM (Local)", "button"));
      posted.length = 0;
      tree.click(tree.findButton("Save & Connect"));
      assert.deepEqual(posted.find((m) => m.type === "addCustomProvider"), {
        type: "addCustomProvider",
        payload: { label: "vLLM (Local)", baseUrl: "http://localhost:8000/v1", apiKey: undefined, requireApiKey: false },
      });
    } finally {
      tree.unmount();
    }
  });

  it("7. SettingsPanel Tools tab, Advanced tab (inline MCP Approve/Session/Revoke), and verifies Customizations is hidden", async () => {
    const { posted, sendHost, tree } = mountApp();
    try {
      tree.click(tree.findByAriaLabel("Settings and Providers", "button"));

      // Tools Tab
      tree.click(tree.findByText("Tools", "button"));
      posted.length = 0;
      tree.click(tree.findOne((n) => n.tag === "button" && n.props.role === "switch"));
      assert.deepEqual(posted.find((m) => m.type === "setAutoApprove"), { type: "setAutoApprove", payload: { enabled: true } });

      const wsSelect = tree.findOne((n) => n.tag === "select" && n.props.className === "settings-select");
      posted.length = 0;
      tree.change(wsSelect, "duckduckgo");
      assert.deepEqual(posted.find((m) => m.type === "setWebSearchProvider"), {
        type: "setWebSearchProvider",
        payload: { provider: "duckduckgo" },
      });
      posted.length = 0;
      tree.change(wsSelect, "none");
      assert.deepEqual(posted.find((m) => m.type === "setWebSearchProvider"), {
        type: "setWebSearchProvider",
        payload: { provider: "none" },
      });

      // Expand Built-in Tools
      tree.click(tree.findByText(/Built-in Tools/, "button"));
      assert.ok(tree.findByText("write_file"));

      // Verify Customizations tab & mentions are completely hidden from Settings
      assert.equal(tree.findAllByText("Customizations", "button").length, 0);

      // Advanced Tab
      tree.click(tree.findByText("Advanced", "button"));
      assert.equal(tree.findAllByText(/Manage in Customizations/).length, 0);
      assert.equal(tree.findAllByClass("custom-shell").length, 0);

      posted.length = 0;
      tree.click(tree.findOne((n) => n.tag === "button" && n.props.role === "switch"));
      assert.deepEqual(posted.find((m) => m.type === "setIndexingEnabled"), { type: "setIndexingEnabled", payload: { enabled: false } });
      sendHost({ type: "config", payload: makeBaseConfig({ indexingEnabled: true }) }, tree);

      const embedSelect = tree.findOne((n) => n.tag === "select" && n.props.className === "settings-select");
      posted.length = 0;
      tree.change(embedSelect, "bge-m3");
      assert.deepEqual(posted.find((m) => m.type === "setEmbeddingModel"), { type: "setEmbeddingModel", payload: { model: "bge-m3" } });

      // Phase ready -> Re-index
      posted.length = 0;
      tree.click(tree.findButton("Re-index"));
      assert.ok(posted.some((m) => m.type === "reindex"));

      // Phase unavailable -> Pull embedding model (and verify PullProgressBar dismiss unlocks!)
      sendHost({ type: "indexStatus", payload: { phase: "unavailable", filesIndexed: 0, chunks: 0, pending: 0 } }, tree);
      posted.length = 0;
      tree.click(tree.findButton(/Pull nomic-embed-text|Pull bge-m3/));
      assert.ok(posted.some((m) => m.type === "pullModel"));

      // Inline .vscode/mcp.json MCP Servers controls inside Advanced tab (Approve / Session / Revoke)
      posted.length = 0;
      tree.click(tree.findButton("Approve"));
      assert.deepEqual(posted.find((m) => m.type === "approveMcpServer"), {
        type: "approveMcpServer",
        payload: { id: "filesystem", expectedFingerprint: "fp-fs-1", scope: "persistent" },
      });
      posted.length = 0;
      tree.click(tree.findButton("Session"));
      assert.deepEqual(posted.find((m) => m.type === "approveMcpServer"), {
        type: "approveMcpServer",
        payload: { id: "filesystem", expectedFingerprint: "fp-fs-1", scope: "session" },
      });
      posted.length = 0;
      tree.click(tree.findButton("Revoke"));
      assert.deepEqual(posted.find((m) => m.type === "revokeMcpServer"), {
        type: "revokeMcpServer",
        payload: { id: "docs-http" },
      });

      // Expand Diagnostics -> Open Logs
      tree.click(tree.findByText("Diagnostics", "button"));
      posted.length = 0;
      tree.click(tree.findButton("Open Logs"));
      assert.ok(posted.some((m) => m.type === "openDiagnostics"));
    } finally {
      tree.unmount();
    }
  });

  it("8. Modals (ProjectContextModal, HardwareMetricsModal, RevertModal) and Approval dock (standard & destructive)", async () => {
    const { posted, sendHost, tree } = mountApp();
    try {
      // 1) ProjectContextModal
      tree.click(tree.findByClass("ctx-header-btn", "button"));
      assert.ok(tree.findByAriaLabel("Project Context and Memory"));

      posted.length = 0;
      tree.click(tree.findButton("Sync"));
      assert.ok(posted.some((m) => m.type === "refreshProjectContext"));

      posted.length = 0;
      tree.click(tree.findButton("Clear"));
      assert.ok(posted.some((m) => m.type === "clearWorkingMemory"));

      // Active file pill -> openFile & closes modal
      posted.length = 0;
      tree.click(tree.findByTitle("Open src/host/PhotonController.ts in editor", "button"));
      assert.deepEqual(posted.find((m) => m.type === "openFile"), { type: "openFile", payload: { path: "src/host/PhotonController.ts", line: undefined } });

      // Reopen ProjectContextModal -> Modules & Index tab -> Entry point pill
      tree.click(tree.findByClass("ctx-header-btn", "button"));
      tree.click(tree.findByText("Modules & Index", "button"));
      posted.length = 0;
      tree.click(tree.findByTitle("Open src/extension.ts in editor", "button"));
      assert.deepEqual(posted.find((m) => m.type === "openFile"), { type: "openFile", payload: { path: "src/extension.ts", line: undefined } });

      // Reopen -> Notes tab -> Add note form & Delete note
      tree.click(tree.findByClass("ctx-header-btn", "button"));
      tree.click(tree.findByText(/^Notes/, "button"));
      tree.change(tree.findByAriaLabel("Note category"), "decision");
      tree.change(tree.findByAriaLabel("Note title"), "UI E2E Verified");
      tree.change(tree.findByAriaLabel("Rule or project note"), "All modals verified.");
      posted.length = 0;
      tree.click(tree.findButton("Add"));
      assert.deepEqual(posted.find((m) => m.type === "addProjectNote"), {
        type: "addProjectNote",
        payload: { category: "decision", title: "UI E2E Verified", content: "All modals verified." },
      });

      posted.length = 0;
      tree.click(tree.findByAriaLabel("Delete note Keep protocol typed", "button"));
      assert.deepEqual(posted.find((m) => m.type === "deleteProjectNote"), { type: "deleteProjectNote", payload: { id: "note-1" } });

      tree.click(tree.findByAriaLabel("Close Project Context modal", "button"));

      // 2) HardwareMetricsModal (Local Unload + Cloud Reset)
      tree.click(tree.findByClass("ctx-icon-trigger", "button"));
      tree.click(tree.findByClass("hw-chart-btn", "button"));
      assert.ok(tree.findByClass("hw-modal"));

      tree.click(tree.findByAriaLabel("Unload qwen2.5-coder:7b from memory", "button"));
      tree.click(tree.findButton("Cancel"));
      tree.click(tree.findByAriaLabel("Unload qwen2.5-coder:7b from memory", "button"));
      posted.length = 0;
      tree.click(tree.findButton("Unload"));
      assert.deepEqual(posted.find((m) => m.type === "unloadModel"), { type: "unloadModel", payload: { model: "qwen2.5-coder:7b" } });

      tree.click(tree.findByText("Cloud", "button"));
      tree.click(tree.findButton("Reset"));
      tree.click(tree.findButton("Cancel"));
      tree.click(tree.findButton("Reset"));
      posted.length = 0;
      const resetBtns = tree.findAllByText("Reset", "button");
      tree.click(resetBtns[resetBtns.length - 1]);
      assert.ok(posted.some((m) => m.type === "resetCloudUsage"));

      tree.click(tree.findByAriaLabel("Close Hardware and Telemetry modal", "button"));

      // 3) RevertModal (with >2MB unrestorable warning)
      sendHost({
        type: "openRevertModal",
        payload: {
          checkpoints: [
            {
              id: "cp-1",
              checkpointNumber: 1,
              timestamp: Date.now() - 60000,
              label: "Update App.tsx",
              filesCount: 2,
              files: ["src/a.ts", "big.bin"],
              messageId: "m-a1",
              hasUnrestorableFiles: true,
              unrestorableFiles: ["big.bin"],
            },
          ],
        },
      }, tree);
      assert.ok(tree.findByClass("revert-modal"));
      posted.length = 0;
      tree.click(tree.findByClass("revert-file-tag", "button"));
      assert.deepEqual(posted.find((m) => m.type === "openFile"), { type: "openFile", payload: { path: "src/a.ts", line: undefined } });

      posted.length = 0;
      tree.click(tree.findButton("Files Only"));
      assert.deepEqual(posted.find((m) => m.type === "rollbackCheckpoint"), {
        type: "rollbackCheckpoint",
        payload: { checkpointId: "cp-1", rewindChat: false },
      });

      sendHost({ type: "openRevertModal" }, tree);
      posted.length = 0;
      tree.click(tree.findButton("Revert & Rewind Chat"));
      assert.deepEqual(posted.find((m) => m.type === "rollbackCheckpoint"), {
        type: "rollbackCheckpoint",
        payload: { checkpointId: "cp-1", rewindChat: true },
      });

      // 4) Approval dock: standard tool vs run_command destructive
      sendHost({
        type: "toolApprovalRequest",
        payload: {
          messageId: "m-2",
          call: { id: "call-1", name: "write_file", args: { path: "foo.ts", content: "export const a = 1;" }, status: "proposed", sideEffecting: true },
        },
      }, tree);
      assert.equal(tree.findByClass("approval-btn-always", "button").props.disabled, false);
      posted.length = 0;
      tree.click(tree.findByClass("approval-btn-allow", "button"));
      assert.deepEqual(posted.find((m) => m.type === "toolApproval"), {
        type: "toolApproval",
        payload: { callId: "call-1", approved: true, remember: false, toolName: "write_file" },
      });

      sendHost({
        type: "toolApprovalRequest",
        payload: {
          messageId: "m-3",
          call: { id: "call-2", name: "write_file", args: { path: "bar.ts", content: "x" }, status: "proposed", sideEffecting: true },
        },
      }, tree);
      posted.length = 0;
      tree.click(tree.findByClass("approval-btn-always", "button"));
      assert.deepEqual(posted.find((m) => m.type === "toolApproval"), {
        type: "toolApproval",
        payload: { callId: "call-2", approved: true, remember: true, toolName: "write_file" },
      });

      // Destructive / run_command disables Always allow and labels button "Confirm & Allow Once"
      sendHost({
        type: "toolApprovalRequest",
        payload: {
          messageId: "m-4",
          call: { id: "call-3", name: "run_command", args: { command: "rm -rf tmp" }, status: "proposed", sideEffecting: true, risk: "destructive" },
        },
      }, tree);
      assert.equal(getText(tree.findByClass("approval-btn-allow", "button")), "Confirm & Allow Once");
      assert.equal(tree.findByClass("approval-btn-always", "button").props.disabled, true);
      posted.length = 0;
      tree.click(tree.findByClass("approval-btn-deny", "button"));
      assert.deepEqual(posted.find((m) => m.type === "toolApproval"), {
        type: "toolApproval",
        payload: { callId: "call-3", approved: false, remember: false, toolName: "run_command" },
      });
    } finally {
      tree.unmount();
    }
  });

  it("9. Message Stream (TurnProcess, ThinkingBlock, ToolCard, CheckpointPill, CompactedMessage, NoticeBubble, Copy, Markdown See more), TerminalTaskBanner, PullProgressBar Dismiss fix, ErrorBanner & ErrorBoundary", async () => {
    const largeCode = Array.from({ length: 24 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const assistantMarkdown = [
      "Here is a small block:",
      "```ts",
      "console.log('hi');",
      "```",
      "And a large block:",
      "```ts",
      largeCode,
      "```",
    ].join("\n");

    const { env, posted, sendHost, tree } = mountApp({
      session: {
        id: "sess-1",
        title: "Stream Session",
        mode: "agent",
        model: "qwen2.5-coder:7b",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          { id: "u1", role: "user", content: "Inspect codebase", createdAt: Date.now() - 5000 },
          {
            id: "a1",
            role: "assistant",
            content: "",
            thinking: "Step 1 reasoning trace",
            thinkingElapsedMs: 1200,
            toolCalls: [{ id: "tc1", name: "read_file", args: { path: "src/extension.ts" }, status: "done", result: "line1\nline2" }],
            createdAt: Date.now() - 4000,
          },
          {
            id: "a2",
            role: "assistant",
            content: assistantMarkdown,
            notice: "⚠️ API Error: { \"code\": 429, \"message\": \"rate limit\" }",
            checkpointId: "cp-msg-1",
            checkpointNumber: 1,
            checkpointFiles: ["src/extension.ts"],
            createdAt: Date.now() - 3000,
          },
          {
            id: "sys-compact",
            role: "system",
            content: "⚡ **[Context Compaction Summary]** Preserved architecture notes.",
            isCompacted: true,
            compactStats: { messagesCount: 6, tokensSaved: 4200, pctSaved: 45 },
            createdAt: Date.now() - 2000,
          },
        ],
      },
    });

    try {
      // TurnProcess toggle -> ThinkingBlock toggle -> ToolCard file link & expand
      tree.click(tree.findByClass("turn-process-head", "button"));
      assert.ok(tree.findByClass("turn-process-body"));

      tree.click(tree.findByClass("thinking-head", "button"));
      assert.ok(tree.findByClass("thinking-body"));

      posted.length = 0;
      tree.click(tree.findByClass("tool-file-link", "button"));
      assert.deepEqual(posted.find((m) => m.type === "openFile"), { type: "openFile", payload: { path: "src/extension.ts", line: undefined } });

      tree.click(tree.findByClass("tool-head"));
      assert.ok(tree.findByClass("tool-body"));

      // CheckpointPill popover
      tree.click(tree.findByClass("checkpoint-pill-btn", "button"));
      posted.length = 0;
      tree.click(tree.findButton("Files Only"));
      assert.deepEqual(posted.find((m) => m.type === "rollbackCheckpoint"), {
        type: "rollbackCheckpoint",
        payload: { checkpointId: "cp-msg-1", rewindChat: false },
      });

      // CompactedMessage & NoticeBubble
      tree.click(tree.findByClass("msg-compact-header", "button"));
      assert.ok(tree.findByClass("msg-compact-body"));

      tree.click(tree.findByClass("error-bubble-head", "button"));
      assert.ok(tree.findByClass("error-bubble-detail"));

      // MessageActions copy + Markdown small & large copy + See more / Show less
      tree.click(tree.findAllByClass("msg-action-btn", "button")[0]);
      tree.click(tree.findByClass("copy-btn", "button"));
      tree.click(tree.findByClass("code-block-copy", "button"));
      await tree.tick(10);
      assert.equal(env.copiedTexts.length, 3);

      tree.click(tree.findByClass("code-block-more-btn", "button"));
      assert.equal(getText(tree.findByClass("code-block-more-btn", "button")), "Show less");
      tree.click(tree.findByClass("code-block-more-btn", "button"));

      // TerminalTaskBanner: running + queued + expand + Stop + done Dismiss
      sendHost({ type: "status", payload: { kind: "running", detail: "Running tests" } }, tree);
      sendHost({
        type: "messageAppended",
        payload: {
          id: "a-term",
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          toolCalls: [{ id: "tc-run", name: "run_command", args: { command: "npm test", cwd: "Photon" }, status: "running", sideEffecting: true }],
        },
      }, tree);
      sendHost({
        type: "queuedTools",
        payload: [{ id: "tc-q", name: "get_diagnostics", args: { path: "src" }, status: "proposed" }],
      }, tree);

      assert.ok(tree.findByClass("terminal-banner"));
      tree.click(tree.findByClass("terminal-banner-queue-chip", "button"));
      assert.ok(tree.findByClass("terminal-banner-details"));
      tree.click(tree.findByClass("terminal-banner-toggle", "button"));
      assert.equal(tree.findAllByClass("terminal-banner-details").length, 0);

      posted.length = 0;
      tree.click(tree.findByClass("terminal-banner-stop", "button"));
      assert.ok(posted.some((m) => m.type === "cancel"));

      // Mark command done (still inside active turn) -> Dismiss banner
      sendHost({
        type: "toolUpdate",
        payload: {
          messageId: "a-term",
          call: { id: "tc-run", name: "run_command", args: { command: "npm test" }, status: "done", result: "All pass" },
        },
      }, tree);
      sendHost({ type: "queuedTools", payload: [] }, tree);
      tree.click(tree.findByClass("terminal-banner-dismiss", "button"));
      assert.equal(tree.findAllByClass("terminal-banner").length, 0);
      sendHost({ type: "status", payload: { kind: "idle" } }, tree);

      // PullProgressBar: error + resumable -> Resume & Dismiss (clears pullProgress so Advanced embed Pull unlocks!)
      sendHost({
        type: "pullProgress",
        payload: { model: "nomic-embed-text", phase: "error", status: "Network reset", error: "reset", resumable: true },
      }, tree);
      posted.length = 0;
      tree.click(tree.findByClass("pull-btn-resume", "button"));
      assert.deepEqual(posted.find((m) => m.type === "pullModel"), { type: "pullModel", payload: { model: "nomic-embed-text" } });

      // Dismiss failed pull and verify Advanced tab Pull button becomes enabled
      tree.click(tree.findByClass("pull-btn-close", "button"));
      assert.equal(tree.findAllByClass("pull-progress-bar-container").length, 0);

      tree.click(tree.findByAriaLabel("Settings and Providers", "button"));
      tree.click(tree.findByText("Advanced", "button"));
      sendHost({ type: "indexStatus", payload: { phase: "unavailable", filesIndexed: 0, chunks: 0, pending: 0 } }, tree);
      const embedPullBtn = tree.findButton(/Pull nomic-embed-text/);
      assert.equal(Boolean(embedPullBtn.props.disabled), false, "Dismissing pull error must unlock embedding Pull button");
    } finally {
      tree.unmount();
    }

    // Standalone ErrorBanner & ErrorBoundary recovery + Hard refresh
    const { env: env2 } = createHostDispatcher();
    let dismissed = false;
    const errBannerTree = new MountedTree(() =>
      React.createElement(ErrorBanner, {
        message: "Request failed Bearer sk-secretkey1234567890123456 401",
        onClose: () => {
          dismissed = true;
        },
      })
    );
    try {
      const errText = getText(errBannerTree.findByClass("error-text"));
      assert.ok(errText.includes("[REDACTED]"), "ErrorBanner must sanitize tokens");
      errBannerTree.click(errBannerTree.findByAriaLabel("Dismiss error", "button"));
      assert.equal(dismissed, true);
    } finally {
      errBannerTree.unmount();
    }

    let shouldThrow = true;
    function FlakyChild() {
      if (shouldThrow) throw new Error("Crash with Bearer secret-token-abcdefg");
      return React.createElement("div", { className: "recovered-ok" }, "Recovered OK");
    }
    const ebTree = new MountedTree(() =>
      React.createElement(ErrorBoundary, null, React.createElement(FlakyChild))
    );
    try {
      assert.ok(getText(ebTree.findByClass("error-text")).includes("Bearer [REDACTED]"));
      shouldThrow = false;
      ebTree.click(ebTree.findButton("Reload view"));
      assert.ok(ebTree.findByClass("recovered-ok"));

      // Trigger again to test Hard refresh
      shouldThrow = true;
      ebTree.rerender();
      assert.equal(env2.reloadCount, 0);
      ebTree.click(ebTree.findButton("Hard refresh"));
      assert.equal(env2.reloadCount, 1);
    } finally {
      ebTree.unmount();
    }
  });
});
