import type { ToolCall } from "../../../src/shared/types";
import type { Actions } from "../state/store";

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
    actions.approve(call.id, approved, remember);
    onResolved();
  };
  return (
    <div className="approval">
      <div className="approval-title">Allow {call.name}?</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
        {Object.entries(call.args ?? {}).map(([k, v]) => (
          <div key={k}>
            {k}: {truncate(String(v))}
          </div>
        ))}
      </div>
      <div className="approval-actions">
        <button className="btn primary" onClick={() => decide(true)}>
          Allow
        </button>
        <button className="btn" onClick={() => decide(true, true)}>
          Always allow
        </button>
        <button className="btn ghost" onClick={() => decide(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
