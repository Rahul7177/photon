import type { ToolCall } from "../shared/types";
import type { McpServerConfig } from "../core/tools/mcp/bridge";

/**
 * Manages tool execution approval lifecycles, auto-approve state, and MCP configuration parsing.
 * Enforces fail-closed rules: critical/destructive commands can NEVER bypass confirmation
 * through general auto-approve.
 */
export class ApprovalService {
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private sessionApprovedToolNames = new Set<string>();
  private approvedCallIds = new Set<string>();
  private userConfiguredAutoApprove = false;
  private sessionAutoApprove = false;

  constructor(initialAutoApprove = false) {
    this.userConfiguredAutoApprove = initialAutoApprove;
  }

  /**
   * Returns true if user global preference has enabled auto-approval
   * OR the user chose "Always allow in session" for this active session.
   */
  get autoApprove(): boolean {
    return this.userConfiguredAutoApprove || this.sessionAutoApprove;
  }

  /** Set user-level auto-approve setting. Setting to false also clears session auto-approval. */
  set autoApprove(val: boolean) {
    this.userConfiguredAutoApprove = val;
    if (!val) {
      this.sessionAutoApprove = false;
    }
  }

  /** True only if user enabled global auto-approve in settings. */
  get isUserConfiguredAutoApprove(): boolean {
    return this.userConfiguredAutoApprove;
  }

  /** True if auto-approval was granted specifically for this session. */
  get isSessionAutoApprove(): boolean {
    return this.sessionAutoApprove;
  }

  /** Number of tool calls currently awaiting user approval. */
  get pendingCount(): number {
    return this.pendingApprovals.size;
  }

  /**
   * Request user approval for a tool call.
   * Critical and destructive actions (such as high-risk shell commands or file removals)
   * can NEVER bypass confirmation through general auto-approve.
   */
  requestApproval(
    call: ToolCall,
    onPostRequest: (call: ToolCall) => void
  ): Promise<boolean> {
    if (call.id && this.approvedCallIds.has(call.id)) {
      return Promise.resolve(true);
    }

    const isCritical = call.risk === "critical" || call.risk === "destructive";

    if (
      !isCritical &&
      (this.autoApprove ||
        !call.sideEffecting ||
        this.sessionApprovedToolNames.has(call.name))
    ) {
      if (call.id) this.approvedCallIds.add(call.id);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(call.id, resolve);
      onPostRequest(call);
    });
  }

  /** Resolve a pending tool approval from the UI. */
  resolveApproval(
    callId: string,
    approved: boolean,
    remember?: boolean,
    toolName?: string
  ): { resolved: boolean; autoApproveChanged: boolean } {
    const resolve = this.pendingApprovals.get(callId);
    if (!resolve) {
      return { resolved: false, autoApproveChanged: false };
    }
    this.pendingApprovals.delete(callId);
    let autoApproveChanged = false;
    if (approved) {
      this.approvedCallIds.add(callId);
    }
    if (remember && approved) {
      // General shell execution ('run_command') cannot receive blanket session approval
      // because arbitrary dangerous commands could be executed under the same tool name.
      if (toolName && toolName !== "run_command") {
        this.sessionApprovedToolNames.add(toolName);
      }
      if (!this.sessionAutoApprove) {
        this.sessionAutoApprove = true;
        if (!this.userConfiguredAutoApprove) {
          autoApproveChanged = true;
        }
      }
    }
    resolve(approved);
    return { resolved: true, autoApproveChanged };
  }

  /** Cancel and deny all pending approvals (e.g., when a turn is aborted or switched). */
  cancelAllPending(): number {
    this.approvedCallIds.clear();
    let count = 0;
    for (const [id, resolve] of this.pendingApprovals) {
      this.pendingApprovals.delete(id);
      resolve(false);
      count++;
    }
    return count;
  }

  /** Clear session-scoped tool approvals and reset session-level auto-approval. */
  clearSessionApprovals(): { autoApproveChanged: boolean } {
    this.sessionApprovedToolNames.clear();
    this.approvedCallIds.clear();
    const hadSessionAuto = this.sessionAutoApprove;
    this.sessionAutoApprove = false;
    const changed = hadSessionAuto && !this.userConfiguredAutoApprove;
    return { autoApproveChanged: changed };
  }

  /** Clear turn-scoped approvals without resetting session-level permissions. */
  clearTurnApprovals(): void {
    this.approvedCallIds.clear();
  }
}

/**
 * Parse `.vscode/mcp.json` contents into typed `McpServerConfig[]`.
 */
export function parseMcpConfigJson(rawJson: string): McpServerConfig[] {
  try {
    const json = JSON.parse(rawJson) as {
      servers?: Record<
        string,
        {
          url?: string;
          headers?: Record<string, string>;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          cwd?: string;
          allowLocalNetwork?: boolean;
          permissions?: McpServerConfig["permissions"];
        }
      >;
    };
    const out: McpServerConfig[] = [];
    for (const [id, v] of Object.entries(json.servers ?? {})) {
      if (!v || typeof v !== "object") continue;
      if (typeof v.url === "string") {
        out.push({
          id,
          transport: "http",
          url: v.url,
          headers: v.headers,
          allowLocalNetwork: v.allowLocalNetwork,
          permissions: v.permissions,
        });
      } else if (typeof v.command === "string") {
        out.push({
          id,
          transport: "stdio",
          command: v.command,
          args: v.args,
          env: v.env,
          cwd: v.cwd,
          permissions: v.permissions,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
