import type { ReactNode } from "react";
import type { PublicKeyStatus, RunStatus } from "../data";

/**
 * A state as a pill: a dot and a word. The word always carries the meaning; the colour only repeats it.
 * "ok" is green (awake, active, paid), "warn" is amber (in progress, waiting), "neutral" stays grey.
 */
export type Tone = "ok" | "warn" | "danger" | "neutral";

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const cls = tone === "ok" ? "state state-ok" : tone === "warn" ? "state state-warn" : tone === "danger" ? "state state-danger" : "state";
  return (
    <span className={cls} data-tone={tone}>
      <span className={`dot ${tone === "neutral" ? "dot-outline" : "dot-filled"}`} aria-hidden="true" />
      {children}
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

/** A run: green passed, red failed, amber running, grey cancelled. The word always says it too. */
export function RunStatusPill({ status }: { status: RunStatus }) {
  const tone: Tone = status === "passed" ? "ok" : status === "failed" ? "danger" : status === "running" ? "warn" : "neutral";
  return <StatusPill tone={tone}>{status === "passed" ? "Passed" : status === "failed" ? "Failed" : status === "running" ? "Running" : "Cancelled"}</StatusPill>;
}
