import * as fs from "node:fs";
import * as path from "node:path";
import type { HostMessage } from "../shared/protocol";
import { McpManager, type McpServerConfig } from "../core/tools/mcp/bridge";
import { ProjectStore, computeMcpConfigFingerprint, type McpTrustScope } from "./projectStore";
import { parseMcpConfigJson } from "./approvalService";

export interface McpCoordinatorDeps {
  mcpManager: McpManager;
  projectStore: ProjectStore;
  getWorkspaceRoot: () => string | undefined;
  post: (msg: HostMessage) => void;
  pushTools: () => void;
  output: { appendLine: (line: string) => void };
}

/**
 * Coordinates MCP configuration loading, user trust, fingerprint validation,
 * server lifecycle (connect/disconnect/revoke), and UI status broadcasts.
 */
export class McpCoordinator {
  constructor(private readonly deps: McpCoordinatorDeps) {}

  readMcpConfig(): McpServerConfig[] {
    try {
      const root = this.deps.getWorkspaceRoot();
      if (!root) return [];
      const mcpPath = path.join(root, ".vscode", "mcp.json");
      if (!fs.existsSync(mcpPath)) return [];
      const raw = fs.readFileSync(mcpPath, "utf8");
      return parseMcpConfigJson(raw);
    } catch {
      return [];
    }
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
          message: `Cannot approve MCP server "${id}": configuration not found in .vscode/mcp.json.`,
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
}

