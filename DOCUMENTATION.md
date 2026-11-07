# Photon — Comprehensive Documentation

> Version 0.1.0 · VS Code `^1.90.0` · License MIT  
> Agentic coding with small local LLMs — tuned so low-end models actually cope, with cloud frontier models available as BYOK overflow.

This document is a complete inventory of what Photon implements, how it is architected, the design theme it uses, and how to build, configure, test, and extend it.

---

## 1. Overview & Philosophy

Photon flips the conventional AI coding assistant priority: instead of designing exclusively for massive cloud frontier models and bolting on local support as an afterthought, Photon is built **local-first for the 3B–16B parameter class** (Qwen 2.5 Coder, DeepSeek-Coder-V2-Lite, Gemma 3, Devstral Small, Llama 3.2). It dynamically adapts system prompts, tool protocols, context budgets, and repair loops down to the specific machine and model at hand.

- **Local-first.** Ollama (`http://localhost:11434`), LM Studio, and llama.cpp (`http://localhost:8080/v1`) are primary citizens. Your code stays strictly on your machine.
- **Adaptive down.** Terse prompts, curated tool subsets, and tight output token caps for small contexts; rich multi-tool scaffolding only when running on capable hardware or cloud models.
- **Forgiving protocols.** The `[TOOL name] arg: value [/TOOL]` flat block protocol plus a multi-format resilient parser allows compact models to call tools reliably without stumbling over strict nested JSON.
- **Automated Tool Repair.** Intercepts malformed tool invocations, streams targeted repair prompts (up to 2 retries), and marks blocked todos rather than silently terminating.
- **Cloud when needed.** Google Gemini, Anthropic Claude, OpenAI, NVIDIA NIM, OpenRouter, OpenCode Zen, Blackbox AI, and custom OpenAI-compatible endpoints with API keys securely stored in VS Code `SecretStorage`.
- **Fail-Safe Checkpoints & Rollback.** Automatic pre-mutation file snapshotting across turns with single-click file restoration, chat rewinding with prompt auto-paste, and numbered checkpoint tracking.
- **Automatic Context Compaction.** Multi-strategy token condensation that monitors context window pressure in real time, triggering automatic or manual `/compact` summarization before overflow occurs.

---

## 2. Feature Inventory

### 2.1 Interaction Modes

Photon provides three specialized operational modes selectable via the top header tabs or keyboard shortcuts:

| Mode | Behavior | File Mutations | Terminal Commands | Step Cap |
|------|----------|----------------|-------------------|----------|
| **Chat** | Pure conversation, architecture Q&A, conceptual discussions, and code snippets | ❌ Disabled | ❌ Disabled | 6 steps |
| **Plan** | Read-only investigation (`read_file`, `list_dir`, `find_files`, `search_code`), structured blueprints, numbered step-by-step action checklists | ❌ Disabled | ❌ Disabled | 10 steps |
| **Agent** | Full autonomous coding: edits, creates, and moves files, executes commands, checks diagnostics, and verifies work | ✅ Enabled (Approval required) | ✅ Enabled (Approval required) | 25 steps (cloud safety net: 200) |

*Step caps enforce finite execution loops. Typing "continue" seamlessly starts another turn while retaining context.*

---

### 2.2 Adaptive Engine & Machine Profiling

Photon continuously profiles system resources and model specifications to calculate an `AdaptivePlan` for each session:

1. **Hardware Profiling (`machineProfiler.ts`):** Evaluates CPU cores, total/free system RAM, and GPU VRAM via platform tools (`nvidia-smi`, Windows registry, macOS `system_profiler`). Categorizes hardware into tiers (`Low`, `Mid`, `High`) and computes safe context ceilings:
   - Low: 8,192 tokens (with 22.5% safety buffer to prevent swap thrashing)
   - Mid: 16,384 tokens
   - High: 32,768+ tokens
2. **Model Profiling (`modelProfiler.ts`):** Extracts parameter count, quantization level, context length limit, and native tool-calling capabilities from Ollama manifests or modelfiles. Caches profiles by `name@digest` (10-minute TTL, 50 entries).
3. **Task Complexity Analysis (`policy.ts`, `complexity.ts`):** Classifies requests into scopes (`single_file`, `multi_file`, `codebase`), reasoning depth (`low`, `medium`, `high`), and destructive risk level.
4. **Benchmark Integration (`bench.ts`, `benchStore.ts`):** Evaluates real throughput (`tok/s`), tool execution reliability, and reasoning pass rates. Keyed by `model + hardwareClass + methodologyVersion`.
5. **Auto Mode (`orchestrator.ts`, `autoMode.ts`):** Dynamically picks the optimal model, intelligence level, temperature, and context window. Rationale is surfaced transparently in the **Transparency Panel** (`◎`).

Intelligence level presets (`intelligence/`):
- `Auto`: Dynamically computed per turn.
- `Low`: 5 tools, 768 output token cap, minimal prompt overhead (ideal for 3B–4B models).
- `Medium`: 8 tools, 2,048 output token cap, standard prompt formatting (7B–8B models).
- `High`: 14 tools, 4,096 output token cap, rich scaffolding (14B–16B models).
- `Maximum`: All tools, 8,192 output token cap (32B+ or frontier cloud models).

---

### 2.3 Checkpoint & Rollback System (Copilot & Claude Code Parity)

Photon features a checkpoint and rollback system engineered to undo faulty agent edits and rewind conversation turns.

```
                    ┌────────────────────────┐
                    │ User Sends Turn Prompt │
                    └───────────┬────────────┘
                                │ beginTurn()
                                ▼
                    ┌────────────────────────┐
                    │ File Mutation Tool     │
                    │ (write, edit, append)  │
                    └───────────┬────────────┘
                                │ recordBeforeChange()
                                ▼ (lazy pre-mutation snapshot)
                    ┌────────────────────────┐
                    │ File Written on Disk   │
                    └───────────┬────────────┘
                                │ commitTurn()
                                ▼
                    ┌────────────────────────┐
                    │ Checkpoint #N Created  │
                    │ (.photon/checkpoints)  │
                    └────────────────────────┘
```

#### Key Architecture & Capabilities:
- **Pure TypeScript Engine Boundary (`checkpointManager.ts`):** Strictly dependency-free with zero `vscode` imports. Persists a bounded sliding window of 60 checkpoints to `.photon/checkpoints.json`.
- **Lazy Pre-Mutation Tracking (`checkpointTracker`):** Before any file write, edit, append, or move tool modifies a file on disk, Photon captures the file's original ground-truth content, existence status, and modification timestamp (`mtimeMs`). Read-only tools (`read_file`, `list_dir`, `find_files`, `search_code`) incur zero snapshot overhead.
- **Reverse-Chain Cumulative Rollback:** When rolling back across multi-turn histories (e.g. from Turn 3 back to Turn 1), Photon traverses the chain in reverse order, restoring each affected file to its *earliest pre-mutation state* and deleting any files created after that checkpoint.
- **Dual Restoration Workflows:**
  1. **Revert & Rewind Chat:** Restores files on disk to their exact pre-turn state, trims the chat history back to that checkpoint, and automatically pastes the original user prompt back into the composer input box, auto-focused and expanded for easy editing.
  2. **Files Only:** Reverts file modifications on disk while preserving the entire conversation history.
- **Numbered Checkpoint Badges:** Checkpoints are sequentially numbered (`Checkpoint #1`, `Checkpoint #2`, etc.) within each chat session.
- **Interactive Checkpoint Pill:** Every assistant turn that modifies workspace files displays an interactive pill: `Checkpoint #1 · 2 files › Revert`. Clicking toggles a confirmation popover listing modified files and rollback buttons.
- **Revert Modal (`RevertModal.tsx`):** A dedicated dropdown modal listing all session checkpoints, their relative timestamps (`2m ago`), user prompt quotes, and file tags.
- **Symbol Cache Synchronization:** Every rollback immediately re-indexes reverted files and removes deleted files from `ProjectContextManager`, keeping symbol references in exact parity with disk.

---

### 2.4 Context Compaction Engine (Copilot & Claude Code Parity)

To prevent conversation context overflows during long-running sessions, Photon implements an automated compaction engine (`compactor.ts`):

- **Automatic Threshold Compaction:** Continuously computes token usage against the model's active context window (`used / window`). When context pressure exceeds **85%**, the engine automatically triggers context compaction before prompt execution.
- **Structural Summarization (`compactSessionMessages`):**
  - **Preserved Core Context:** Preserves the initial user request, active task goal, workspace files touched, pending todos, key technical decisions, and the 2 most recent turns.
  - **Condensed History:** Compresses intermediate turns, tool calls, and diagnostics into a dense `[Context Compaction Summary]` block.
- **Visual Status & Metrics:** Displays a clean compaction pill in chat and status bars indicating tokens saved, percentage reduction, and active compaction indicators.
- **Manual Compaction:** Triggerable at any time via the `/compact [focus]` command or by clicking **Compact** in the Context Meter popover.

---

### 2.5 Slash Commands & Composer Autocomplete

Typing `/` in the Composer opens a floating slash-command autocomplete menu with keyboard navigation (`↑`/`↓` to navigate, `Enter`/`Tab` to select, `Esc` to dismiss):

| Slash Command | Parameters | Description |
|---------------|------------|-------------|
| `/revert` | Optional: `<number>` | Opens the Checkpoint Revert Modal to select a numbered checkpoint. If a number is provided (e.g. `/revert 1`), immediately reverts files and rewinds chat to that checkpoint. |
| `/rewind` | None | Instantly rolls back the latest turn's file modifications and rewinds the chat. |
| `/compact` | Optional: `[focus]` | Condenses conversation history to free up context tokens. An optional focus area can be provided. |
| `/clear` | None | Clears the active chat session and starts a fresh conversation. |

---

### 2.6 Tool System (14 Built-ins + Cloud + MCP)

Tools are registered in `src/core/tools/registry.ts` with tier-gated availability, concurrency policies, and risk levels:

| Tool | Parameters | Risk | Description |
|------|------------|------|-------------|
| `read_file` | `path`, `start_line?`, `end_line?` | Read | Reads file contents with line numbering (`0001 │`). Protected by a 200-line default slice and 2 MB binary guard. |
| `edit_file` | `path`, `old_str`, `new_str`, `replace_all?` | Write | Performs targeted find-and-replace with whitespace/gutter tolerance. Preserves original line endings. Automatically snapshot-tracked. |
| `write_file` | `path`, `content` | Write | Creates or overwrites files with automatic directory creation. Approval-gated and snapshot-tracked. |
| `append_file` | `path`, `content` | Write | Appends text to the end of an existing file. Approval-gated and snapshot-tracked. |
| `move_path` | `from`, `to` | Write | Safely moves or renames files or directories within the workspace boundary. Approval-gated and snapshot-tracked. |
| `list_dir` | `path?`, `recursive?` | Read | Lists directory contents (directories first). Ignores `node_modules`, `.git`, `dist`, and build output. |
| `find_files` | `pattern` | Read | Matches filenames using globs (e.g. `**/*.test.ts`) or substrings. Results capped based on intelligence tier. |
| `search_code` | `query`, `path?` | Read | Fast regex and substring code search across workspace files with depth and file size guards. |
| `code_outline` | `path` | Read | Extracts top-level classes, functions, interfaces, and methods. |
| `run_command` | `command` | Execute | Executes shell commands in the workspace root. Enforces single-command security (rejects chaining operators `&&`, `\|\|`, `;`, `$()`, backticks). Approval-gated with 60s timeout. |
| `get_diagnostics` | `path?` | Read | Extracts active compiler, linter, and typechecker diagnostics from VS Code. |
| `web_search` | `query` | Network | Performs web search via DuckDuckGo with Google fallback (15s timeout, 5–8 results). |
| `web_fetch` | `url` | Network | Fetches and sanitizes web pages. Protected against SSRF (blocks private/loopback IP ranges and non-HTTP schemes). |
| `todo_write` | `todos` | Workflow | Manages task checklist items (`pending`, `in_progress`, `done`, `blocked`). |

**Cloud Tools Aliasing (`cloudTools.ts`):** Transparently translates standard cloud model function calls (`write_to_file`, `replace_in_file`, `execute_command`, `list_files`, `search_files`) to Photon's workspace engine tools.

**Model Context Protocol (MCP):** Connects external MCP servers declared in `.vscode/mcp.json`. Supports `stdio` (allowlisted runtimes: `node`, `npx`, `python`, `uvx`, `deno`, `bun`) and `http`/SSE transports with strict approval gating and argument sanitization.

---

### 2.7 Multi-Provider LLM Architecture

Photon supports local and cloud LLM providers via a unified streaming client architecture:

| Provider | Transport | Default Endpoint | Features |
|----------|-----------|------------------|----------|
| **Ollama** | Native NDJSON HTTP | `http://localhost:11434` | Streaming token generation, model pulling with live progress & ETA, keep-alive management, auto-detection. |
| **llama.cpp** | OpenAI-compatible SSE | `http://localhost:8080/v1` | Process management, automatic `-ngl` GPU layer calculation, context configuration, zero API key required. |
| **Google Gemini** | Google API SSE | `generativelanguage.googleapis.com` | Gemini 2.0 Flash, Gemini 1.5 Pro, multimodal image support, high context windows. |
| **Anthropic Claude** | Messages API SSE | `api.anthropic.com` | Claude 3.5 Sonnet, Claude 3 Opus, Claude 3.5 Haiku, streaming reasoning trace support. |
| **OpenAI** | Chat Completions SSE | `api.openai.com/v1` | GPT-4o, GPT-4o-mini, o1, o3-mini with reasoning level controls. |
| **NVIDIA NIM** | OpenAI-compatible SSE | `integrate.api.nvidia.com/v1` | Nemotron-3.5-Super, Llama-3.1-405B, high-speed inference. |
| **OpenRouter** | OpenAI-compatible SSE | `openrouter.ai/api/v1` | Universal model routing with dynamic model catalog retrieval. |
| **Custom Providers** | OpenAI-compatible SSE | User defined | Arbitrary local or remote endpoints with custom headers and key-in-body configurations. |

All API keys are securely managed via VS Code's `SecretStorage` API (`secrets.store`), ensuring credentials never leak into git repositories, settings files, or logs.

---

### 2.8 Telemetry & Real-Time Resource Monitoring

Photon features a real-time telemetry and hardware monitoring pipeline:

- **Live Hardware Gauges (`sampleHardwareMetrics`):** Real-time monitoring of system RAM, free RAM, CPU utilization, and GPU VRAM updated at configurable intervals.
- **Cloud Usage Tracker (`cloudUsage.ts`):** Accumulates session and all-time token usage (input, output, cached tokens) and calculates exact costs in USD using an up-to-date pricing table for all supported frontier models.
- **Hardware Metrics Modal (`HardwareMetricsModal.tsx`):** Visual modal displaying live hardware telemetry, Ollama VRAM residency, running models, and aggregated cloud billing statistics with one-click reset options.

---

### 2.9 Project Context & Offline RAG

- **Persistent Architecture Memory:** Maintains `.photon/context.json` to store architectural decisions, workspace symbol indexes, key file mappings, and multi-model turn handoffs.
- **Offline Vector Store (`indexService.ts`):** Chunks workspace files (60 lines / 12 overlap), generates embeddings locally via Ollama (`nomic-embed-text`), and stores vector embeddings in `.photon/index-<hash>.json`. Retrieves top-k semantically relevant snippets for plan and agent turns.
- **Turn Handoff Tracking:** Automatically logs user goals, assistant responses, and tools executed per turn to preserve continuity across model swaps.

---

## 3. Design Theme & UI Architecture

Photon features a custom **Void Black + Animated Moving Gradient** design system built in `webview-ui/src/theme/photon.css`:

### 3.1 Design Palette
- **Deep Void Surfaces:** `--space-900: #07070A` (primary void background), `--space-850: #0a0a0e`, `--space-800: #0E0E14` (elevated cards), `--space-700: #151519` (user chat bubbles).
- **Hairline Borders:** `--line: rgba(255, 255, 255, 0.08)` providing clean, non-intrusive container edges.
- **High-Contrast Text Hierarchy:** Primary text `#FFFFFF` / `#ECECF0`, secondary text `rgba(255, 255, 255, 0.65)`, faint labels `rgba(255, 255, 255, 0.40)`.
- **Brand Gradient:** Subtly deployed on active underlines, focus rings, and wordmarks:
  ```css
  --grad-brand: linear-gradient(92deg, #FF2D2D 0%, #FF6B2D 46%, #FFC02E 100%);
  ```

### 3.2 Visual Highlights & Micro-Interactions
- **Fluid Moving Gradient Hero:** Welcome screen inspired by the modern Gemini UI and the official Photon website, featuring animated, moving blurred mesh gradients behind a bold, matte foreground Photon wordmark.
- **Smooth Animations:** Hardware-accelerated modal dialog scale-ins (`modalDialogScaleIn`), slide-up popovers (`popoverSlideUp`), and backdrop fades (`modalBackdropFadeIn`).
- **Seamless Smooth Scrolling:** Native smooth scrolling enabled across the chat message list for a fluid conversation stream.
- **Elevated Controls & High-Visibility Dropdowns:** Clean, high-contrast menus with white background and dark text on hover for maximum legibility.
- **Pure SVG Icon Suite:** All controls, status badges, buttons, and checkpoint indicators use clean, crisp vector SVGs with zero emoji dependencies.

---

## 4. Configuration Reference

All settings are configured under the `photon.*` namespace in VS Code Settings (`Ctrl+,` / `Cmd+,`):

| Setting | Default | Description |
|---------|---------|-------------|
| `photon.ollama.baseUrl` | `http://localhost:11434` | Ollama server URL |
| `photon.ollama.connectTimeoutMs` | `300000` | Connection timeout for loading cold models into memory |
| `photon.ollama.requestTimeoutMs` | `180000` | Token stream idle timeout |
| `photon.ollama.keepAlive` | `"30m"` | Model residency duration in VRAM after turn completion |
| `photon.llamacpp.baseUrl` | `http://localhost:8080` | llama.cpp server URL |
| `photon.defaultMode` | `"chat"` | Active mode on launch (`chat`, `plan`, `agent`) |
| `photon.defaultModel` | `""` | Model to activate on launch |
| `photon.interfaceMode` | `"local"` | Primary interface mode (`local` or `cloud`) |
| `photon.intelligence.level` | `"auto"` | Intelligence preset (`auto`, `low`, `medium`, `high`, `max`) |
| `photon.adaptive.enabled` | `true` | Enable hardware-aware dynamic context and parameter tuning |
| `photon.tools.autoApprove` | `false` | Bypass user confirmation prompts for file edits and terminal commands |
| `photon.webSearch.provider` | `"duckduckgo"` | Web search provider (`duckduckgo`, `google`, `none`) |
| `photon.index.enabled` | `false` | Enable local codebase vector indexing and offline RAG |
| `photon.index.embeddingModel` | `"nomic-embed-text"` | Ollama model used for local vector embeddings |
| `photon.experimental.harness` | `false` | Enable event-sourced agent loop architecture |

---

## 5. Build, Test, & Package

### Prerequisites
- Node.js `^20.0.0`
- npm `^10.0.0`
- VS Code `^1.90.0`

### Build Commands
```bash
# Install dependencies
npm install

# Run TypeScript typechecks across root and webview
npm run typecheck

# Execute unit test suite (244 tests)
npm test

# Build production bundles (webview + extension host)
npm run build

# Package VS Code extension VSIX
npm run package

# Install VSIX into VS Code
code --install-extension photon-0.1.0.vsix
```

---

## 6. Project Directory Structure

```
Photon/
├── src/
│   ├── core/
│   │   ├── adaptive/         # Hardware profiling, model assessment, task complexity
│   │   ├── agent/            # Unified agent engine, cloud engine, context compactor
│   │   ├── bench/            # Photon Bench methodology & throughput measurement
│   │   ├── checkpoints/      # Checkpoint manager (pure TypeScript, zero VS Code imports)
│   │   ├── index/            # Local vector embedding, chunker, cosine similarity store
│   │   ├── intelligence/     # Tool policies, intelligence levels, prompt budgeting
│   │   ├── llm/              # Provider managers, SSE stream framing, Ollama client
│   │   └── tools/            # 14 built-in workspace tools, cloud tools, MCP client
│   ├── host/
│   │   ├── PhotonController.ts # Primary turn controller & webview communication bridge
│   │   ├── extension.ts      # Extension activation, commands, and subscription setup
│   │   ├── indexService.ts   # Workspace file watcher & vector indexing service
│   │   └── sessionStore.ts   # Multi-session state persistence
│   └── shared/
│       ├── protocol.ts       # Typed bidirectional host <-> webview messaging protocol
│       └── types.ts          # Core domain data models
├── webview-ui/
│   ├── src/
│   │   ├── components/       # React UI: Composer, MessageList, RevertModal, ContextMeter
│   │   ├── state/            # Central Zustand/useAppState reducer & store
│   │   ├── theme/            # photon.css (Void Black design theme & animations)
│   │   └── App.tsx           # Webview application root
├── test/
│   └── unit/                 # Node test runner unit tests (checkpoints, compactor, tools)
└── DOCUMENTATION.md          # Comprehensive technical documentation
```

---

## 7. Recent Updates & Changelog

### Version 0.1.0 (Latest Release)
- **Checkpoint & Rollback Parity:**
  - Introduced `CheckpointManager` with lazy pre-mutation file snapshotting.
  - Multi-turn cumulative reverse-chain rollback for exact disk restoration.
  - Dual restoration options: "Revert & Rewind Chat" (truncates conversation and pastes user prompt into composer) and "Files Only".
  - Sequential numbered checkpoints (`Checkpoint #1`, `Checkpoint #2`, …).
  - Revert Modal (`RevertModal.tsx`) with relative timestamps, prompt quotes, and file tags.
  - Slash command autocomplete menu (`/revert`, `/rewind`, `/compact`, `/clear`).
  - Pure SVG icon set replacing all emojis.
- **Context Compaction Engine:**
  - Automated threshold compaction triggering at 85% context window capacity.
  - Preserves goals, active files, pending todos, key decisions, and latest turns while condensing older turns.
  - Interactive visual status pill in chat displaying tokens saved and compaction metrics.
  - Dedicated `/compact [focus]` command.
- **Real-Time Telemetry & Hardware Cost Tracking:**
  - Live hardware telemetry sampler monitoring CPU, system RAM, free RAM, and GPU VRAM.
  - Real-time cloud usage tracker calculating exact USD billing with token caching discounts across all major frontier models.
  - Hardware Metrics Modal (`HardwareMetricsModal.tsx`) with resource utilization gauges.
- **UI & Motion Upgrades:**
  - Fluid moving blurred mesh gradient background on the welcome screen with matte finish.
  - Smooth animation primitives for dialogs, popovers, and chat scrolling.
  - Enhanced contrast dropdowns and pickers with dark theme styling.
