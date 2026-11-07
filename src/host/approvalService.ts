import type { ToolCall } from "../shared/types";
import type { McpServerConfig } from "../core/tools/mcp/bridge";

/**
 * Manages tool execution approval lifecycles, auto-approve state, and MCP configuration parsing.
 */
export class ApprovalService {
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private sessionApprovedToolNames = new Set<string>();
  public autoApprove: boolean;

  constructor(initialAutoApprove = false) {
    this.autoApprove = initialAutoApprove;
  }

  /** Number of tool calls currently awaiting user approval. */
  get pendingCount(): number {
    return this.pendingApprovals.size;
  }

  /** Request user approval for a side-effecting tool call. */
  requestApproval(
    call: ToolCall,
    onPostRequest: (call: ToolCall) => void
  ): Promise<boolean> {
    if (
      this.autoApprove ||
      !call.sideEffecting ||
      this.sessionApprovedToolNames.has(call.name)
    ) {
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
    if (remember && approved) {
      if (toolName) {
        this.sessionApprovedToolNames.add(toolName);
      }
      if (!this.autoApprove) {
        this.autoApprove = true;
        autoApproveChanged = true;
      }
    }
    resolve(approved);
    return { resolved: true, autoApproveChanged };
  }

  /** Cancel and deny all pending approvals (e.g., when a turn is aborted or switched). */
  cancelAllPending(): number {
    let count = 0;
    for (const [id, resolve] of this.pendingApprovals) {
      this.pendingApprovals.delete(id);
      resolve(false);
      count++;
    }
    return count;
  }

  /** Clear session-scoped tool approvals (e.g., on new session if desired). */
  clearSessionApprovals(): void {
    this.sessionApprovedToolNames.clear();
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
          permissions: v.permissions,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

