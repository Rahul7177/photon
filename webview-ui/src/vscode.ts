import type { HostMessage, ViewMessage } from "../../src/shared/protocol";

interface VsCodeApi {
  postMessage(msg: ViewMessage): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// acquireVsCodeApi may only be called once per webview.
export const vscode: VsCodeApi = acquireVsCodeApi();

export function post(msg: ViewMessage): void {
  vscode.postMessage(msg);
}

export function onHostMessage(handler: (msg: HostMessage) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data as HostMessage);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
