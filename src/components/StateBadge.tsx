import type { DbState } from "../data";

/** Filled dot = awake, outlined dot = asleep. The text label always carries the meaning. */
export function StateBadge({ state }: { state: DbState }) {
  return (
    <span className="state">
      <span className={`dot ${state === "awake" ? "dot-filled" : "dot-outline"}`} aria-hidden="true" />
      {state === "awake" ? "Awake" : "Asleep"}
    </span>
  );
}

export function KeyStatus({ revoked }: { revoked: boolean }) {
  return (
    <span className="state">
      <span className={`dot ${revoked ? "dot-outline" : "dot-filled"}`} aria-hidden="true" />
      {revoked ? "Revoked" : "Active"}
    </span>
  );
}
