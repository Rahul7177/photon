# Photon Adaptive Scaffolding — Phase 1 Eval (Deterministic Harness)

> Generated at 2026-11-25T16:12:27.060Z against `EVAL_TASKS` (12 tasks).
> Overall pass count: **36/36** (100%).

## Summary by Model & Mode

| Model & Scaffold | Mode | Tasks Passed | Avg Prompt Tok | Tools Section Tok | Examples Rendered (first task) | Issues |
|---|---|---:|---:|---:|---|---:|
| qwen2.5-coder:3b (tiny/max) | agent | 8/8 | 3499 | 2723 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:3b (tiny/max) | chat | 3/3 | 2227 | 1584 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:3b (tiny/max) | plan | 1/1 | 2294 | 1582 | get_diagnostics, query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:7b (small/max) | agent | 8/8 | 3499 | 2723 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:7b (small/max) | chat | 3/3 | 2227 | 1584 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:7b (small/max) | plan | 1/1 | 2294 | 1582 | get_diagnostics, query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:14b (medium/high) | agent | 8/8 | 3458 | 2706 | query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:14b (medium/high) | chat | 3/3 | 2194 | 1565 | query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:14b (medium/high) | plan | 1/1 | 2265 | 1567 | get_diagnostics, query_project_context, read_file, find_files | 0 |

## Representative `max` Agent Prompt Breakdown (First Agent Task)

- Model: `qwen2.5-coder:3b` · Total prompt: **3507** tok (budget: 13762 tok) · Tools rendered: 17
- Worked examples rendered: `query_project_context`, `read_file`, `find_files`, `list_dir`, `search_code`

| Section ID | Label | Tokens | Status |
|---|---|---:|---|
| `identity` | Identity & Workspace | 62 | kept |
| `mode` | Mode Rules | 107 | kept |
| `tools` | Tool Instructions | 2723 | kept |
| `result_framing` | Result Framing | 127 | kept |
| `workflow` | Engineering Workflow | 202 | kept |
| `formatting` | Formatting & Language | 164 | kept |
| `project_digest` | Project Digest | 131 | kept |
| `workspace_map` | Workspace Map | 10 | kept |

## Full Task Matrix

| Task ID | Model | Mode | Level | Protocol | Result | Steps | Prompt Tok | Issues | Detail |
|---|---|---|---|---|---|---:|---:|---:|---|
| fix-discount-sign | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3507 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3499 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3496 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:3b | agent | max | photon-block | PASS | 5 | 3520 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3474 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:3b | agent | max | photon-block | PASS | 2 | 3497 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:3b | agent | max | photon-block | PASS | 4 | 3497 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 2250 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 2249 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:3b | plan | max | photon-block | PASS | 3 | 2294 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 2181 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:3b | agent | max | photon-block | PASS | 4 | 3502 | 0 | validator.ts fixed and diagnostics verified |
| fix-discount-sign | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3507 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3499 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3496 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:7b | agent | max | photon-block | PASS | 5 | 3520 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3474 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:7b | agent | max | photon-block | PASS | 2 | 3497 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:7b | agent | max | photon-block | PASS | 4 | 3497 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 2250 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 2249 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:7b | plan | max | photon-block | PASS | 3 | 2294 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 2181 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:7b | agent | max | photon-block | PASS | 4 | 3502 | 0 | validator.ts fixed and diagnostics verified |
| fix-discount-sign | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3465 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3457 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3457 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:14b | agent | high | photon-block | PASS | 5 | 3478 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3432 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:14b | agent | high | photon-block | PASS | 2 | 3458 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:14b | agent | high | photon-block | PASS | 4 | 3455 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 2218 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 2217 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:14b | plan | high | photon-block | PASS | 3 | 2265 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 2148 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:14b | agent | high | photon-block | PASS | 4 | 3462 | 0 | validator.ts fixed and diagnostics verified |
