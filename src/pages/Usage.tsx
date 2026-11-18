import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import { client } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { StackedBars } from "../components/charts";
import { MinuteSum, SAVED_NOTE } from "../components/ci";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { download } from "../lib/download";
import { formatCount, formatMinutes, formatMoney } from "../lib/format";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

const units = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
/** Units in the table: always one decimal, so the column lines up and adds up to its total. */
const unitsCell = (n: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
export const UNIT_NOTE = "1 run unit = 10 baseline minutes: the minutes the same job takes on a GitHub-hosted runner (tests run, tests skipped with proof, and the other steps).";

/** "123 of 2,000 run units used", or the units alone when the plan's included units are not set yet. */
export function UnitsLine({ used, included }: { used: number; included: number | null }) {
  return included === null ? <>{units(used)} run units used. Units included: not set yet.</> : <>{`${units(used)} of ${units(included)} run units used`}</>;
}

/** Run units used this month against the units the plan includes; with none set yet, the units and a plain note. */
export function UnitsMeter({ used, included }: { used: number; included: number | null }) {
  if (included === null)
    return (
      <div className="meter-wrap">
        <p className="units-used">
          <strong className="big-number mono">{units(used)}</strong> <span className="muted">run units used</span>
        </p>
        <p className="muted small">Units included in your plan: not set yet.</p>
      </div>
    );
  const share = included > 0 ? Math.min(1, used / included) : 1;
  return (
    <div className="meter-wrap">
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={included} aria-valuenow={used} aria-label="Run units used this month">
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <p className="small">
        <strong className="mono">{units(used)}</strong> of {units(included)} run units used ({included > 0 ? Math.round((used / included) * 100) : 100}%)
      </p>
    </div>
  );
}

export function UsagePage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const months = useAsync(() => client.listUsageMonths(), []);
  const month = params.get("month") ?? (months.status === "ready" ? months.data[0] : "");
  const report = useAsync(() => (month ? client.getUsage(month) : new Promise<never>(() => {})), [month]);
  const [exporting, setExporting] = useState(false);

  async function exportCsv() {
    setExporting(true);
    try {
      const file = await client.exportUsage(month);
      download(file);
      toast(`CSV ready: ${file.filename}`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed.", "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        back={<Kicker />}
        title="Usage"
        description="Run units used against your plan, the test minutes fenvix skipped with proof, and what the same runs would cost on GitHub-hosted runners. Per project, for any month."
        actions={
          <button type="button" className="btn" onClick={exportCsv} disabled={exporting || !month}>
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
        }
      />
      <div className="toolbar">
        <div className="field">
          <label htmlFor="u-month">Month</label>
          <Select id="u-month" value={month} onChange={(v) => setParams({ month: v }, { replace: true })} options={months.status === "ready" ? months.data.map((m, i) => ({ value: m, label: `${monthLabel(m)}${i === 0 ? " (so far)" : ""}` })) : []} />
        </div>
      </div>

      {report.status === "loading" && <Message>Loading usage</Message>}
      {report.status === "error" && <Message role="alert">{report.message}</Message>}
      {report.status === "ready" && (() => {
        const u = report.data;
        return (
          <>
            <div className="grid-2">
              <Card id="units-used" title="Run units" description={`${u.plan ? `${u.plan.name} plan` : "No plan yet"}, ${monthLabel(u.month)}: ${formatCount(u.runsUsed)} billable ${u.runsUsed === 1 ? "run" : "runs"}.`}>
                <UnitsMeter used={u.unitsUsed} included={u.unitsIncluded} />
                <p className="muted small">{UNIT_NOTE} The month is billed as its units rounded up to a whole unit.</p>
                <Link to="/billing" className="row-link small">
                  Plans and billing
                </Link>
              </Card>
              <Card id="totals" title="Totals" description={`${monthLabel(u.month)}, every project.`}>
                <dl className="facts">
                  <div>
                    <dt>Same runs on GitHub-hosted</dt>
                    <dd className="mono">{formatMinutes(u.totals.githubEquivalentMinutes)}</dd>
                  </div>
                  <div>
                    <dt>At GitHub's rate</dt>
                    <dd className="mono">{formatMoney(u.totals.githubEquivalentUsd)}</dd>
                  </div>
                </dl>
                <p className="minute-line" id="usage-minutes">
                  <MinuteSum m={{ ran: u.totals.testMinutesRan, skipped: u.totals.minutesSaved, other: u.totals.otherStepMinutes, total: u.totals.githubEquivalentMinutes }} />
                </p>
                <dl className="facts">
                  <div>
                    <dt>Minutes saved</dt>
                    <dd className="mono">{formatMinutes(u.totals.minutesSaved)}</dd>
                    <dd className="muted small">{SAVED_NOTE}</dd>
                  </div>
                </dl>
                <p className="muted small">
                  ${u.rate.usdPerMinute} a minute, {u.rate.runner}, as stated on GitHub's pricing page ({u.rate.checkedOn}).
                </p>
              </Card>
            </div>

            <Card id="per-day" title="Runs per day" description="Split by project.">
              {u.daily.series.length > 0 ? <StackedBars days={u.daily.days} series={u.daily.series} valueLabel={(n) => `${formatCount(n)} runs`} /> : <p className="muted">No runs this month.</p>}
            </Card>

            <div className="table-card">
              <table className="data responsive">
                <caption className="sr-only">Usage per project, {monthLabel(u.month)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col" className="num">
                      Runs
                    </th>
                    <th scope="col" className="num">
                      Run units
                    </th>
                    <th scope="col" className="num">
                      Test minutes run
                    </th>
                    <th scope="col" className="num">
                      Skipped with proof
                    </th>
                    <th scope="col" className="num">
                      Setup and build
                    </th>
                    <th scope="col" className="num">
                      GitHub-hosted minutes
                    </th>
                    <th scope="col" className="num">
                      GitHub-hosted cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {u.rows.map((r) => (
                    <tr key={r.projectId || "unmatched"}>
                      <td data-label="Project">
                        {r.projectId ? (
                          <Link to={`/projects/${r.projectId}`} className="row-link mono break-anywhere">
                            {r.fullName}
                          </Link>
                        ) : (
                          <span className="muted">{r.fullName}</span>
                        )}
                      </td>
                      <td data-label="Runs" data-key="runs" className="num mono">
                        {formatCount(r.runs)}
                      </td>
                      <td data-label="Run units" data-key="units" className="num mono">
                        {unitsCell(r.units)}
                      </td>
                      <td data-label="Test minutes run" data-key="testMinutesRan" className="num mono">
                        {formatMinutes(r.testMinutesRan)}
                      </td>
                      <td data-label="Skipped with proof" data-key="minutesSaved" className="num mono">
                        {formatMinutes(r.minutesSaved)}
                      </td>
                      <td data-label="Setup and build" data-key="otherStepMinutes" className="num mono">
                        {formatMinutes(r.otherStepMinutes)}
                      </td>
                      <td data-label="GitHub-hosted minutes" data-key="githubEquivalentMinutes" className="num mono">
                        {formatMinutes(r.githubEquivalentMinutes)}
                      </td>
                      <td data-label="GitHub-hosted cost" data-key="githubEquivalentUsd" className="num mono">
                        {formatMoney(r.githubEquivalentUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" className="hide-narrow">
                      Total
                    </th>
                      <td data-total data-label="Runs" data-key="runs" className="num mono">
                        {formatCount(u.totals.runs)}
                      </td>
                      <td data-total data-label="Run units" data-key="units" className="num mono">
                        {unitsCell(u.totals.units)}
                      </td>
                      <td data-total data-label="Test minutes run" data-key="testMinutesRan" className="num mono">
                        {formatMinutes(u.totals.testMinutesRan)}
                      </td>
                      <td data-total data-label="Skipped with proof" data-key="minutesSaved" className="num mono">
                        {formatMinutes(u.totals.minutesSaved)}
                      </td>
                      <td data-total data-label="Setup and build" data-key="otherStepMinutes" className="num mono">
                        {formatMinutes(u.totals.otherStepMinutes)}
                      </td>
                      <td data-total data-label="GitHub-hosted minutes" data-key="githubEquivalentMinutes" className="num mono">
                        {formatMinutes(u.totals.githubEquivalentMinutes)}
                      </td>
                      <td data-total data-label="GitHub-hosted cost" data-key="githubEquivalentUsd" className="num mono">
                        {formatMoney(u.totals.githubEquivalentUsd)}
                      </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        );
      })()}
    </>
  );
}
