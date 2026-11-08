import { exec, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../shared/types";
import { clampLines, clampToolResult, ok, toolError, type Tool } from "../types";
import { analyzeCommandSecurity, isUnattendedCommandAllowed } from "../security";
import { resolveInWorkspace } from "../paths";

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
    const isUnattended = isUnattendedCommandAllowed(command);

    // Present exact command and working directory to the user in approval request
    const toolCall: ToolCall = {
      id: ctx.pendingCallId ?? randomUUID(),
      name: "run_command",
      args: { command, cwd },
      status: "proposed",
      sideEffecting: true,
      risk: secAnalysis.isDangerous ? "critical" : isUnattended ? "execute" : "critical",
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

    return new Promise((resolve) => {
      if (ctx.signal.aborted) return resolve(toolError("execution_error", "Command cancelled."));

      let settled = false;
      let child: ReturnType<typeof exec> | undefined;

      const finish = (res: ReturnType<typeof ok>) => {
        if (settled) return;
        settled = true;
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(res);
      };

      const onAbort = () => {
        if (child) {
          killProcessTree(child);
        }
        finish(toolError("execution_error", "Command cancelled."));
      };

      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child = exec(
        command,
        { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          if (settled || ctx.signal.aborted) {
            return finish(toolError("execution_error", "Command cancelled."));
          }

          if (error && (error as { killed?: boolean }).killed) {
            return finish(
              toolError(
                "timeout",
                `Command timed out after ${Math.round(timeoutMs / 1000)}s.\n${clampToolResult(stdout || stderr || "")}`,
                { retryable: true, recovery: { action: "retry" } }
              )
            );
          }

          const code = error ? ((error as unknown as { code?: number }).code ?? 1) : 0;
          const header = `Exit code ${code}.`;

          // Clearly label stdout and stderr streams
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

          outputText = clampToolResult(outputText);

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
  },
};

/**
 * Detect shell chaining, substitution, redirection, or PowerShell-specific syntax
 * outside single and double quotes. Returns offending token or null.
 */
export function findShellChaining(cmd: string): string | null {
  let sq = false, dq = false, esc = false;

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === "'" && !dq) { sq = !sq; continue; }
    if (c === '"' && !sq) { dq = !dq; continue; }
    if (sq || dq) continue;

    const two = cmd.slice(i, i + 2);
    // Chaining operators
    if (two === "&&" || two === "||" || two === "|&") return two;
    // Redirection and pipeline
    if (two === ">>" || two === "2>" || two === "<(" || two === ">(") return two;
    if (c === ";" || c === "|" || c === "&" || c === "`" || c === ">" || c === "<") return c;

    // Subexpression / command substitution
    if (two === "$(" || two === "@(") return two;
    // Newline splitting
    if (c === "\n" || c === "\r") return "\\n";
  }

  return null;
}
