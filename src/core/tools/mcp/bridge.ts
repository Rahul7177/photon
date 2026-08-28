import { randomUUID } from "node:crypto";
import type { McpServerInfo, McpServerStatus, ToolParam, ToolSpec } from "../../../shared/types";
import type { ToolRegistry } from "../registry";
import { clamp, fail, ok, type Tool } from "../types";
import { McpClient, type McpTool } from "./mcpClient";
import { McpStdioClient } from "./mcpStdioClient";
import type { IMcpClient } from "./transport";

export const MCP_PREFIX = "mcp_";

export interface McpServerConfig {
  id: string;
  transport: "http" | "stdio";
  /** For http transport. */
  url?: string;
  headers?: Record<string, string>;
  /** For stdio transport. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface Entry {
  config: McpServerConfig;
  client?: IMcpClient;
  status: McpServerStatus;
  toolCount: number;
  message?: string;
}

/**
 * Manages the lifecycle of imported MCP servers (M11). Every server is
 * untrusted until explicitly approved: a configured-but-unapproved server sits
 * in "pending" and exposes NO tools. The host drives connect()/disconnect()
 * from the approval UI; tools only enter the registry once a server is connected,
 * and are removed the instant it's revoked. Failures never throw into the chat.
 */
export class McpManager {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly log: (msg: string) => void
  ) {}

  /** Reconcile the configured server set. New servers start "pending" (no tools
   *  exposed); servers dropped from config are disconnected and forgotten. */
  async setConfigs(configs: McpServerConfig[]): Promise<void> {
    for (const id of [...this.entries.keys()]) {
      if (!configs.some((c) => c.id === id)) {
        await this.disconnect(id);
        this.entries.delete(id);
      }
    }
    for (const c of configs) {
      const existing = this.entries.get(c.id);
      if (existing) existing.config = c;
      else this.entries.set(c.id, { config: c, status: "pending", toolCount: 0 });
    }
  }

  /** Approve + connect a server, bridging its tools into the registry. */
  async connect(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    await this.teardownClient(e);
    e.status = "approved";

    let client: IMcpClient;
    try {
      client = createClient(e.config);
    } catch (err) {
      e.status = "error";
      e.message = (err as Error).message;
      this.log(`MCP "${id}": ${e.message}`);
      return;
    }

    try {
      await client.connect();
      const tools = await client.listTools();
      this.registry.unregisterByPrefix(prefixFor(id));
      for (const t of tools) this.registry.register(makeBridgedTool(id, client, t));
      e.client = client;
      e.status = "connected";
      e.toolCount = tools.length;
      e.message = undefined;
      this.log(`MCP "${id}": connected, ${tools.length} tool(s).`);
    } catch (err) {
      await client.close().catch(() => undefined);
      e.status = "error";
      e.toolCount = 0;
      e.message = (err as Error).message;
      this.log(`MCP "${id}": ${e.message}`);
    }
  }

  /** Revoke a server: drop its tools and close the connection. */
  async disconnect(id: string, status: McpServerStatus = "revoked"): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.registry.unregisterByPrefix(prefixFor(id));
    await this.teardownClient(e);
    e.toolCount = 0;
    e.status = status;
  }

  list(): McpServerInfo[] {
    return [...this.entries.values()].map((e) => ({
      id: e.config.id,
      transport: e.config.transport,
      target: e.config.transport === "http" ? e.config.url ?? "" : mkCmd(e.config),
      status: e.status,
      toolCount: e.toolCount,
      message: e.message,
    }));
  }

  /** Close every connection and drop all tools (extension shutdown). */
  async dispose(): Promise<void> {
    for (const id of this.entries.keys()) {
      this.registry.unregisterByPrefix(prefixFor(id));
    }
    await Promise.all(
      [...this.entries.values()].map((e) => e.client?.close().catch(() => undefined))
    );
    this.entries.clear();
  }

  private async teardownClient(e: Entry): Promise<void> {
    if (e.client) {
      await e.client.close().catch(() => undefined);
      e.client = undefined;
    }
  }
}

const ALLOWED_STDIO_BINS = new Set(["npx", "node", "python", "python3", "uvx", "bun", "deno"]);
const BLOCKED_ARG_RE = /(^|\s)(rm\s+-rf|sudo|chmod\s+\+x|\|\s*sh|;\s*)/i;

function createClient(c: McpServerConfig): IMcpClient {
  if (c.transport === "stdio") {
    if (!c.command) throw new Error("stdio MCP server requires a `command`.");
    const bin = c.command.split(/[\\/]/).pop()?.split(/\s+/)[0]?.toLowerCase() ?? "";
    // Allowlist + block traversal — prevents RCE via cloned .vscode/mcp.json (audit).
    if (!ALLOWED_STDIO_BINS.has(bin) && !c.command.startsWith("node ")) {
      throw new Error(`Blocked stdio command "${c.command}" — allowed: ${[...ALLOWED_STDIO_BINS].join(", ")} (request an allowlist addition if needed).`);
    }
    if (BLOCKED_ARG_RE.test((c.args ?? []).join(" "))) throw new Error("Blocked suspicious MCP args (shell injection pattern).");
    // Strip dangerous env passthrough — only pass through explicit allowlist
    const safeEnv: Record<string, string> | undefined = c.env ? Object.fromEntries(Object.entries(c.env).filter(([k]) => /^(PATH|NODE_ENV|PYTHONPATH)$/i.test(k) || k.startsWith("MCP_"))) : undefined;
    return new McpStdioClient(c.command, c.args ?? [], safeEnv);
  }
  if (!c.url) throw new Error("http MCP server requires a `url`.");
  if (!/^https?:\/\//i.test(c.url)) throw new Error(`Blocked MCP url "${c.url}" — must be http(s).`);
  return new McpClient(c.url, c.headers);
}

function mkCmd(c: McpServerConfig): string {
  return [c.command ?? "", ...(c.args ?? [])].join(" ").trim();
}

/** Sanitized tool-name prefix for a server, matching makeBridgedTool's naming. */
function prefixFor(serverId: string): string {
  return `${MCP_PREFIX}${serverId}_`.replace(/[^a-z0-9_]/gi, "_");
}

function makeBridgedTool(serverId: string, client: IMcpClient, mcp: McpTool): Tool {
  const spec: ToolSpec = {
    name: `${MCP_PREFIX}${serverId}_${mcp.name}`.replace(/[^a-z0-9_]/gi, "_"),
    // Keep the summary to one short line — a verbose MCP description would eat a
    // weak model's context just like an oversized native tool would.
    summary: mcp.description?.split("\n")[0]?.slice(0, 160) ?? `MCP tool ${mcp.name}`,
    params: flattenSchema(mcp.inputSchema),
    // MCP tools are opaque; treat them as side-effecting so they need approval.
    sideEffecting: true,
    priority: 9,
    // Imported tools are gated like native ones (M11): keep them off weak models,
    // whose scarce context shouldn't be spent on third-party schemas.
    minTier: "medium",
    tags: ["mcp"],
  };

  return {
    spec,
    async execute(args, ctx) {
      const approved = await ctx.requestApproval({
        id: randomUUID(),
        name: spec.name,
        args,
        status: "proposed",
        sideEffecting: true,
      });
      if (!approved) return fail("User declined the MCP tool call.");
      try {
        const result = await client.callTool(mcp.name, args);
        return ok(clamp(result, 6000));
      } catch (e) {
        return fail(`MCP tool "${mcp.name}" failed: ${(e as Error).message}`);
      }
    },
  };
}

function flattenSchema(schema: McpTool["inputSchema"]): ToolParam[] {
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, def]) => ({
    name,
    type: mapType(def.type),
    required: required.has(name),
    description: def.description ?? "",
  }));
}

function mapType(t?: string): ToolParam["type"] {
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}
