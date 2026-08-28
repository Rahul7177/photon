import { useState } from "react";
import { useAppState } from "./state/store";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { Hero } from "./components/Hero";
import { OfflineBanner } from "./components/OfflineBanner";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusIndicator } from "./components/StatusIndicator";
import { ErrorBanner } from "./components/ErrorBanner";

export function App() {
  const { state, dispatch, actions } = useAppState();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="app">
      <Header state={state} actions={actions} onOpenSettings={() => setShowSettings(true)} />
      {showSettings ? (
        <SettingsPanel state={state} actions={actions} onClose={() => setShowSettings(false)} />
      ) : (
        <>
          {!state.ollamaReachable && state.ready && state.config.interfaceMode === "local" && (
            <OfflineBanner onRetry={actions.refreshModels} />
          )}
          {state.messages.length === 0 ? (
            <Hero state={state} onPick={actions.send} />
          ) : (
            <MessageList state={state} dispatch={dispatch} actions={actions} />
          )}
          {state.error && (
            <ErrorBanner message={state.error} onClose={() => dispatch({ type: "_clearError" })} />
          )}
          <StatusIndicator state={state} />
          <Composer state={state} actions={actions} />
        </>
      )}
    </div>
  );
}
