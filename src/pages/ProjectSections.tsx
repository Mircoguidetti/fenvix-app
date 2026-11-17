/*
 * The project's sections that the landing's dashboard shows (founder, 2026-11-17): Skip with proof, Nightly exploration,
 * Time to green, and the recent activity used on the Runs page and the Overview. Data from docs/data-contract.md:
 * runs (skip shares, the reasons tests ran), explorations (the engine's explore.json), the project's baseline.
 */
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowRight, Check, Moon, TriangleAlert, X } from "lucide-react";
import { client, type ActivityItem, type ProjectRow } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { AreaSeriesChart, BeforeWithChart, HBars, TimeBarsChart } from "../components/charts";
import { MinuteSum, SAVED_NOTE, shortTest } from "../components/ci";
import { useProjectTitle } from "../components/Shell";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatDate, formatDateTime, formatDuration, formatMinutes, formatPercent, formatRelative, shortSha } from "../lib/format";
import { MISS_LABELS, median, missSummary, percentile, setupSnippet, timeToGreenPerCommit } from "../data/ci";
import { languageLabel } from "./Projects";

const DAY = 86_400_000;
export const seconds = (s: number) => (s < 120 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);

/** Loads the project of the address and names it in the frame. */
export function useProjectPage(): { id: string; project: ReturnType<typeof useAsync<ProjectRow | null>> } {
  const { id = "" } = useParams();
  const project = useAsync(() => client.getProject(id), [id]);
  const p = project.status === "ready" ? project.data : null;
  useProjectTitle(p?.fullName, p ? { language: languageLabel(p.language), runner: p.testRunner, snippet: setupSnippet(p) } : undefined);
  return { id, project };
}

/** Recent activity: what fenvix did lately. A state always comes with its word and its icon. */
export function ActivityList({ items, now }: { items: ActivityItem[]; now: Date }) {
  if (items.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <ul className="activity">
      {items.map((a) => {
        const Icon = a.kind === "run_green" ? Check : a.kind === "run_failed" ? X : a.kind === "defect_reproduced" ? TriangleAlert : a.kind === "exploration" ? Moon : ArrowRight;
        return (
          <li key={a.id}>
            <span className="activity-icon" data-kind={a.kind} aria-hidden="true">
              <Icon size={14} strokeWidth={2.2} />
            </span>
            <span className="activity-text">
              <Link to={a.to} className="row-link">
                {a.title}
              </Link>
              <span className="muted small mono ellipsis">{a.detail}</span>
            </span>
            <span className="muted small activity-at">{formatRelative(a.at, now)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Missing({ what }: { what: string }) {
  return (
    <div className="empty not-found">
      <h1>{what} not found</h1>
      <Link to="/projects" className="btn btn-primary">
        Back to your projects
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------- Skip with proof

export function SkipWithProofPage() {
  const { id, project } = useProjectPage();
  const now = client.now();
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const runs = useAsync(() => client.listRunsSince(id, since), [id]);
  const series = useAsync(() => client.getSkipShareSeries(id, 60), [id]);
  const summary = useMemo(() => (runs.status === "ready" ? missSummary(runs.data) : null), [runs]);
  if (project.status === "loading") return <Message>Loading project</Message>;
  if (project.status === "error") return <Message role="alert">{project.message}</Message>;
  const p = project.data;
  if (!p) return <Missing what="Project" />;
  const finished = runs.status === "ready" ? runs.data.filter((r) => r.status === "passed" || r.status === "failed") : [];
  const skippedTests = finished.reduce((a, r) => a + r.tests.skippedWithProof, 0);
  const ranTests = finished.reduce((a, r) => a + r.tests.ran, 0);
  const lowest = [...finished].sort((a, b) => a.skipShare - b.skipShare).slice(0, 5);
  return (
    <>
      <PageHeader back={<Kicker>{p.fullName}</Kicker>} title="Skip with proof" description="A test is skipped only when everything it depends on is proven unchanged since a run where it passed: the code it runs, the files and environment variables it reads, the runtime and the configuration. Every skipped test has a receipt." />
      <div className="kpis">
        <div className="kpi">
          <strong className="kpi-value">{p.medianSkipShare === null ? "–" : formatPercent(p.medianSkipShare)}</strong>
          <span className="kpi-label">Skipped with proof</span>
          <span className="kpi-sub muted small">median share of test time, this month</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatCount(skippedTests)}</strong>
          <span className="kpi-label">Tests skipped</span>
          <span className="kpi-sub muted small">last 30 days, each with a receipt</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatCount(ranTests)}</strong>
          <span className="kpi-label">Tests that ran</span>
          <span className="kpi-sub muted small">because something they use changed</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatMinutes(p.minutesThisMonth.skipped)}</strong>
          <span className="kpi-label">Minutes saved</span>
          <span className="kpi-sub muted small">skipped tests only, this month</span>
        </div>
      </div>
      <Card id="skip-trend" title="Skipped with proof over time" description="Median share of test time skipped per run, day by day, over 60 days.">
        {series.status === "ready" ? <AreaSeriesChart points={series.data} range="30d" valueLabel={(n) => formatPercent(n)} /> : <Message>Loading the chart</Message>}
        <p className="minute-line">
          This month: <MinuteSum m={p.minutesThisMonth} />
        </p>
        <p className="muted small">{SAVED_NOTE}</p>
      </Card>
      <div className="grid-2 even">
        <Card id="why" title="Why tests ran" description="Over the last 30 days, the reason each test that ran could not be reused.">
          {summary && summary.byKind.length > 0 ? (
            <HBars labelWidth={230} rows={summary.byKind.map((k) => ({ label: MISS_LABELS[k.kind], sort: k.tests, value: formatCount(k.tests) }))} />
          ) : (
            <Message>{runs.status === "ready" ? "No runs in the last 30 days." : "Loading"}</Message>
          )}
        </Card>
        <Card id="details" title="What made the most tests run" description="The changes behind the most re-runs: a function, a file, a variable, the packages.">
          {summary && summary.details.length > 0 ? (
            <ul className="receipt-list">
              {summary.details.map((d) => (
                <li key={`${d.kind}|${d.detail}`}>
                  <span>
                    <span className="mono break-anywhere">{d.detail}</span> <span className="muted small">{MISS_LABELS[d.kind].toLowerCase()}</span>
                  </span>
                  <span className="mono small">
                    {formatCount(d.tests)} tests · {d.runs} {d.runs === 1 ? "run" : "runs"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Message>No re-runs to explain yet.</Message>
          )}
        </Card>
      </div>
      <Card id="lowest" title="Runs that skipped the least" description="Usually a dependency or configuration change: everything has to run again once, then skipping resumes.">
        {lowest.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <div className="table-card flush">
            <table className="data responsive">
              <caption className="sr-only">Runs that skipped the least</caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Commit</th>
                  <th scope="col" className="num">
                    Skipped with proof
                  </th>
                  <th scope="col">Main reason</th>
                  <th scope="col">Receipts</th>
                </tr>
              </thead>
              <tbody>
                {lowest.map((r) => {
                  const top = r.missDetails[0];
                  return (
                    <tr key={r.id}>
                      <td data-label="Run">
                        <Link to={`/projects/${id}/runs/${r.id}`} className="row-link mono nowrap">
                          #{r.number}
                        </Link>
                      </td>
                      <td data-label="Commit">
                        <span className="mono">{shortSha(r.commitSha)}</span> <span className="muted small">{r.commitMessage}</span>
                      </td>
                      <td data-label="Skipped with proof" className="num mono">
                        {formatPercent(r.skipShare)}
                      </td>
                      <td data-label="Main reason">{top ? `${MISS_LABELS[top.kind]}: ` : "–"}{top && <span className="mono small">{top.detail}</span>}</td>
                      <td data-label="Receipts">
                        <Link to={`/projects/${id}/runs/${r.id}?outcome=skipped_with_proof`} className="row-link">
                          {formatCount(r.tests.skippedWithProof)} receipts
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Nightly exploration

export function NightlyPage() {
  const { id, project } = useProjectPage();
  const nights = useAsync(() => client.listExplorations(id), [id]);
  const defects = useAsync(() => client.listDefects({ projectId: id, state: "all" }), [id]);
  if (project.status === "loading") return <Message>Loading project</Message>;
  if (project.status === "error") return <Message role="alert">{project.message}</Message>;
  const p = project.data;
  if (!p) return <Missing what="Project" />;
  const list = nights.status === "ready" ? nights.data : [];
  const last = list[0];
  const defectName = (did: string) => (defects.status === "ready" ? shortTest(defects.data.find((d) => d.id === did)?.testId ?? did) : did);
  const maxFailing = last ? Math.max(1, ...last.seedsLog.map((x) => x.failing)) : 1;
  return (
    <>
      <PageHeader
        back={<Kicker>{p.fullName}</Kicker>}
        title="Nightly exploration"
        description="At night fenvix runs the suite again in many seeded orders, on fenvix machines, to find order and timing bugs before they reach a pull request. Included in every plan; nightly runs do not count as runs."
        actions={
          <Link to={`/projects/${id}/settings`} className="btn">
            {p.settings.nightlyExploration ? "On · settings" : "Turn it on"}
          </Link>
        }
      />
      {nights.status === "loading" && <Message>Loading nights</Message>}
      {nights.status === "error" && <Message role="alert">{nights.message}</Message>}
      {nights.status === "ready" && list.length === 0 && (
        <div className="empty">
          <h2>No nights yet</h2>
          <p className="muted">{p.settings.nightlyExploration ? "The first exploration runs tonight." : "Nightly exploration is off for this project."}</p>
          <Link to={`/projects/${id}/settings`} className="btn btn-primary">
            Project settings
          </Link>
        </div>
      )}
      {last && (
        <>
          <div className="kpis">
            <div className="kpi">
              <strong className="kpi-value">{formatCount(last.seeds)}</strong>
              <span className="kpi-label">Seeds last night</span>
              <span className="kpi-sub muted small">{formatCount(last.collected)} tests each, {formatDuration(last.seconds * 1000)}</span>
            </div>
            <div className="kpi">
              <strong className="kpi-value">{formatCount(last.flakyFailing.length)}</strong>
              <span className="kpi-label">Flaky tests seen</span>
              <span className="kpi-sub muted small">failed under some seeds only</span>
            </div>
            <div className="kpi">
              <strong className="kpi-value">{formatCount(list.reduce((a, n) => a + n.newDefectIds.length, 0))}</strong>
              <span className="kpi-label">Defects found at night</span>
              <span className="kpi-sub muted small">in {list.length} nights, before a pull request hit them</span>
            </div>
            <div className="kpi">
              <strong className="kpi-value">{formatCount(last.alwaysFailing.length)}</strong>
              <span className="kpi-label">Always failing</span>
              <span className="kpi-sub muted small">real failures, not flaky</span>
            </div>
          </div>
          <div className="grid-2 even">
            <Card id="per-night" title="Flaky tests per night" description={`The last ${list.length} nights.`}>
              <TimeBarsChart points={[...list].reverse().map((n) => ({ at: n.startedAt, value: n.flakyFailing.length }))} range="30d" valueLabel={(n) => `${formatCount(n)} flaky tests`} bucketNoun="night" />
            </Card>
            <Card id="seeds" title="Last night, seed by seed" description={`Tests that failed under each of the ${last.seeds} seeds (${formatDateTime(last.startedAt)}).`}>
              <div className="seed-bars" role="img" aria-label={`Failing tests per seed: at most ${maxFailing}.`}>
                {last.seedsLog.map((x) => (
                  <span key={x.seed} className="seed-bar" style={{ height: `${Math.max(4, (x.failing / maxFailing) * 100)}%` }} data-zero={x.failing === 0 || undefined} title={`Seed ${x.seed}: ${x.failing} failing`} />
                ))}
              </div>
              <p className="muted small">
                Seeds 1 to {last.seeds}. A test that fails under some seeds and passes under others is flaky; fenvix then searches the smallest order that fails 10 times out of 10.
              </p>
            </Card>
          </div>
          <Card id="nights" title="Nights" description="Newest first.">
            <div className="table-card flush">
              <table className="data responsive">
                <caption className="sr-only">Nights of exploration</caption>
                <thead>
                  <tr>
                    <th scope="col">Night</th>
                    <th scope="col">Commit</th>
                    <th scope="col" className="num">
                      Seeds
                    </th>
                    <th scope="col" className="num">
                      Duration
                    </th>
                    <th scope="col" className="num">
                      Flaky
                    </th>
                    <th scope="col">Defects found</th>
                    <th scope="col">Families</th>
                  </tr>
                </thead>
                <tbody>
                  {list.slice(0, 30).map((n) => (
                    <tr key={n.id}>
                      <td data-label="Night" className="nowrap">{formatDate(n.startedAt)}</td>
                      <td data-label="Commit" className="mono">
                        {shortSha(n.commitSha)} · {n.branch}
                      </td>
                      <td data-label="Seeds" className="num mono">
                        {n.seeds}
                      </td>
                      <td data-label="Duration" className="num mono nowrap">
                        {formatDuration(n.seconds * 1000)}
                      </td>
                      <td data-label="Flaky" className="num mono">
                        {n.flakyFailing.length}
                        {n.notReproduced.length > 0 && <span className="muted small"> ({n.notReproduced.length} not reproduced in time)</span>}
                      </td>
                      <td data-label="Defects found">
                        {n.newDefectIds.length === 0 ? (
                          <span className="muted">None new</span>
                        ) : (
                          n.newDefectIds.map((d) => (
                            <Link key={d} to={`/defects/${d}`} className="row-link mono small">
                              {defectName(d)}
                            </Link>
                          ))
                        )}
                      </td>
                      <td data-label="Families" className="small">
                        {n.familiesByPolluter.length === 0 ? <span className="muted">–</span> : n.familiesByPolluter.map((f) => `${f.key === "<none>" ? "no polluter" : shortTest(f.key)} (${f.tests})`).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Time to green

export function TimeToGreenPage() {
  const { id, project } = useProjectPage();
  const now = client.now();
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const runs = useAsync(() => client.listRunsSince(id, since), [id]);
  if (project.status === "loading") return <Message>Loading project</Message>;
  if (project.status === "error") return <Message role="alert">{project.message}</Message>;
  const p = project.data;
  if (!p) return <Missing what="Project" />;
  const per = runs.status === "ready" ? timeToGreenPerCommit(runs.data) : [];
  const values = per.map((x) => x.seconds);
  const med = median(values);
  const p90 = percentile(values, 0.9);
  const before = p.baseline?.medianTimeToGreenS ?? null;
  const slowest = [...per].sort((a, b) => b.seconds - a.seconds).slice(0, 8);
  return (
    <>
      <PageHeader back={<Kicker>{p.fullName}</Kicker>} title="Time to green" description="From a push to its first passing test run, per commit. Before fenvix is the median of the project's GitHub Actions history when it was connected." />
      <div className="kpis">
        <div className="kpi">
          <strong className="kpi-value">{med === null ? "–" : seconds(med)}</strong>
          <span className="kpi-label">With fenvix</span>
          <span className="kpi-sub muted small">median, last 30 days</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{before === null ? "–" : seconds(before)}</strong>
          <span className="kpi-label">Before fenvix</span>
          <span className="kpi-sub muted small">{p.baseline ? `median of ${formatCount(p.baseline.runsSampled)} runs` : "not measured"}</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{p90 === null ? "–" : seconds(p90)}</strong>
          <span className="kpi-label">Slow commits</span>
          <span className="kpi-sub muted small">90th percentile with fenvix</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatCount(per.length)}</strong>
          <span className="kpi-label">Commits</span>
          <span className="kpi-sub muted small">turned green in 30 days</span>
        </div>
      </div>
      <Card id="ttg-chart" title="Time to green, per commit" description="Each commit's push to its first green run, with fenvix, against the median before fenvix.">
        {runs.status !== "ready" ? <Message>Loading the chart</Message> : per.length < 2 ? <p className="muted">Not enough green commits yet.</p> : <BeforeWithChart points={per.map((x) => ({ at: x.at, value: x.seconds }))} before={before} format={(n) => seconds(n)} />}
      </Card>
      <Card id="slowest" title="Slowest commits" description="Usually a change that made most tests run again, or a failure fixed by a later run.">
        {slowest.length === 0 ? (
          <p className="muted">No green commits yet.</p>
        ) : (
          <div className="table-card flush">
            <table className="data responsive">
              <caption className="sr-only">Slowest commits</caption>
              <thead>
                <tr>
                  <th scope="col">Commit</th>
                  <th scope="col">First green run</th>
                  <th scope="col" className="num">
                    Time to green
                  </th>
                  <th scope="col" className="num">
                    Skipped with proof
                  </th>
                </tr>
              </thead>
              <tbody>
                {slowest.map((x) => (
                  <tr key={x.run.id}>
                    <td data-label="Commit">
                      <span className="mono">{shortSha(x.run.commitSha)}</span> <span className="muted small">{x.run.commitMessage}</span>
                    </td>
                    <td data-label="First green run">
                      <Link to={`/projects/${id}/runs/${x.run.id}`} className="row-link mono">
                        #{x.run.number}
                      </Link>
                    </td>
                    <td data-label="Time to green" className="num mono">
                      {seconds(x.seconds)}
                    </td>
                    <td data-label="Skipped with proof" className="num mono">
                      {formatPercent(x.run.skipShare)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
