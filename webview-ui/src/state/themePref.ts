export type ThemePreference = "auto" | "dark" | "light";

const THEME_STORAGE_KEY = "photon.theme";

/** Read persisted webview theme preference, defaulting cleanly to `"auto"` (follows VS Code). */
export function getThemePreference(): ThemePreference {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_STORAGE_KEY) : null;
    if (raw === "dark" || raw === "light" || raw === "auto") return raw;
  } catch {
    // Ignore storage access restrictions in tests or sandboxed contexts
  }
  return "auto";
}

/** Apply theme preference to document body (`data-theme`) so `"auto"` defers to VS Code host theme classes. */
export function applyThemePreference(pref: ThemePreference): void {
  if (typeof document === "undefined" || !document.body) return;
  if (pref === "auto") {
    delete document.body.dataset.theme;
  } else {
    document.body.dataset.theme = pref;
  }
}

/** Persist and immediately apply a theme preference change. */
export function setThemePreference(pref: ThemePreference): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, pref);
    }
  } catch {
    // Ignore storage errors
  }
  applyThemePreference(pref);
}
