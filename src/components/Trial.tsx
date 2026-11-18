import type { Trial } from "../data";
import { StatusPill } from "./StateBadge";
import { formatCount, formatDate, formatMinutes, formatPercent } from "../lib/format";

const gatePercent = (t: Trial) => formatPercent(t.gate.threshold);

/** The trial's gate as a state, with its words: met, below, or nothing to judge yet. */
export function GatePill({ trial }: { trial: Trial }) {
  if (trial.wouldSkipShare === null) return <StatusPill tone="neutral">No finished run yet</StatusPill>;
  return trial.gate.met ? <StatusPill tone="ok">{`${gatePercent(trial)} gate met`}</StatusPill> : <StatusPill tone="warn">{`Below the ${gatePercent(trial)} gate`}</StatusPill>;
}

/** One sentence that says what the gate means for this trial. */
export function gateSentence(t: Trial): string {
  const gate = gatePercent(t);
  if (t.wouldSkipShare === null) return `No shadow run has finished yet. The trial passes when fenvix would have skipped at least ${gate} of your test time.`;
  const share = formatPercent(t.wouldSkipShare);
  if (t.gate.met) return `fenvix would have skipped ${share} of your test time with proof: at or above the ${gate} the trial asks for, so skipping can be switched on.`;
  return `fenvix would have skipped ${share} of your test time with proof: under the ${gate} the trial asks for${t.status === "active" ? ". There is still time: the share is measured over every finished shadow run of the trial." : "."}`;
}

/**
 * The 30-day shadow trial: every test runs as usual, and fenvix records what it would have skipped with proof. The
 * share, the minutes and the run units are over the trial's finished shadow runs.
 */
export function TrialSummary({ trial }: { trial: Trial }) {
  const active = trial.status === "active";
  return (
    <div className="trial">
      <div className="kpis kpis-4 trial-kpis">
        <div className="kpi">
          <strong className="kpi-value">{trial.wouldSkipShare === null ? "–" : formatPercent(trial.wouldSkipShare)}</strong>
          <span className="kpi-label">Would have skipped</span>
          <span className="kpi-sub muted small">
            of test time, over {formatCount(trial.runs)} finished {trial.runs === 1 ? "run" : "runs"}
          </span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatMinutes(trial.wouldSaveMinutes)}</strong>
          <span className="kpi-label">Would have saved</span>
          <span className="kpi-sub muted small">test minutes, skipped with proof</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(trial.units)}</strong>
          <span className="kpi-label">Run units</span>
          <span className="kpi-sub muted small">not billed during the trial</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{active ? formatCount(trial.daysLeft) : "0"}</strong>
          <span className="kpi-label">{trial.daysLeft === 1 ? "Day left" : "Days left"}</span>
          <span className="kpi-sub muted small">
            {active ? "ends" : "ended"} {formatDate(trial.endsAt)}
          </span>
        </div>
      </div>
      <p className="trial-gate">
        <GatePill trial={trial} />
        <span>{gateSentence(trial)}</span>
      </p>
    </div>
  );
}

export const TRIAL_DESCRIPTION = "For 30 days every test runs as usual, in shadow mode: fenvix records which tests it would have skipped with proof, and skips none. The trial is not billed.";
