// Minimal MCP client over the Streamable HTTP transport (JSON-RPC 2.0).
// Supports servers that reply with either application/json or text/event-stream.
// Pinned connection prevents DNS rebinding / SSRF between validation and connection.

import * as dns from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import {
  validateRemoteEndpoint,
  isPrivateOrProhibitedIp,
  isSafeRemoteHostname,
  type DnsLookupFn,
} from "./dnsValidator";

export const MAX_MCP_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_TOOL_OUTPUT_CHARS = 200_000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Creates an Undici Agent whose socket connect lookup is strictly bound to DNS validation.
 * Ensures the connection connects only to a validated IP address while preserving the
 * original hostname for TLS SNI and certificate verification.
 * Strictly rejects mixed DNS answers containing any prohibited address.
 */
export function createPinnedDispatcher(
  allowLocalNetwork: boolean,
  customLookup?: DnsLookupFn
): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, opts, cb) => {
        const cleanHost = hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");

        if (!allowLocalNetwork && !isSafeRemoteHostname(cleanHost)) {
          return cb(
            new Error(`SSRF blocked: hostname "${cleanHost}" targets local/prohibited network.`),
            []
          );
        }

        const resolveDns = async () => {
          const lookupFn = customLookup || (dns.lookup as unknown as DnsLookupFn);
          const records = await lookupFn(cleanHost, { all: true });
          if (!records || records.length === 0) {
            throw new Error(`DNS resolution returned no addresses for "${cleanHost}".`);
          }

          // Mixed DNS answers check: if ANY record is prohibited, fail closed!
          for (const rec of records) {
            if (!allowLocalNetwork && isPrivateOrProhibitedIp(rec.address)) {
              throw new Error(
                `DNS rebinding / SSRF protection blocked connection: host "${cleanHost}" resolved to prohibited address "${rec.address}".`
              );
            }
          }
          return records;
        };

        resolveDns()
          .then((records) => {
            if (opts && (opts as { all?: boolean }).all) {
              cb(null, records as any);
            } else {
              const first = records[0];
              cb(null, first.address as any, first.family);
            }
          })
          .catch((err) => {
            cb(err, [] as any);
          });
      },
    },
  });
}

export class McpClient {
  private sessionId?: string;
  private nextId = 1;
  private initialized = false;
  private readonly dispatcher: Agent;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly allowLocalNetwork = false,
    private readonly customLookup?: DnsLookupFn
  ) {
    this.dispatcher = createPinnedDispatcher(this.allowLocalNetwork, this.customLookup);
  }

  async connect(timeoutMs = 8000): Promise<void> {
    try {
      // 1. Initial endpoint validation check
      const check = await validateRemoteEndpoint(this.url, this.allowLocalNetwork, this.customLookup);
      if (!check.ok) {
        throw new Error(`MCP connection blocked: ${check.reason}`);
      }

      const result = (await this.rpc(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "photon", version: "0.1.0" },
        },
        timeoutMs
      )) as { protocolVersion?: string };
      if (!result?.protocolVersion) {
        throw new Error("MCP server did not complete initialize.");
      }
      // Fire-and-forget the initialized notification.
      await this.notify("notifications/initialized").catch(() => undefined);
      this.initialized = true;
    } catch (err) {
      this.sessionId = undefined;
      this.initialized = false;
      await this.dispatcher.destroy().catch(() => undefined);
      throw err;
    }
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.rpc("tools/list", {})) as { tools?: McpTool[] };
    return res?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    let text = (res?.content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
      .join("\n")
      .trim();

    if (text.length > MAX_TOOL_OUTPUT_CHARS) {
      text = text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n...[truncated output exceeding limit]";
    }

    if (res?.isError) throw new Error(text || "MCP tool returned an error.");
    return text || "(no content)";
  }

  /** End the server session (HTTP DELETE per the spec). Enforces identical redirect & SSRF policies. */
  async close(): Promise<void> {
    try {
      if (this.sessionId) {
        await this.executeRequest("DELETE", this.url, undefined, 3000);
      }
    } catch {
      /* server may not support session teardown — ignore */
    } finally {
      this.sessionId = undefined;
      this.initialized = false;
      await this.dispatcher.destroy().catch(() => undefined);
    }
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async rpc(method: string, params: unknown, timeoutMs = 15000): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);

    // Validate JSON-RPC response version
    if (res.jsonrpc !== "2.0") {
      throw new Error(`Invalid JSON-RPC protocol version in MCP response: "${res.jsonrpc}".`);
    }

    // Validate JSON-RPC response ID correlation
    if (res.id !== id) {
      throw new Error(`Mismatched JSON-RPC response id: expected ${id}, received ${res.id}.`);
    }

    // Validate JSON-RPC error shape if present
    if (res.error) {
      const errMsg = res.error.message || "Unknown error";
      const errCode = typeof res.error.code === "number" ? ` (code ${res.error.code})` : "";
      throw new Error(`MCP ${method} failed: ${errMsg}${errCode}`);
    }

    return res.result;
  }

  private async post(body: unknown, timeoutMs = 15000): Promise<JsonRpcResponse> {
    return this.executeRequest("POST", this.url, body, timeoutMs);
  }

  /**
   * Core request executor with strict redirect handling, header strip on port/origin change,
   * destination re-validation, and pinned connection dispatcher.
   */
  private async executeRequest(
    method: "POST" | "DELETE",
    initialUrl: string,
    body?: unknown,
    timeoutMs = 15000
  ): Promise<JsonRpcResponse> {
    let url = initialUrl;
    let currentHeaders: Record<string, string> = {
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...this.headers,
    };

    for (let hop = 0; hop < 4; hop++) {
      let res: any;
      try {
        res = await (undiciFetch as any)(url, {
          method,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "manual",
          dispatcher: this.dispatcher,
          headers: currentHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err: any) {
        const rootMsg = err?.cause?.message || err?.message || String(err);
        throw new Error(rootMsg);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new Error(`MCP HTTP ${res.status} with no location.`);
        const next = new URL(loc, url);
        const orig = new URL(url);

        // Security check: Must remain HTTPS unless allowLocalNetwork
        if (next.protocol !== "https:" && !this.allowLocalNetwork) {
          throw new Error("Blocked MCP redirect to insecure non-HTTPS protocol.");
        }

        // Security check: Never redirect to a different host
        if (next.hostname.toLowerCase() !== orig.hostname.toLowerCase()) {
          throw new Error("Blocked MCP redirect to a different host.");
        }

        // Same-host different-port redirect policy:
        // If port differs, strip credentials and session IDs to prevent cross-port leakage
        if (next.port !== orig.port) {
          const strippedHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(currentHeaders)) {
            const lowerKey = k.toLowerCase();
            if (lowerKey !== "authorization" && lowerKey !== "mcp-session-id") {
              strippedHeaders[k] = v;
            }
          }
          currentHeaders = strippedHeaders;
        }

        // Validate the redirect destination URL
        const redirectCheck = await validateRemoteEndpoint(
          next.toString(),
          this.allowLocalNetwork,
          this.customLookup
        );
        if (!redirectCheck.ok) {
          throw new Error(`Blocked unsafe MCP redirect: ${redirectCheck.reason}`);
        }

        url = next.toString();
        continue;
      }

      // Handle session expiry
      if (res.status === 401 || res.status === 404 || res.status === 410) {
        this.sessionId = undefined;
      }

      const sid = res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;

      // Notifications get 202 with no body.
      if (res.status === 202) return { jsonrpc: "2.0", id: 0 };
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);

      // Bound response size
      const contentLengthHeader = res.headers.get("Content-Length");
      if (contentLengthHeader) {
        const len = parseInt(contentLengthHeader, 10);
        if (!isNaN(len) && len > MAX_MCP_RESPONSE_BYTES) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`MCP response exceeded maximum size limit (${MAX_MCP_RESPONSE_BYTES} bytes).`);
        }
      }

      const ct = res.headers.get("Content-Type") ?? "";
      const text = await res.text();
      if (text.length > MAX_MCP_RESPONSE_BYTES) {
        throw new Error(`MCP response exceeded maximum size limit (${MAX_MCP_RESPONSE_BYTES} bytes).`);
      }

      if (ct.includes("text/event-stream")) {
        return parseSse(text);
      }
      return text ? (JSON.parse(text) as JsonRpcResponse) : { jsonrpc: "2.0", id: 0 };
    }
    throw new Error("Too many MCP redirects.");
  }
}

/**
 * Extract the first JSON-RPC response from an SSE stream body.
 * Robustly parses multiple events, multi-line data payloads, CRLF, and comments.
 */
export function parseSse(body: string): JsonRpcResponse {
  // Normalize CRLF to LF
  const normalized = body.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n");
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(":")) continue; // skip comments / heartbeats
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) continue;
    try {
      const joined = dataLines.join("\n");
      const parsed = JSON.parse(joined) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error) {
        return parsed;
      }
    } catch {
      /* continue checking subsequent events */
    }
  }
  throw new Error("No JSON-RPC payload found in MCP SSE response.");
}
