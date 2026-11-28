# Photon Adaptive Scaffolding — Phase 4 Ablation Matrix

> Generated at 2026-11-26T15:10:30.031Z across 6 scaffold variants × 3 model tiers (12 tasks each).

| Variant | Tier & Model | Pass Rate | Avg Prompt Tok (vs Legacy) | Agent `tools` Tok (vs Legacy) | Issues |
|---|---|---:|---:|---:|---:|
| `full_phase4` | tiny (`qwen2.5-coder:3b`) | 12/12 (100%) | 1873 (-39.2%) | 1252 (-54%) | 0 |
| `full_phase4` | small (`qwen2.5-coder:7b`) | 12/12 (100%) | 1873 (-39.2%) | 1252 (-54%) | 0 |
| `full_phase4` | medium (`qwen2.5-coder:14b`) | 12/12 (100%) | 1859 (-38.9%) | 1252 (-53.7%) | 0 |
| `legacy_flag_off` | tiny (`qwen2.5-coder:3b`) | 12/12 (100%) | 3081 (+0%) | 2723 (+0%) | 0 |
| `legacy_flag_off` | small (`qwen2.5-coder:7b`) | 12/12 (100%) | 3081 (+0%) | 2723 (+0%) | 0 |
| `legacy_flag_off` | medium (`qwen2.5-coder:14b`) | 12/12 (100%) | 3043 (+0%) | 2706 (+0%) | 0 |
| `toolCards_full` | tiny (`qwen2.5-coder:3b`) | 12/12 (100%) | 3081 (+0%) | 2723 (+0%) | 0 |
| `toolCards_full` | small (`qwen2.5-coder:7b`) | 12/12 (100%) | 3081 (+0%) | 2723 (+0%) | 0 |
| `toolCards_full` | medium (`qwen2.5-coder:14b`) | 12/12 (100%) | 2836 (-6.8%) | 2706 (+0%) | 0 |
| `stateCard_off` | tiny (`qwen2.5-coder:3b`) | 12/12 (100%) | 1873 (-39.2%) | 1252 (-54%) | 0 |
| `stateCard_off` | small (`qwen2.5-coder:7b`) | 12/12 (100%) | 1873 (-39.2%) | 1252 (-54%) | 0 |
| `stateCard_off` | medium (`qwen2.5-coder:14b`) | 12/12 (100%) | 1859 (-38.9%) | 1252 (-53.7%) | 0 |
| `examples_none` | tiny (`qwen2.5-coder:3b`) | 12/12 (100%) | 1796 (-41.7%) | 1169 (-57.1%) | 0 |
| `examples_none` | small (`qwen2.5-coder:7b`) | 12/12 (100%) | 1796 (-41.7%) | 1169 (-57.1%) | 0 |
| `examples_none` | medium (`qwen2.5-coder:14b`) | 12/12 (100%) | 1782 (-41.4%) | 1169 (-56.8%) | 0 |
| `adaptivity_frozen` | tiny (`qwen2.5-coder:3b`) | 12/12 (100%) | 1873 (-39.2%) | 1252 (-54%) | 0 |
| `adaptivity_frozen` | small (`qwen2.5-coder:7b`) | 12/12 (100%) | 1873 (-39.2%) | 1252 (-54%) | 0 |
| `adaptivity_frozen` | medium (`qwen2.5-coder:14b`) | 12/12 (100%) | 1859 (-38.9%) | 1252 (-53.7%) | 0 |
