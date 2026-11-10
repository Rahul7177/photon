# Photon — Product Info

## What Is Photon?
Photon is a **VS Code extension for local-first agentic coding** — and a **direct BYOK cloud workspace agent** when you switch to Cloud mode. It is built so small 2–8B local models on everyday laptops finish multi-file tasks reliably without manual prompt engineering or context math, while frontier cloud models run at full context with minimal overhead.

- **Local-first by default:** Runs on your machine via **Ollama** (`http://localhost:11434`) and **llama.cpp** (`http://localhost:8080`, OpenAI-compatible), keeping workspace code local and offline.
- **Direct BYOK Cloud Engine:** Toggle **Local | Cloud** anytime using keys stored exclusively in VS Code `SecretStorage` — no intermediary proxy or pooled keys.

---

## Interaction Modes & Continuity

Switch between modes anytime in the composer bar without losing conversation history or **Maintained Project Context**:

| Mode | Capabilities & Guardrails | Safety Ceiling | Best For |
| :--- | :--- | :--- | :--- |
| **Chat** | **Strictly read-only.** Workspace inspection (`read_file`, `list_dir`, `find_files`, `search_code`, `code_outline`, `get_diagnostics`, `query_project_context`) + web (`web_search`, `web_fetch`). Blocks file edits/commands; outputs full copy-pastable blocks with manual steps and suggests **Agent** mode. | `100` steps | Q&A, code explanations, reviewing changes, drafting files to copy manually |
| **Plan** | **Read-only interactive planning.** Inspects files first, asks **2–4 focused clarifying questions** when ambiguous, then writes a structured Markdown implementation plan with exact file paths, symbols, and verification steps. | `150` steps | Architecture design, multi-file refactor scoping, clarifying requirements |
| **Agent** | **Full autonomous execution.** Full read/write/create/append/move/terminal/web + connected **MCP** tools, approval prompts (`autoApprove` optional), diagnostics verification, and per-turn workspace checkpoints. | `200` steps | Implementing features, multi-file edits, running tests/builds, bug fixing |

- Switching `Chat → Plan → Agent` or `Local ↔ Cloud` preserves prior turn context (while scrubbing stale internal coaching nudges across protocol boundaries).

---

## Dual Execution Architecture: Local vs. Cloud

### Local Engine (`runUnifiedTurn`) — Adaptive + Inverse Scaffolding
Rather than starving weak models of tools, Photon grants full tool access (`maxTools = 40` within mode bounds) and scales **cognitive scaffolding inversely** with model capability (`src/core/adaptive/orchestrator.ts`, `src/core/intelligence/policy.ts`):

| Intelligence Level | `chatTemp` / `taskTemp` | Output Cap | Prompt Budget Fraction | Workspace Map Lines | Ideal Target |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`low`** | `0.25 / 0.15` | `2048` | `20%` | `30` | Large self-sufficient models, simple tasks |
| **`medium`** | `0.25 / 0.15` | `3072` | `26%` | `60` | Capable models, moderate tasks |
| **`high`** | `0.20 / 0.10` | `4096` | `34%` | `90` | Mid-sized models (9–20B) or complex/codebase tasks |
| **`max`** | `0.15 / 0.10` | `4096` | `42%` | `120` | Tiny (`≤4.2B`) & small (`≤8.5B`) models or lower tool reliability (`<0.72`) |

* **Hardware-Aware Context Window (`computeOptimalContextWindow`)**: Profiles RAM, CPU cores, and GPU VRAM (`nvidia-smi` / Windows registry `HardwareInformation.qpMemorySize` / macOS `system_profiler` / Linux `/sys/class/drm`). Reserves a strict **22.5% OS/VS Code RAM safety buffer** and **0.5 GB VRAM**, applies CPU hybrid-offload caps (`16k / 32k / 64k` by core count, `128k` GPU-resident), and snaps down to `[8192 … 262144]`. Minimum local target floor is `min(8192, modelMax)`.
* **Protocol Auto-Selection (`shouldUseNativeToolProtocol`)**: Uses **native JSON tool calling** when local models declare native tool support (or pass fresh **Photon Bench v4** at `toolCallReliability ≥ 0.80`, `schemaAdherence ≥ 0.82`, `toolCalling ≥ 0.82`); otherwise runs the tolerant **`[TOOL name] … [/TOOL]`** block parser covering `[TOOL]`, `<tool_call>`, Gemma pipe calls, fenced blocks, and balanced JSON objects.
* See [`docs/ADAPTIVE_INTELLIGENCE.md`](./ADAPTIVE_INTELLIGENCE.md) for exact formulas and scoring weights.

### Cloud Engine (`runCloudTurn`) — High-Throughput Native Calling
* Bypasses hardware RAM context caps and gives cloud models their full `contextLength` (`128,000` default, honoring per-model overrides).
* Request-aware tool surface (`classifyCloudToolPolicy`): `0` tool schemas on standalone opening greetings, `web`-only schemas on pure external-fact questions, read-only + web tools in **Chat/Plan**, and full file/terminal/web + approved MCP tools in **Agent**.
* Parallel read-only execution waves (`Promise.all` for concurrent `read_file` / search batches), real-time token usage & cost tracking (`CloudUsageTracker`), and automatic blocked-write recovery to Markdown code blocks in Chat mode.

### Auto Mode Routing (`autoMode.ts`) & Photon Bench (`bench.ts`)
* **Multi-signal scoring (`rankModels`)**: Combines `contextFit (+30)` + `headroom (+6)`, `toolCalling (×18)`, `coding (×14)`, `reasoning (×12)`, `throughput (×12)`, `recovery (×10)`, `verification (×8)`, `tierMatch (×8)`, `localPreference (+3)`, cost penalty (`-15` for expensive cloud on simple tasks), and `localOnly` privacy enforcement (`-200`).
* **Controlled runtime fallback (`selectFallbackModel`)**: Never silently escalates a local turn to paid cloud APIs without `allowCloudEscalation`.
* **Photon Bench (`BENCH_VERSION = 4`)**: Measures real throughput (`tok/s`), tool-call schema reliability, coding edits, recovery, verification, and context retention (valid for 30 days). Inspect full rankings & Pin per project in the **Transparency Panel** (`◎`).

---

## Context Compaction & Long-Session Resilience

Photon implements multi-layered compaction matching cloud-grade coding agents (`src/core/agent/compactor.ts`, `src/core/agent/contextManager.ts`):

1. **Pre-Turn 75% Auto-Compaction & `/compact [focus]`**: Evaluates projected input (`history + pending user prompt + fixedOverheadTokens + reserveOutputTokens`) against `0.75` of usable window before starting each turn (and via the `Compact` meter button or `/compact [focus]`).
2. **Proactive Mid-Turn Compaction & Overflow Retry**: During long multi-step turns inside both `runCloudTurn` (`compactMidTurnLLMHistory`) and `runUnifiedTurn` (`compactSessionMessages`), Photon proactively compacts older tool rounds before turns get dropped — and if an API rejects a request for context overflow (`context_length_exceeded` / `413` / `"prompt is too long"`), Photon compacts and retries cleanly instead of failing.
3. **Hybrid Provider + Ground-Truth Compaction**: Calls a fast provider model (automatically retrying on the active working model if the sibling fails, up to 30s timeout and dynamic 8k–48k char transcript windows) and validates/appends omitted structured facts (`retainMissingStructuredFacts`), backed by deterministic offline `buildNativeCompactionSummary` separating:
   - Original task anchor & negative user constraints
   - Verified modified/created/moved files, inspected files, and `ENOENT`/0-match findings
   - Explicit command execution outcomes (`✓ Completed`, `✗ Failed`, `⏸ Not executed`, `⏳ Awaiting approval`, `⛔ Denied`)
   - Unverified model assumptions vs. unresolved errors/TODOs
4. **In-Request Clamping & Persistence Archival**:
   - `compactCloudHistory` deduplicates repeated `read_file` outputs and compacts stale tool outputs (>2 user turns old).
   - `fitToWindow` JSON- and line-clamps large tool payloads (`clampStructuredToolResult`) and guarantees `tool_call` / `tool` pairing (`sanitizeToolPairing`).
   - `enforceSessionMessageCap` archives overflow turns into cumulative digests without losing earlier history across multi-round compactions.

---

## Checkpoints & Rollback

* **Pre-mutation snapshots (`CheckpointManager` / `CheckpointCoordinator`)**: Automatically records clean workspace file states before mutating Agent turns commit.
* **Restore anytime**: Use the inline **Checkpoint Pill** on assistant turns, `/rewind` (instant rollback of the latest edit turn), or `/revert [#N]` / the **Revert Modal** (`RevertModal.tsx`) to restore workspace files with optional chat rewind.

---

## Model & Provider Ecosystem

### Local Runtimes (`LocalProviderHub.tsx`, `localProcessManager.ts`, `modelAdvisor.ts`)
* **Ollama** (`http://localhost:11434`, configurable `keepAlive: "-1"` default, `preloadOnStartup: true`) with live model capability probing (`paramsB` incl. Gemma-4 `:e2b`/`:e4b` MoE effective sizes, quantization, vision/audio/video/thinking/tools).
* **llama.cpp** (`http://localhost:8080/v1`, toggle `photon.providers.llamacpp.enabled`) with per-model `llama-server` CLI flag generator (`-ngl`, `--fit`, `-np`, `-fa`, `-ctk`, `-ctv`, extra args).
* **Lifecycle UI**: Hardware-matched model catalog recommendations (`MODEL_CATALOG`), one-click server start/install check, live `ollama pull` progress bars (`PullProgressBar`), and real-time GPU/VRAM/RAM telemetry (`HardwareMetricsModal`).

### Cloud BYOK Providers (`providerCatalogService.ts`)
API keys are stored encrypted in VS Code `SecretStorage` (`photon.provider.<id>.apiKey`):

| Provider | Endpoint / Integration | Features |
| :--- | :--- | :--- |
| **Google Gemini** | `generativelanguage.googleapis.com/v1beta` | Live model sync, thinking levels, multimodal inline media |
| **Anthropic Claude** | `api.anthropic.com/v1/messages` | Ephemeral prompt caching on system & tools, reasoning |
| **OpenAI** | `api.openai.com/v1` | Live catalog, GPT-4o / o-series reasoning & usage stats |
| **NVIDIA NIM** | `integrate.api.nvidia.com/v1` | Live catalog, Nemotron & open-weight frontier models |
| **OpenRouter** | `openrouter.ai/api/v1` | Multi-vendor routing + app headers |
| **OpenCode Zen** | `opencode.ai/zen/v1` | Live model listing & OpenAI-compat streaming |
| **Blackbox AI** | `api.blackbox.ai` (`keyInBody`) | Curated reasoning/coding catalog |
| **Custom** | User-defined `baseUrl` (`photon.providers.custom`) | Custom OpenAI-compat endpoints, custom headers, optional key in body |

* **SSE & Timeout Hardening**: All cloud streams enforce a `60s` HTTP fetch timeout, `90s` SSE idle watchdog, immediate `[DONE]` loop termination (preventing keep-alive stalls), duplicate-call spin guards, and elapsed progress notices (`Waiting for model (Ns)…` / `Thinking (Ns)…` / `Generating (Ns)…`).

---

## Workspace Intelligence & Tools

### Maintained Project Context & Offline Vector Index
* **Maintained Project Context (`ProjectContextManager`, `ProjectContextModal`)**: Maintains structural workspace digests, file/symbol outlines, architectural decision logs, and cross-model/cross-mode handoff summaries injected into system prompts and accessible via `query_project_context` / `update_project_context`.
* **Local Semantic Vector Index (`indexService.ts`)**: Watches up to `1,500` workspace files (`≤256 KB` each), chunks code (`60` lines, `12`-line overlap), embeds locally via Ollama `nomic-embed-text` (or configured model, validated against model-identity changes), stores up to `8,000` normalized vectors in `globalStorage`, and retrieves top-6 chunks during Plan/Agent turns (`Medium+` tiers).

### Built-in Tools & MCP (`src/core/tools/`, `mcpCoordinator.ts`)
* **Workspace (Local 17 tools + Cloud-mapped aliases):** `read_file` (with `start_line`/`end_line`), `edit_file` (`replace_in_file`), `write_file` (`write_to_file`), `append_file`, `move_path`, `find_files`, `list_dir` (`list_files`), `search_code` (`search_files`), `code_outline` (`list_code_definition_names`), `get_diagnostics`, `run_command` (`execute_command`), `query_project_context`, `update_project_context`, `todo_write`, `think`, `web_search` (DuckDuckGo / Google), `web_fetch`.
* **MCP Servers:** Reads `.vscode/mcp.json` (`stdio` allowlist `npx/node/python/uvx/bun/deno` with shell-injection guard & filtered env, or `http(s)://`), registers tools as `mcp_<id>_<tool>`, exposed in **Agent** mode (`Local` + `Cloud`), with trust fingerprints and one-click Approve/Revoke.

---

## Webview UX & Safety

* **Clean Turn Abstraction (`TurnProcess`, `AssistantTurn`)**: Groups intermediate tool calls (`ToolCard`) and thinking blocks (`ThinkingBlock`) cleanly per turn, auto-collapsing finished work into concise summaries while keeping live pulsing status visible through multi-step waits and mid-reply generation.
* **Smart Markdown & Large-File Previews (`Markdown.tsx`)**: Line-based CommonMark parser supporting `4`-backtick outer blocks (` ````markdown ```` `), resilient nested `3`-backtick fences inside Markdown/README blocks (keeping an entire file in one copyable block), and automatic **14-line preview + `See more (N more lines)` / `Show less` collapse** with always-accessible full **Copy** on large files (`>20` lines or `>1,400` chars).
* **Composer & Controls (`Composer.tsx`, `ContextMeter.tsx`)**: Slash command menu (`/compact`, `/revert`, `/rewind`), file/screenshot drag-drop & paste (`Ctrl+V`, vision-gated), live `tok/s` & context budget popover with manual **Compact** and **Telemetry**, queue/abort (`TurnCoordinator`), onboarding walkthrough (`OnboardingModal`), and project config hot-reload (`.photon/config.json|yaml|yml`).
* **Persistence & Redaction (`sessionStore.ts`, `SecretStorage`)**: Up to `40` sessions persisted (`SESSION_STORE_SCHEMA_VERSION = 2`, 200 persisted messages / 400 live messages per session) with automatic `redactSecrets` scrubbing of API keys/Bearer tokens across persisted histories, logs, and compaction summaries.
