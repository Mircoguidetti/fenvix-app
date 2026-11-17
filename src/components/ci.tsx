import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { StatusPill } from "./StateBadge";
import type { Defect, DefectCause, RunTrigger, TestOutcome } from "../data";
import { formatPercent } from "../lib/format";

/** A block of code or a command, with a copy button. */
export function CodeBlock({ code, what, label }: { code: string; what: string; label?: string }) {
  return (
    <div className="codebox">
      <pre className="mono" tabIndex={0} aria-label={label ?? what}>
        {code}
      </pre>
      <CopyButton value={code} what={what} />
    </div>
  );
}

/** The share of test time skipped with proof, as a thin bar and the number. */
export function SkipShare({ share }: { share: number | null }) {
  if (share === null) return <span className="muted">No runs</span>;
  return (
    <span className="skip-share">
      <span className="skip-track" aria-hidden="true">
        <span className="skip-fill" style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} />
      </span>
      <span className="mono">{formatPercent(share)}</span>
    </span>
  );
}

const TRIGGERS: Record<RunTrigger, string> = { push: "Push", pull_request: "Pull request", merge_group: "Merge queue", schedule: "Schedule", workflow_dispatch: "Manual" };
export const triggerLabel = (t: RunTrigger) => TRIGGERS[t];

const CAUSES: Record<DefectCause, string> = { polluter: "Polluter", state_setter: "State setter missing", fails_alone: "Fails alone" };
export const causeLabel = (c: DefectCause) => CAUSES[c];

/** One sentence that names the cause. */
export function causeSentence(d: Pick<Defect, "cause" | "causeTests">): ReactNode {
  if (d.cause === "polluter")
    return (
      <>
        Fails when <span className="mono break-anywhere">{d.causeTests.join(" and ")}</span> runs before it: {d.causeTests.length === 1 ? "that test leaves state behind" : "those tests leave state behind"}.
      </>
    );
  if (d.cause === "state_setter")
    return (
      <>
        Fails without <span className="mono break-anywhere">{d.causeTests.join(" and ")}</span> running first: it depends on state that test sets.
      </>
    );
  return <>Fails on its own with this seed: no other test is needed. The engine names where the runs diverge.</>;
}

export function ReplayStatus({ d }: { d: Pick<Defect, "replays" | "status"> }) {
  const ok = d.status === "reproduced";
  return (
    <StatusPill tone={ok ? "ok" : "warn"}>
      Replays {d.replays.fails}/{d.replays.runs}
      {ok ? "" : ", fingerprints differ"}
    </StatusPill>
  );
}

export function OutcomePill({ outcome, flaky }: { outcome: TestOutcome; flaky?: boolean }) {
  if (outcome === "passed") return <StatusPill tone="ok">Passed</StatusPill>;
  if (outcome === "failed") return <StatusPill tone="danger">{flaky ? "Failed: flaky defect" : "Failed"}</StatusPill>;
  return <StatusPill tone="neutral">Skipped with proof</StatusPill>;
}

/** The last part of a test id, for tight places; the full id stays in the title. */
export const shortTest = (id: string) => id.split(/::| > /).slice(-1)[0];
