import { useEffect, useMemo, useRef } from "react";
import type { AppState, Actions } from "../state/store";
import type { ChatMessage } from "../../../src/shared/types";
import { Message } from "./Message";
import { AssistantTurn } from "./AssistantTurn";
import { Approval } from "./Approval";

type TurnGroup =
  | { kind: "user"; id: string; message: ChatMessage }
  | { kind: "assistant"; id: string; messages: ChatMessage[] }
  | { kind: "system"; id: string; message: ChatMessage };

function groupTurns(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let currentAssistant: ChatMessage[] = [];

  const flushAssistant = () => {
    if (currentAssistant.length > 0) {
      groups.push({
        kind: "assistant",
        id: currentAssistant[0].id,
        messages: currentAssistant,
      });
      currentAssistant = [];
    }
  };

  for (const m of messages) {
    if (m.hidden) continue;
    if (m.role === "assistant") {
      currentAssistant.push(m);
    } else if (m.role === "user") {
      flushAssistant();
      groups.push({ kind: "user", id: m.id, message: m });
    } else {
      flushAssistant();
      groups.push({ kind: "system", id: m.id, message: m });
    }
  }
  flushAssistant();

  return groups;
}

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

  const turnGroups = useMemo(() => groupTurns(state.messages), [state.messages]);

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
      {turnGroups.map((g) => {
        if (g.kind === "assistant") {
          return (
            <AssistantTurn
              key={g.id}
              messages={g.messages}
              pendingApproval={state.pendingApproval}
              actions={actions}
            />
          );
        }
        return (
          <Message
            key={g.id}
            message={g.message}
            pendingApproval={state.pendingApproval}
            actions={actions}
          />
        );
      })}

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
