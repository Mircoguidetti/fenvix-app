import type { DbState } from "../data";

/** Filled dot = awake, hollow dot = asleep. The word always carries the meaning. */
export function StateBadge({ state }: { state: DbState }) {
  return (
    <span className={`state ${state === "awake" ? "state-awake" : "state-asleep"}`}>
      <span className={`dot ${state === "awake" ? "dot-filled" : "dot-outline"}`} aria-hidden="true" />
      {state === "awake" ? "Awake" : "Asleep"}
    </span>
  );
}

export function KeyStatus({ revoked }: { revoked: boolean }) {
  return (
    <span className={`state ${revoked ? "state-asleep" : "state-awake"}`}>
      <span className={`dot ${revoked ? "dot-outline" : "dot-filled"}`} aria-hidden="true" />
      {revoked ? "Revoked" : "Active"}
    </span>
  );
}
