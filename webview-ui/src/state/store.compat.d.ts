declare module "./store" {
  interface AppState {
    /** Mirrors PhotonConfig.autoSelectModel for optimistic model-picker state. */
    autoSelectModel?: boolean;
  }
}
export {};
