/* Global theme store — module-level state + subscription so every component
   (TopBar button, Settings switch) sees the same value and updates together. */

import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "anistream.theme";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

let current: Theme = initialTheme();
const listeners = new Set<(t: Theme) => void>();

// apply once at module load (component render must not race the boot script)
document.documentElement.dataset.theme = current;

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.documentElement.style.background = "";
  document.documentElement.style.color = "";
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(t: Theme) {
  current = t;
  apply(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l(t));
}

export function toggleTheme() {
  setTheme(current === "dark" ? "light" : "dark");
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getTheme,
  );
  return { theme, toggle: toggleTheme };
}
