import { useSyncExternalStore } from "react";

/** Bumped whenever the workspace settings change, so every screen showing them reloads. */
let version = 0;
const listeners = new Set<() => void>();

export function workspaceChanged() {
  version++;
  listeners.forEach((l) => l());
}

export function useWorkspaceVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
}
