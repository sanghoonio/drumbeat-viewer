/** Theme mode: light / dark / auto (system). Persisted; applied via data-theme, which
 * daisyui reads (atlas = light, atlas-dark = dark; auto = no attribute → system). */
import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "auto";
const KEY = "atlas-viewer-theme";
const ORDER: ThemeMode[] = ["light", "dark", "auto"];

function initial(): ThemeMode {
  const v = (typeof localStorage !== "undefined" && localStorage.getItem(KEY)) as ThemeMode | null;
  return v && ORDER.includes(v) ? v : "auto";
}

/** Set the daisyui theme from a mode (auto = remove the attribute → system default). */
export function applyTheme(mode: ThemeMode) {
  const el = document.documentElement;
  if (mode === "auto") delete el.dataset.theme;
  else el.dataset.theme = mode === "dark" ? "atlas-dark" : "atlas";
}

interface ThemeState {
  mode: ThemeMode;
  cycle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  mode: initial(),
  cycle: () => {
    const next = ORDER[(ORDER.indexOf(get().mode) + 1) % ORDER.length];
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    set({ mode: next });
  },
}));
