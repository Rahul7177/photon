# Photon

**Local-first agentic coding for VS Code — engineered so compact 2B–16B local LLMs reliably inspect, edit, and verify real codebases on consumer hardware, with direct BYOK frontier cloud models a single toggle away.**

[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](https://github.com/Rahul7177/photon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-blue.svg)](https://code.visualstudio.com/)
[![CI](https://github.com/Rahul7177/photon/actions/workflows/ci.yml/badge.svg)](https://github.com/Rahul7177/photon/actions/workflows/ci.yml)

---

## Table of Contents

- [Overview](#overview)
- [Why Photon](#why-photon)
- [Highlights in v0.1.0](#highlights-in-v010)
- [Interaction Modes](#interaction-modes)
- [Slash Commands & VS Code Integration](#slash-commands--vs-code-integration)
- [Built-in Tools & MCP](#built-in-tools--mcp)
- [Architecture](#architecture)
- [Supported Providers & Models](#supported-providers--models)
- [Installation & Quick Start](#installation--quick-start)
- [Configuration Reference](#configuration-reference)
- [Privacy, Security & Data Isolation](#privacy-security--data-isolation)
- [Development & Verification](#development--verification)
- [License](#license)

---

## Overview

Most AI coding extensions are designed around 200k-context cloud APIs and treat local LLMs as an afterthought — stuffing thousands of tokens of rigid JSON schemas into a 4 GB–8 GB laptop GPU until small models hallucinate arguments, overflow VRAM, or stall.

**Photon is built from the ground up around the memory limits, KV-cache math, and tool-calling behaviors of compact local models** (`Qwen 2.5 Coder`, `Gemma 4`, `Qwen 3 / 3.5`, `Phi-4 Mini`, `DeepSeek R1`, `DeepSeek-Coder-V2-Lite`) via **Ollama** and **llama.cpp**, while also providing a dedicated high-throughput **Cloud Engine** for BYOK frontier providers (`Claude`, `OpenAI`, `Gemini`, `NVIDIA NIM`, `OpenRouter`, `OpenCode Zen`, `Blackbox AI`, and custom OpenAI-compatible endpoints).

For the full product vision and `v0.1.0` capability breakdown, see [PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md).

---

## Why Photon

- **100% Local & Offline by Default:** Code, conversation history, project memory, and vector embeddings stay on your machine in Local mode.
- **Inverse Cognitive Scaffolding:** Smaller models automatically receive richer step-by-step guidance, phase-specific worked examples, and state cards, while frontier models receive lean, low-overhead prompts.
- **Hardware-Aware Context & VRAM Guardrails:** Profiles CPU cores, free/total RAM (reserving a 22.5% OS/IDE buffer), and GPU VRAM to pick safe context ceilings and warn before high context settings trigger disk swapping.
- **Dual Tool Protocol (`photon-block` + Compact Native JSON):** Supports both a fault-tolerant flat block syntax (`TOOL_NAME` / `BEGIN_ARG` / `[TOOL]`) and pruned native function schemas (`>40%` lighter on local VRAM), backed by a live **Reliability Governor** that auto-recovers or downgrades protocols mid-turn if a model stumbles.
- **Zero Silent Cloud Escalation:** Local and Cloud modes operate as explicit, independent stacks — Photon never silently sends local code to a cloud API.

---

## Highlights in v0.1.0

### Fail-Safe Checkpoints & Cumulative Rollback
- **Lazy Pre-Mutation Snapshots:** Automatically snapshots original file state right before any `write_file`, `edit_file`, `append_file`, or `move_path` mutation executes. Read-only turns incur zero disk overhead.
- **Reverse-Chain Multi-Turn Rollback:** Restores modified files to their exact pre-mutation bytes and cleanly deletes newly created files across multiple turns.
- **Two Recovery Modes:** **Revert & Rewind Chat** (restores disk files, rewinds chat history, and places your original prompt back into the Composer ready to edit) or **Files Only** (restores disk state while keeping chat history intact).
- **Interactive Revert Modal:** Sequential checkpoint numbering (`Checkpoint #1`, `#2`, …) accessible via inline turn pills, `/revert`, `/revert <num>`, or `/rewind`.

### Intelligent Context Compaction
- **Automatic 75% Threshold:** Projects incoming prompt + tool overhead before each turn and automatically compacts older turns once context pressure reaches **75%** of the active window, plus mid-turn overflow recovery.
- **Ground-Truth Fact Retention:** Preserves the original task anchor, user constraints, verified modified/inspected files, command execution outcomes, and open todos while summarizing older dialogue.
- **Manual Compaction:** Trigger anytime via `/compact [optional focus]` or the Composer's **Context & Runtime** meter.

### Real-Time Hardware & Cloud Cost Telemetry
- **Live Local Gauges:** Real-time GPU utilization, temperature, VRAM allocation, system RAM, active resident Ollama models (with 1-click VRAM unload), and smoothed `tok/s` speed tracking.
- **Cloud Usage & Cost Calculator:** Tracks exact input, output, cached, and schema-saved tokens with per-model USD cost estimates and cache-hit rates across Claude, OpenAI, Gemini, DeepSeek, Grok, and custom overrides.

### Adaptive Void Black & Soft Light UI
- **Refined Dual Themes:** Frosted `#181818` Soft Dark theme with an animated aurora hero, plus a high-contrast warm-stone **Soft Light** theme (`Auto (VS Code)`, `Soft Dark`, `Soft Light`).
- **Narrow Sidebar Ready:** Engineered to stay crisp and readable down to `300px` VS Code Activity Bar sidebars.
- **Guided Setup Wizard:** First-run onboarding senses installed local runtimes/models, recommends hardware-matched models with 1-click `ollama pull` progress bars, or tests and connects cloud API keys.

---

## Interaction Modes

Switch modes anytime from the Composer dropdown without losing session history or **Maintained Project Context**:

| Mode | Purpose | File Mutations & Terminal | Safety Step Ceiling |
| :--- | :--- | :---: | :---: |
| **Chat** | Read-only Q&A, codebase inspection, and live web lookup; outputs copyable code snippets instead of editing disk | No | `100` steps |
| **Plan** | Read-only codebase exploration, 2–4 clarifying questions when ambiguous, and structured Markdown architecture plans | No | `150` steps |
| **Agent** | Autonomous multi-file editing, terminal command execution, diagnostics verification, and MCP tool invocation | Yes (Approval-gated by default) | `200` steps |

---

## Slash Commands & VS Code Integration

### Composer Slash Commands
Type `/` in the Composer input to open the keyboard-navigable command menu:

| Command | Action |
| :--- | :--- |
| `/revert` | Opens the interactive Checkpoint Revert Modal. |
| `/revert <num>` | Rolls back directly to `Checkpoint #<num>` and rewinds chat. |
| `/rewind` | Instantly rolls back the latest mutating turn and restores your prompt. |
| `/compact [focus]` | Compacts conversation history to free up context tokens (with optional focus topic). |

### Command Palette & `@photon` Chat Participant
- `Photon: Open Chat` (`photon.openChat`) — Focuses the Photon sidebar view (also bound to the VS Code Status Bar indicator).
- `Photon: New Chat` (`photon.newSession`) — Starts a fresh session.
- `Photon: Refresh Ollama Models` (`photon.refreshModels`) — Re-scans local and configured models.
- `Photon: Run Machine + Model Diagnostics` (`photon.runDiagnostics`) — Writes redacted hardware, model, and runtime diagnostics to the `Photon` Output channel.
- `@photon` — Send prompts and `#file` / image references directly from VS Code's native Chat panel into Photon.

---

## Built-in Tools & MCP

Photon ships with **17 built-in tools** (automatically mapped to industry-standard native tool aliases in Cloud mode) plus **Model Context Protocol (MCP)** support:

| Tool | Category | Description |
| :--- | :--- | :--- |
| `read_file` | Files | Line-numbered file slicing (`start_line` / `end_line`), binary NUL-byte rejection, and UTF-8 BOM preservation. |
| `edit_file` | Files | Atomic find-and-replace with CRLF/LF preservation, gutter/whitespace tolerance, and pre-mutation checkpointing. |
| `write_file` | Files | Atomic file creation/overwrite with workspace boundary enforcement and checkpointing. |
| `append_file` | Files | Appends content to existing or new workspace files without full-file rewrites. |
| `move_path` | Files | Renames or moves files/directories within the workspace while preventing silent overwrites. |
| `list_dir` | Search | Lists directory entries (folders first), excluding build/cache folders (`node_modules`, `dist`, `.git`). |
| `find_files` | Search | Fast workspace glob and substring file discovery. |
| `search_code` | Search | Workspace-wide regex and literal code search with file/line reporting. |
| `code_outline` | Search | Extracts top-level functions, classes, interfaces, and type declarations. |
| `get_diagnostics` | Verify | Reads live VS Code compiler, typechecker, and linter diagnostics. |
| `run_command` | Terminal | Executes workspace shell commands with chaining/obfuscation analysis and destructive-command approval locks. |
| `query_project_context` | Memory | Queries Photon's maintained symbol index, file summaries, and cross-turn handoff notes. |
| `update_project_context` | Memory | Records persistent architectural notes and decisions for the workspace. |
| `todo_write` | Workflow | Maintains structured task checklists (`pending`, `in_progress`, `done`, `blocked`). |
| `think` | Workflow | Scratchpad reasoning tool for structured step planning on compact models. |
| `web_search` | Web | Live web search via DuckDuckGo (HTML/Lite/Instant) and Google with weather/currency fast paths. |
| `web_fetch` | Web | Fetches and cleans public `https://` pages with DNS-pinned SSRF protection across every redirect hop. |

**MCP Integration (`.vscode/mcp.json`):** Supports both `stdio` (sanitized environment variable allowlist + command allowlist) and `http`/`sse` (DNS-pinned remote endpoints) with config SHA-256 trust fingerprinting and persistent or session-scoped approval in **Settings → Advanced**.

---

## Architecture

```text
src/
├── core/          # Pure TypeScript engine (zero 'vscode' imports — enforced at build time)
│   ├── adaptive/      # Hardware/VRAM profiler, KV-cache planner, Auto-Mode router, Capability Passport
│   ├── agent/         # Local Unified Engine, Cloud Engine, 75% Compactor, Error Recovery
│   ├── bench/         # Photon Bench v5 (throughput, block & native tool-call reliability)
│   ├── checkpoints/   # Lazy pre-mutation snapshots & reverse-chain rollback engine
│   ├── context/       # Maintained Project Context & cross-model turn handoff
│   ├── index/         # Sliding-window code chunker & offline Ollama vector store
│   ├── intelligence/  # Task analyzer, Inverse Scaffolding policy, narration/deflection guards
│   ├── llm/           # Provider adapters (Ollama, Anthropic, Gemini, OpenAI-compatible) & catalogs
│   ├── prompts/       # Budgeted Local & Cloud system prompt builders
│   ├── protocol/      # Tolerant Photon-Block parser & compact/native tool serializers
│   └── tools/         # 17 built-in tools, path/command security, DNS-pinned MCP client
├── photon-core/   # Tool execution pipeline & event-sourced loop primitives
├── host/          # VS Code integration (PhotonController, ChatViewProvider, SecretStorage, watchers)
└── shared/        # Dependency-free protocol & domain types shared with the React webview
webview-ui/        # React 18 + Vite UI (Void Black & Soft Light design system)
```

---

## Supported Providers & Models

### Local Runtimes (Offline)
- **Ollama** (`http://localhost:11434`) — Process start/stop, disk & live model sensing, 1-click `ollama pull` with ETA, VRAM residency control (`keepAlive`), and local RAG embeddings (`nomic-embed-text`).
- **llama.cpp** (`http://localhost:8080`) — Managed `llama-server` startup, port-conflict recovery, and per-model CLI flag builder (`-c`, `-ngl`, `--fit`, `-fa`, `-ctk`, `-ctv`).
- **LM Studio & vLLM** — Local runtime detection and OpenAI-compatible connection presets.

### Cloud Frontier Providers (BYOK)
- **Anthropic Claude:** `claude-sonnet-4-5`, `claude-opus-4-1`, `claude-haiku-4-5`, `claude-sonnet-4`, `claude-3-7-sonnet` (with ephemeral system/tool prompt caching)
- **OpenAI:** `gpt-5`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`, `o3`, `o4-mini`
- **Google Gemini:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`
- **NVIDIA NIM:** `deepseek-ai/deepseek-r1`, `qwen/qwen2.5-coder-32b-instruct`, `meta/llama-3.3-70b-instruct`
- **OpenRouter, OpenCode Zen, Blackbox AI, & Custom Endpoints** (`Groq`, `DeepSeek`, `Mistral`, `Together`, `xAI Grok 4`, or any OpenAI-compatible URL)

*All API keys are stored exclusively in VS Code `SecretStorage` — never written to `settings.json`, project files, or logs.*

---

## Installation & Quick Start

### Prerequisites
- **VS Code** `1.90.0` or newer
- **Ollama** *(recommended for local mode)* — [ollama.com](https://ollama.com)

Recommended starter local models:
```bash
# Sweet-spot 7B local coding (6–8 GB VRAM)
ollama pull qwen2.5-coder:7b

# Compact multimodal & reasoning (4–6 GB VRAM)
ollama pull gemma4:e4b

# Lightweight 3B coding (4 GB VRAM / CPU-friendly)
ollama pull qwen2.5-coder:3b

# Optional: Offline workspace semantic RAG embeddings
ollama pull nomic-embed-text
```

### Build & Install from Source
```bash
npm install
npm run package
code --install-extension photon-0.1.0.vsix
```

Open VS Code, click the **Photon** icon in the Activity Bar, complete the 2-step Setup Wizard (Local or Cloud), and start building.

---

## Configuration Reference

Configure via Photon's in-app **Settings** panel or VS Code Settings (`Ctrl+,` / `Cmd+,` → `Photon`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `photon.interfaceMode` | `"local"` | Active execution stack: `"local"` (Ollama / llama.cpp) or `"cloud"` (direct BYOK APIs) |
| `photon.defaultMode` | `"chat"` | Default interaction mode (`"chat"`, `"plan"`, `"agent"`) |
| `photon.defaultModel` | `""` | Default selected model (empty = best/first available) |
| `photon.adaptive.enabled` | `true` | Auto-tune context window, prompt scaffolding, and tool protocol to hardware + model |
| `photon.adaptive.freeze` | `false` | Freeze live Reliability Governor escalations and Capability Passport priors |
| `photon.intelligence.level` | `"auto"` | Guidance preset (`"auto"`, `"max"`, `"high"`, `"medium"`, `"low"`) |
| `photon.tools.autoApprove` | `false` | Auto-approve non-destructive file edits and allowlisted commands |
| `photon.ollama.baseUrl` | `"http://localhost:11434"` | Ollama server URL |
| `photon.ollama.keepAlive` | `"-1"` | Keep active local model resident in VRAM (`"-1"`, `"30m"`, `"2h"`, or `""`) |
| `photon.ollama.preloadOnStartup` | `true` | Warm-load the selected local model in the background on startup |
| `photon.llamacpp.baseUrl` | `"http://localhost:8080"` | `llama-server` base URL |
| `photon.bench.autoRun` | `false` | Run Photon Bench automatically on un-benchmarked local models in the background |
| `photon.webSearch.provider` | `"duckduckgo"` | Live search provider (`"duckduckgo"`, `"google"`, `"none"`) |
| `photon.index.enabled` | `false` | Enable offline local vector indexing for workspace RAG |
| `photon.index.embeddingModel` | `"nomic-embed-text"` | Local Ollama embedding model used for workspace indexing |

Team-shared model defaults can also be checked into `.photon/config.json` (created via **Settings → General → Project Config**; `autoApprove` in repo configs is ignored by design).

---

## Privacy, Security & Data Isolation

- **Strict Stack Separation:** Local mode executes 100% on-device. Cloud mode transmits prompts and relevant code context strictly to the user-enabled BYOK endpoint — with zero proxy servers and zero silent Local-to-Cloud fallback.
- **Workspace Path Containment:** `resolveInWorkspace` blocks lexical traversal (`..`), Windows UNC/cross-drive escapes, and symlinks pointing outside the workspace root.
- **Terminal & Destructive Action Guards:** Shell commands are scanned for chaining (`&&`, `;`, `|`, backticks, `$()`), caret/Base64/EncodedCommand obfuscation, privilege escalation, and destructive operations (`rm -rf`, `git reset --hard`, force push). High-risk commands always require explicit single-turn confirmation (`Always allow` is disabled).
- **SSRF & Secret Scrubbing:** `web_fetch` and remote MCP transports validate DNS resolution and pin connections to block localhost, RFC1918 private, and link-local IPs across redirects. Session persistence and diagnostics automatically redact API keys, `Bearer` tokens, and credentials.

---

## Development & Verification

```bash
# Install dependencies
npm install

# Typecheck extension host + React webview
npm run typecheck

# Run full unit & UI E2E suite (639 tests across 192 suites)
npm test

# Run deterministic multi-tier adaptive eval release gate
npm run eval:gate

# Build production webview + extension bundle
npm run build

# Package production VSIX
npm run package

# Launch standalone browser workbench for live UI inspection
npm run workbench
```

---

## License

Released under the [MIT License](LICENSE).
