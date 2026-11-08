import * as vscode from "vscode";
import type { McpServerConfig } from "../core/tools/mcp/bridge";
import { computeMcpConfigFingerprint } from "../core/tools/mcp/fingerprint";

export { computeMcpConfigFingerprint } from "../core/tools/mcp/fingerprint";

const PIN_KEY = "photon.pinnedModel";
const MCP_APPROVED_KEY = "photon.mcpApproved";
const MCP_FINGERPRINTS_KEY = "photon.mcpFingerprints";

export type McpTrustScope = "persistent" | "session" | "one_time";

/**
 * Per-project (workspace-scoped) state: the pinned model for Auto Mode override
 * and the set of MCP server fingerprints the user has explicitly approved.
 * Stored in workspaceState so it's naturally scoped to this project.
 */
export class ProjectStore {
  private sessionApprovedFingerprints = new Map<string, string>();
  private oneTimeApprovedFingerprints = new Set<string>();

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
   * Verifies that the server configuration exactly matches an approved trust fingerprint.
   * Checks one-time, session, and persistent trust records in order.
   * Consumes one-time approval upon verification.
   * If any security-relevant field has changed, returns false (fails closed).
   */
  isMcpConfigApproved(config: McpServerConfig): boolean {
    const fp = computeMcpConfigFingerprint(config);

    // 1. One-time approval (consumed immediately upon verification)
    const oneTimeKey = `${config.id}:${fp}`;
    if (this.oneTimeApprovedFingerprints.has(oneTimeKey)) {
      this.oneTimeApprovedFingerprints.delete(oneTimeKey);
      return true;
    }

    // 2. Session-scoped approval (in-memory)
    if (this.sessionApprovedFingerprints.get(config.id) === fp) {
      return true;
    }

    // 3. Persistent approval (workspaceState)
    const fingerprints = this.approvedMcpFingerprints();
    return fingerprints[config.id] === fp;
  }

  /**
   * Strict fail-closed check: approval by ID alone is disallowed.
   * Callers must verify the full configuration via isMcpConfigApproved.
   */
  isMcpApproved(_id: string): boolean {
    return false;
  }

  /**
   * Approves an exact server configuration fingerprint under a designated scope.
   */
  async approveMcpConfig(
    config: McpServerConfig,
    scope: McpTrustScope = "persistent"
  ): Promise<void> {
    const fp = computeMcpConfigFingerprint(config);

    if (scope === "one_time") {
      this.oneTimeApprovedFingerprints.add(`${config.id}:${fp}`);
      return;
    }

    if (scope === "session") {
      this.sessionApprovedFingerprints.set(config.id, fp);
      return;
    }

    // Persistent approval
    const fps = { ...this.approvedMcpFingerprints() };
    fps[config.id] = fp;
    await this.context.workspaceState.update(MCP_FINGERPRINTS_KEY, fps);
    await this.approveMcp(config.id);
  }

  /**
   * Internal helper to record approved ID in persistent list.
   */
  private async approveMcp(id: string): Promise<void> {
    const set = new Set(this.approvedMcp());
    set.add(id);
    await this.context.workspaceState.update(MCP_APPROVED_KEY, [...set]);
  }

  /**
   * Immediately revokes trust across one-time, session, and persistent scopes.
   */
  async revokeMcpConfig(id: string): Promise<void> {
    this.sessionApprovedFingerprints.delete(id);
    for (const key of this.oneTimeApprovedFingerprints) {
      if (key.startsWith(`${id}:`)) {
        this.oneTimeApprovedFingerprints.delete(key);
      }
    }
    const fps = { ...this.approvedMcpFingerprints() };
    delete fps[id];
    await this.context.workspaceState.update(MCP_FINGERPRINTS_KEY, fps);
    await this.revokeMcp(id);
  }

  private async revokeMcp(id: string): Promise<void> {
    await this.context.workspaceState.update(
      MCP_APPROVED_KEY,
      this.approvedMcp().filter((x) => x !== id)
    );
  }

  /**
   * Prunes stale trust records for servers that have been removed or renamed in .vscode/mcp.json.
   */
  async pruneStaleMcpApprovals(activeServerIds: string[]): Promise<void> {
    const activeSet = new Set(activeServerIds);
    const fps = { ...this.approvedMcpFingerprints() };
    let changed = false;
    for (const id of Object.keys(fps)) {
      if (!activeSet.has(id)) {
        delete fps[id];
        changed = true;
      }
    }

    const currentApproved = this.approvedMcp();
    const filteredApproved = currentApproved.filter((id) => activeSet.has(id));
    if (changed || filteredApproved.length !== currentApproved.length) {
      await this.context.workspaceState.update(MCP_FINGERPRINTS_KEY, fps);
      await this.context.workspaceState.update(MCP_APPROVED_KEY, filteredApproved);
    }
  }

  /**
   * Clear session-scoped MCP approvals on session reset.
   */
  clearSessionApprovals(): void {
    this.sessionApprovedFingerprints.clear();
    this.oneTimeApprovedFingerprints.clear();
  }
}
