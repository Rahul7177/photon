import type { AppState } from "../state/store";

const SUGGESTIONS: Record<string, string[]> = {
  chat: [
    "Explain what this project does",
    "Write a debounce function in TypeScript",
    "What's the difference between let and const?",
  ],
  plan: [
    "Plan how to add a settings page",
    "Plan a refactor of the auth module",
    "Outline steps to add unit tests",
  ],
  agent: [
    "Create a README for this project",
    "Find and fix the TODO comments",
    "Add error handling to the API calls",
  ],
};

export function Hero({ state, onPick }: { state: AppState; onPick: (t: string) => void }) {
  const model = state.models.find((m) => m.name === state.selectedModel);
  return (
    <div className="messages">
      <div className="hero">
        <h2>Start a conversation</h2>
        <p>Agentic coding with local models, tuned to fit.</p>
        {model && (
          <p style={{ color: "var(--text-faint)", fontSize: 11 }}>
            {model.name} · {model.tier ?? "?"} tier
            {model.contextLength ? ` · ${model.contextLength.toLocaleString()} ctx` : ""}
          </p>
        )}
        <div className="suggestions">
          {(SUGGESTIONS[state.mode] ?? []).map((s) => (
            <button
              key={s}
              className="suggestion"
              disabled={!state.selectedModel}
              onClick={() => onPick(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
