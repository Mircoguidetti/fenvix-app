import { useSyncExternalStore } from "react";

/**
 * An invitation link is /invite#token=…. The token is read once, as the page loads, kept in sessionStorage (this tab
 * only) and taken out of the address bar, so it is not left in history, bookmarks or a screenshot. It survives the
 * sign-in that may come first, and is dropped once the invitation is accepted or dismissed.
 */
const KEY = "fenvix-invite";
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const listeners = new Set<() => void>();
let pending: string | null = null;

try {
  pending = sessionStorage.getItem(KEY);
} catch {
  pending = null;
}

/** Called once before the app renders. */
export function captureInviteFromUrl(): void {
  if (window.location.pathname !== "/invite") return;
  const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  if (token && TOKEN.test(token)) {
    pending = token;
    try {
      sessionStorage.setItem(KEY, token);
    } catch {
      /* memory only */
    }
  }
  window.history.replaceState(window.history.state, "", "/invite");
}

export function clearPendingInvite(): void {
  pending = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function usePendingInvite(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
    () => pending,
  );
}
