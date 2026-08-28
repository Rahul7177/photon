# Photon — Harness-Inspired Core Migration

*Date: Aug 2026 — complete revamp, intelligence moat preserved.*

## Why
Previous `PhotonController:+AgentEngine` monolith (see `src/host/PhotonController.ts:89`, `src/core/agent/engine.ts:78`) caused: mid-convo stops, ghost session ends, tool-loop failures, single-line `write_file` truncation (`src/core/protocol/parse.ts:264`).

Reference is `deepseek-harness` (`deepseek-harness/docs/architecture.md`): everything-is-a-plugin, capability seams, event-sourced `Session`, `Agent/Inbox/Registry`, `agent/*` waterfall.

## What stays (moat)
`src/photon-core/intelligence` is thin wrapper — `buildPlan` `src/core/adaptive/orchestrator.ts:53` + `planRequest/rankModels` `src/core/adaptive/autoMode.ts` + `profileMachine/ModelProfiler` + `runBench` `src/core/bench/bench.ts` remain pure, no `vscode` import (enforced `esbuild.mjs:8`). They now run as `agent/pre-step` waterfall, not inline `onPrompt` `src/host/PhotonController.ts:1162`.

Local vs cloud separation (`interfaceMode`) kept: `ProviderManager` `src/core/llm/providerManager.ts:11` still routes `prefix:` — cloud uses native `tools`, local uses `photon-block` `format.ts`.

## New layout `src/photon-core/`
```
session/  PhotonSession + SessionRegistry — append-only SessionEvent log, deriveMessages(), request/header (harness dsh-session)
agent/    PhotonAgent + Inbox + AgentRegistry + AgentContext (scoped tools/prompt) — harness dsh-agent
llm/      types.v2 GenerateOptions/StreamChunk + bridgeLegacyProvider over existing LLMProvider (harness dsh-llm)
tools/    ToolPipeline — pre-execute waterfall (policy) -> execute -> post-execute (harness tools/*)
systemPrompt/ SystemPromptRegistry — section registry ordered by priority, wraps buildSystemPrompt
loop/     AgentLoop — turn/start -> agent/pre-step -> step/start -> llm/stream -> assistant/chunk* -> tool/call/result -> step/end -> turn/end
boot/     bootPhoton() — composes seams (single Context, like dsh boot)
intelligence/ plugin that plugs buildPlan into loop
```

## Fixes landed
* **write_file one-line** `src/core/protocol/parse.ts:285` (`parseBody`): greedily captures unfenced `content/find/replace` tail when next lines aren't new `key:` args — model multi-line without fences no longer truncated. Tool still prefers fenced example `src/core/tools/builtin/files.ts:177` `content:\n```\n...\n````.
* **Mid-convo stop / empty generation / cut-off** — `AgentLoop` `src/photon-core/loop/agentLoop.ts:118` ports guards: `MAX_EMPTY_RETRIES`, `MAX_CONTINUATIONS`, `MAX_STREAM_RETRIES`, `hasUnclosedFence`, `continuationIntent`, `fitToWindow` budget. Every `assistant/chunk` is persisted as `session/event`, so truncated streams replay.
* **Tool failing / repair ignored** — `ToolPipeline` `src/photon-core/tools/pipeline.ts:16` validates via `validateAgainstSpec` `parse.ts:157` before execute, repair runs on partial batches, `onPreExecute` can inject spec example `engine.ts:646` pattern.
* **Session ghost-stop** — `Inbox.claim()` `src/photon-core/agent/inbox.ts:10` separates `wake` vs `injected`; `agent/pre-step` decide `reject|enter` replaces early `return` `PhotonController.ts:1136`. `turn/start|end` + `step/start|end` are durable; `fork()` `session/store.ts:29` clones only closed turns.

## Incremental adoption
* `PhotonController` now boots both seams: legacy `ToolRegistry` + harness `ToolPipeline` kept in sync via `mcpRegistryBridge` `src/host/PhotonController.ts:163`.
* `ProviderManager` wrapped by `bridgeLegacyProvider` `src/photon-core/llm/types.v2.ts:27` — existing Ollama/Gemini/Claude/OpenAICompat providers unchanged.
* Legacy `AgentEngine` path still drives UI (`onPrompt` `src/host/PhotonController.ts:1132`) — guarantees chat not regressed. Durable `SessionRegistry` mirrors events for observability; switch local `interfaceMode` to `agentLoop.run(agent)` behind flag `photon.harness.enabled` (next PR) for full cutover.

## Verify
```
npx tsc --noEmit -p tsconfig.json   # pass
node esbuild.mjs --production       # dist/extension.js 153.7kb
```

## Next
* Flip local turns to `AgentLoop` fully + wire `session/event` -> webview RPC (replace `TurnEmitter` callbacks).
* Persist `SessionRegistry` rows to `globalState` (compact rows, `SCHEMA_VERSION` bump).
* Move `IndexService` to harness `fs` capability + approval to `interaction` seam.
