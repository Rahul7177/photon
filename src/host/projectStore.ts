import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { McpServerConfig } from "../core/tools/mcp/bridge";

const PIN_KEY = "photon.pinnedModel";
const MCP_APPROVED_KEY = "photon.mcpApproved";
const MCP_FINGERPRINTS_KEY = "photon.mcpFingerprints";

/**
 * Creates a deterministic trust fingerprint from an MCP server's identity:
 * transport, endpoint URL or executable command, arguments, permissions, and network access.
 * If any of these change, the fingerprint changes, preventing stealth config hijacking.
 */
export function computeMcpConfigFingerprint(config: McpServerConfig): string {
  const norm = {
    id: config.id,
    transport: config.transport,
    url: config.url ? config.url.trim().toLowerCase() : "",
    command: config.command ? config.command.trim().toLowerCase() : "",
    args: config.args ?? [],
    allowLocalNetwork: !!config.allowLocalNetwork,
    permissions: config.permissions ?? null,
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 32);
}

/**
 * Per-project (workspace-scoped) state: the pinned model for Auto Mode override
 * (M8/M12) and the set of MCP servers the user has explicitly approved (M11).
 * Stored in workspaceState so it's naturally scoped to this project — the
 * on-ramp to the checked-in `.photon/config.yaml` team profile later.
 */
export class ProjectStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  pinnedModel(): string | undefined {
    return this.context.workspaceState.get<string>(PIN_KEY) || undefined;
  }

  async setPinnedModel(model: string | undefined): Promise<void> {
    await this.context.workspaceState.update(PIN_KEY, model || undefined);
  }

  approvedMcp(): string[] {
    return this.context.workspaceState.get<string[]>(MCP_APPROVED_KEY, []);
  }

  approvedMcpFingerprints(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(MCP_FINGERPRINTS_KEY, {});
  }

  /**
   * Verifies that the server configuration exactly matches the previously approved trust fingerprint.
   * If the command, URL, arguments, or permissions have changed, returns false.
   */
  isMcpConfigApproved(config: McpServerConfig): boolean {
    const fingerprints = this.approvedMcpFingerprints();
    const fp = computeMcpConfigFingerprint(config);
    return fingerprints[config.id] === fp;
  }

  isMcpApproved(id: string): boolean {
    return this.approvedMcp().includes(id);
  }

  async approveMcpConfig(config: McpServerConfig): Promise<void> {
    const fps = { ...this.approvedMcpFingerprints() };
    fps[config.id] = computeMcpConfigFingerprint(config);
    await this.context.workspaceState.update(MCP_FINGERPRINTS_KEY, fps);
    await this.approveMcp(config.id);
  }

  async approveMcp(id: string): Promise<void> {
    const set = new Set(this.approvedMcp());
    set.add(id);
    await this.context.workspaceState.update(MCP_APPROVED_KEY, [...set]);
  }

  async revokeMcpConfig(id: string): Promise<void> {
    const fps = { ...this.approvedMcpFingerprints() };
    delete fps[id];
    await this.context.workspaceState.update(MCP_FINGERPRINTS_KEY, fps);
    await this.revokeMcp(id);
  }

  async revokeMcp(id: string): Promise<void> {
    await this.context.workspaceState.update(
      MCP_APPROVED_KEY,
      this.approvedMcp().filter((x) => x !== id)
    );
  }
}
