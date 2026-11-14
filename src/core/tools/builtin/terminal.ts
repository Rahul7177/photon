import { exec, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../shared/types";
import { clamp, clampLines, clampToolResult, ok, toolError, type Tool, type ToolResult } from "../types";
import { analyzeCommandSecurity, findShellChaining } from "../security";
import { resolveInWorkspace } from "../paths";

export { findShellChaining };

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 1024 * 1024;

/**
 * Reliably terminates an entire process tree across Windows, macOS, and Linux.
 * Prevents orphaned background descendants from lingering after abort or timeout.
 */
export function killProcessTree(child: ChildProcess): void {
  if (!child || !child.pid) return;

  try { child.stdout?.destroy(); } catch { /* ignore */ }
  try { child.stderr?.destroy(); } catch { /* ignore */ }
  try { child.stdin?.destroy(); } catch { /* ignore */ }

  if (process.platform === "win32") {
    try {
      exec(`taskkill /pid ${child.pid} /T /F`, { windowsHide: true });
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
  } else {
    // POSIX: Kill descendants via pkill, process group kill, and direct SIGKILL
    try {
      exec(`pkill -P ${child.pid}`, () => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}

export const runCommandTool: Tool = {
  spec: {
    name: "run_command",
    summary:
      "Run ONE shell command in the workspace root and return its output and exit code. Check the exit code before assuming success.",
    params: [
      {
        name: "command",
        type: "string",
        required: true,
        description: 'The shell command to run. One command at a time — never chain with &&. Example: "npm test".',
      },
      {
        name: "cwd",
        type: "string",
        required: false,
        description: "Working directory relative to workspace root. Defaults to workspace root.",
      },
    ],
    sideEffecting: true,
    priority: 8,
    minTier: "low",
    tags: ["exec", "write", "verify"],
    risk: "execute",
    concurrency: "serial",
    idempotency: "stateful",
    example: '```tool\nTOOL_NAME: run_command\nBEGIN_ARG: command\nnpm test\nEND_ARG\n```',
    verifyAfter: ["tests", "build", "diagnostics"],
  },
  async execute(args, ctx) {
    const command = (args.command as string)?.trim();
    if (!command) {
      return toolError("invalid_args", 'Missing required argument "command". Provide a command to run.');
    }

    // §6.2: run_command accepts ONE command at a time.
    const chained = findShellChaining(command);
    if (chained) {
      return toolError(
        "invalid_args",
        `Run one command at a time with run_command — chaining/substitution with "${chained}" is not allowed. Split into separate calls. Got: "${command.slice(0, 120)}"`,
        { recovery: { action: "repair", hints: ["Split chained commands into separate run_command calls"] } }
      );
    }

    if (!ctx.workspaceRoot) return toolError("execution_error", "No workspace folder is open.");
    const cwdRel = (args.cwd as string)?.trim();
    let cwd = ctx.workspaceRoot;
    if (cwdRel) {
      const r = resolveInWorkspace(ctx.workspaceRoot, cwdRel);
      if ("error" in r) return toolError("not_found", r.error);
      cwd = r.abs;
    }

    const requested = Number(args.timeout_ms ?? args.timeoutMs);
    const timeoutMs =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    const secAnalysis = analyzeCommandSecurity(command);

    // Present exact command and working directory to the user in approval request.
    // Dangerous/destructive commands remain "critical" (never auto-approved);
    // standard non-dangerous commands use "execute" (prompt when autoApprove=false, allowed when global autoApprove=true).
    const toolCall: ToolCall = {
      id: ctx.pendingCallId ?? randomUUID(),
      name: "run_command",
      args: { command, cwd },
      status: "proposed",
      sideEffecting: true,
      risk: secAnalysis.isDangerous ? "critical" : "execute",
      statusDetail: secAnalysis.isDangerous
        ? `High-risk action: ${secAnalysis.reason}`
        : `Terminal execution in: ${cwd}`,
    };

    const approved = await ctx.requestApproval(toolCall);
    if (ctx.signal.aborted) return toolError("execution_error", "Command cancelled.");
    if (!approved) {
      return toolError(
        "permission_denied",
        secAnalysis.isDangerous
          ? `User declined high-risk action: ${secAnalysis.reason}`
          : "User declined to run the command."
      );
    }

    ctx.log(`$ ${command}`);

    return executeShellCommand({
      command,
      cwd,
      timeoutMs,
      signal: ctx.signal,
    });
  },
};

export interface ShellExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  maxOutputChars?: number;
}

/**
 * Shared hardened single-command executor used by both local (`run_command`)
 * and cloud (`execute_command`) terminal tools.
 */
export function executeShellCommand(opts: ShellExecOptions): Promise<ToolResult> {
  const { command, cwd, timeoutMs, signal, maxOutputChars } = opts;

  return new Promise((resolve) => {
    if (signal.aborted) return resolve(toolError("execution_error", "Command cancelled."));

    let settled = false;
    let child: ChildProcess | undefined;

    const finish = (res: ToolResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(res);
    };

    const onAbort = () => {
      if (child) {
        killProcessTree(child);
      }
      finish(toolError("execution_error", "Command cancelled."));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    child = exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (settled || signal.aborted) {
          return finish(toolError("execution_error", "Command cancelled."));
        }

        if (error && (error as { killed?: boolean }).killed) {
          if (child) killProcessTree(child);
          const partial = [stdout, stderr].filter(Boolean).join("\n").trim();
          const clampedPartial = maxOutputChars ? clamp(partial, maxOutputChars) : clampToolResult(partial);
          return finish(
            toolError(
              "timeout",
              `Command timed out after ${Math.round(timeoutMs / 1000)}s.\n${clampedPartial}`,
              { retryable: true, recovery: { action: "retry" } }
            )
          );
        }

        const code = error ? ((error as unknown as { code?: number }).code ?? 1) : 0;
        const header = `Exit code ${code}.`;

        let outputText = "";
        const trimmedStdout = (stdout || "").trim();
        const trimmedStderr = (stderr || "").trim();

        if (trimmedStdout && trimmedStderr) {
          outputText = `${header}\n[stdout]\n${clampLines(trimmedStdout, 60)}\n\n[stderr]\n${clampLines(trimmedStderr, 30)}`;
        } else if (trimmedStderr) {
          outputText = `${header}\n[stderr]\n${clampLines(trimmedStderr, 80)}`;
        } else if (trimmedStdout) {
          outputText = `${header}\n${clampLines(trimmedStdout, 80)}`;
        } else {
          outputText = `${header}\n${error?.message || "(no output)"}`;
        }

        outputText = maxOutputChars ? clamp(outputText, maxOutputChars) : clampToolResult(outputText);

        if (code !== 0) {
          return finish(
            toolError("execution_error", outputText, {
              retryable: true,
              recovery: {
                action: "repair",
                hints: ["Inspect the output/stderr above, fix errors, and re-run"],
              },
            })
          );
        }

        finish(ok(outputText, { metadata: { evidence: [`command exited 0: ${command}`] } }));
      }
    );
  });
}
