import * as vscode from "vscode";

const PIN_KEY = "photon.pinnedModel";
const MCP_APPROVED_KEY = "photon.mcpApproved";

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

  isMcpApproved(id: string): boolean {
    return this.approvedMcp().includes(id);
  }

  async approveMcp(id: string): Promise<void> {
    const set = new Set(this.approvedMcp());
    set.add(id);
    await this.context.workspaceState.update(MCP_APPROVED_KEY, [...set]);
  }

  async revokeMcp(id: string): Promise<void> {
    await this.context.workspaceState.update(
      MCP_APPROVED_KEY,
      this.approvedMcp().filter((x) => x !== id)
    );
  }
}
