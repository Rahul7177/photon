# Authoritative Production Runtime (`src/core/agent`)

## Overview

The runtime implemented in `src/core/agent` is the **authoritative production execution engine** for the Photon extension. All production turns executed through VS Code UI chat, prompt queuing, and language model participants run through this stack.

## Architecture

1. **Local Agent Engine (`engine.ts`)**:
   - Manages local turn loops with multi-turn conversation memory, context retrieval, tool executions, and step-budget enforcement.
   - Coordinates with `UnifiedEngineLifecycle` (`unifiedEngine.ts`) to ensure single-terminal events, tool deduplication, and parallel tool dispatching.

2. **Cloud Agent Engine (`cloudEngine.ts`)**:
   - Manages frontier cloud turns via native model tool calling without local quantization constraints.
   - Respects selective tool policies (e.g. read-only, web-only, all) and streams tokens directly to the webview UI.

3. **Context Compaction & Window Management (`compactor.ts`, `contextManager.ts`)**:
   - Monitors model context usage and automatically compacts long-running session histories using hierarchical summarization while preserving system prompts, active intents, and tool invariants.

4. **Self-Healing Recovery (`errorRecovery.ts`)**:
   - Analyzes execution errors and syntax/tool failures to formulate self-correcting retry turns before returning control to the user.

