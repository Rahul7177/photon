import { randomUUID } from "node:crypto";
import type {
  JsonSchema,
  McpServerInfo,
  McpServerStatus,
  ToolParam,
  ToolSpec,
  ToolRisk,
} from "../../../shared/types";
import type { ToolRegistry } from "../registry";
import { BUILTIN_TOOL_NAMES, clamp, fail, ok, type Tool } from "../types";
import { McpClient, type McpTool } from "./mcpClient";
import { McpStdioClient } from "./mcpStdioClient";
import type { IMcpClient } from "./transport";
import { validateRemoteEndpoint, type DnsLookupFn } from "./dnsValidator";
import { computeMcpConfigFingerprint } from "./fingerprint";

export { computeMcpConfigFingerprint } from "./fingerprint";

export const MCP_PREFIX = "mcp_";

export type McpToolPermission = "always_allow" | "ask" | "deny";

export interface McpServerPermissions {
  defaultPolicy: McpToolPermission;
  toolPolicies?: Record<string, McpToolPermission>;
  allowLocalNetwork?: boolean;
}

export interface McpAuditEntry {
  id: string;
  timestamp: number;
  serverId: string;
  toolName: string;
  args: Record<string, unknown>;
  decision: "approved" | "declined" | "auto_allowed" | "denied_by_policy";
  risk: ToolRisk;
  expectedEffect: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
}

export interface McpServerConfig {
  id: string;
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  allowLocalNetwork?: boolean;
  permissions?: McpServerPermissions;
}

interface Entry {
  config: McpServerConfig;
  client?: IMcpClient;
  status: McpServerStatus;
  toolCount: number;
  message?: string;
  fingerprint?: string;
}

const ALLOWED_STDIO_BINS = new Set(["npx", "node", "python", "python3", "uvx", "bun", "deno"]);
const BLOCKED_ARG_RE = /(^|\s)(rm\s+-rf|sudo|chmod\s+\+x|\|\s*sh|;\s*|-y\b|--yes\b|--package\b|\binstall\b)/i;

export class McpManager {
  private readonly entries = new Map<string, Entry>();
  private readonly permissions = new Map<string, McpServerPermissions>();
  private readonly auditLog: McpAuditEntry[] = [];
  private readonly MAX_AUDIT_ENTRIES = 500;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly log: (msg: string) => void,
    private readonly customDnsLookup?: DnsLookupFn
  ) {}

  async setConfigs(configs: McpServerConfig[]): Promise<void> {
    for (const id of [...this.entries.keys()]) {
      if (!configs.some((c) => c.id === id)) {
        await this.disconnect(id);
        this.entries.delete(id);
        this.permissions.delete(id);
      }
    }
    for (const c of configs) {
      if (c.permissions) {
        this.permissions.set(c.id, c.permissions);
      }
      const fp = computeMcpConfigFingerprint(c);
      const e = this.entries.get(c.id);
      if (e) {
        e.config = c;
        e.fingerprint = fp;
      } else {
        this.entries.set(c.id, { config: c, status: "pending", toolCount: 0, fingerprint: fp });
      }
    }
  }

  setPermissions(serverId: string, perms: McpServerPermissions): void {
    this.permissions.set(serverId, perms);
  }

  getPermissions(serverId: string): McpServerPermissions {
    return (
      this.permissions.get(serverId) || {
        defaultPolicy: "ask",
      }
    );
  }

  getToolPermission(serverId: string, toolName: string, risk: ToolRisk): McpToolPermission {
    const serverPerms = this.getPermissions(serverId);
    if (serverPerms.toolPolicies && toolName in serverPerms.toolPolicies) {
      return serverPerms.toolPolicies[toolName];
    }
    // Read-only tools default to always_allow unless server policy overrides
    if (risk === "read" && !serverPerms.defaultPolicy) {
      return "always_allow";
    }
    return serverPerms.defaultPolicy || (risk === "read" ? "always_allow" : "ask");
  }

  recordAudit(entry: Omit<McpAuditEntry, "id" | "timestamp">): McpAuditEntry {
    const fullEntry: McpAuditEntry = {
      id: `audit_${randomUUID()}`,
      timestamp: Date.now(),
      ...entry,
    };
    this.auditLog.push(fullEntry);
    if (this.auditLog.length > this.MAX_AUDIT_ENTRIES) {
      this.auditLog.shift();
    }
    return fullEntry;
  }

  getAuditLog(): McpAuditEntry[] {
    return [...this.auditLog];
  }

  clearAuditLog(): void {
    this.auditLog.length = 0;
  }

  async connect(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    await this.teardownClient(e);
    e.status = "approved";

    let client: IMcpClient;
    try {
      client = await createClient(e.config, this.customDnsLookup);
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
      for (const t of tools) {
        const bridged = makeBridgedTool(id, client, t, this);
        if (BUILTIN_TOOL_NAMES.has(bridged.spec.name)) {
          this.log(`MCP "${id}": skipping tool "${bridged.spec.name}" because it collides with a built-in tool.`);
          continue;
        }
        this.registry.register(bridged);
      }
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

  async disconnect(id: string, status: McpServerStatus = "revoked"): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.registry.unregisterByPrefix(prefixFor(id));
    await this.teardownClient(e);
    e.toolCount = 0;
    e.status = status;
  }

  setServerMessage(id: string, message: string, status?: McpServerStatus): void {
    const e = this.entries.get(id);
    if (e) {
      e.message = message;
      if (status) e.status = status;
    }
  }

  list(): McpServerInfo[] {
    return [...this.entries.values()].map((e) => ({
      id: e.config.id,
      transport: e.config.transport,
      target: e.config.transport === "http" ? e.config.url ?? "" : mkCmd(e.config),
      status: e.status,
      toolCount: e.toolCount,
      message: e.message,
      args: e.config.args,
      permissions: e.config.permissions,
      envKeys: e.config.env ? Object.keys(e.config.env).sort() : undefined,
      headerKeys: e.config.headers ? Object.keys(e.config.headers).sort() : undefined,
      fingerprint: e.fingerprint ?? computeMcpConfigFingerprint(e.config),
    }));
  }

  async dispose(): Promise<void> {
    for (const id of this.entries.keys()) {
      this.registry.unregisterByPrefix(prefixFor(id));
    }
    await Promise.all([...this.entries.values()].map((e) => e.client?.close().catch(() => undefined)));
    this.entries.clear();
  }

  private async teardownClient(e: Entry): Promise<void> {
    if (e.client) {
      await e.client.close().catch(() => undefined);
      e.client = undefined;
    }
  }
}

async function createClient(c: McpServerConfig, customLookup?: DnsLookupFn): Promise<IMcpClient> {
  if (c.transport === "stdio") {
    if (!c.command) throw new Error("stdio MCP server requires a `command`.");
    const rawBin = c.command.split(/[\\/]/).pop()?.split(/\s+/)[0]?.toLowerCase() ?? "";
    const bin = rawBin.replace(/\.(exe|cmd|bat)$/i, "");
    if (!ALLOWED_STDIO_BINS.has(bin) && !c.command.startsWith("node ")) {
      throw new Error(`Blocked stdio command "${c.command}" — executable is not allowlisted.`);
    }
    const argsStr = (c.args ?? []).join(" ");
    if (BLOCKED_ARG_RE.test(argsStr)) {
      throw new Error("Blocked suspicious MCP args (shell injection pattern).");
    }

    // Inspect npx arguments to block unsafe remote package URLs
    if (bin === "npx") {
      for (const arg of c.args ?? []) {
        if (/^https?:\/\//i.test(arg) || /^git(\+ssh)?:\/\//i.test(arg)) {
          throw new Error(`Blocked remote package URL in npx command: "${arg}".`);
        }
      }
    }

    return new McpStdioClient(c.command, c.args ?? [], c.env);
  }

  if (!c.url) throw new Error("http MCP server requires a `url`.");

  const validation = await validateRemoteEndpoint(c.url, c.allowLocalNetwork, customLookup);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  return new McpClient(c.url, c.headers, c.allowLocalNetwork, customLookup);
}

function mkCmd(c: McpServerConfig): string {
  return [c.command ?? "", ...(c.args ?? [])].join(" ").trim();
}

function prefixFor(serverId: string): string {
  return `${MCP_PREFIX}${serverId}_`.replace(/[^a-z0-9_]/gi, "_");
}

export function describeRiskEffect(risk: ToolRisk, toolName: string): string {
  switch (risk) {
    case "destructive":
      return `Permanently deletes, overwrites, or removes resources via '${toolName}'`;
    case "execute":
      return `Executes shell or binary commands via '${toolName}'`;
    case "workspace_write":
      return `Modifies or creates files in the workspace via '${toolName}'`;
    case "network":
      return `Transmits network requests or downloads data via '${toolName}'`;
    case "read":
    default:
      return `Inspects data or queries state via '${toolName}'`;
  }
}

export function inferRisk(mcp: McpTool): ToolRisk {
  const text = `${mcp.name} ${mcp.description ?? ""}`.toLowerCase().replace(/[_.-]/g, " ");
  if (/\b(delete|destroy|drop|purge|wipe|reset|remove|kill|terminate|shutdown|reboot|overwrite|chmod)\b/.test(text)) {
    return "destructive";
  }
  if (/\b(execute|shell|command|terminal|run|download|upload|install|eval)\b/.test(text)) {
    return "execute";
  }
  if (/\b(fetch|http|request|search|browser|web|send|post|put|patch|api)\b/.test(text)) {
    return "network";
  }
  if (/\b(write|edit|update|create|insert|move|rename|save|append)\b/.test(text)) {
    return "workspace_write";
  }
  if (/\b(read|get|list|describe|query|search|find|inspect|status|view|info)\b/.test(text)) {
    return "read";
  }
  return "workspace_write";
}

function makeBridgedTool(
  serverId: string,
  client: IMcpClient,
  mcp: McpTool,
  manager: McpManager
): Tool {
  const risk = inferRisk(mcp);
  const readOnly = risk === "read";
  const schema: JsonSchema = mcp.inputSchema as any;
  const spec: ToolSpec = {
    name: `${MCP_PREFIX}${serverId}_${mcp.name}`.replace(/[^a-z0-9_]/gi, "_"),
    summary: mcp.description?.split("\n")[0]?.slice(0, 160) ?? `MCP tool ${mcp.name}`,
    params: flattenSchema(schema),
    inputSchema: schema,
    sideEffecting: !readOnly,
    priority: readOnly ? 9 : 15,
    minTier: "medium",
    tags: ["mcp", readOnly ? "read" : "write"],
    risk,
    concurrency: readOnly ? "safe_parallel" : "serial",
    idempotency: readOnly ? "idempotent" : "stateful",
  };

  return {
    spec,
    async execute(args, ctx) {
      const effect = describeRiskEffect(risk, mcp.name);
      const perm = manager.getToolPermission(serverId, mcp.name, risk);

      // 1. Explicit denial by policy
      if (perm === "deny") {
        manager.recordAudit({
          serverId,
          toolName: mcp.name,
          args,
          decision: "denied_by_policy",
          risk,
          expectedEffect: effect,
          success: false,
          error: `Blocked by policy: tool '${mcp.name}' on server '${serverId}' is set to deny.`,
        });
        return fail(`Execution of MCP tool "${mcp.name}" on server "${serverId}" was denied by security policy.`);
      }

      // 2. User approval requirement
      if (perm === "ask") {
        const approved = await ctx.requestApproval({
          id: ctx.pendingCallId ?? randomUUID(),
          name: spec.name,
          args,
          status: "proposed",
          sideEffecting: true,
        });

        if (!approved) {
          manager.recordAudit({
            serverId,
            toolName: mcp.name,
            args,
            decision: "declined",
            risk,
            expectedEffect: effect,
            success: false,
            error: "User declined approval.",
          });
          return fail(`User declined the MCP tool call "${mcp.name}" on server "${serverId}".`);
        }
      }

      // 3. Execution with audit trail and duration measurement
      const start = Date.now();
      const decision = perm === "ask" ? "approved" : "auto_allowed";

      try {
        const rawResult = await client.callTool(mcp.name, args);
        const durationMs = Date.now() - start;
        manager.recordAudit({
          serverId,
          toolName: mcp.name,
          args,
          decision,
          risk,
          expectedEffect: effect,
          durationMs,
          success: true,
        });
        return ok(clamp(rawResult, 6000));
      } catch (e) {
        const durationMs = Date.now() - start;
        const errorMsg = (e as Error).message;
        manager.recordAudit({
          serverId,
          toolName: mcp.name,
          args,
          decision,
          risk,
          expectedEffect: effect,
          durationMs,
          success: false,
          error: errorMsg,
        });
        return fail(`MCP tool "${mcp.name}" failed: ${errorMsg}`, {
          retryable: true,
          recovery: { action: "retry" },
        });
      }
    },
  };
}

function flattenSchema(schema: JsonSchema): ToolParam[] {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.entries(properties).map(([name, def]) => ({
    name,
    type: mapType(def.type),
    required: required.has(name),
    description: def.description ?? "",
    ...(Array.isArray(def.enum) ? { enum: def.enum } : {}),
    ...(def.items ? { items: def.items } : {}),
    ...(def.properties ? { properties: def.properties } : {}),
  }));
}

function mapType(t?: string): ToolParam["type"] {
  if (
    t === "number" ||
    t === "integer" ||
    t === "boolean" ||
    t === "array" ||
    t === "object" ||
    t === "null"
  ) {
    return t as ToolParam["type"];
  }
  return "string";
}
