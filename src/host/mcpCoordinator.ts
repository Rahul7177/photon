import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomizationScope } from "../shared/types";
import type { HostMessage } from "../shared/protocol";
import { McpManager, type McpServerConfig } from "../core/tools/mcp/bridge";
import { ProjectStore, computeMcpConfigFingerprint, type McpTrustScope } from "./projectStore";
import { parseMcpConfigJson } from "./approvalService";

export interface McpCoordinatorDeps {
  mcpManager: McpManager;
  projectStore: ProjectStore;
  getWorkspaceRoot: () => string | undefined;
  getUserRoot?: () => string;
  post: (msg: HostMessage) => void;
  pushTools: () => void;
  output: { appendLine: (line: string) => void };
}

export interface AddMcpServerInput {
  scope: CustomizationScope;
  id: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  allowLocalNetwork?: boolean;
  connectNow?: boolean;
}

const VALID_SERVER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Coordinates MCP configuration loading (User + Workspace scopes), user trust,
 * fingerprint validation, CRUD management, server lifecycle, and UI status broadcasts.
 */
export class McpCoordinator {
  constructor(private readonly deps: McpCoordinatorDeps) {}

  private userRoot(): string {
    return this.deps.getUserRoot?.() ?? path.join(os.homedir(), ".photon");
  }

  getConfigPath(scope: CustomizationScope): string | undefined {
    if (scope === "user") {
      return path.join(this.userRoot(), "mcp.json");
    }
    const root = this.deps.getWorkspaceRoot();
    return root ? path.join(root, ".vscode", "mcp.json") : undefined;
  }

  getAllowedConfigPaths(): string[] {
    const out: string[] = [path.join(this.userRoot(), "mcp.json")];
    const root = this.deps.getWorkspaceRoot();
    if (root) {
      out.push(path.join(root, ".vscode", "mcp.json"));
      out.push(path.join(root, ".photon", "mcp.json"));
    }
    return out;
  }

  private readConfigFile(filePath: string, scope: CustomizationScope): McpServerConfig[] {
    try {
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, "utf8");
      return parseMcpConfigJson(raw).map((srv) => ({
        ...srv,
        scope,
        sourcePath: filePath,
      }));
    } catch {
      return [];
    }
  }

  readMcpConfig(): McpServerConfig[] {
    const byId = new Map<string, McpServerConfig>();
    // User-scoped MCP servers first
    for (const s of this.readConfigFile(path.join(this.userRoot(), "mcp.json"), "user")) {
      byId.set(s.id, s);
    }
    // Workspace-scoped MCP servers (.photon/mcp.json then .vscode/mcp.json override user on same id)
    const root = this.deps.getWorkspaceRoot();
    if (root) {
      for (const s of this.readConfigFile(path.join(root, ".photon", "mcp.json"), "workspace")) {
        byId.set(s.id, s);
      }
      for (const s of this.readConfigFile(path.join(root, ".vscode", "mcp.json"), "workspace")) {
        byId.set(s.id, s);
      }
    }
    return [...byId.values()];
  }

  async setupMcp(): Promise<void> {
    const servers = this.readMcpConfig();
    await this.deps.projectStore.pruneStaleMcpApprovals(servers.map((s) => s.id));
    await this.deps.mcpManager.setConfigs(servers);
    for (const s of servers) {
      if (this.deps.projectStore.isMcpConfigApproved(s)) {
        await this.deps.mcpManager.connect(s.id);
      } else {
        const hadOld = !!this.deps.projectStore.approvedMcpFingerprints()[s.id];
        const reason = hadOld
          ? "Configuration modified since last approval. Re-approval required."
          : "Server requires user approval before connecting.";
        this.deps.mcpManager.setServerMessage(s.id, reason, "pending");
      }
    }
    this.pushMcpServers();
    this.deps.pushTools();
  }

  pushMcpServers(): void {
    this.deps.post({ type: "mcpServers", payload: this.deps.mcpManager.list() });
  }

  async approveMcpServer(
    id: string,
    expectedFingerprint?: string,
    scope: McpTrustScope = "persistent"
  ): Promise<void> {
    const servers = this.readMcpConfig();
    const server = servers.find((s) => s.id === id);
    if (!server) {
      this.deps.post({
        type: "error",
        payload: {
          message: `Cannot approve MCP server "${id}": configuration not found in user (~/.photon/mcp.json) or workspace (.vscode/mcp.json).`,
        },
      });
      return;
    }

    const currentFp = computeMcpConfigFingerprint(server);
    if (expectedFingerprint && expectedFingerprint !== currentFp) {
      this.deps.post({
        type: "error",
        payload: {
          message: `Configuration for MCP server "${id}" was modified while approval was pending. Re-approval required.`,
        },
      });
      this.pushMcpServers();
      return;
    }

    await this.deps.projectStore.approveMcpConfig(server, scope);
    await this.deps.mcpManager.connect(id);
    this.pushMcpServers();
    this.deps.pushTools();
  }

  async revokeMcpServer(id: string): Promise<void> {
    await this.deps.projectStore.revokeMcpConfig(id);
    await this.deps.mcpManager.disconnect(id);
    this.deps.mcpManager.setServerMessage(id, "Server trust revoked by user.", "revoked");
    this.pushMcpServers();
    this.deps.pushTools();
  }

  ensureConfigFile(scope: CustomizationScope): string | undefined {
    const filePath = this.getConfigPath(scope);
    if (!filePath) return undefined;
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ servers: {} }, null, 2) + "\n", "utf8");
    }
    return filePath;
  }

  async addServer(input: AddMcpServerInput): Promise<void> {
    const id = input.id.trim();
    if (!VALID_SERVER_ID_RE.test(id)) {
      this.deps.post({
        type: "error",
        payload: {
          message: `Invalid MCP server name "${input.id}". Use letters, numbers, dots, underscores, or hyphens.`,
        },
      });
      return;
    }
    const targetPath = this.getConfigPath(input.scope);
    if (!targetPath) {
      this.deps.post({
        type: "error",
        payload: {
          message: "Open a workspace folder first to add a workspace-scoped MCP server, or choose User scope.",
        },
      });
      return;
    }

    let entry: Record<string, unknown>;
    if (input.transport === "stdio") {
      const command = (input.command ?? "").trim();
      if (!command) {
        this.deps.post({ type: "error", payload: { message: "MCP stdio server requires a command (e.g. npx, uvx, node, python)." } });
        return;
      }
      const args = (input.args ?? []).map((a) => a.trim()).filter(Boolean);
      entry = {
        command,
        ...(args.length ? { args } : {}),
        ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
      };
    } else {
      const url = (input.url ?? "").trim();
      if (!url) {
        this.deps.post({ type: "error", payload: { message: "MCP HTTP server requires a server URL." } });
        return;
      }
      entry = {
        url,
        ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
        ...(input.allowLocalNetwork ? { allowLocalNetwork: true } : {}),
      };
    }

    let existing: { servers?: Record<string, unknown>; [k: string]: unknown } = { servers: {} };
    try {
      if (fs.existsSync(targetPath)) {
        const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
        if (parsed && typeof parsed === "object") existing = parsed;
      }
    } catch {
      existing = { servers: {} };
    }
    const serversObj =
      existing.servers && typeof existing.servers === "object" && !Array.isArray(existing.servers)
        ? { ...(existing.servers as Record<string, unknown>) }
        : {};
    serversObj[id] = entry;
    existing.servers = serversObj;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    this.deps.output.appendLine(`[mcp] Saved ${input.scope} MCP server "${id}" to ${targetPath}`);

    await this.setupMcp();
    if (input.connectNow) {
      await this.approveMcpServer(id, undefined, "persistent");
    }
  }

  async removeServer(id: string, scope?: CustomizationScope): Promise<void> {
    const candidates: string[] = [];
    if (!scope || scope === "workspace") {
      const root = this.deps.getWorkspaceRoot();
      if (root) {
        candidates.push(path.join(root, ".vscode", "mcp.json"));
        candidates.push(path.join(root, ".photon", "mcp.json"));
      }
    }
    if (!scope || scope === "user") {
      candidates.push(path.join(this.userRoot(), "mcp.json"));
    }

    let modified = false;
    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { servers?: Record<string, unknown>; [k: string]: unknown };
        if (parsed?.servers && Object.prototype.hasOwnProperty.call(parsed.servers, id)) {
          delete parsed.servers[id];
          fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
          modified = true;
        }
      } catch {
        /* ignore malformed sibling file */
      }
    }

    await this.deps.projectStore.revokeMcpConfig(id);
    await this.deps.mcpManager.disconnect(id);
    if (modified) {
      this.deps.output.appendLine(`[mcp] Removed MCP server "${id}".`);
    }
    await this.setupMcp();
  }
}

