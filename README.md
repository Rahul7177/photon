# 🚀 Photon

**Agentic coding with small local LLMs — tuned so low-end models actually cope, with frontier cloud models as seamless overflow.**

[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](https://github.com/Rahul7177/photon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.90.0-blue.svg)](https://code.visualstudio.com/)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/Rahul7177/photon/actions)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Rahul7177/photon/pulls)

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [New in Version 0.1.0](#-new-in-version-010)
  - [Fail-Safe Checkpoints & Rollback](#-fail-safe-checkpoints--rollback)
  - [Intelligent Context Compaction](#-intelligent-context-compaction)
  - [Real-Time Hardware & Cost Telemetry](#-real-time-hardware--cost-telemetry)
  - [Modern Void Black & Animated Gradient UI](#-modern-void-black--animated-gradient-ui)
- [Interaction Modes](#-interaction-modes)
- [Slash Commands & Quick Actions](#-slash-commands--quick-actions)
- [Built-in Tools & Integrations](#-built-in-tools--integrations)
- [Architecture](#-architecture)
  - [Adaptive Orchestrator](#adaptive-orchestrator)
  - [Photon-Block Protocol](#photon-block-protocol)
  - [Pure TypeScript Checkpoint Engine](#pure-typescript-checkpoint-engine)
- [Supported Providers & Models](#-supported-providers--models)
- [Installation & Quick Start](#-installation--quick-start)
- [Configuration Reference](#-configuration-reference)
- [Development & Testing](#-development--testing)
- [License](#-license)

---

## 🔍 Overview

Photon is a VS Code extension engineered to bridge the gap between compact local LLMs (3B–16B parameter models like Qwen 2.5 Coder, DeepSeek-Coder-V2-Lite, Gemma 3, and Llama 3.2 via Ollama, LM Studio, or llama.cpp) and frontier cloud models.

Unlike standard extensions built for massive cloud models that treat local LLMs as an afterthought, **Photon is designed around the hardware constraints, smaller context windows, and tool-calling behaviors of compact models.** It dynamically adapts prompts, context budgets, tool protocols, and execution parameters to ensure small local LLMs punch above their weight.

---

## ✨ Key Features

- **Local-First & Offline Code Security:** Code, vector embeddings, and conversation state stay strictly on your local machine.
- **Adaptive Intelligence:** Automatically profiles CPU, system RAM, and GPU VRAM to select safe context ceilings, optimal models, and curated tool sets.
- **Resilient Photon-Block Protocol:** A flat, forgiving bracket-tagged tool syntax (`[TOOL name] arg: value [/TOOL]`) that lets local models execute tools reliably without JSON syntax errors.
- **Automated Tool Repair Loop:** Intercepts malformed tool invocations, streams targeted corrective examples, and recovers gracefully without crashing the workflow.
- **Model Context Protocol (MCP):** Connect external MCP servers declared in `.vscode/mcp.json` with strict approval controls.
- **Offline Workspace RAG:** Built-in vector embedding engine powered by Ollama (`nomic-embed-text`) with sliding-window code chunking.

---

## 🌟 New in Version 0.1.0

### ↺ Fail-Safe Checkpoints & Rollback (Copilot & Claude Code Parity)
Never worry about bad AI edits breaking your codebase. Photon automatically creates safe recovery checkpoints before mutating files on disk:
- **Lazy Pre-Mutation Snapshots:** Automatically records the original file content and state before any file edit, write, or move tool runs. Read-only queries have zero overhead.
- **Reverse-Chain Cumulative Rollback:** Restores files across multi-turn histories to their earliest pre-mutation state and deletes newly created files cleanly.
- **Revert & Rewind Chat:** Restores workspace files, truncates the chat history back to that checkpoint, and **automatically pastes your original prompt back into the chat box**, auto-focused and expanded for instant editing.
- **Files Only Mode:** Restores disk files while preserving your full conversation history.
- **Numbered Checkpoints & Revert Modal:** Checkpoints are sequentially numbered (`Checkpoint #1`, `Checkpoint #2`, …). Type `/revert` to open an interactive modal with file lists, relative timestamps, and one-click rollback buttons.

### 🗜️ Intelligent Context Compaction
Avoid context overflow errors during extended coding sessions:
- **Automatic Threshold Trigger:** Continuously tracks context pressure and automatically triggers structural compaction when token usage exceeds **75%** of the context window.
- **Preserved Core Insights:** Preserves the initial task objective, active files list, pending todos, key technical decisions, and the latest turns while summarizing older turns into a dense summary.
- **Visual Compaction Pill:** Real-time chat indicators display exact tokens saved and percentage reduction.
- **Manual Control:** Trigger compaction anytime via `/compact [focus]` or through the Context Meter.

### 📊 Real-Time Hardware & Cost Telemetry
- **Live System Telemetry:** Real-time gauges for CPU utilization, system RAM, available free memory, and GPU VRAM.
- **Frontier Cloud Cost Calculator:** Accurate token counting and USD cost tracking across OpenAI, Anthropic Claude, Google Gemini, and NVIDIA NIM with automatic cached-token discounts.
- **Hardware Metrics Modal:** Comprehensive dashboard displaying running Ollama models, VRAM allocation, and billing metrics.

### 🎨 Modern Void Black & Animated Gradient UI
- **Moving Blurred Gradient Hero:** Minimalist welcome screen inspired by the modern Gemini UI and official Photon website, featuring an animated moving gradient behind a bold matte foreground wordmark.
- **Smooth Animations:** Fluid transitions for dialogs, popovers, and message bubbles with native smooth scrolling throughout the chat.
- **Refined Matte Finish:** High-contrast dropdowns and pickers designed for dark themes with zero illegible hover states.
- **Crisp SVG Icons:** Complete vector icon set with zero emoji dependencies for a clean, distraction-free environment.

---

## 🚦 Interaction Modes

| Mode | Purpose | File Edits | Terminal Commands | Step Limit |
|------|---------|------------|-------------------|------------|
| **Chat** | Direct Q&A, refactoring advice, conceptual discussions | ❌ No | ❌ No | 6 steps |
| **Plan** | Read-only codebase investigation and structured checklist generation | ❌ No | ❌ No | 10 steps |
| **Agent** | Full autonomous coding, file editing, and command verification | ✅ Yes (Approval required) | ✅ Yes (Approval required) | 25 steps (Cloud: 200) |

---

## ⚡ Slash Commands & Quick Actions

Type `/` in the Composer input to open the command autocomplete menu:

| Command | Action |
|---------|--------|
| `/revert` | Opens the Checkpoint Revert Modal to choose a checkpoint to restore. |
| `/revert <num>` | (e.g. `/revert 1`) Instantly rolls back to Checkpoint #1, rewinding chat and restoring the prompt. |
| `/rewind` | Instantly rolls back the latest turn's file modifications and rewinds chat. |
| `/compact [focus]` | Condenses the active context window to free up tokens (optional focus area). |
| `/clear` | Clears conversation history and starts a fresh session. |

---

## 🛠️ Built-in Tools & Integrations

| Tool | Category | Description |
|------|----------|-------------|
| `read_file` | Files | Reads file slices with line numbering (`0001 │`), 200-line default slice, and 2 MB guards. |
| `edit_file` | Files | Targeted find-and-replace with whitespace and gutter tolerance. Snapshot-tracked. |
| `write_file` | Files | Creates or overwrites files with automatic directory creation. Approval-gated and snapshot-tracked. |
| `append_file` | Files | Appends content to existing files without overwriting. Approval-gated and snapshot-tracked. |
| `move_path` | Files | Moves or renames files and directories within the workspace boundary. Approval-gated and snapshot-tracked. |
| `list_dir` | Search | Lists directories (directories first) excluding build artifacts (`node_modules`, `dist`, `.git`). |
| `find_files` | Search | Fast file search via glob patterns (e.g. `**/*.ts`) or substring matching. |
| `search_code` | Search | Workspace-wide regex and substring code search with line number reporting. |
| `code_outline` | Search | Extracts top-level declarations, functions, classes, and types. |
| `run_command` | Terminal | Executes shell commands in the workspace root with single-command injection protection. |
| `get_diagnostics` | Verification | Retrieves active VS Code compiler, linter, and typechecker diagnostics. |
| `web_search` | External | Fast web searching via DuckDuckGo with Google fallback. |
| `web_fetch` | External | Fetches and cleans public web pages with SSRF and private IP protection. |
| `todo_write` | Workflow | Manages structured multi-step checklists (`pending`, `in_progress`, `done`, `blocked`). |

---

## 🏗️ Architecture

### Adaptive Orchestrator
Before every turn, Photon computes an `AdaptivePlan` through a five-stage pipeline:
1. **Hardware Profiling:** Assesses RAM/VRAM constraints and reserves safety buffers (22.5% RAM buffer on local machines).
2. **Model Profiling:** Reads context window limits and tool-calling support.
3. **Task Complexity:** Determines scope (`single_file`, `multi_file`, `codebase`) and reasoning depth.
4. **Benchmark Metrics:** Integrates real throughput (`tok/s`) and tool reliability rates.
5. **Context Budgeting:** Dynamically configures system prompt detail, temperature, and output token caps.

### Photon-Block Protocol
Small LLMs often fail when outputting strict, nested JSON for tool calls. Photon supports both native tool calling and its token-efficient flat block protocol:

```text
[TOOL read_file] path: src/index.ts [/TOOL]
```

### Pure TypeScript Checkpoint Engine
Located at `src/core/checkpoints/checkpointManager.ts`, the checkpoint engine maintains a clean architectural boundary with **zero `vscode` imports**. Checkpoint manifests are persisted to `.photon/checkpoints.json` with multi-turn reverse-chain traversal.

---

## ☁️ Supported Providers & Models

### Local Runtimes (Zero Cloud Transmission)
- **Ollama:** `http://localhost:11434` (native support, model pulls with live ETA, auto-detection)
- **llama.cpp:** `http://localhost:8080/v1` (managed process startup, GPU layer calculation)
- **LM Studio:** Automatic local port and process detection

### Cloud Frontier Providers (BYOK)
- **Google Gemini:** Gemini 2.0 Flash, Gemini 1.5 Pro (multimodal vision, high context)
- **Anthropic Claude:** Claude 3.5 Sonnet, Claude 3 Opus, Claude 3.5 Haiku
- **OpenAI:** GPT-4o, GPT-4o-mini, o1, o3-mini
- **NVIDIA NIM:** Nemotron-3.5-Super, Llama-3.1-405B
- **OpenRouter, OpenCode Zen, Blackbox AI, & Custom OpenAI-compatible endpoints**

*All API keys are securely stored in VS Code `SecretStorage` and never saved to settings files or logs.*

---

## ⬇️ Installation & Quick Start

### Prerequisites
- **VS Code:** `v1.90.0` or later
- **Ollama:** (Recommended for local models) — [ollama.com](https://ollama.com)

Recommended starter models:
```bash
# General Coding & Agentic Work (7B)
ollama pull qwen2.5-coder:7b

# High Capacity MoE Coding (16B)
ollama pull deepseek-coder-v2:lite

# Lightweight Coding (4B)
ollama pull gemma3:4b

# Local Embeddings for Workspace RAG
ollama pull nomic-embed-text
```

### Installation
1. Download or package the VSIX:
   ```bash
   npm run package
   ```
2. Install via VS Code CLI:
   ```bash
   code --install-extension photon-0.1.0.vsix
   ```
3. Open VS Code, click the **Photon** icon in the Activity Bar, select your model, and start coding.

---

## ⚙️ Configuration Reference

Access settings in VS Code (`Ctrl+,` / `Cmd+,` → search **Photon**):

| Setting | Default | Description |
|---------|---------|-------------|
| `photon.ollama.baseUrl` | `http://localhost:11434` | Ollama server URL |
| `photon.ollama.keepAlive` | `"30m"` | Model residency duration in VRAM after completion |
| `photon.llamacpp.baseUrl` | `http://localhost:8080` | llama.cpp server URL |
| `photon.defaultMode` | `"chat"` | Default active mode (`chat`, `plan`, `agent`) |
| `photon.intelligence.level` | `"auto"` | Intelligence preset (`auto`, `low`, `medium`, `high`, `max`) |
| `photon.adaptive.enabled` | `true` | Enable hardware-aware dynamic context and parameter tuning |
| `photon.tools.autoApprove` | `false` | Bypass confirmation prompts for file edits and terminal commands |
| `photon.webSearch.provider` | `"duckduckgo"` | Web search provider (`duckduckgo`, `google`, `none`) |
| `photon.index.enabled` | `false` | Enable local vector embedding and offline codebase RAG |

---

## 🛠️ Development & Testing

```bash
# Install dependencies
npm install

# Typecheck root and webview
npm run typecheck

# Run unit tests (244 tests passing)
npm test

# Build production bundles
npm run build

# Start live dev watchers
npm run dev
```

---

## 📄 License

Photon is open-source software licensed under the [MIT License](LICENSE).
