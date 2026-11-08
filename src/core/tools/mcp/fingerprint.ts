import { createHash } from "node:crypto";
import type { McpServerConfig, McpServerPermissions } from "./bridge";

/**
 * Deterministically sorts object keys and arrays for canonical hashing.
 */
export function canonicalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  if (typeof val === "object") {
    const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      result[k] = canonicalizeValue((val as Record<string, unknown>)[k]);
    }
    return result;
  }
  return val;
}

/**
 * Hashes a secret value with SHA-256 so raw credentials are never stored
 * in trust records or fingerprints, but changes in secrets invalidate previous approval.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Sanitizes a key-value dictionary (headers or env) by sorting keys
 * and hashing values to prevent storing raw secrets in trust fingerprints.
 */
export function sanitizeAndHashDictionary(
  dict?: Record<string, string>,
  lowercaseKeys = false
): Record<string, string> | null {
  if (!dict || typeof dict !== "object") return null;
  const keys = Object.keys(dict).sort();
  if (keys.length === 0) return null;
  const res: Record<string, string> = {};
  for (const k of keys) {
    const v = dict[k];
    if (typeof v === "string") {
      const keyName = lowercaseKeys ? k.toLowerCase() : k;
      res[keyName] = hashSecret(v);
    }
  }
  return res;
}

/**
 * Creates a deterministic, canonical trust fingerprint from an MCP server's effective configuration:
 * transport, normalized endpoint URL or executable command, arguments, working directory,
 * sanitized/hashed HTTP headers, sanitized/hashed stdio environment, network policy, and permissions.
 *
 * Any change to security-relevant fields or secret rotation changes the fingerprint,
 * preventing stealth configuration hijacking.
 */
export function computeMcpConfigFingerprint(config: McpServerConfig): string {
  const norm = {
    id: config.id,
    transport: config.transport,
    url: config.url ? config.url.trim().toLowerCase() : "",
    command: config.command ? config.command.trim() : "",
    args: config.args ? [...config.args] : [],
    cwd: config.cwd ? config.cwd.trim() : "",
    headers: sanitizeAndHashDictionary(config.headers, true),
    env: sanitizeAndHashDictionary(config.env, false),
    allowLocalNetwork: !!config.allowLocalNetwork,
    permissions: config.permissions
      ? (canonicalizeValue(config.permissions) as McpServerPermissions)
      : null,
  };

  const canonicalJson = JSON.stringify(canonicalizeValue(norm));
  return createHash("sha256").update(canonicalJson).digest("hex").slice(0, 32);
}

