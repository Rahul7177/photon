# Photon — Current Feature Inventory

**Repository reviewed:** `Rahul7177/photon`  
**Branch:** `main`  
**Revision:** `ae029ca92431d2bdf44d2923e8331b7439896515`  

This document inventories the important capabilities visible in the current extension code. Each item separates what is implemented today from the direction the feature should evolve toward. “Ideal” describes a product target, not a claim that the capability already exists.

---

## 1. Chat Experience & Streaming

- **What it does now:** Provides a React-based VS Code sidebar with streaming responses, Markdown/code rendering, tool cards, status indicators, generation speed, context meter, and cancellation.
- **Ideal:** Make the conversation experience feel like a complete coding workspace: richer inline diffs, editable artifacts, file references, clearer progress, and reliable recovery after interruptions.

## 2. Interaction Modes — Chat, Plan, Agent

- **What it does now:** Chat is for Q&A, Plan supports read-oriented investigation and planning, and Agent enables tools and workspace changes. Each mode has its own execution policy and step budget.
- **Ideal:** Make mode boundaries and permissions obvious, allow smooth transitions between planning and execution, and let users control autonomy per task rather than only per mode.

## 3. Agent Execution & Orchestration (Use Argon / Claude models to iterate)

- **What it does now:** Runs a multi-step model/tool loop, selects tools, executes calls, feeds results back, tracks todos, applies step limits, and produces completion or unresolved-task summaries.
- **Ideal:** Improve task decomposition, parallelize safe work, maintain explicit task state, avoid repeated work, and verify the requested outcome before declaring a task complete.

## 4. Context Management & Compaction

- **What it does now:** Estimates token use, fits conversation history to the active context window, protects the system prompt and recent interaction/tool-call pairs, reserves output tokens, and supports manual `/compact` plus automatic compaction at a 75% threshold. Compaction preserves task goals, constraints, file activity, decisions, findings, and unresolved items.
- **Ideal:** Use provider/model-specific token accounting wherever possible, preserve exact active-task state and tool pairing, retrieve omitted history on demand, and compact only the information that is genuinely safe to summarize.

## 5. Adaptive Intelligence Levels

- **What it does now:** Offers Auto, Low, Medium, High, and Max levels that adjust prompt detail, tool availability, and execution guidance based on the selected level and model/machine context.
- **Ideal:** Automatically tune the full execution strategy—prompt structure, tool schemas, context budget, parallelism, verification depth, and retries—based on measured task outcomes, not just model size or fixed heuristics.

## 6. Adaptive Model Routing / Auto Mode

- **What it does now:** Classifies task complexity and ranks available models using context fit, capabilities, benchmark data, hardware fit, cost, and local preference. Users can pin a model and inspect why a model was selected in the Transparency panel.
- **Ideal:** Route by expected task success per unit of latency, token cost, and resource use; learn from actual task outcomes; and make routing decisions explainable and user-controllable.

## 7. Hardware Profiling & Model Recommendations

- **What it does now:** Profiles CPU, system RAM, GPU/VRAM, and machine tier; inspects model metadata and capabilities; estimates memory/context fit; and recommends suitable installed or catalog models. Available benchmark results can inform model fit and throughput estimates.
- **Ideal:** Predict real inference performance and memory pressure for each runtime, context length, and quantization; validate predictions against live measurements; and recommend the best model for a specific task rather than a generic hardware tier.

## 8. Multi-Provider Support (BYOK)

- **What it does now:** Supports local and cloud provider adapters, including Ollama, llama.cpp, Gemini, Anthropic, OpenAI-compatible providers, NVIDIA NIM, OpenRouter, OpenCode Zen, Blackbox, and custom endpoints. Cloud API keys are stored through VS Code SecretStorage.
- **Ideal:** Normalize provider differences more deeply, expose capability and pricing metadata consistently, improve provider health/fallback handling, and make adding a new provider straightforward.

## 9. Local Runtime Discovery & Lifecycle

- **What it does now:** Detects Ollama, llama.cpp, LM Studio, and vLLM runtime presence/status. Photon can manage start/stop and launch flows for Ollama and llama.cpp, show process logs, detect port conflicts, and provide installation guidance.
- **Ideal:** Support reliable lifecycle management across all detected runtimes, runtime-specific configuration, automatic recovery, model download/launch management, and clear ownership boundaries for processes Photon starts.

## 10. Local Mode & Cloud Mode

- **What it does now:** Provides separate local and cloud execution stacks. Local mode uses local runtimes and adaptive local execution; Cloud mode uses configured cloud providers and native tool calling. Switching is user-controlled; there is no silent local-to-cloud overflow.
- **Ideal:** Offer an optional, policy-driven hybrid mode that tries local execution first and escalates to cloud only under explicit user-defined cost, privacy, and quality rules—with clear consent and auditability.

## 11. Built-in Coding & Workspace Tools

- **What it does now:** Includes file reading/editing/creation/appending/moving, directory listing, file and code search, code outline, todo management, project-context operations, web search/fetch, and editor diagnostics.
- **Ideal:** Expand the toolset with structured diff review, Git-aware operations, test discovery, dependency/code navigation, refactoring primitives, and reliable multi-file transactions.

## 12. Tool Protocols, Normalization & Repair

- **What it does now:** Supports Photon-block tool calls for local models and native function calling for cloud models. Parsers handle multiple output formats; calls are validated and normalized; malformed calls can receive bounded repair guidance; cloud tool names/arguments are mapped to Photon's tools.
- **Ideal:** Make tool execution protocol-independent, support partial/streamed tool-call assembly consistently, reduce repair round-trips, and use per-model protocol profiles grounded in benchmark results.

## 13. Terminal Execution & Verification

- **What it does now:** Runs workspace commands with approval, timeouts, output limits, cancellation/process-tree cleanup, and exit-code reporting. Verification can use VS Code diagnostics and the agent can run tests/build/lint commands through the terminal.
- **Ideal:** Turn verification into a first-class workflow: infer the right checks, run them automatically when authorized, capture structured evidence, map failures to changed files, and require evidence before reporting success.

## 14. Checkpoints, Revert & Rewind

- **What it does now:** Captures pre-mutation file snapshots, stores checkpoint history, supports cumulative rollback, and can restore workspace files with or without rewinding chat. `/rewind`, `/revert`, and numbered checkpoints are available.
- **Ideal:** Provide dependable transactional recovery across all supported file types and multi-file edits, handle symlinks/large files/external edits explicitly, and make partial rollback state and recovery options unambiguous.

## 15. Project Context & Lightweight Project Memory

- **What it does now:** Maintains project-level information such as file/symbol summaries, recently inspected or edited files, notes, key findings, and model/task handoff information. It can inject a compact project-context digest into agent prompts.
- **Ideal:** Build a durable, queryable project knowledge layer that tracks architecture, conventions, decisions, dependencies, and task history while keeping facts, assumptions, and stale information clearly separated.

## 16. Workspace Indexing & Local RAG

- **What it does now:** Optionally chunks workspace files, creates embeddings through a local Ollama embedding model, stores vectors in a TypeScript vector store, incrementally updates changed files, persists the index, and retrieves relevant code for agent context. Indexing is bounded and excludes common generated/vendor directories.
- **Ideal:** Scale to large monorepos with efficient incremental indexing, stronger language-aware chunking, hybrid lexical/vector retrieval, ranking and deduplication, and retrieval-quality evaluation—all while keeping indexing local by default.

## 17. Model Context Protocol (MCP)

- **What it does now:** Connects configured HTTP and stdio MCP servers, discovers their tools, registers them with an `mcp_` prefix, tracks connection state, and supports approval, trust fingerprints, and revocation.
- **Ideal:** Make MCP lifecycle changes fully fail-closed, support richer transport/server compatibility, expose granular per-tool trust and audit history, and provide a smooth server discovery/configuration experience.

## 18. Tool Approval, Security & Privacy Controls

- **What it does now:** Requires approval for side-effecting tools unless auto-approval is enabled; includes workspace path checks, command risk checks, secret redaction, secure API-key storage, MCP trust controls, and network/SSRF protections.
- **Ideal:** Move toward a unified permission model covering file scope, command class, network access, MCP tools, and data egress—with least-privilege defaults, scoped approvals, and a user-visible audit trail.

## 19. Session History & Persistence

- **What it does now:** Supports creating, switching, and deleting conversations; auto-titles sessions; persists bounded message history in VS Code global state; and prunes large message/tool/attachment payloads to control storage.
- **Ideal:** Preserve complete conversation semantics across reloads, provide robust search/export/import, support project/workspace-aware history, and make retention and pruning transparent to users.

## 20. Project Configuration & Per-Model Settings

- **What it does now:** Reads team-shareable `.photon/config.json` or flat `.yaml/.yml` defaults and supports per-model context, llama.cpp launch parameters, and sampling overrides. Configuration changes can be watched and applied without restarting the extension.
- **Ideal:** Provide a versioned schema with validation/migration, clear precedence and conflict handling, richer team policies, and a UI to inspect effective settings and their source (user, project, or default).

## 21. Image & Text Attachments

- **What it does now:** Accepts image and text/code attachments through paste, file picker, drag-and-drop, and VS Code Chat references. Image forwarding is gated by model vision capability; attachment sizes/types are bounded.
- **Ideal:** Support broader multimodal inputs where providers/models allow them, preview and manage attachments, extract structured context from PDFs and other common developer formats, and preserve attachment references efficiently in sessions.

## 22. Photon Bench & Model Evaluation

- **What it does now:** Benchmarks local models for token throughput, first-token latency, tool-call reliability, and selected coding/tool behaviours; stores versioned results and uses benchmark data in model ranking and recommendations.
- **Ideal:** Run reproducible end-to-end coding tasks through Photon's actual agent/tool pipeline in disposable workspaces, execute real tests, compare models and routing strategies, and report quality/latency/token/cost trade-offs with confidence intervals.

## 23. Hardware & Cloud Usage Telemetry

- **What it does now:** Shows available live hardware/runtime measurements such as RAM, GPU utilization/temperature, VRAM, and loaded local models. Tracks cloud input/output/cached tokens and estimated spend by session, total, and model.
- **Ideal:** Provide reliable time-series usage, resource and latency trends, per-task/per-model cost attribution, configurable budgets/alerts, and clear separation between provider-reported billing and Photon's own estimates.

## 24. VS Code Native Integration

- **What it does now:** Provides an Activity Bar sidebar, command-palette actions, status-bar model/reachability indicator, retained webview state, and an `@photon` participant in VS Code Chat that forwards prompts and supported references to the Photon controller.
- **Ideal:** Deepen native editor workflows with inline diffs, diagnostics/code actions, editor selections and current-file context, keyboard-first controls, and a consistent experience across the sidebar and native Chat.

## 25. Onboarding, Settings & Diagnostics

- **What it does now:** Includes a guided local/cloud setup flow, provider/model configuration, model scanning/testing, context and intelligence controls, model recommendations, runtime logs, and a machine/model diagnostics command.
- **Ideal:** Make setup largely automatic, diagnose common failures with actionable fixes, expose effective configuration and feature health in one place, and provide contextual guidance instead of requiring users to understand runtime details.

## 26. Experimental Photon Harness

- **What it does now:** `src/photon-core` contains an experimental event-oriented harness with session/agent registries, inboxes, a tool pipeline, prompt registry, and agent-loop contracts. It is **not the production chat execution path**; the active production engine remains under `src/core/agent/`.
- **Ideal:** Promote only proven components behind stable interfaces, then use the harness for durable event-sourced sessions, multi-agent coordination, extensible hooks, and alternate editor front ends—without destabilizing the current engine.

---

## Important Scope Notes

- **Local and cloud are separate execution modes today.** Automatic local-first cloud escalation is a potential future capability, not current seamless fallback behaviour.
- **The Photon Harness is experimental.** The production extension currently uses the engine under `src/core/agent/`.
- **Benchmark scores are not yet equivalent to proven real-world coding success.** The current benchmark contains capability probes and targeted checks; end-to-end agent evaluation remains an improvement target.
- **Cloud spend is estimated by Photon.** Treat it as usage/cost visibility, not a replacement for the provider's invoice or billing console.

---

## Main Code Areas

| Feature area | Main implementation paths |
|---|---|
| Chat UI / settings | `webview-ui/src/`, `src/host/ChatViewProvider.ts` |
| Controller / orchestration | `src/host/PhotonController.ts`, `src/host/*Coordinator.ts`, `src/core/agent/` |
| Adaptive intelligence | `src/core/adaptive/`, `src/core/intelligence/` |
| Providers / runtimes | `src/core/llm/`, `src/host/providerCatalogService.ts`, `src/host/localProcessManager.ts` |
| Context / compaction | `src/core/agent/contextManager.ts`, `src/core/agent/compactor.ts` |
| Tools / MCP / security | `src/core/tools/`, `src/host/mcpCoordinator.ts`, `src/host/approvalService.ts` |
| Checkpoints | `src/core/checkpoints/checkpointManager.ts`, `src/host/checkpointCoordinator.ts` |
| Project context / RAG | `src/core/context/`, `src/core/index/`, `src/host/indexService.ts` |
| Bench / telemetry | `src/core/bench/`, `src/core/telemetry/`, `src/host/benchStore.ts` |
| Experimental harness | `src/photon-core/` |
