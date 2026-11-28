# Photon Adaptive Scaffolding — Phase 3 Eval (Deterministic Harness)

> Generated at 2026-11-26T15:00:08.276Z against `EVAL_TASKS` (12 tasks).
> Overall pass count: **36/36** (100%).

## Summary by Model & Mode

| Model & Scaffold | Mode | Tasks Passed | Avg Prompt Tok | Tools Section Tok | Examples Rendered (first task) | Issues |
|---|---|---:|---:|---:|---|---:|
| qwen2.5-coder:3b (tiny/max) | agent | 8/8 | 2028 | 1252 | query_project_context, read_file, find_files | 0 |
| qwen2.5-coder:3b (tiny/max) | chat | 3/3 | 1540 | 897 | query_project_context, read_file | 0 |
| qwen2.5-coder:3b (tiny/max) | plan | 1/1 | 1627 | 914 | get_diagnostics, query_project_context, read_file | 0 |
| qwen2.5-coder:7b (small/max) | agent | 8/8 | 2028 | 1252 | query_project_context, read_file, find_files | 0 |
| qwen2.5-coder:7b (small/max) | chat | 3/3 | 1540 | 897 | query_project_context, read_file | 0 |
| qwen2.5-coder:7b (small/max) | plan | 1/1 | 1627 | 914 | get_diagnostics, query_project_context, read_file | 0 |
| qwen2.5-coder:14b (medium/high) | agent | 8/8 | 2014 | 1252 | query_project_context, read_file, find_files | 0 |
| qwen2.5-coder:14b (medium/high) | chat | 3/3 | 1526 | 897 | query_project_context, read_file | 0 |
| qwen2.5-coder:14b (medium/high) | plan | 1/1 | 1613 | 914 | get_diagnostics, query_project_context, read_file | 0 |

## Representative `max` Agent Prompt Breakdown (First Agent Task)

- Model: `qwen2.5-coder:3b` · Total prompt: **2057** tok (budget: 5600 tok) · Tools rendered: 17
- Worked examples rendered: `query_project_context`, `read_file`, `find_files`

| Section ID | Label | Tokens | Status |
|---|---|---:|---|
| `identity` | Identity & Workspace | 62 | kept |
| `mode` | Mode Rules | 107 | kept |
| `tools` | Tool Instructions | 1273 | kept |
| `result_framing` | Result Framing | 127 | kept |
| `workflow` | Engineering Workflow | 202 | kept |
| `formatting` | Formatting & Language | 164 | kept |
| `project_digest` | Project Digest | 131 | kept |
| `workspace_map` | Workspace Map | 10 | kept |

## Full Task Matrix

| Task ID | Model | Mode | Level | Protocol | Result | Steps | Prompt Tok | Issues | Detail |
|---|---|---|---|---|---|---:|---:|---:|---|
| fix-discount-sign | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 2057 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 2049 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 2004 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:3b | agent | max | photon-block | PASS | 5 | 2028 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 2024 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:3b | agent | max | photon-block | PASS | 2 | 2005 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:3b | agent | max | photon-block | PASS | 4 | 2047 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 1587 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 1586 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:3b | plan | max | photon-block | PASS | 3 | 1627 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 1446 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:3b | agent | max | photon-block | PASS | 4 | 2010 | 0 | validator.ts fixed and diagnostics verified |
| fix-discount-sign | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 2057 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 2049 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 2004 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:7b | agent | max | photon-block | PASS | 5 | 2028 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 2024 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:7b | agent | max | photon-block | PASS | 2 | 2005 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:7b | agent | max | photon-block | PASS | 4 | 2047 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 1587 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 1586 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:7b | plan | max | photon-block | PASS | 3 | 1627 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 1446 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:7b | agent | max | photon-block | PASS | 4 | 2010 | 0 | validator.ts fixed and diagnostics verified |
| fix-discount-sign | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 2043 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 2036 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 1990 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:14b | agent | high | photon-block | PASS | 5 | 2014 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 2010 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:14b | agent | high | photon-block | PASS | 2 | 1991 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:14b | agent | high | photon-block | PASS | 4 | 2034 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 1573 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 1572 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:14b | plan | high | photon-block | PASS | 3 | 1613 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 1432 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:14b | agent | high | photon-block | PASS | 4 | 1996 | 0 | validator.ts fixed and diagnostics verified |
