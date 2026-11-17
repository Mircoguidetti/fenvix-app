import { Link } from "react-router-dom";
import { client } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { AreaSeriesChart, HBars, Sparkline, TimeBarsChart } from "../components/charts";
import { SkipShare, shortTest } from "../components/ci";
import { useAsync } from "../lib/useAsync";
import { useWorkspaceVersion } from "../lib/workspace";
import { formatCount, formatMinutes, formatMoney, formatPercent, formatRelative } from "../lib/format";

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
export const seconds = (s: number) => (s < 120 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);

function Kpi({ label, value, sub, spark }: { label: string; value: string; sub: string; spark?: number[] }) {
  return (
    <div className="kpi">
      <strong className="kpi-value">{value}</strong>
      <span className="kpi-label">{label}</span>
      <span className="kpi-sub muted small">{sub}</span>
      <div className="kpi-spark">{spark && spark.length > 1 ? <Sparkline values={spark} /> : <span className="spark-none" aria-hidden="true" />}</div>
    </div>
  );
}

/** First screen after sign-in: this month's runs, the minutes and time fenvix saved, and what GitHub would have charged. */
export function OverviewPage() {
  const version = useWorkspaceVersion();
  const settings = useAsync(() => client.getSettings(), [version]);
  const data = useAsync(() => client.getOverview(), []);
  const now = client.now();

  return (
    <>
      <PageHeader
        back={<Kicker>Overview</Kicker>}
        title={settings.status === "ready" ? settings.data.workspaceName : "Overview"}
        description="Your test runs on fenvix this month: how many, how much test time was skipped with proof, and how fast pull requests turn green."
        actions={
          <Link to="/projects/connect" className="btn">
            Connect a project
          </Link>
        }
      />

      {data.status === "loading" && <Message>Loading overview</Message>}
      {data.status === "error" && <Message role="alert">{data.message}</Message>}
      {data.status === "ready" && data.data.projects.length === 0 && (
        <div className="empty">
          <h2>Connect your first project</h2>
          <p className="muted">Install the fenvix GitHub App on a repository, then change one line in its test job: runs-on: fenvix.</p>
          <Link to="/projects/connect" className="btn btn-primary">
            Connect a project
          </Link>
        </div>
      )}
      {data.status === "ready" && data.data.projects.length > 0 && (() => {
        const o = data.data;
        const month = monthName(o.month);
        const ttgBefore = o.timeToGreen.beforeMedianS;
        const ttgWith = o.timeToGreen.withMedianS;
        const price = o.cost.plan?.priceUsdMonth ?? null;
        return (
          <>
            <div className="kpis">
              <Kpi label="Runs" value={formatCount(o.runs.thisMonth)} sub={`${month} so far · ${formatCount(o.runs.lastMonthSameDays)} same days before`} spark={o.runs.perDay.map((p) => p.value)} />
              <Kpi label="Minutes saved" value={formatMinutes(o.minutesSaved.thisMonth)} sub="test time skipped with proof" spark={o.minutesSaved.perDay.map((p) => p.value)} />
              <Kpi label="Skipped with proof" value={o.skipShare.median === null ? "–" : formatPercent(o.skipShare.median)} sub="median share of test time per run" spark={o.skipShare.perDay.map((p) => p.value)} />
              <Kpi label="Time to green" value={ttgWith === null ? "–" : seconds(ttgWith)} sub={ttgBefore === null ? "median, push to green" : `median · ${seconds(ttgBefore)} before fenvix`} />
              <Kpi label="On GitHub-hosted" value={formatMoney(o.cost.githubEquivalentUsd)} sub={`what ${month}'s runs would cost there`} />
              <Kpi label="Open defects" value={formatCount(o.openDefects)} sub="flaky tests made reproducible" />
            </div>

            <div className="grid-2 even">
              <Card id="runs" title="Runs per day" description="Test jobs that ran on runs-on: fenvix in the last 30 days.">
                <TimeBarsChart points={o.runs.perDay} range="30d" valueLabel={(n) => `${formatCount(n)} runs`} />
              </Card>
              <Card id="skipped" title="Skipped with proof" description="Median share of test time skipped per run, day by day. A test is skipped only when everything it read is proven unchanged.">
                <AreaSeriesChart points={o.skipShare.perDay} range="30d" valueLabel={(n) => formatPercent(n)} />
              </Card>
            </div>

            <div className="grid-2 even">
              <Card id="ttg" title="Time to green" description="Median time from a push to its first passing test run.">
                <HBars
                  labelWidth={150}
                  rows={[
                    ...(ttgBefore !== null ? [{ label: "Before fenvix", sort: ttgBefore, value: seconds(ttgBefore) }] : []),
                    ...(ttgWith !== null ? [{ label: "With fenvix", sort: ttgWith, value: seconds(ttgWith) }] : []),
                  ]}
                />
                <p className="muted small">
                  Before: the median of each project's GitHub Actions history when it was connected. With fenvix: {formatCount(o.timeToGreen.commits)} commits this month.
                </p>
              </Card>
              <Card id="cost" title="Cost compared" description={`${formatCount(o.runs.thisMonth)} runs in ${month}, priced as GitHub-hosted runner minutes and as your plan.`}>
                <dl className="compare">
                  <div>
                    <dt>On GitHub-hosted runners</dt>
                    <dd className="mono">{formatMoney(o.cost.githubEquivalentUsd)}</dd>
                    <dd className="muted small">
                      {formatMinutes(o.cost.githubEquivalentMinutes)} at {formatMoney(o.cost.rate.usdPerMinute)} a minute ({o.cost.rate.runner})
                    </dd>
                  </div>
                  <div>
                    <dt>Your plan{o.cost.plan ? `: ${o.cost.plan.name}` : ""}</dt>
                    <dd className="mono">{price === null ? "Price not set" : formatMoney(price)}</dd>
                    <dd className="muted small">
                      {o.cost.plan?.runsPerMonth ? `${formatCount(o.runs.thisMonth)} of ${formatCount(o.cost.plan.runsPerMonth)} runs used` : "No run limit"}
                    </dd>
                  </div>
                </dl>
                <p className="muted small">GitHub's rate as stated on its pricing page ({o.cost.rate.checkedOn}). A full job's minutes are each project's median job before fenvix.</p>
              </Card>
            </div>

            <div className="grid-2">
              <Card id="projects" title="Projects" description="This month, per repository.">
                <div className="table-card flush">
                  <table className="data responsive">
                    <caption className="sr-only">Projects this month</caption>
                    <thead>
                      <tr>
                        <th scope="col">Project</th>
                        <th scope="col" className="num">
                          Runs
                        </th>
                        <th scope="col">Skipped with proof</th>
                        <th scope="col" className="num">
                          Open defects
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.projects.map((p) => (
                        <tr key={p.id}>
                          <td data-label="Project">
                            <Link to={`/projects/${p.id}`} className="row-link mono">
                              {p.fullName}
                            </Link>
                          </td>
                          <td data-label="Runs" className="num mono">
                            {formatCount(p.runsThisMonth)}
                          </td>
                          <td data-label="Skipped with proof">
                            <SkipShare share={p.medianSkipShare} />
                          </td>
                          <td data-label="Open defects" className="num mono">
                            {p.openDefects}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card id="defects" title="Latest defects" description="Flaky tests turned into reproducible defects." actions={<Link to="/defects" className="btn btn-sm">All defects</Link>}>
                {o.recentDefects.length === 0 ? (
                  <p className="muted">No open defects.</p>
                ) : (
                  <ul className="defect-mini">
                    {o.recentDefects.map((d) => (
                      <li key={d.id}>
                        <Link to={`/defects/${d.id}`} className="row-link mono break-anywhere" title={d.testId}>
                          {shortTest(d.testId)}
                        </Link>
                        <span className="muted small">
                          {d.projectName} · seen {formatRelative(d.lastSeenAt, now)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        );
      })()}
    </>
  );
}
