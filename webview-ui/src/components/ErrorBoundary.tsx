import { Component, type ErrorInfo, type ReactNode } from "react";
import { sanitizeErrorMessage } from "./ErrorBanner";

interface State {
  error: Error | null;
}

/**
 * Catches any render-time exception so a single malformed host message can't
 * white-screen the whole webview. Offers a reset that clears the error and
 * re-renders (the next host message repopulates state).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaced in the webview devtools console for debugging.
    console.error("Photon UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const sanitized = sanitizeErrorMessage(this.state.error.message);
      return (
        <div className="app">
          <div className="banner error-banner" role="alert" style={{ margin: 16 }}>
            <span className="error-text">
              Something went wrong rendering the view: {sanitized}
            </span>
          </div>
          <div style={{ padding: "0 16px", display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={() => this.setState({ error: null })}
            >
              Reload view
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }}
            >
              Hard refresh
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
