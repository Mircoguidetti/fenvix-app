import { useSyncExternalStore } from "react";

/**
 * The organization the dashboard acts for. Chosen here, in the browser, and sent with every request as
 * X-Fenvix-Workspace; the server checks on every request that the person is a member of it and uses their role there.
 * Nothing here is trusted: a wrong or stale id only gets a "not found" from the API.
 */
const KEY = "fenvix-org";
export const ORG_HEADER = "X-Fenvix-Workspace";

let active: string | null = read();
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && /^[0-9a-z_-]{3,64}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function activeOrgId(): string | null {
  return active;
}

export function setActiveOrgId(id: string | null): void {
  if (id === active) return;
  active = id;
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: memory only */
  }
  listeners.forEach((l) => l());
}

export function useActiveOrgId(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => active,
    () => active,
  );
}

/** The chosen organization's id when it looks like one of the API's (a UUID): the only value ever sent. */
export function activeWorkspaceId(): string | null {
  return active && /^[0-9a-f-]{36}$/i.test(active) ? active : null;
}

/** The header for a request, when an organization is chosen. */
export function orgHeaders(): Record<string, string> {
  const id = activeWorkspaceId();
  return id ? { [ORG_HEADER]: id } : {};
}
