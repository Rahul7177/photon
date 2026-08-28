import type { McpTool } from "./mcpClient";

/**
 * Common surface for an MCP transport (Streamable HTTP or stdio). The manager
 * treats every server through this interface so per-server approval, tool
 * bridging, and teardown are identical regardless of how the server is reached.
 */
export interface IMcpClient {
  connect(timeoutMs?: number): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  /** Release the session / child process. Best-effort; never throws. */
  close(): Promise<void>;
}
