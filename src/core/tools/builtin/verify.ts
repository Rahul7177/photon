import { resolveInWorkspace } from "../paths";
import { clamp, fail, ok, outputBudget, type Tool } from "../types";

/**
 * Surface the editor's own problems (compile errors, lint warnings) to the
 * model. This is the verification half of the edit loop: a weak model that
 * just made a change can ASK the editor whether anything broke instead of
 * assuming success — the single biggest defense against confident breakage.
 */
export const getDiagnosticsTool: Tool = {
  spec: {
    name: "get_diagnostics",
    summary: "Get current errors and warnings from the editor for a file, or the whole workspace.",
    params: [
      { name: "path", type: "string", required: false, description: "File to check, relative to the workspace root. Omit to check every open project file." },
      { name: "errors_only", type: "boolean", required: false, description: "true = only errors, skip warnings/info (default false)." },
    ],
    sideEffecting: false,
    priority: 7,
    minTier: "low",
    tags: ["verify", "read"],
    example: '[TOOL get_diagnostics]\npath: src/app.ts\n[/TOOL]',
  },
  async execute(args, ctx) {
    const rel = (args.path as string)?.trim();
    let absFilter: string | undefined;
    if (rel && rel !== "." && rel !== "/") {
      const r = resolveInWorkspace(ctx.workspaceRoot, rel);
      if ("error" in r) return fail(r.error);
      absFilter = r.abs;
    }

    try {
      const all = await ctx.getDiagnostics(absFilter);
      const errorsOnly = args.errors_only === true;
      const filtered = errorsOnly ? all.filter((d) => d.severity === "error") : all;

      if (filtered.length === 0) {
        return ok(
          all.length > 0
            ? `No errors${absFilter ? " in this file" : ""} — only warnings/info exist (${all.length}). Pass errors_only: false to see them.`
            : `No problems detected${absFilter ? ` in ${rel}` : " in the workspace"}. The code is clean.`
        );
      }

      const budget = outputBudget(ctx);
      const maxShown = ctx.capability === "low" ? 20 : 50;
      // Hard cap total problems considered to prevent 5k-diagnostic blast (audit)
      const cappedFiltered = filtered.slice(0, 200);
      const eff = cappedFiltered.slice(0, maxShown);
      const lines = eff.map((d) => {
        const sev = d.severity === "error" ? "ERROR" : d.severity === "warning" ? "WARN" : "INFO";
        return `${sev} ${d.file}:${d.line}:${d.col}${d.source ? ` [${d.source}]` : ""}: ${d.message}`;
      });
      const more = cappedFiltered.length > maxShown ? `\n… (${cappedFiltered.length - maxShown} more)` : "";
      const overflow = filtered.length > 200 ? ` (+${filtered.length - 200} beyond cap)` : "";
      return ok(clamp(`${cappedFiltered.length} problem(s)${overflow}:\n${lines.join("\n")}${more}`, budget));
    } catch (e) {
      return fail(`Could not read diagnostics: ${(e as Error).message}`);
    }
  },
};
