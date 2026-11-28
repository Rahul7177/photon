# Photon — Product Idea, Overview & v0.1.0 Capabilities

## 1. The Product Idea

### The Problem in Today's AI Coding Market
Almost every AI coding assistant on the market (Cursor, GitHub Copilot, Cline, Roo Code, Windsurf) is architected around massive 128k–200k-context cloud models. When developers connect a compact **2B–16B local LLM** running on an everyday consumer laptop or desktop GPU (`4 GB–12 GB VRAM` via Ollama or `llama.cpp`), standard agentic extensions break down in predictable ways:

1. **Prompt & Schema Bloat:** Sending 3,000–6,000 tokens of verbose JSON tool schemas eats 40%+ of a safe 8k local context window before the user types a single word, causing long prefill stalls and VRAM thrashing.
2. **Strict JSON Fragility:** Small quantized models frequently drop closing braces, mis-escape multiline code strings inside JSON, narrate *"Calling edit_file…"* instead of emitting a tool call, or invent parameter synonyms (`filepath` instead of `path`, `old_text` instead of `old_str`).
3. **Blind Context Sizing:** Requesting a model's nominal `128k` context window on a 6 GB GPU silently allocates 15+ GB of KV-cache, forcing Ollama into brutal disk/RAM swap or crashing the turn.
4. **Cloud Lock-In vs. Local Friction:** Developers want **$0, 100% private, offline execution** for everyday coding, exploration, and sensitive repositories — while still wanting a clean, 1-click switch to **direct BYOK frontier cloud models** (without middleman markups or subscriptions) when tackling massive architectural refactors.

### The Photon Thesis
**Photon makes compact local LLMs actually cope with real multi-step software engineering** — not by dumbing down what the agent can do, but by moving the reliability burden from the small model into an intelligent, hardware-aware host runtime (**Inverse Cognitive Scaffolding**), paired with a zero-compromise direct BYOK Cloud stack in the same unified VS Code interface.

---

## 2. Product Overview

### Positioning
> **Photon** is a local-first agentic coding extension for VS Code engineered around consumer GPUs and compact 2B–16B local models (Ollama & `llama.cpp`), with direct Bring-Your-Own-Key (BYOK) support for frontier cloud providers.

### Target Audience
- **Privacy-Conscious & Enterprise Engineers:** Developers whose source code cannot leave their machine or pass through third-party SaaS proxies.
- **Indie Builders, Students & Cost-Conscious Teams:** Developers with consumer laptops/GPUs (`4 GB–16 GB VRAM` or Apple Silicon unified memory) who want capable agentic coding at **$0 marginal token cost**, reserving paid API keys only for heavy tasks they explicitly choose.
- **Local AI Power Users:** Developers running `Qwen 2.5 Coder`, `Gemma 4`, `Qwen 3`, `Phi-4 Mini`, or `DeepSeek R1` who want live VRAM/KV-cache telemetry, empirical `tok/s` benchmarks, and `llama-server` tuning inside VS Code.

### Core Product Pillars
1. **Hardware-Truthful Adaptivity:** Every context limit, model recommendation, and overflow warning is grounded in real measured CPU, free RAM, and GPU VRAM math rather than guesswork.
2. **Inverse Cognitive Scaffolding:** Smaller models receive tighter sampling temperatures, phase-pruned worked examples, state cards, and tolerant block parsing; larger models get lean prompts and native parallel tool waves.
3. **Strict Local / Cloud Isolation:** Switching `Local | Cloud` in the Composer switches the underlying execution engine explicitly. There is **never** silent background fallback from Local to Cloud.
4. **Fearless Workspace Mutation:** Every mutating turn is guarded by workspace path containment, command-injection/destructive-action locks, and lazy pre-mutation file snapshots with 1-click cumulative rollback (`/revert`).
5. **Calm, High-Craft Developer UX:** A distraction-free Void Black & Soft Light interface that stays readable at `300px` sidebar widths, collapses multi-step tool noise into clean expandable summaries, and surfaces progressive-disclosure telemetry only when asked.

---

## 3. What We Have Currently in Photon v0.1.0

Everything listed below is **implemented, built, and verified in `v0.1.0`** (`639` automated unit & UI E2E tests passing across `192` suites + `100%` pass rate on the multi-tier deterministic eval release gate).

### 3.1 Dual Execution Engines (`src/core/agent/`)
- **Local Unified Engine (`runUnifiedTurn`):**
  - Supports both **Photon-Block protocol** (`TOOL_NAME` / `BEGIN_ARG` / `[TOOL]`, raw unescaped multiline code bodies) and **Compact Native JSON tool calling** (shrinking secondary tool schemas by `>40%` to preserve local VRAM and prefill speed).
  - **Tolerant Multi-Dialect Parser (`parse.ts`):** Recovers tool calls across fenced ```` ```tool ```` blocks, `[TOOL]…[/TOOL]`, `<tool_call>` XML, hybrid `<|tool_call>…[/TOOL]`, `[SYS]…[/SYS]`, bare balanced JSON, split adjacent JSON objects, echoed JSON schemas, and 30+ tool/parameter name aliases.
  - **Live Reliability Governor (`governor.ts`):** Tracks parse failures, empty replies, duplicate calls, mode violations, narration leaks (including first-person and gerund tool narration), and diagnostic regressions across rungs — injecting targeted worked examples or automatically downgrading failing native local models to `photon-block` mid-turn.
  - **Capability Passport (`passport.ts`):** Remembers empirical on-device reliability per local model so subsequent turns start at the right scaffolding rung automatically.
- **Cloud Engine (`runCloudTurn`):**
  - Purpose-built native function-calling loop for frontier APIs with full native context windows (`128k–200k+`).
  - Intent-pruned tool schemas (`0` schemas on greetings, read/web-only in Chat/Plan), **parallel read-only execution waves**, transparent industry tool-name aliasing (`str_replace_editor`, `replace_in_file`, `bash`, `write_to_file`), repeated-read deduplication, and Anthropic ephemeral prompt caching.

### 3.2 Hardware Profiling, Auto-Mode & Photon Bench (`src/core/adaptive/`, `src/core/bench/`)
- **Cross-Platform Machine Profiler (`machineProfiler.ts`):** Detects CPU cores, total/free RAM, Apple Silicon unified memory, and dedicated GPU VRAM/utilization/temperature (`nvidia-smi`, Windows Registry `HardwareInformation.qwMemorySize`, macOS `system_profiler`, Linux `/sys/class/drm`).
- **KV-Cache Context Sizer & Overflow Warning Modal:** Reserves a `22.5%` OS/VS Code RAM buffer and `0.5 GB` VRAM, calculates model weights + KV-cache memory requirements per preset (`8k`–`256k`), and intercepts unsafe overrides with a plain-English explanation and 1-click recommended context button.
- **Hardware-Matched Model Advisor & Installer:** Evaluates installed models (`Fits in VRAM`, `Requires Offloading`, `Heavy Offload`), recommends curated models by goal (`Code`, `Reason`, `Vision`, `Fast`), and streams `ollama pull` with live progress/ETA and disk-space pre-checks.
- **Auto-Select Routing & Transparency Panel:** Multi-signal per-prompt model router (`contextFit`, `toolCalling`, `coding`, `reasoning`, `throughput`, `cost`) with an inspectable score breakdown and project-level model pinning.
- **Photon Bench v5:** Built-in local benchmark measuring `tok/s`, first-token latency, block tool reliability, native JSON tool reliability, and reasoning pass/fail.

### 3.3 Interaction Modes, Continuity & VS Code Integration
- **Three Seamless Modes:**
  - **Chat (`100`-step cap):** Strictly read-only workspace + web inspection; redirects edit attempts into clean copy-pastable code blocks.
  - **Plan (`150`-step cap):** Read-only codebase investigation, interactive clarifying questions (`2–4` focused questions when requirements are ambiguous), and structured step-by-step architecture plans.
  - **Agent (`200`-step cap):** Full autonomous file creation/editing, terminal execution, VS Code diagnostics verification, checkpoints, and MCP tools.
- **VS Code Host Integration:** Activity Bar Webview (`photon.chat`), live Status Bar model/reachability indicator, 4 Command Palette commands, file/folder Explorer drag-and-drop, clipboard image paste (`Ctrl+V`, vision-gated), and crash-guarded `@photon` VS Code Chat Participant integration.

### 3.4 Complete Tooling, Security & MCP (`src/core/tools/`)
- **17 Built-in Tools:**
  - *Files:* `read_file`, `edit_file`, `write_file`, `append_file`, `move_path` (atomic writes, CRLF & UTF-8 BOM preservation, binary file detection).
  - *Search & Outline:* `list_dir`, `find_files`, `search_code`, `code_outline`.
  - *Verification & Terminal:* `get_diagnostics`, `run_command` (shell-chaining detector, obfuscation scanner, unattended read-only allowlist, and mandatory interactive confirmation on destructive commands).
  - *Memory & Workflow:* `query_project_context`, `update_project_context`, `todo_write`, `think`.
  - *Live Web:* `web_search` (DuckDuckGo HTML/Lite/Instant + Google + direct weather/currency fast paths) and `web_fetch` (DNS-pinned SSRF guard across every redirect hop).
- **MCP Client & Trust Coordinator:** Discovers `.vscode/mcp.json` servers (`stdio` and `http`/`sse`), computes SHA-256 config fingerprints, sanitizes subprocess environments, and enforces explicit persistent or session-only user approval.

### 3.5 Fail-Safe Checkpoints, Context Compaction & Project Memory
- **Pure-TS Checkpoint Engine (`checkpointManager.ts`):** Lazy pre-mutation snapshots (`≤2 MB` per file, `50 MB` cap), reverse-chain cumulative rollback, external-edit conflict detection, numbered checkpoints, `/rewind`, `/revert`, and the interactive **Revert Modal** (`Revert & Rewind Chat` with automatic prompt restoration in Composer, or `Files Only`).
- **Multi-Layer Context Compactor (`compactor.ts`):** Pre-turn auto-compaction at **75%** projected window usage, mid-turn compaction, API context-overflow retry, manual `/compact [focus]`, and structured ground-truth retention (task anchor, modified/inspected files, command statuses, unresolved todos).
- **Maintained Project Context & Offline Vector RAG:**
  - Live file-watcher symbol/outline index + cross-model turn handoff digest (`ProjectContextModal`).
  - Optional offline semantic codebase index (`nomic-embed-text` or custom Ollama embedding model, `60`-line sliding chunks with `12`-line overlap, hybrid cosine + lexical retrieval).

### 3.6 Provider Ecosystem, Telemetry & UI (`webview-ui/`)
- **Local Provider Hub:** 1-click start/stop/restart/port-free and live log viewer for **Ollama** and **llama.cpp**, plus detection for **LM Studio** and **vLLM**.
- **Cloud BYOK Hub:** Native adapters and live model fetching/pinging for **Google Gemini**, **Anthropic Claude**, **OpenAI**, **NVIDIA NIM**, **OpenRouter**, **OpenCode Zen**, **Blackbox AI**, and custom OpenAI-compatible presets (`Groq`, `DeepSeek`, `Mistral`, `Together`, `xAI`), backed by `SecretStorage`.
- **Hardware & Cloud Cost Modal:** Real-time GPU/VRAM/RAM bars, resident model unloader, and per-model session/cumulative USD cost & prompt-cache tracking.
- **Polished Dual-Theme Webview:** Soft Dark (`#181818` + animated aurora hero) and Soft Light (`#EDEAE4` warm stone), responsive down to `300px` sidebars, collapsible `TurnProcess` / `ThinkingBlock` / `ToolCard` streams, smart 14-line code block folding, `ErrorBoundary` recovery with secret scrubbing, and checked-in `.photon/config.json` team config support.

---

## 4. High-Impact Next Horizon (Post-v0.1.0 Roadmap)

1. **Native VS Code Diff Editor Previews (`v0.1.1`):** Open full side-by-side `vscode.diff` views in the main editor when reviewing proposed or completed file mutations and checkpoints.
2. **`@` Context Mention Picker in Composer (`v0.1.1`):** Keyboard autocomplete for `@file`, `@folder`, `@problems` (active diagnostics), and `@git-diff` to pin exact context into small local windows effortlessly.
3. **`AGENTS.md` & Workspace Customizations (`v0.2.0`):** Enable the built-in `CustomizationsStore` (`AGENTS.md`, `.photon/rules`, reusable Skills, and Custom Agents) for repository-specific coding conventions.
4. **Opt-In Hybrid Local + Cloud Workflows (`v0.2.0`):** Explicit user-controlled workflows where a cloud architect generates a plan while local GPU models execute file reads, edits, and test loops at `$0` token cost.
