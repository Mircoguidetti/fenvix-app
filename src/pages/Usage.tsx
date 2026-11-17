import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import { client } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { StackedBars } from "../components/charts";
import { Select } from "../components/Select";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { download } from "../lib/download";
import { formatCount, formatMinutes, formatMoney } from "../lib/format";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A bar of runs used against the plan's runs. */
export function RunsMeter({ used, included }: { used: number; included: number | null }) {
  if (included === null) return <p className="muted small">{formatCount(used)} runs. Your plan has no run limit.</p>;
  const share = Math.min(1, used / included);
  return (
    <div className="meter-wrap">
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={included} aria-valuenow={used} aria-label="Runs used this month">
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <p className="small">
        <strong className="mono">{formatCount(used)}</strong> of {formatCount(included)} runs used ({Math.round((used / included) * 100)}%)
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
        description="Runs used against your plan, the test minutes fenvix skipped with proof, and what the same runs would cost on GitHub-hosted runners. Per project, for any month."
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
              <Card id="runs-used" title="Runs" description={u.plan ? `${u.plan.name} plan, ${monthLabel(u.month)}.` : monthLabel(u.month)}>
                <RunsMeter used={u.runsUsed} included={u.runsIncluded} />
                <Link to="/billing" className="row-link small">
                  Plans and billing
                </Link>
              </Card>
              <Card id="totals" title="Totals" description={`${monthLabel(u.month)}, every project.`}>
                <dl className="facts">
                  <div>
                    <dt>Minutes saved</dt>
                    <dd className="mono">{formatMinutes(u.totals.minutesSaved)}</dd>
                  </div>
                  <div>
                    <dt>Test minutes run</dt>
                    <dd className="mono">{formatMinutes(u.totals.testMinutesRan)}</dd>
                  </div>
                  <div>
                    <dt>Same runs on GitHub-hosted</dt>
                    <dd className="mono">{formatMinutes(u.totals.githubEquivalentMinutes)}</dd>
                  </div>
                  <div>
                    <dt>At GitHub's rate</dt>
                    <dd className="mono">{formatMoney(u.totals.githubEquivalentUsd)}</dd>
                  </div>
                </dl>
                <p className="muted small">
                  {formatMoney(u.rate.usdPerMinute)} a minute, {u.rate.runner}, as stated on GitHub's pricing page ({u.rate.checkedOn}).
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
                      Minutes saved
                    </th>
                    <th scope="col" className="num">
                      Test minutes run
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
                    <tr key={r.projectId}>
                      <td data-label="Project">
                        <Link to={`/projects/${r.projectId}`} className="row-link mono break-anywhere">
                          {r.fullName}
                        </Link>
                      </td>
                      <td data-label="Runs" className="num mono">
                        {formatCount(r.runs)}
                      </td>
                      <td data-label="Minutes saved" className="num mono">
                        {formatMinutes(r.minutesSaved)}
                      </td>
                      <td data-label="Test minutes run" className="num mono">
                        {formatMinutes(r.testMinutesRan)}
                      </td>
                      <td data-label="GitHub-hosted minutes" className="num mono">
                        {formatMinutes(r.githubEquivalentMinutes)}
                      </td>
                      <td data-label="GitHub-hosted cost" className="num mono">
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
                    <td data-label="Runs" className="num mono">
                      {formatCount(u.totals.runs)}
                    </td>
                    <td data-label="Minutes saved" className="num mono">
                      {formatMinutes(u.totals.minutesSaved)}
                    </td>
                    <td data-label="Test minutes run" className="num mono">
                      {formatMinutes(u.totals.testMinutesRan)}
                    </td>
                    <td data-label="GitHub-hosted minutes" className="num mono">
                      {formatMinutes(u.totals.githubEquivalentMinutes)}
                    </td>
                    <td data-label="GitHub-hosted cost" className="num mono">
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
