import type { ReactNode } from "react";
import { BadgeCheck, Check, Clock, Minus, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { PublicKeyStatus, RunStatus } from "../data";

/**
 * A state as a pill: an icon and a word, so it reads in black and white and for people who do not tell colours apart
 * (founder's rules, 2026-11-17): ✓ passed, ✕ failed, a seal for skipped with proof. The colour only repeats it: green
 * for ok, red for failed, amber for in progress, grey otherwise. The brand blue never marks a state.
 */
export type Tone = "ok" | "warn" | "danger" | "neutral";

const TONE_ICON: Record<Tone, LucideIcon> = { ok: Check, danger: X, warn: Clock, neutral: Minus };

/** Icons a state may use instead of its tone's default: the seal of a test skipped with proof, the mark of an open defect. */
export const STATE_ICONS = { seal: BadgeCheck, alert: TriangleAlert } as const;

export function StatusPill({ tone, icon, children }: { tone: Tone; icon?: LucideIcon; children: ReactNode }) {
  const cls = tone === "ok" ? "state state-ok" : tone === "warn" ? "state state-warn" : tone === "danger" ? "state state-danger" : "state";
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <span className={cls} data-tone={tone}>
      <Icon className="state-icon" size={13} strokeWidth={2.4} aria-hidden="true" />
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
