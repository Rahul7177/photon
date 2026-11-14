import * as fs from "node:fs";
import * as path from "node:path";
import type { IntelligenceSetting, PerModelConfig } from "../shared/types";
import type { ProjectConfigStatus } from "../shared/protocol";

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

export const DEFAULT_PROJECT_CONFIG_TEMPLATE = JSON.stringify(
  {
    version: 1,
    intelligence: "auto",
    indexing: true,
    modelConfigs: {},
  },
  null,
  2
);

/** Summarize a loaded project config for UI status display. */
export function summarizeProjectConfig(
  result: LoadResult,
  workspaceRoot?: string
): ProjectConfigStatus {
  const relPath =
    result.path && workspaceRoot
      ? path.relative(workspaceRoot, result.path).replace(/\\/g, "/")
      : result.path;
  if (!result.config) {
    return {
      loaded: false,
      ...(result.path ? { path: result.path, relativePath: relPath } : {}),
      ...(result.error ? { error: result.error } : {}),
      fields: [],
      modelConfigKeys: [],
    };
  }
  const fields: string[] = [];
  if (result.config.model) fields.push(`model: ${result.config.model}`);
  if (result.config.intelligence) fields.push(`scaffolding: ${result.config.intelligence}`);
  if (result.config.numCtx) fields.push(`numCtx: ${result.config.numCtx}`);
  if (result.config.indexing !== undefined) fields.push(`indexing: ${result.config.indexing ? "on" : "off"}`);
  const modelConfigKeys = Object.keys(result.config.modelConfigs ?? {});
  return {
    loaded: true,
    ...(result.path ? { path: result.path, relativePath: relPath } : {}),
    ...(result.error ? { error: result.error } : {}),
    fields,
    modelConfigKeys,
    ...(result.config.autoApprove ? { autoApproveIgnored: true } : {}),
  };
}

/** Load + validate the project config for a specific workspace directory. */
export function loadProjectConfigFromDir(workspaceRoot: string): LoadResult {
  if (!workspaceRoot) return { config: null };

  for (const file of ["config.json", "config.yaml", "config.yml"]) {
    const filePath = path.join(workspaceRoot, ".photon", file);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue; // not present — try the next
    }
    try {
      const parsed = file.endsWith(".json") ? JSON.parse(raw) : parseFlatYaml(raw);
      const config = validateProjectConfig(parsed);
      // A YAML file that parsed to zero keys means we couldn't read the user's
      // actual config (e.g. nested YAML). Report it — never silently default.
      if (!file.endsWith(".json") && Object.keys(parsed).length === 0) {
        return {
          config: null,
          path: filePath,
          error: `.photon/${file} contained no recognizable settings. This parser supports only flat "key: value" pairs — use .photon/config.json for nested YAML.`,
        };
      }
      // Phase 1.4: Return per-model configs for file-wins merging
      return { config, modelConfigs: config.modelConfigs, path: filePath };
    } catch (e) {
      return { config: null, path: filePath, error: `Could not parse .photon/${file}: ${(e as Error).message}` };
    }
  }
  return { config: null };
}

/** Load + validate the project config, trying JSON then the flat-YAML form. */
export function loadProjectConfig(): LoadResult {
  // Deferred require keeps validateProjectConfig / summarizeProjectConfig / loadProjectConfigFromDir runnable in Node tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode") as typeof import("vscode");
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return { config: null };
  return loadProjectConfigFromDir(root);
}

/** Coerce + validate a raw object into a ProjectConfig, ignoring unknown keys. */
export function validateProjectConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("expected a top-level object");
  }
  const o = raw as Record<string, unknown>;
  const version = o.version === undefined ? CURRENT_VERSION : Number(o.version);
  if (!Number.isInteger(version) || version < 1 || version > CURRENT_VERSION) {
    throw new Error(
      `unsupported config version "${String(o.version)}" (supported: 1..${CURRENT_VERSION})`
    );
  }
  const config: ProjectConfig = { version };

  if (typeof o.model === "string" && o.model.trim()) config.model = o.model.trim();
  if (typeof o.intelligence === "string" && VALID_INTELLIGENCE.includes(o.intelligence as IntelligenceSetting)) {
    config.intelligence = o.intelligence as IntelligenceSetting;
  }
  if (typeof o.numCtx === "number" && Number.isFinite(o.numCtx) && o.numCtx > 0) {
    config.numCtx = Math.floor(o.numCtx);
  }
  if (typeof o.indexing === "boolean") config.indexing = o.indexing;
  if (typeof o.autoApprove === "boolean") config.autoApprove = o.autoApprove;

  // Phase 1.4: Per-model configs — a map of model-name → PerModelConfig
  // Example: { "llamacpp:gemma": { "numCtx": 32768, "llamacpp": { "ngl": "all" }, "sampling": { "temp": 0.7 } } }
  if (o.modelConfigs && typeof o.modelConfigs === "object" && !Array.isArray(o.modelConfigs)) {
    const mc = o.modelConfigs as Record<string, unknown>;
    const validated: Record<string, PerModelConfig> = {};
    for (const [key, val] of Object.entries(mc)) {
      if (!key.trim() || typeof val !== "object" || !val || Array.isArray(val)) continue;
      const parsed = val as Record<string, unknown>;
      const cfg: PerModelConfig = {};
      if (typeof parsed.numCtx === "number" && Number.isFinite(parsed.numCtx) && parsed.numCtx > 0) {
        cfg.numCtx = Math.floor(parsed.numCtx);
      }
      if (typeof parsed.note === "string" && parsed.note.trim()) cfg.note = parsed.note.trim();
      if (parsed.llamacpp && typeof parsed.llamacpp === "object" && !Array.isArray(parsed.llamacpp)) {
        const lc = parsed.llamacpp as Record<string, unknown>;
        cfg.llamacpp = {};
        if (typeof lc.ctx === "number" && Number.isFinite(lc.ctx) && lc.ctx > 0) {
          cfg.llamacpp.ctx = Math.floor(lc.ctx);
        }
        if (lc.ngl !== undefined) {
          const nglRaw = typeof lc.ngl === "string" ? lc.ngl.trim().toLowerCase() : lc.ngl;
          if (nglRaw === "all") {
            cfg.llamacpp.ngl = "all";
          } else if (nglRaw !== "") {
            const n = Number(nglRaw);
            if (Number.isFinite(n) && n >= 0) {
              cfg.llamacpp.ngl = Math.floor(n);
            }
          }
        }
        if (typeof lc.fit === "boolean") cfg.llamacpp.fit = lc.fit;
        if (typeof lc.np === "number" && Number.isFinite(lc.np) && lc.np > 0) {
          cfg.llamacpp.np = Math.floor(lc.np);
        }
        if (typeof lc.fa === "boolean") cfg.llamacpp.fa = lc.fa;
        if (typeof lc.ctk === "string" && lc.ctk.trim()) cfg.llamacpp.ctk = lc.ctk.trim();
        if (typeof lc.ctv === "string" && lc.ctv.trim()) cfg.llamacpp.ctv = lc.ctv.trim();
        if (typeof lc.extraArgs === "string" && lc.extraArgs.trim()) cfg.llamacpp.extraArgs = lc.extraArgs.trim();
        if (Object.keys(cfg.llamacpp).length === 0) delete cfg.llamacpp;
      }
      if (parsed.sampling && typeof parsed.sampling === "object" && !Array.isArray(parsed.sampling)) {
        const sp = parsed.sampling as Record<string, unknown>;
        cfg.sampling = {};
        if (typeof sp.temp === "number" && Number.isFinite(sp.temp) && sp.temp >= 0 && sp.temp <= 2) {
          cfg.sampling.temp = sp.temp;
        }
        if (typeof sp.topP === "number" && Number.isFinite(sp.topP) && sp.topP > 0 && sp.topP <= 1) {
          cfg.sampling.topP = sp.topP;
        }
        if (typeof sp.seed === "number" && Number.isFinite(sp.seed) && sp.seed >= 0) {
          cfg.sampling.seed = Math.floor(sp.seed);
        }
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
