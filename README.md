# 🚀 Photon

**Agentic coding with small local LLMs — tuned so low-end models actually cope.**

[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](https://github.com/photon-agent/photon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.90.0-blue.svg)](https://code.visualstudio.com/)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/photon-agent/photon/pulls)

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Architecture](#-architecture)
  - [Adaptive Orchestrator](#adaptive-orchestrator)
  - [Photon-Block Protocol](#photon-block-protocol)
  - [Agent Engine & Event-Sourced Harness](#agent-engine--event-sourced-harness)
  - [Local Runtime & Process Manager](#local-runtime--process-manager)
- [Modes](#-modes)
- [Built-in Tools](#-built-in-tools)
- [Intelligence Levels & Auto Mode](#-intelligence-levels--auto-mode)
- [Installation & Quick Start](#-installation--quick-start)
- [Configuration](#-configuration)
- [Development & Testing](#-development--testing)
- [License](#-license)

---

## 🔍 Overview

Photon is a VS Code extension engineered to bridge the gap between small local LLMs (3B–16B parameter models like Qwen 2.5 Coder, DeepSeek Coder V2, Gemma 3, and Llama 3.2 via Ollama, LM Studio, or llama.cpp) and cloud models.

Unlike standard extensions built primarily for frontier models (GPT-4o, Claude 3.5 Sonnet) that treat local models as an afterthought, **Photon is designed around the resource constraints, smaller context windows, and tool-calling quirks of compact models.** It dynamically adapts prompts, context budgets, tool protocols, and execution parameters to ensure small local LLMs punch above their weight.

---

## ✨ Key Features

### 🎯 Adaptive Intelligence & Machine Profiling
- **Hardware Tiering:** Automatically measures available CPU, system RAM, and GPU VRAM to classify system capability tiers (`Low`, `Mid`, `High`).
- **Model Profiling & Catalog Advisor:** Analyzes model size, context length, tool training status, and parameter counts to recommend optimal setups.
- **Task Complexity Analysis:** Analyzes user prompts to categorize task complexity and dynamically assign context token allocations, output caps, and tool permissions.
- **Auto Mode:** Automatically chooses the optimal intelligence level, system prompt depth, and model for each task, displaying human-readable reasoning in the UI.

### 🛠️ Robust Tooling & Resilient Protocol
- **Photon-Block Tool Protocol:** A flat, forgiving bracket-tagged tool syntax (`[TOOL name] arg: value [/TOOL]`) optimized for local models that struggle with rigid JSON schemas.
- **Automated Tool Repair:** Intercepts malformed tool invocations and streams targeted repair prompts (up to 2 retries) without interrupting the workflow.
- **Comprehensive Built-in Tools:** File inspection/manipulation, workspace symbol mapping, local project context management, code searching, terminal execution, diagnostic inspection, and web search.
- **MCP (Model Context Protocol) Support:** Bridge external MCP servers defined in `.vscode/mcp.json` into the agent registry with strict human approval controls.

### 🤖 Multi-Mode Agency & Harness Architecture
- **Chat Mode:** Read-only conversation and coding guidance with zero file side-effects.
- **Plan Mode:** Read-only architectural investigation and task checklist generation before making changes.
- **Agent Mode:** Autonomous multi-turn task execution with explicit approval controls for file edits and terminal commands.
- **Event-Sourced Harness (Experimental):** Features an event-driven `AgentLoop` architecture with session registry and inbox patterns for robust step tracking.

### 📂 Offline-First & Local RAG
- **Local Vector Store:** Pure-TypeScript vector database for offline code search and RAG.
- **Local Embedding Support:** Embeds workspace code locally using Ollama (`nomic-embed-text`), avoiding external data transmission.
- **Project Context Management:** Indexes workspace symbols, maintains persisted project insights, and tracks file modifications dynamically.

### ☁️ Multi-Provider Support
- **Local Runtimes:** Native Ollama client, LM Studio detection, llama.cpp process management, and live model pull tracking.
- **Cloud Providers:** Google Gemini, Anthropic Claude, OpenAI, NVIDIA NIM, Blackbox AI, OpenRouter, OpenCode Zen, and arbitrary OpenAI-compatible custom endpoints.

---

## 🏗️ Architecture

### Adaptive Orchestrator

For every turn, Photon computes an `AdaptivePlan` using five pipeline stages:

1. **Hardware Profiling:** Assesses machine RAM/VRAM constraints and reserves safety buffers.
2. **Model Profiling:** Inspects model capabilities, context window capabilities, and function-calling capabilities.
3. **Task Analysis:** Estimates task complexity based on intent keywords, referenced file paths, and projected step counts.
4. **Benchmark Data:** Uses execution speed and throughput metrics stored from Photon Bench runs.
5. **Prompt & Context Optimization:** Tunes system prompt verbosity, temperature, context allocation, and tool subsets.

### Photon-Block Protocol

Small LLMs frequently fail when generating strict, nested JSON for tool calls. Photon uses a token-efficient format:

```text
[TOOL read_file] path: src/index.ts [/TOOL]
```

The parser accepts:
- Flexible casing and key-value separators (`:` or `=`)
- Multi-line fenced text payloads
- Missing closing tags recovery
- Automatic fallback/upgrade to native function calling for tool-trained models

### Agent Engine & Event-Sourced Harness

- **Streaming & Token Budgeting:** Token-by-token generation with streaming UI updates and character/word-based token estimation.
- **Turn Context Gating:** Truncates older turns while preserving core context and workspace state.
- **Safety & Loop Protection:** Enforces step limits (1 to 100 turns) and requires human approval for destructive disk or system commands.
- **Dual Runtime Engine:** Supports both the baseline `UnifiedEngine` and the decoupled event-sourced `AgentLoop` harness.

### Local Runtime & Process Manager

- **Runtime Detection:** Probes system ports and process listings for Ollama, LM Studio, and llama.cpp.
- **Local Process Management:** Spawns local server binaries when necessary and monitors runtime status.
- **Model Downloader:** Manages model pulls with progress monitoring, ETA calculation, and free disk headroom validation (`DISK_HEADROOM_BYTES`).

---

## 🚦 Modes

| Mode | Purpose | File Edits | Command Execution | Use Case |
|------|---------|------------|-------------------|----------|
| **Chat** | Direct Q&A | ❌ No | ❌ No | Code explanations, refactoring advice, conceptual questions |
| **Plan** | System Blueprinting | ❌ No | ❌ No | Analyzing codebase structures and writing action checklists |
| **Agent** | Automated Coding | ✅ Yes (Approval required) | ✅ Yes (Approval required) | Implementing features, fixing bugs, writing tests |

---

## 🛠️ Built-in Tools

| Tool | Category | Description |
|------|----------|-------------|
| `read_file` | Files | Read source code files with optional line range controls |
| `write_to_file` | Files | Write or create files with full content |
| `replace_in_file` | Files | Precise pattern replacement within targeted files |
| `list_files` | Files | List files in specified workspace paths |
| `search_files` | Search | Regex or text search across workspace files |
| `find_files` | Search | Quick filename pattern matching |
| `workspace_map` | Search | High-level overview of files and definitions |
| `execute_command` | System | Shell command execution with approval gating and timeout protection |
| `query_project_context` | Context | Retrieve dynamic workspace architecture and symbol line ranges |
| `update_project_context` | Context | Persist high-level architecture insights and turn notes |
| `web_search` | External | Search web results via DuckDuckGo or Google |
| `web_fetch` | External | Fetch and extract text from public web URLs |
| `get_diagnostics` | Code | Extract current VS Code linter and compiler diagnostics |
| `todo_write` | Workflow | Track multi-step task checklists in the agent UI |
| `ask_followup_question` | Workflow | Prompt user for clarification during execution |
| `attempt_completion` | Workflow | Finalize turn output and output summary |

---

## 🧠 Intelligence Levels & Auto Mode

Photon configures model execution parameters across five intelligence tiers:

| Intelligence Level | Max Tools | Output Token Cap | Strategy |
|--------------------|-----------|------------------|----------|
| **Auto** | Dynamic | Dynamic | Automatic model selection based on task & hardware |
| **Low** | 5 | 768 tokens | Lightweight models on tight RAM/context budgets |
| **Medium** | 8 | 2048 tokens | Standard local coding workflows |
| **High** | 11 | 4096 tokens | Multi-file features and larger models |
| **Maximum** | 14 | 8192 tokens | Capable models (16B+ or Cloud APIs) |

---

## ⬇️ Installation & Quick Start

### Prerequisites

- **VS Code:** v1.90.0 or later
- **Ollama:** (Recommended for local models) — Download from [ollama.com](https://ollama.com)

Recommended models:
```bash
# General Coding (7B)
ollama pull qwen2.5-coder:7b

# High Capacity MoE Coding (16B)
ollama pull deepseek-coder-v2:lite

# Lightweight Coding (4B)
ollama pull gemma3:4b

# Local Embeddings for Offline Workspace RAG
ollama pull nomic-embed-text
```

### Installation

1. Download or package the extension VSIX (`photon-0.1.0.vsix`).
2. Install via VS Code CLI:
   ```bash
   code --install-extension photon-0.1.0.vsix
   ```
3. Open VS Code, select the **Photon** tab in the Activity Bar, select your model, and start coding.

---

## ⚙️ Configuration

Key settings accessible via VS Code Settings (`Ctrl+,` / `Cmd+,` → search **Photon**):

| Setting | Default | Description |
|---------|---------|-------------|
| `photon.ollama.baseUrl` | `http://localhost:11434` | Ollama server base URL |
| `photon.ollama.connectTimeoutMs` | `300000` | Connection timeout for loading cold models |
| `photon.ollama.requestTimeoutMs` | `180000` | Token stream idle timeout |
| `photon.defaultMode` | `"chat"` | Default active mode (`chat`, `plan`, `agent`) |
| `photon.intelligence.level` | `"auto"` | Intelligence level tier |
| `photon.adaptive.enabled` | `true` | Enable hardware and model dynamic tuning |
| `photon.index.enabled` | `false` | Enable local RAG indexing |
| `photon.index.embeddingModel` | `"nomic-embed-text"` | Ollama embedding model |
| `photon.experimental.harness` | `false` | Enable event-sourced agent loop harness |

---

## 🛠️ Development & Testing

### Workspace Setup

```bash
# Install dependencies
npm install

# Build Webview and Extension
npm run build

# Run Typecheck
npm run typecheck

# Run Test Suite
npm test
```

### Watching for Changes

```bash
npm run dev
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
