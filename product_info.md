# Photon — Product Info

## What is Photon?
A VS Code extension for **agentic coding with small local LLMs** (Qwen2.5-Coder, Gemma, Qwen3-8B, etc.) via Ollama. It adapts prompts, tools, and context to weak models on low-end machines — filling the gap left by Continue.dev's acquisition and cloud-first extensions that overwhelm small models.

---

## Core Architecture

### Adaptive Orchestrator
Reads machine specs (RAM/CPU/GPU) + model params to generate an `AdaptivePlan`: context window, temperature, output cap, tool protocol, tool count, and prompt verbosity. Every decision is transparent with a human-readable `rationale` shown in the UI.

### Photon-Block Protocol
A flat, bracket-tagged tool format (`[TOOL name] arg: value [/TOOL]`) with a forgiving parser that tolerates casing, `:`/`=`, quotes, fenced values, and missing close tags. Tool-trained models auto-upgrade to native Ollama tool calling.

### Agent Engine
Streaming turn loop with token budgeting, tool execution, approval gating, and anti-loop guards. Supports Chat / Plan / Agent modes with configurable step limits (1 / 50 / 100 steps).

---

## Modes

### Chat Mode
Pure conversation — no tools, no file edits. Answers coding questions directly with code snippets.

### Plan Mode
Read-only investigation → numbered plan. Uses only read-only tools (read, list, search, find). Never edits files.

### Agent Mode
Uses tools to edit files and run commands, one step at a time, with user approval gating for destructive operations.

---

## Tools

### Built-in Tools
- **`read_file`** — Read file contents with optional line ranges. Shows line numbers for context.
- **`write_file`** — Create or overwrite files in the workspace.
- **`edit_file`** — Find-and-replace edits with unique match validation.
- **`list_dir`** — List directory contents, filtering ignored folders (node_modules, .git, etc.).
- **`find_files`** — Find files by name/path using VS Code's index.
- **`search_code`** — Full-text search across workspace files.
- **`run_command`** — Execute shell commands with timeout and approval gating.
- **`web_search`** — DuckDuckGo search (no API key required). Returns top 5 results.

### MCP Integration
Import any Model Context Protocol server from `.vscode/mcp.json`. Servers start in "pending" state, require explicit user approval, and tools are bridged into the registry only when connected.

---

## Intelligence Levels

### Auto Mode
Photon picks the intelligence level from model + machine automatically. Analyzes task complexity (keywords, file references, estimated steps) and ranks available models by context fit, throughput, tool reliability, and tier match.

### Low / Medium / High / Max
Each level defines: max tools (5–14), parallel tool calls, output cap (768–8192), temperature, and prompt detail. Weak models get terse prompts; capable models get rich multi-file workflow guidance.

---

## Model Profiling

### Machine Profiler
Detects RAM, CPU cores/model, platform, and GPU (via PowerShell/system_profiler/nvidia-smi). Classifies machine as low/mid/high-end to cap context windows and adjust settings.

### Model Profiler
Enriches Ollama tags with context length, tool-training status, vision support, and parameter-based tier (tiny/small/medium/large). Uses model family heuristics when metadata is missing.

### Photon Bench
Runs 3 quick tasks per model: throughput measurement, tool-call reliability probe, and a reasoning check. Results feed Auto Mode's model ranking and are persisted across sessions.

---

## Context Management

### Token Estimation
Lightweight tokenizer-free estimation using chars/4 + word-count heuristics. Approximate but sufficient for budgeting small context windows.

### Context Manager
Fits conversation into the model's context window by dropping oldest turns. System message always kept. Returns usage breakdown for the UI meter.

### Tool Repair
Detects malformed tool calls and sends terse corrective prompts (max 2 retries). Falls back gracefully instead of looping.

---

## Workspace Indexing

### Offline-First Vector Store
Pure-TS vector store with unit-normalized vectors and linear-scan retrieval. No cloud, no server process — works on low-end machines.

### Indexer
Chunks + embeds files via a local Ollama embedding model. Incremental per file, watches for changes, persists across reloads. Max 1500 files, 8000 chunks.

### Context Retrieval
Injects relevance-ranked code snippets into the system prompt. Bounded by maxChars to avoid overflowing small windows.

---

## Multi-Provider LLM Support

### Ollama Provider
Local model runtime — the primary provider. Handles streaming, tool calling, and embedding.

### Cloud Providers
- **Gemini** — gemini-2.5-pro/flash, gemini-2.0-flash-lite, etc.
- **Claude** — claude-opus-4, claude-sonnet-4, claude-haiku-4-5, etc.
- **NVIDIA** — llama-3.3-70b, deepseek-r1, gemma-4-31b, etc.
- **Blackbox** — blackboxai-pro, llama-3.3-70b, etc.
- **Custom OpenAI-compatible** — any endpoint with OpenAI API format.

### Provider Manager
Routes requests by model prefix (e.g. `gemini:gemini-2.5-pro`). Aggregates model catalogs, handles fallback, and supports runtime provider swaps.

---

## UI (React Sidebar)

### Header
Mode switcher (Chat/Plan/Agent), model picker dropdown, Auto Mode toggle, session history, refresh models, new chat.

### Composer
Auto-growing textarea, file/image attachments (vision-aware), context meter showing token usage vs window.

### Message List
Streaming markdown rendering, tool cards with expand/collapse, inline approval dialogs for destructive operations.

### Settings Panel
Intelligence level selector, adaptive engine toggle, context window override, auto-approve tools, indexing config, cloud provider setup.

### Transparency Panel
Shows why Auto Mode chose a model: complexity signals, ranked candidate list, one-click pin to override per project.

### Context Meter
Live token usage bar with plan chip showing intelligence level, tool protocol, and context window size.

---

## Persistence

### Session Store
Persists chat sessions across window reloads via globalState. Max 40 sessions, sorted by last updated.

### Project Store
Per-workspace state: pinned model for Auto Mode override, approved MCP servers. Stored in workspaceState.

### Bench Store
Persists Photon Bench results keyed by model + hardware class + methodology version. Max 200 results.

---

## Protocol Layer

### Parse
Forgiving multi-format parser: `[TOOL]` blocks, `<tool_call>` tags, ```json fences, and bare JSON. Validates against tool specs, feeds errors back for repair.

### Serialize
Renders tool instructions scaled by intelligence level. Builds Ollama-native `tools` JSON schema for tool-trained models. Formats tool results for conversation injection.

---

## System Prompt Builder
Constructs system prompts scaled by intelligence level: identity, workspace name, file tree, retrieved code, mode instructions, tool instructions, multi-file workflow guidance, and formatting rules.

---

## Key Differentiators
1. **Small-model-first** — Not model-agnostic; purpose-built for 3–16B parameter models.
2. **Adaptive** — Auto-tunes context, tools, prompts, and protocol per model + machine.
3. **Transparent** — Every decision has a rationale shown in the UI.
4. **Offline-first** — Works without cloud; indexing uses local Ollama embeddings.
5. **Tool repair** — Handles malformed calls instead of failing silently.
6. **Multi-provider** — Local Ollama + cloud providers (Gemini, Claude, NVIDIA, Blackbox) in one interface.
