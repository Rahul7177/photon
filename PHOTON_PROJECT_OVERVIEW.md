# Photon Project Overview

**Photon** is a VS Code extension (v0.1.0, MIT licensed) for agentic coding with **small local LLMs** (3B–16B parameter models like Qwen 2.5 Coder, DeepSeek-Coder-V2-Lite, Gemma 3, Llama 3.2) via Ollama, LM Studio, or llama.cpp — with frontier cloud models as seamless overflow.

The core differentiator: unlike most AI coding extensions built for massive cloud models, Photon is **designed around the hardware constraints, smaller context windows, and tool-calling behaviors of compact models**. It dynamically adapts prompts, context budgets, tool protocols, and execution parameters so low-end models "punch above their weight."

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Local-First & Offline** | Code, vector embeddings, and conversation state stay strictly on your machine |
| **Adaptive Intelligence** | Profiles CPU, RAM, and GPU VRAM to select safe context ceilings, optimal models, and curated tool sets |
| **Photon-Block Protocol** | A forgiving bracket-tagged tool syntax (`[TOOL name] arg: value [/TOOL]`) so local models execute tools without JSON syntax errors |
| **Tool Repair Loop** | Intercepts malformed tool invocations, streams corrective examples, and recovers gracefully |
| **MCP Support** | Connects external MCP servers from `.vscode/mcp.json` with strict approval controls |
| **Offline Workspace RAG** | Vector embedding engine powered by Ollama (`nomic-embed-text`) with sliding-window code chunking |
| **Checkpoints & Rollback** | Pre-mutation snapshots, reverse-chain cumulative rollback, revert/rewind chat, one-click restore modals |
| **Context Compaction** | Auto-triggers at 75% projected context pressure; preserves task objective, active files, todos, key decisions |
| **Hardware & Cost Telemetry** | Live CPU/RAM/VRAM gauges + USD cost calculator across OpenAI, Anthropic, Google Gemini, NVIDIA NIM |
| **Modern UI** | Void black theme, animated gradients, matte finish, crisp SVG icons |

---

## Architecture

The project is split across several layers:

```
src/
├── extension.ts           # VS Code extension entry point (activation, commands, webview provider)
├── host/                  # Extension host layer (ChatViewProvider, PhotonController, LmProvider, unifiedRuntime, sessionStore, etc.)
├── core/                  # Core engine (adaptive, agent, bench, checkpoints, context, index, intelligence, kernel, llm, ollama, prompts, protocol, telemetry, tools)
├── photon-core/           # Core engine submodules (agent, boot, intelligence, llm, loop, session, systemPrompt, tools)
├── shared/                # Dependency-free domain types shared between host and webview (types.ts, protocol.ts)
└── ...

webview-ui/src/            # React webview UI (App.tsx, components/, state/, theme/, main.tsx, vscode.ts)
test/                      # Unit and e2e test suites
```

### Key entry points

- **`src/extension.ts`** — Activates the extension, registers the webview view provider (`ChatViewProvider`), status bar, and commands (`photon.openChat`, `photon.newSession`, `photon.refreshModels`, `photon.runDiagnostics`)
- **`src/shared/types.ts`** — Shared domain types (Mode, ChatMessage, ToolCall, Attachment, ModelInfo, ToolSpec, AdaptivePlan, etc.) — kept dependency-free so the webview can import it directly
- **`src/core/protocol/parse.ts`** — Parses the Photon-Block tool-call syntax into structured `ParsedCall` objects
- **`src/core/adaptive/runtimeDetector.ts`** — Detects local LLM runtimes (Ollama, LM Studio, llama.cpp) and their capabilities

### Build & test scripts

- `npm run test` — Runs the test suite (tsx)
- `npm run build` — Builds webview (Vite) + extension (esbuild)
- `npm run build:ext` — Production extension build via esbuild
- `npm run build:webview` — Vite webview build
- `npm run watch` — Watch mode via esbuild
