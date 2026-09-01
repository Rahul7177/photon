import { useEffect, useRef } from "react";
import type { AppState, Actions } from "../state/store";
import { Message } from "./Message";
import { Approval } from "./Approval";

export function MessageList({
  state,
  dispatch,
  actions,
}: {
  state: AppState;
  dispatch: (a: { type: "_clearApproval" }) => void;
  actions: Actions;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Whether the user is parked at (or near) the bottom. While they've scrolled
  // up to read, streaming deltas must NOT yank the viewport down again.
  const nearBottom = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!nearBottom.current) return;
    // "auto" (not smooth) so rapid streaming deltas don't queue animations.
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [state.messages, state.pendingApproval]);

  return (
    <div className="messages" ref={containerRef}>
      {state.messages.filter((m) => !m.hidden).map((m) => (
        <Message key={m.id} message={m} />
      ))}

      {state.pendingApproval && (
        <Approval
          call={state.pendingApproval}
          actions={actions}
          onResolved={() => dispatch({ type: "_clearApproval" })}
        />
      )}

      <div ref={endRef} />
    </div>
  );
}
