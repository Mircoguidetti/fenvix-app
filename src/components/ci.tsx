import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { STATE_ICONS, StatusPill } from "./StateBadge";
import type { Defect, DefectCause, MinuteBreakdown, RunTrigger, TestOutcome, WarmCache } from "../data";
import { formatPercent, formatRelative } from "../lib/format";
import { warmCacheText } from "../lib/warm";

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
    <StatusPill tone={ok ? "ok" : "warn"} icon={ok ? STATE_ICONS.seal : undefined}>
      Replays {d.replays.fails}/{d.replays.runs}
      {ok ? "" : ", fingerprints differ"}
    </StatusPill>
  );
}

/** Said when the runner reported a test (or run) not proven without a cause. */
export const NO_CAUSE = "The runner did not report why";

export function OutcomePill({ outcome, flaky, cause }: { outcome: TestOutcome; flaky?: boolean; cause?: string | null }) {
  if (outcome === "passed") return <StatusPill tone="ok">Passed</StatusPill>;
  if (outcome === "failed") return <StatusPill tone="danger">{flaky ? "Failed: flaky defect" : "Failed"}</StatusPill>;
  if (outcome === "not_proven")
    // Amber, never green: its parallel result could not be proven equal to the serial one. The cause is its tooltip.
    return (
      <span title={cause ?? NO_CAUSE}>
        <StatusPill tone="warn" icon={STATE_ICONS.unproven}>
          Not proven
        </StatusPill>
      </span>
    );
  return (
    <StatusPill tone="neutral" icon={STATE_ICONS.seal}>
      Skipped with proof
    </StatusPill>
  );
}

/** The last part of a test id, for tight places; the full id stays in the title. */
export const shortTest = (id: string) => id.split(/::| > /).slice(-1)[0];

const minutes = (n: number, decimals: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);

/**
 * "875 run + 1,959 skipped with proof + 1,296 setup and build = 4,130 min": the GitHub-equivalent minutes and the three
 * parts they are made of. The parts come rounded so that they add up (src/data/ci.ts, roundToSum).
 */
export function MinuteSum({ m, decimals = 0 }: { m: MinuteBreakdown; decimals?: number }) {
  return (
    <span className="minute-sum" data-ran={m.ran} data-skipped={m.skipped} data-other={m.other} data-total={m.total}>
      <span className="mono">{minutes(m.ran, decimals)}</span> run + <span className="mono">{minutes(m.skipped, decimals)}</span> skipped with proof +{" "}
      <span className="mono">{minutes(m.other, decimals)}</span> setup and build = <strong className="mono">{minutes(m.total, decimals)} min</strong>
    </span>
  );
}

/** Under every "minutes saved": what is counted. */
export const SAVED_NOTE = "Skipped test time only: checkout, install and build still run on fenvix.";

export const runMinutesNote = "Saved: test minutes skipped with proof only; checkout, install and build still run.";

/**
 * "Cache warm since <commit>": the shared cache of the repository's default branch, so the first pull request after
 * the setup is not a cold run (fenvix warms it after the setup and after each push to the default branch). `full`
 * adds the warm-up's own words (why it waits, how it ended): the Connect page.
 */
export function WarmCacheNote({ cache, now, full }: { cache: WarmCache; now: Date; full?: boolean }) {
  const t = warmCacheText(cache);
  return (
    <span className="warm-cache" data-state={cache.state}>
      <span>
        {t.lead}
        {cache.state === "warm" && cache.warmAt ? <span className="muted"> · {formatRelative(cache.warmAt, now)}</span> : null}
      </span>
      {t.sub && <span className="muted">{t.sub}{full && t.detail ? `: ${t.detail}` : ""}</span>}
    </span>
  );
}
