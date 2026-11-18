import type { ReactNode } from "react";
import { BadgeCheck, Check, Clock, Minus, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { InstallationStatus, OnboardingState, RunStatus } from "../data";

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

/**
 * A GitHub App installation: green when it works, amber when it is suspended on GitHub (it needs someone to act),
 * grey once uninstalled (it is over, not waiting for anything).
 */
export function InstallationStatusPill({ status }: { status: InstallationStatus }) {
  return <StatusPill tone={status === "active" ? "ok" : status === "suspended" ? "warn" : "neutral"}>{status === "active" ? "Active" : status === "suspended" ? "Suspended" : "Uninstalled"}</StatusPill>;
}

/** A repository's onboarding state in plain English (the detail from the App says more). */
export const ONBOARDING_LABELS: Record<OnboardingState, string> = {
  pending: "Not set up yet",
  pr_open: "Pull request open",
  merged: "On fenvix",
  closed: "Pull request closed",
  no_workflow: "No workflow file",
  no_test_job: "No test job found",
  already_fenvix: "Already on fenvix",
  unsupported: "Test runner not supported",
  failed: "Could not open the pull request",
};

/** Green once the test job runs on fenvix, amber while a pull request waits, red when the App failed, grey otherwise. */
export function OnboardingPill({ state }: { state: OnboardingState }) {
  const tone: Tone = state === "merged" || state === "already_fenvix" ? "ok" : state === "pr_open" ? "warn" : state === "failed" ? "danger" : "neutral";
  return <StatusPill tone={tone}>{ONBOARDING_LABELS[state]}</StatusPill>;
}

export function InvoiceStatus({ status }: { status: "paid" | "open" }) {
  return <StatusPill tone={status === "paid" ? "ok" : "warn"}>{status === "paid" ? "Paid" : "Open"}</StatusPill>;
}

/** A run: green passed, red failed, amber running, grey cancelled. The word always says it too. */
export function RunStatusPill({ status }: { status: RunStatus }) {
  const tone: Tone = status === "passed" ? "ok" : status === "failed" ? "danger" : status === "running" ? "warn" : "neutral";
  return <StatusPill tone={tone}>{status === "passed" ? "Passed" : status === "failed" ? "Failed" : status === "running" ? "Running" : "Cancelled"}</StatusPill>;
}
