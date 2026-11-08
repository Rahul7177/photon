import type { ToolCall } from "../../../src/shared/types";
import type { Actions } from "../state/store";
import { FileCodeIcon } from "./Icons";

export function Approval({
  call,
  actions,
  onResolved,
}: {
  call: ToolCall;
  actions: Actions;
  onResolved: () => void;
}) {
  const decide = (approved: boolean, remember?: boolean) => {
    actions.approve(call.id, approved, remember, call.name);
    onResolved();
  };

  const args = call.args ?? {};
  const toolName = call.name || "tool";

  // Identify special tool types for tailored, readable previews
  const isFileWrite = /write|create/i.test(toolName);
  const isFileEdit = /edit|replace|patch/i.test(toolName);
  const isCommand = /exec|command|bash|terminal|shell/i.test(toolName);

  const filePath = (args.path || args.file || args.filepath || args.target_file || args.file_path) as string | undefined;
  const content = (args.content || args.file_text || args.text) as string | undefined;
  const oldStr = (args.old_str || args.old_string || args.find) as string | undefined;
  const newStr = (args.new_str || args.new_string || args.replace) as string | undefined;
  const command = (args.command || args.cmd) as string | undefined;

  const isDestructive =
    (call as any).risk === "destructive" ||
    /delete|remove|rmdir|unlink|drop|purge|reset/i.test(toolName) ||
    Boolean(command && /\b(rm\s+-[rf]|git\s+reset\s+--hard|drop\s+database|del\s+\/[fq]|format)\b/i.test(command));

  let permissionDescription = "Execute tool operation";
  if (isFileWrite) permissionDescription = "Write / create file on disk in your workspace";
  else if (isFileEdit) permissionDescription = "Modify existing file content in your workspace";
  else if (isCommand) permissionDescription = "Execute command in terminal with OS privileges";
  else if (/delete|remove/i.test(toolName)) permissionDescription = "Permanently delete file or directory in your workspace";

  return (
    <div className={`approval${isDestructive ? " approval-destructive" : ""}`} role="region" aria-label={`Tool approval required for ${toolName}`}>
      <div className="approval-header">
        <div className="approval-title-wrap">
          <span className={`approval-badge${isDestructive ? " destructive" : ""}`} aria-hidden="true">
            {isDestructive ? "⚠️" : "!"}
          </span>
          <span className="approval-title-text">
            {isDestructive ? "Confirm Destructive Action: " : "Allow "}
            <strong>{toolName}</strong>?
          </span>
        </div>
        {filePath && (
          <div className="approval-file-pill" title={filePath}>
            <span className="approval-file-icon"><FileCodeIcon /></span>
            <span className="approval-file-name">{filePath}</span>
          </div>
        )}
      </div>

      {isDestructive && (
        <div className="approval-destructive-banner" role="alert">
          <strong>Warning:</strong> This operation permanently alters workspace state or executes high-risk shell commands.
        </div>
      )}

      <div className="approval-permission-hint">
        <span className="permission-key">Permission requested:</span> <span>{permissionDescription}</span>
      </div>

      <div className="approval-body">
        {/* Case 1: File Write (e.g. write_to_file) */}
        {isFileWrite && content !== undefined && (
          <div className="approval-section">
            <div className="approval-section-label">File Content Preview:</div>
            <pre className="approval-code-block">{previewText(content)}</pre>
          </div>
        )}

        {/* Case 2: File Edit / Replace (e.g. replace_in_file) */}
        {isFileEdit && (oldStr !== undefined || newStr !== undefined) && (
          <div className="approval-section">
            {oldStr !== undefined && (
              <div className="approval-diff-block diff-old">
                <div className="approval-diff-label">Replace:</div>
                <pre className="approval-code-block old">{previewText(oldStr)}</pre>
              </div>
            )}
            {newStr !== undefined && (
              <div className="approval-diff-block diff-new">
                <div className="approval-diff-label">With:</div>
                <pre className="approval-code-block new">{previewText(newStr)}</pre>
              </div>
            )}
          </div>
        )}

        {/* Case 3: Command execution */}
        {isCommand && command !== undefined && (
          <div className="approval-section">
            <div className="approval-section-label">Command to execute:</div>
            <div className="approval-command-block">
              <span className="approval-prompt-symbol">$</span>
              <code>{command}</code>
            </div>
          </div>
        )}

        {/* Case 4: General arguments for any other tools or extra args */}
        {(() => {
          const skipKeys = new Set<string>();
          if (isFileWrite) { skipKeys.add("path"); skipKeys.add("file"); skipKeys.add("content"); skipKeys.add("file_text"); }
          if (isFileEdit) { skipKeys.add("path"); skipKeys.add("file"); skipKeys.add("old_str"); skipKeys.add("new_str"); skipKeys.add("find"); skipKeys.add("replace"); }
          if (isCommand) { skipKeys.add("command"); skipKeys.add("cmd"); }

          const remaining = Object.entries(args).filter(([k]) => !skipKeys.has(k));
          if (!remaining.length && (isFileWrite || isFileEdit || isCommand)) return null;

          return (
            <div className="approval-args-grid">
              {remaining.map(([k, v]) => {
                const strVal = typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
                const isLong = strVal.length > 70 || strVal.includes("\n");
                return (
                  <div key={k} className={`approval-arg-entry${isLong ? " long" : ""}`}>
                    <span className="approval-arg-key">{k}:</span>
                    {isLong ? (
                      <pre className="approval-code-block compact">{previewText(strVal)}</pre>
                    ) : (
                      <span className="approval-arg-val">{strVal}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      <div className="approval-actions">
        <button
          type="button"
          className={`btn primary approval-btn-allow${isDestructive ? " btn-destructive" : ""}`}
          aria-label={isDestructive ? `Confirm destructive action ${toolName}` : `Allow ${toolName} once`}
          onClick={() => decide(true, false)}
        >
          {isDestructive ? "Confirm & Allow Once" : "Allow"}
        </button>
        <button
          type="button"
          className="btn approval-btn-always"
          aria-label={isDestructive ? "Always allow is disabled for destructive commands" : "Always allow tools in this session"}
          disabled={isDestructive}
          title={isDestructive ? "Always allow is disabled for destructive actions to protect your workspace" : "Always allow this tool for this session"}
          onClick={() => decide(true, true)}
        >
          Always allow in session
        </button>
        <button
          type="button"
          className="btn ghost approval-btn-deny"
          aria-label={`Deny ${toolName}`}
          onClick={() => decide(false, false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function previewText(s: string, maxLen = 4000): string {
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n… [${s.length - maxLen} more characters]`;
}
