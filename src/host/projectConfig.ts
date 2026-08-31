import * as vscode from "vscode";
import type { IntelligenceSetting, PerModelConfig } from "../shared/types";

/**
 * Checked-in, team-shareable project configuration (Module 5). Lives at
 * `.photon/config.json` or `.photon/config.yaml` in the workspace root, the way
 * a team checks in `.eslintrc`. Versioned so the schema can evolve without
 * breaking older checked-in files. These are DEFAULTS — an explicit user choice
 * in the UI/settings always overrides them (see PhotonController precedence).
 *
 * Phase 1.4: Adds `modelConfigs` — a map of model-name → PerModelConfig so a
 * team can check in per-model overrides (context, ngl, sampling, etc.) and new
 * clones pick them up automatically.
 */
export interface ProjectConfig {
  version: number;
  /** Preferred model for this project (seeds the pin if the user hasn't pinned one). */
  model?: string;
  /** Prompt/tool intelligence tier default. */
  intelligence?: IntelligenceSetting;
  /** Context-window override in tokens. */
  numCtx?: number;
  /** Turn on local workspace indexing for this project. */
  indexing?: boolean;
  /** Auto-approve side-effecting tools (file writes, commands) for this project. */
  autoApprove?: boolean;
  /** Phase 1.4: Per-model overrides keyed by model name (e.g. "llamacpp:gemma"). */
  modelConfigs?: Record<string, PerModelConfig>;
}

const CURRENT_VERSION = 1;
const VALID_INTELLIGENCE: IntelligenceSetting[] = ["auto", "low", "medium", "high", "max"];

export interface LoadResult {
  config: ProjectConfig | null;
  /** Per-model configs from the file (Phase 1.4). Merged with config.modelConfigs. */
  modelConfigs?: Record<string, PerModelConfig>;
  /** Absolute path that was read, if any (for the file watcher). */
  path?: string;
  /** Human-readable problem, if the file existed but couldn't be used. */
  error?: string;
}

/** Load + validate the project config, trying JSON then the flat-YAML form. */
export function loadProjectConfig(): LoadResult {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return { config: null };
  const fs = require("node:fs") as typeof import("node:fs");

  for (const file of ["config.json", "config.yaml", "config.yml"]) {
    const path = vscode.Uri.joinPath(root, ".photon", file).fsPath;
    let raw: string;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch {
      continue; // not present — try the next
    }
    try {
      const parsed = file.endsWith(".json") ? JSON.parse(raw) : parseFlatYaml(raw);
      const config = validate(parsed);
      // A YAML file that parsed to zero keys means we couldn't read the user's
      // actual config (e.g. nested YAML). Report it — never silently default.
      if (!file.endsWith(".json") && Object.keys(parsed).length === 0) {
        return {
          config: null,
          path,
          error: `.photon/${file} contained no recognizable settings. This parser supports only flat "key: value" pairs — use .photon/config.json for nested YAML.`,
        };
      }
      // Phase 1.4: Return per-model configs for file-wins merging
      return { config, modelConfigs: config.modelConfigs, path };
    } catch (e) {
      return { config: null, path, error: `Could not parse .photon/${file}: ${(e as Error).message}` };
    }
  }
  return { config: null };
}

/** Coerce + validate a raw object into a ProjectConfig, ignoring unknown keys. */
function validate(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== "object") throw new Error("expected a top-level object");
  const o = raw as Record<string, unknown>;
  const version = typeof o.version === "number" ? o.version : CURRENT_VERSION;
  if (version > CURRENT_VERSION) {
    throw new Error(`version ${version} is newer than this Photon supports (${CURRENT_VERSION})`);
  }
  const config: ProjectConfig = { version };

  if (typeof o.model === "string" && o.model.trim()) config.model = o.model.trim();
  if (typeof o.intelligence === "string" && VALID_INTELLIGENCE.includes(o.intelligence as IntelligenceSetting)) {
    config.intelligence = o.intelligence as IntelligenceSetting;
  }
  if (typeof o.numCtx === "number" && o.numCtx > 0) config.numCtx = Math.floor(o.numCtx);
  if (typeof o.indexing === "boolean") config.indexing = o.indexing;
  if (typeof o.autoApprove === "boolean") config.autoApprove = o.autoApprove;

  // Phase 1.4: Per-model configs — a map of model-name → PerModelConfig
  // Example: { "llamacpp:gemma": { "numCtx": 32768, "llamacpp": { "ngl": "all" }, "sampling": { "temp": 0.7 } } }
  if (o.modelConfigs && typeof o.modelConfigs === "object") {
    const mc = o.modelConfigs as Record<string, unknown>;
    const validated: Record<string, PerModelConfig> = {};
    for (const [key, val] of Object.entries(mc)) {
      if (!key.trim() || typeof val !== "object" || !val) continue;
      const parsed = val as Record<string, unknown>;
      const cfg: PerModelConfig = {};
      if (typeof parsed.numCtx === "number" && parsed.numCtx > 0) cfg.numCtx = Math.floor(parsed.numCtx);
      if (typeof parsed.note === "string") cfg.note = parsed.note;
      if (parsed.llamacpp && typeof parsed.llamacpp === "object") {
        const lc = parsed.llamacpp as Record<string, unknown>;
        cfg.llamacpp = {};
        if (typeof lc.ctx === "number" && lc.ctx > 0) cfg.llamacpp.ctx = lc.ctx;
        if (lc.ngl !== undefined) cfg.llamacpp.ngl = typeof lc.ngl === "number" ? lc.ngl : (lc.ngl === "all" ? "all" : Number(lc.ngl) || undefined);
        if (typeof lc.fit === "boolean") cfg.llamacpp.fit = lc.fit;
        if (typeof lc.np === "number" && lc.np > 0) cfg.llamacpp.np = lc.np;
        if (typeof lc.fa === "boolean") cfg.llamacpp.fa = lc.fa;
        if (typeof lc.ctk === "string") cfg.llamacpp.ctk = lc.ctk;
        if (typeof lc.ctv === "string") cfg.llamacpp.ctv = lc.ctv;
        if (typeof lc.extraArgs === "string") cfg.llamacpp.extraArgs = lc.extraArgs;
        if (Object.keys(cfg.llamacpp).length === 0) delete cfg.llamacpp;
      }
      if (parsed.sampling && typeof parsed.sampling === "object") {
        const sp = parsed.sampling as Record<string, unknown>;
        cfg.sampling = {};
        if (typeof sp.temp === "number") cfg.sampling.temp = sp.temp;
        if (typeof sp.topP === "number") cfg.sampling.topP = sp.topP;
        if (typeof sp.seed === "number") cfg.sampling.seed = sp.seed;
        if (Object.keys(cfg.sampling).length === 0) delete cfg.sampling;
      }
      if (Object.keys(cfg).length > 0) validated[key.trim()] = cfg;
    }
    if (Object.keys(validated).length > 0) config.modelConfigs = validated;
  }

  return config;
}

/**
 * Minimal flat-YAML parser: `key: value` pairs, `#` comments, blank lines. No
 * nesting/lists — the config schema is intentionally flat, so this stays safe
 * and dependency-free. Anything more complex should use config.json.
 *
 * THROWS on lines it cannot understand (indentation, lists, nested maps) —
 * silently skipping them once made an indented config parse to `{}`, pass
 * validation with pure defaults, and the team's checked-in file was ignored
 * while the UI reported everything healthy.
 */
function parseFlatYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z][\w.-]*)\s*:\s*(.*)$/);
    if (!m) {
      throw new Error(
        `unsupported YAML syntax at "${line.trim().slice(0, 40)}" — this parser accepts only flat "key: value" lines`
      );
    }
    out[m[1]] = coerceScalar(stripInlineComment(m[2]).trim());
  }
  return out;
}

function stripInlineComment(v: string): string {
  // Strip an unquoted trailing `# comment`.
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const hash = v.indexOf(" #");
  return hash === -1 ? v : v.slice(0, hash);
}

function coerceScalar(v: string): unknown {
  if (v === "") return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
