# 🚀 Photon

**Agentic coding with small local LLMs — tuned so low-end models actually cope.**

[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](https://github.com/photon-agent/photon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-^1.90.0-blue.svg)](https://code.visualstudio.com/)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/photon-agent/photon/pulls)

---

## 📖 Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
  - [Adaptive Orchestrator](#adaptive-orchestrator)
  - [Photon-Block Protocol](#photon-block-protocol)
  - [Agent Engine](#agent-engine)
- [Modes](#modes)
  - [Chat Mode](#chat-mode)
  - [Plan Mode](#plan-mode)
  - [Agent Mode](#agent-mode)
- [Tools](#tools)
- [Intelligence Levels](#intelligence-levels)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Install from Marketplace](#install-from-marketplace)
  - [Install from VSIX](#install-from-vsix)
- [Configuration](#configuration)
- [Model Compatibility](#model-compatibility)
- [Development](#development)
  - [Setup](#setup)
  - [Building](#building)
  - [Testing](#testing)
  - [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## 🔍 Overview

Photon is a VS Code extension that bridges the gap between frontier cloud models and small local LLMs. While most AI extensions are designed for "god-tier" models (like Claude 3.5 Sonnet or GPT-4o) and treat local models as an afterthought, **Photon is built from the ground up for the 3B–16B parameter class.**

It doesn't just "support" local models; it actively adapts its prompts, tool protocols, and context management to the specific constraints of your hardware and the model you're running.

> **Why Photon?** Tools like Cline, Roo Code, and the former Continue.dev are model-agnostic—designed for powerful cloud models and bolted-on local support afterward. Photon flips this: it's purpose-built for small models, making them punch above their weight through adaptive tuning and specialized tooling.

---

## ✨ Key Features

### 🎯 Adaptive & Intelligent
- **Machine Profiling**: Automatically detects your hardware specs (RAM, CPU, GPU) and classifies machine capability tiers.
- **Model Profiling**: Enriches model metadata with context length, tool-training status, and parameter-based tiering.
- **Task Analysis**: Estimates request complexity and selects optimal model + settings accordingly.
- **Auto Mode**: Picks the best intelligence level and model for each task, with transparent reasoning shown in the UI.

### 🛠️ Robust Tooling
- **Photon-Block Format**: A forgiving, bracket-tagged tool protocol (`[TOOL name] arg: value [/TOOL]`) that lets small models reliably call tools even when they struggle with strict JSON.
- **Tool Repair**: Detects malformed tool calls and sends corrective prompts (max 2 retries) instead of failing silently.
- **Built-in Tools**: File operations, directory listing, code search, web search, command execution, and more.
- **MCP Integration**: Import Model Context Protocol servers via `.vscode/mcp.json` for extended capabilities.

### 🤖 Multi-Mode Agency
- **Chat Mode**: Pure conversation and coding Q&A — answers with code snippets.
- **Plan Mode**: Read-only workspace investigation and architectural planning.
- **Agent Mode**: Full-cycle autonomous coding with file edits and command execution (with approval gating).

### 📂 Offline-First
- **Local Vector Store**: A pure-TypeScript vector store that runs entirely locally. Uses local Ollama embeddings for RAG across your workspace without cloud dependency.
- **Incremental Indexing**: Chunks and embeds files incrementally, watches for changes, and persists across reloads.

### ☁️ Multi-Provider Support
- **Local**: Native Ollama integration (primary provider).
- **Cloud**: Gemini, Claude, NVIDIA NIM, Blackbox AI, OpenRouter, OpenCode Zen, and any OpenAI-compatible endpoint.
- **Smart Routing**: Routes by model prefix and gracefully falls back when providers are rate-limited.

---

## 🏗️ Architecture

### Adaptive Orchestrator

Photon doesn't use a one-size-fits-all system prompt. It generates an `AdaptivePlan` for every session through a five-stage process:

1. **Machine Profiling** — Detects hardware class (Low/Mid/High-end) to cap context windows and adjust settings.
2. **Model Profiling** — Analyzes model size, tool-calling capabilities, and training data.
3. **Task Analysis** — Estimates complexity based on request keywords, file references, and projected steps.
4. **Benchmark Integration** — Leverages Photon Bench results for model throughput and reliability data.
5. **Optimization** — Adjusts the "Intelligence Level" to balance reasoning power with context window limits.

All decisions are transparent—Photon provides a human-readable `rationale` shown directly in the UI.

### Photon-Block Protocol

A flat, bracket-tagged tool format designed for models that struggle with JSON:

```
[TOOL read_file] path: src/utils/helpers.py [/TOOL]
```

The parser tolerates:
- Casing variations and whitespace
- `:` or `=` separators
- Quoted or unquoted values
- Fenced multi-line values
- Missing or malformed close tags

Tool-trained models automatically upgrade to native Ollama function calling for maximum reliability.

### Agent Engine

- **Streaming**: Token-by-token response generation
- **Context Manager**: Fits conversation into model context window by intelligently dropping oldest turns
- **Approval Gating**: Destructive operations (file writes, command execution) require user approval by default
- **Anti-Loop Guards**: Prevents infinite loops with configurable step limits (1/50/100 per mode)
- **Token Budgeting**: Lightweight estimation using chars/4 + word-count heuristics

---

## 🚦 Modes

### Chat Mode
Pure conversation mode — no tools, no file edits. Perfect for asking coding questions and getting direct answers with code snippets. No side effects.

### Plan Mode
Read-only investigation mode. Uses only safe tools (read, list, search, find). Produces a numbered plan without touching any files. Great for architectural discussions and feasibility analysis.

### Agent Mode
Full autonomous coding mode. Uses tools to edit files and run commands, one step at a time, with **user approval gating** for destructive operations. Configurable step limits ensure the agent doesn't run indefinitely.

---

## 🔧 Tools

### Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with optional line ranges and line numbers |
| `write_file` | Create or overwrite files in the workspace |
| `edit_file` | Find-and-replace edits with unique match validation |
| `list_dir` | List directory contents (filters node_modules, .git, etc.) |
| `find_files` | Find files by name/path using VS Code's index |
| `search_code` | Full-text search across workspace files |
| `run_command` | Execute shell commands with timeout and approval gating |
| `web_search` | DuckDuckGo search (no API key required) |

### MCP Integration

Import any Model Context Protocol server from `.vscode/mcp.json`. Servers start in "pending" state, require explicit user approval, and their tools are bridged into the registry only when connected.

---

## 🧠 Intelligence Levels

Photon scales prompt complexity and tool availability across five intelligence levels:

| Level | Max Tools | Parallel Calls | Output Cap | Best For |
|-------|-----------|----------------|------------|----------|
| **Auto** | Dynamic | Dynamic | Dynamic | Automatic model + settings selection |
| **Low** | 5 | No | 768 tokens | Weak models / tight context windows |
| **Medium** | 8 | Limited | 2048 tokens | Standard coding tasks |
| **High** | 11 | Yes | 4096 tokens | Multi-file workflows |
| **Maximum** | 14 | Yes | 8192 tokens | Capable frontier models |

Each level defines: max tools, parallel tool calls, output cap, temperature, and prompt detail. Weak models get terse prompts; capable models get rich multi-file workflow guidance.

### Auto Mode Details

When enabled, Auto Mode:
- Analyzes task complexity (keywords, file references, estimated steps)
- Ranks available models by: context fit, throughput, tool reliability, and tier match
- Selects the optimal intelligence level and model combination
- Shows transparent reasoning in the UI's Transparency Panel

---

## ⬇️ Installation

### Prerequisites

- **VS Code** (v1.90.0 or later)
- **Ollama** (for local models)
  - Install from [ollama.com](https://ollama.com)
  - Pull a recommended model:
    ```bash
    ollama pull qwen2.5-coder:7b    # Great general coding model
    ollama pull deepseek-coder-v2:lite  # 16B MoE, ~10GB VRAM
    ollama pull gemma3:4b           # Lightweight, fast
    ```
  - For workspace indexing:
    ```bash
    ollama pull nomic-embed-text    # Local embedding model
    ```

### Install from Marketplace

1. Open VS Code Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for "Photon"
3. Click **Install**
4. Reload VS Code when prompted

### Install from VSIX

For development builds:

```bash
# Install the included VSIX
code --install-extension photon-0.1.0.vsix

# Or build from source (see Development section)
```

### Quick Start

1. Install Photon and open VS Code
2. Launch Ollama (it runs as a background service)
3. Open the Photon sidebar (click the photon icon in the Activity Bar)
4. Select your model from the dropdown
5. Start chatting!

---

## ⚙️ Configuration

Photon is highly configurable through VS Code Settings. Access via `Ctrl+,` → search "Photon":

### Core Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `photon.ollama.baseUrl` | `http://localhost:11434` | Base URL of the Ollama server |
| `photon.ollama.requestTimeoutMs` | `180000` | Idle timeout between streamed tokens |
| `photon.defaultModel` | `""` | Model selected by default (empty = first available) |
| `photon.defaultMode` | `"chat"` | Default interaction mode |
| `photon.interfaceMode` | `"local"` | Engine stack: `local` (Ollama) or `cloud` |
| `photon.tools.autoApprove` | `false` | Auto-approve tool actions without prompting |
| `photon.adaptive.enabled` | `true` | Enable automatic tuning to machine + model |

### Context & Intelligence Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `photon.context.reserveOutputTokens` | `1024` | Tokens reserved for model reply in context budget |
| `photon.intelligence.level` | `"auto"` | Prompt complexity and tool machinery level |
| `photon.index.enabled` | `false` | Enable offline workspace indexing |
| `photon.index.embeddingModel` | `nomic-embed-text` | Local Ollama model for embeddings |

### Cloud Provider Settings

Each provider can be individually enabled and configured:

| Provider | Setting |
|----------|---------|
| **Gemini** | `photon.providers.gemini.enabled` |
| **Claude** | `photon.providers.claude.enabled` |
| **NVIDIA NIM** | `photon.providers.nvidia.enabled` |
| **OpenAI** | `photon.providers.openai.enabled` |
| **OpenRouter** | `photon.providers.openrouter.enabled` |
| **OpenCode Zen** | `photon.providers.opencode.enabled` |
| **Blackbox AI** | `photon.providers.blackbox.enabled` |
| **Custom** | `photon.providers.custom` (array of endpoint configs) |

API keys are stored securely in VS Code's secret storage—never in plain text.

---

## 📋 Model Compatibility

Photon is optimized for **small local models (3B–16B parameters)** running via Ollama, but also fully supports cloud providers.

### Tested Local Models

| Model | Size | Notes |
|-------|------|-------|
| Qwen2.5-Coder | 3B, 7B | Excellent fill-in-the-middle coding |
| Qwen3 | 4B, 8B | Latest Qwen series, good general performance |
| DeepSeek-Coder-V2-Lite | 16B MoE | ~10GB VRAM, credible agentic coding |
| Gemma 3 | 4B, 7B | Fast, lightweight |
| Devstral Small | 24B | Apache-2.0, strong agentic performance |

### Cloud Models

Photon supports the full model catalogs of:
- **Google**: Gemini 2.5 Pro/Flash, 2.0 Flash Lite
- **Anthropic**: Claude Opus-4, Sonnet-4, Haiku-4.5
- **NVIDIA**: Llama-3.3-70B, DeepSeek-R1, Gemma-4-31B
- **Blackbox**: blackboxai-pro, Llama-3.3-70B
- **OpenRouter**: Any model in their catalog
- **Custom**: Any OpenAI-compatible endpoint

---

## 💻 Development

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Extension Host** | TypeScript / VS Code API |
| **Frontend** | React 19 / Vite / Tailwind CSS |
| **State Management** | Custom Session & Project Stores |
| **Indexing** | Local Vector Store (Pure TypeScript) |
| **Build** | esbuild + Vite bundler |

### Setup

```bash
# Clone the repository
git clone https://github.com/photon-agent/photon.git
cd photon

# Install dependencies
npm install

# Verify the project builds
npm run compile
```

### Building

```bash
# Build the webview UI (React frontend)
npm run build:ui

# Compile the extension host (TypeScript)
npm run compile

# Full build (both UI and extension)
npm run build
```

### Testing

Photon uses Vitest for testing across multiple configurations:

```bash
# Run unit tests
npm test

# Run web tests
npm run test:web

# Run end-to-end tests
npm run test:e2e

# Run snapshot tests
npm run test:snapshot

# Run all benchmarks
npm run bench
```

#### Test Configurations

| Command | Configuration | Description |
|---------|---------------|-------------|
| `npm test` | `vitest.config.ts` | Unit tests for core logic |
| `npm run test:web` | `vitest.web.config.ts` | Web/frontend component tests |
| `npm run test:e2e` | `vitest.e2e.config.ts` | End-to-end integration tests |
| `npm run test:snapshot` | `vitest.snapshot.config.ts` | Snapshot-based tests |
| `npm run test:expected` | `vitest.expected.config.ts` | Expected output tests |
| `npm run test:stress` | `vitest.web-stress.config.ts` | Performance stress tests |
| `npm run bench` | `vitest.web-stress.config.ts` | Benchmarks |

### Project Structure

```
photon/
├── src/                          # Extension host source
│   ├── photon-core/              # Core engine
│   │   ├── agent/                # Agent loop & orchestration
│   │   ├── boot/                 # Bootstrap & initialization
│   │   ├── intelligence/         # Adaptive engine & model profiling
│   │   ├── llm/                  # Provider integrations (Ollama, Gemini, etc.)
│   │   ├── loop/                 # Conversation & tool execution loops
│   │   ├── session/              # Session & state management
│   │   ├── systemPrompt/         # System prompt builder
│   │   └── tools/                # Built-in tool implementations
│   ├── core/                     # Shared core utilities
│   ├── host/                     # VS Code host environment
│   ├── shared/                   # Shared types & utilities
│   └── extension.ts              # Extension entry point
├── webview-ui/                   # React webview frontend
│   └── src/
│       ├── components/           # UI components
│       ├── state/                # Frontend state management
│       ├── theme/                # Theme definitions
│       └── App.tsx               # Main app component
├── docs/                         # Documentation
├── media/                        # Media assets (icons, SVGs)
├── photon-0.1.0.vsix             # Pre-built extension package
├── esbuild.mjs                   # Build script
├── tsconfig.json                 # TypeScript configuration
└── package.json                  # Dependencies & scripts
```

---

## 📚 Documentation

- **Architecture** — Event-sourced sessions, agent/inbox/registry, everything-is-a-plugin design.
- **Migration Guide** — `docs/PHOTON_HARNESS_MIGRATION.md`

---

## 🤝 Contributing

Contributions are welcome! Please read our guidelines before contributing.

### How to Contribute

1. **Fork** the repository
2. **Create a branch** for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** following the codebase style
4. **Run tests** to ensure everything passes:
   ```bash
   npm test
   ```
5. **Open a Pull Request** with a clear description of your changes

### Development Guidelines

- Follow TypeScript strict mode conventions
- Add or update tests for new features
- Keep commits focused and well-described
- Update documentation (`docs/`) when changing architecture or behavior

### Reporting Issues

Found a bug or have a feature request? [Open an issue](https://github.com/photon-agent/photon/issues) with:
- VS Code version
- Ollama version (if applicable)
- Model being used
- Steps to reproduce
- Expected vs. actual behavior

---

## 📄 License

This project is licensed under the **MIT License**.

---

## 🙏 Acknowledgments

- **Ollama** — For the excellent local model runtime
- **VS Code Team** — For the extensible platform and APIs
- **Continue.dev** — For pioneering the local-model-first philosophy (before its acquisition)
- **Qwen, Gemma, DeepSeek teams** — For creating capable small models
- **Model Context Protocol** — For the MCP standard and server ecosystem

---

## 🪐 About the Name

A **photon** is a quantum of light — the fundamental particle that carries electromagnetic force. Just as photons enable vision and communication across vast distances, Photon brings the power of AI coding assistance to every developer, regardless of their hardware capabilities. Small models, big possibilities.

---

<div align="center">

**Built with ❤️ for developers who code on any machine, not just the expensive ones.**

</div>
