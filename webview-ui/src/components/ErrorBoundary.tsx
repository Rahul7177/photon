import { Component, type ErrorInfo, type ReactNode } from "react";

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
      return (
        <div className="app">
          <div className="banner error-banner" style={{ margin: 16 }}>
            <span className="error-text">
              Something went wrong rendering the view. {this.state.error.message}
            </span>
          </div>
          <div style={{ padding: "0 16px" }}>
            <button className="btn primary" onClick={() => this.setState({ error: null })}>
              Reload view
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
