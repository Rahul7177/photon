# Photon Adaptive Scaffolding — Phase 0 Baseline (Deterministic Harness)

> Generated at 2026-11-25T15:50:55.056Z against `EVAL_TASKS` (12 tasks).
> Overall pass count: **36/36** (100%).

## Summary by Model & Mode

| Model & Scaffold | Mode | Tasks Passed | Avg Prompt Tok | Tools Section Tok | Examples Rendered (first task) | Issues |
|---|---|---:|---:|---:|---|---:|
| qwen2.5-coder:3b (tiny/max) | agent | 8/8 | 3817 | 2737 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:3b (tiny/max) | chat | 3/3 | 2577 | 1584 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:3b (tiny/max) | plan | 1/1 | 2537 | 1582 | get_diagnostics, query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:7b (small/max) | agent | 8/8 | 3817 | 2737 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:7b (small/max) | chat | 3/3 | 2577 | 1584 | query_project_context, read_file, find_files, list_dir, search_code | 0 |
| qwen2.5-coder:7b (small/max) | plan | 1/1 | 2537 | 1582 | get_diagnostics, query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:14b (medium/high) | agent | 8/8 | 3762 | 2720 | query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:14b (medium/high) | chat | 3/3 | 2532 | 1565 | query_project_context, read_file, find_files, list_dir | 0 |
| qwen2.5-coder:14b (medium/high) | plan | 1/1 | 2495 | 1567 | get_diagnostics, query_project_context, read_file, find_files | 0 |

## Representative `max` Agent Prompt Breakdown (First Agent Task)

- Model: `qwen2.5-coder:3b` · Total prompt: **3825** tok (budget: 13762 tok) · Tools rendered: 17
- Worked examples rendered: `query_project_context`, `read_file`, `find_files`, `list_dir`, `search_code`

| Section ID | Label | Tokens | Status |
|---|---|---:|---|
| `identity` | Identity & Workspace | 80 | kept |
| `mode` | Mode Rules | 302 | kept |
| `tools` | Tool Instructions | 2736 | kept |
| `result_framing` | Result Framing | 201 | kept |
| `workflow` | Engineering Workflow | 201 | kept |
| `formatting` | Formatting & Language | 178 | kept |
| `project_digest` | Project Digest | 131 | kept |
| `workspace_map` | Workspace Map | 10 | kept |

## Full Task Matrix

| Task ID | Model | Mode | Level | Protocol | Result | Steps | Prompt Tok | Issues | Detail |
|---|---|---|---|---|---|---:|---:|---:|---|
| fix-discount-sign | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3825 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3817 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3814 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:3b | agent | max | photon-block | PASS | 5 | 3838 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:3b | agent | max | photon-block | PASS | 3 | 3792 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:3b | agent | max | photon-block | PASS | 2 | 3815 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:3b | agent | max | photon-block | PASS | 4 | 3815 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 2582 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 2581 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:3b | plan | max | photon-block | PASS | 3 | 2537 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:3b | chat | max | photon-block | PASS | 2 | 2569 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:3b | agent | max | photon-block | PASS | 4 | 3820 | 0 | validator.ts fixed and diagnostics verified |
| fix-discount-sign | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3825 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3817 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3814 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:7b | agent | max | photon-block | PASS | 5 | 3838 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:7b | agent | max | photon-block | PASS | 3 | 3792 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:7b | agent | max | photon-block | PASS | 2 | 3815 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:7b | agent | max | photon-block | PASS | 4 | 3815 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 2582 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 2581 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:7b | plan | max | photon-block | PASS | 3 | 2537 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:7b | chat | max | photon-block | PASS | 2 | 2569 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:7b | agent | max | photon-block | PASS | 4 | 3820 | 0 | validator.ts fixed and diagnostics verified |
| fix-discount-sign | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3769 | 0 | discount subtracted, tax preserved |
| fix-off-by-one-pagination | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3761 | 0 | 1-based page offset fixed |
| add-timeout-param | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3762 | 0 | timeoutMs param + AbortSignal.timeout present |
| rename-symbol-multi-file | qwen2.5-coder:14b | agent | high | photon-block | PASS | 5 | 3782 | 0 | symbol renamed cleanly across both files |
| append-changelog-entry | qwen2.5-coder:14b | agent | high | photon-block | PASS | 3 | 3737 | 0 | changelog appended cleanly |
| create-healthcheck-module | qwen2.5-coder:14b | agent | high | photon-block | PASS | 2 | 3762 | 0 | src/health.ts created, src/index.ts untouched |
| recover-wrong-path | qwen2.5-coder:14b | agent | high | photon-block | PASS | 4 | 3759 | 0 | found src/lib/math.ts and fixed clamp |
| explain-auth-flow | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 2537 | 0 | read and explained verifyToken |
| chat-readonly-guard | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 2536 | 0 | read-only preserved with manual steps + Agent suggestion |
| plan-multi-file-feature | qwen2.5-coder:14b | plan | high | photon-block | PASS | 3 | 2495 | 0 | read-only plan references both files |
| fresh-info-web-search | qwen2.5-coder:14b | chat | high | photon-block | PASS | 2 | 2523 | 0 | web_search used and answer grounded |
| diagnose-and-verify-bug | qwen2.5-coder:14b | agent | high | photon-block | PASS | 4 | 3766 | 0 | validator.ts fixed and diagnostics verified |
