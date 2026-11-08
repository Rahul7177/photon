# Experimental Harness Sandbox (`src/photon-core`)

## Classification: Experimental / Harness Runtime

`src/photon-core` is an **experimental harness and architectural sandbox**. It was developed as a spike exploring an inbox-driven multi-agent loop (`AgentLoop`), decoupled session registries (`SessionRegistry`), and agent registries (`AgentRegistry`).

## Production Status

- **Non-authoritative for production:** The Photon VS Code extension entry point (`src/extension.ts`) does **not** call `bootPhoton` or wire `AgentLoop` for production chat turns. The authoritative production engine resides in `src/core/agent/`.
- **Harness & Contract Testing:** Tool parsing utilities (`ToolPipeline` in `tools/pipeline.ts`) and agent loop test suites (`agentLoop.test.ts`) are preserved and executed in continuous integration to validate agent loop contracts, stream parsing, and harness resilience during ongoing research.
- **Migration Strategy:** Any proven architectural components (such as inbox-style wakeups and multi-agent coordination) will be migrated behind tested interfaces into `src/core/agent/` without breaking production extension behavior.

