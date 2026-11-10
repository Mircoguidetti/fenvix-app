import { useCallback, useEffect, useState } from "react";

/**
 * Light or dark. Until the person picks one with the button in the top bar, the dashboard follows the device
 * (prefers-color-scheme, handled in styles.css). A pick is kept in this browser only: it is a convenience, never sent
 * to the server.
 */
export type Theme = "light" | "dark";
const KEY = "fenvix-theme";

export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function deviceTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Sets data-theme on <html>; with no pick, removes it so the device setting applies. */
export function applyTheme(theme: Theme | null) {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? deviceTheme());
  useEffect(() => {
    if (storedTheme()) return;
    const m = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!m) return;
    const on = () => setTheme(m.matches ? "dark" : "light");
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* private window: the pick lasts for this page only */
      }
      applyTheme(next);
      return next;
    });
  }, []);
  return { theme, toggle };
}
