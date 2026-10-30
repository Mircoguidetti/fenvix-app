import type { ReactNode } from "react";
import type { DbState, PublicKeyStatus } from "../data";

/**
 * A state as a pill: a dot and a word. The word always carries the meaning; the colour only repeats it.
 * "ok" is green (awake, active, paid), "warn" is amber (in progress, waiting), "neutral" stays grey.
 */
export type Tone = "ok" | "warn" | "neutral";

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls = tone === "ok" ? "state state-ok" : tone === "warn" ? "state state-warn" : "state";
  return (
    <span className={cls} data-tone={tone}>
      <span className={`dot ${tone === "neutral" ? "dot-outline" : "dot-filled"}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** Filled green dot = awake, dark dot = kept awake, hollow grey dot = asleep. */
export function StateBadge({ state, kept }: { state: DbState; kept?: boolean }) {
  if (kept)
    return (
      <span className="state state-kept" data-tone="neutral">
        <span className="dot dot-filled" aria-hidden="true" />
        Kept awake
      </span>
    );
  return (
    <span className={`state ${state === "awake" ? "state-awake" : "state-asleep"}`} data-tone={state === "awake" ? "ok" : "neutral"}>
      <span className={`dot ${state === "awake" ? "dot-filled" : "dot-outline"}`} aria-hidden="true" />
      {state === "awake" ? "Awake" : "Asleep"}
    </span>
  );
}

/** Green for a key that works; expired and revoked keys stay grey: they are over, not waiting for anything. */
export function KeyStatus({ status }: { status: PublicKeyStatus }) {
  return <StatusPill tone={status === "active" ? "ok" : "neutral"}>{status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked"}</StatusPill>;
}

export function InvoiceStatus({ status }: { status: "paid" | "open" }) {
  return <StatusPill tone={status === "paid" ? "ok" : "warn"}>{status === "paid" ? "Paid" : "Open"}</StatusPill>;
}
