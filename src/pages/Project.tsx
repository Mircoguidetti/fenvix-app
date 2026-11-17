import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { client, type Defect, type ProjectRow, type ProjectSettings, type Run, type RunQuery } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { BeforeWithChart, Sparkline } from "../components/charts";
import { CodeBlock, MinuteSum, SAVED_NOTE, runMinutesNote, triggerLabel } from "../components/ci";
import { CopyButton } from "../components/CopyButton";
import { ActivityList, seconds as secs } from "./ProjectSections";
import { RunStatusPill } from "../components/StateBadge";
import { Pagination } from "../components/Pagination";
import { Segmented } from "../components/Segmented";
import { Switch } from "../components/Switch";
import { useProjectTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useOrg } from "../session/OrgProvider";
import { formatCount, formatDate, formatDuration, formatMinutes, formatPercent, formatRelative, shortSha } from "../lib/format";
import { median, pullCommand, replayCommand, runMinutes, setupSnippet, timeToGreenPerCommit } from "../data/ci";
import { SetupStatePill, languageLabel } from "./Projects";
import { SetupDiff } from "./Connect";
import { seconds } from "./Overview";

const PAGE_SIZE = 25;

/** The top of the Runs page, as in the landing: the latest run, its numbers, the replay command of the newest defect. */
function LatestRun({ project, runs, openDefects }: { project: ProjectRow; runs: Run[] | null; openDefects: Defect[] | null }) {
  if (!runs) return <Message>Loading the latest run</Message>;
  const latest = runs.find((r) => r.status === "passed" || r.status === "failed");
  if (!latest) return <p className="muted">No runs yet. The first one arrives once the test job uses runs-on: fenvix.</p>;
  const finished = runs.filter((r) => r.status === "passed" || r.status === "failed").slice(0, 40).reverse();
  const ttg = timeToGreenPerCommit(runs);
  const ttgMed = median(ttg.map((x) => x.seconds));
  const newest = openDefects?.[0];
  return (
    <section className="latest" aria-labelledby="latest-h">
      <div className="latest-head">
        <div>
          <p className="page-kicker">{project.fullName} / Runs</p>
          <div className="page-title-row">
            <h2 id="latest-h" className="latest-title">
              <Link to={`/projects/${project.id}/runs/${latest.id}`} className="row-link">
                Run #{latest.number}
              </Link>
            </h2>
            <RunStatusPill status={latest.status} />
          </div>
        </div>
        {newest && (
          <span className="latest-copy">
            <CopyButton value={`${pullCommand(newest)}\n${replayCommand(newest)}`} what="replay command" text="Copy replay command" />
          </span>
        )}
      </div>
      <div className="kpis kpis-4">
        <div className="kpi">
          <span className="kpi-label">Tests run</span>
          <strong className="kpi-value">{formatCount(latest.tests.ran)}</strong>
          <span className="kpi-sub muted small">of {formatCount(latest.tests.total)} in the suite</span>
          <div className="kpi-spark"><Sparkline values={finished.map((r) => r.tests.ran)} /></div>
        </div>
        <div className="kpi">
          <span className="kpi-label">Skipped with proof</span>
          <strong className="kpi-value">{formatPercent(latest.skipShare)}</strong>
          <span className="kpi-sub muted small">each with a receipt</span>
          <div className="kpi-spark"><Sparkline values={finished.map((r) => r.skipShare)} /></div>
        </div>
        <div className="kpi">
          <span className="kpi-label">Time to green</span>
          <strong className="kpi-value">{ttgMed === null ? "–" : secs(ttgMed)}</strong>
          <span className="kpi-sub muted small">{project.baseline ? `before: ${secs(project.baseline.medianTimeToGreenS)}` : "median, 30 days"}</span>
          <div className="kpi-spark"><Sparkline values={ttg.slice(-40).map((x) => x.seconds)} /></div>
        </div>
        <div className="kpi">
          <span className="kpi-label">Open defects</span>
          <strong className="kpi-value">{openDefects ? formatCount(openDefects.length) : "–"}</strong>
          <span className="kpi-sub muted small">each with a replay command</span>
          <div className="kpi-spark"><Sparkline values={finished.map((r) => r.tests.flakyDefects)} /></div>
        </div>
      </div>
    </section>
  );
}

function RunsTab({ project }: { project: ProjectRow }) {
  const [params, setParams] = useSearchParams();
  const scope = (["pr", "default"].includes(params.get("scope") ?? "") ? params.get("scope") : "all") as NonNullable<RunQuery["scope"]>;
  const status = (["passed", "failed"].includes(params.get("status") ?? "") ? params.get("status") : "all") as NonNullable<RunQuery["status"]>;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const runs = useAsync(() => client.listRuns(project.id, { scope, status, page, pageSize: PAGE_SIZE }), [project.id, scope, status, page]);
  const since = new Date(client.now().getTime() - 30 * 86_400_000).toISOString();
  const recent = useAsync(() => client.listRunsSince(project.id, since), [project.id]);
  const defects = useAsync(() => client.listDefects({ projectId: project.id }), [project.id]);
  const activity = useAsync(() => client.listActivity(project.id, 8), [project.id]);
  const now = client.now();
  const set = (k: string, v: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        if (k !== "page") n.delete("page");
        return n;
      },
      { replace: true },
    );

  return (
    <>
      <LatestRun project={project} runs={recent.status === "ready" ? recent.data : null} openDefects={defects.status === "ready" ? defects.data : null} />
      <div className="grid-2">
        <Card id="ttg-per-run" title="Time to green, per run" description="Push to first green run, per commit, last 30 days.">
          {recent.status === "ready" && timeToGreenPerCommit(recent.data).length > 1 ? (
            <BeforeWithChart points={timeToGreenPerCommit(recent.data).map((x) => ({ at: x.at, value: x.seconds }))} before={project.baseline?.medianTimeToGreenS ?? null} format={(n) => secs(n)} />
          ) : (
            <Message>{recent.status === "ready" ? "Not enough green commits yet." : "Loading the chart"}</Message>
          )}
        </Card>
        <Card id="activity" title="Live activity" description={project.fullName}>
          {activity.status === "ready" ? <ActivityList items={activity.data} now={client.now()} /> : <Message>Loading</Message>}
        </Card>
      </div>

      <Card id="minutes" title="Minutes this month" description="The same runs on a GitHub-hosted runner, and what they are made of.">
        <p className="minute-line" id="project-minutes">
          <MinuteSum m={project.minutesThisMonth} />
        </p>
        <p className="muted small">
          Saved: {formatCount(project.minutesThisMonth.skipped)} min. {SAVED_NOTE}
        </p>
      </Card>


      <Card
        id="runs"
        title="Runs"
        description={`Every test job that ran on fenvix, newest first. ${runMinutesNote}`}
        actions={
          <div className="card-controls">
            <Segmented label="Branch" value={scope} onChange={(v) => set("scope", v === "all" ? null : v)} options={[{ value: "all", label: "All" }, { value: "pr", label: "Pull requests" }, { value: "default", label: project.defaultBranch }]} className="seg-sm" />
            <Segmented label="Status" value={status} onChange={(v) => set("status", v === "all" ? null : v)} options={[{ value: "all", label: "Any" }, { value: "passed", label: "Passed" }, { value: "failed", label: "Failed" }]} className="seg-sm" />
          </div>
        }
      >
        {runs.status === "loading" && <Message>Loading runs</Message>}
        {runs.status === "error" && <Message role="alert">{runs.message}</Message>}
        {runs.status === "ready" && runs.data.items.length === 0 && <p className="muted">No runs match. The first run arrives once the test job uses runs-on: fenvix.</p>}
        {runs.status === "ready" && runs.data.items.length > 0 && (
          <>
            <div className="table-card flush">
              <table className="data responsive runs-table">
                <caption className="sr-only">Runs</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Commit</th>
                    <th scope="col">Branch or pull request</th>
                    <th scope="col" className="num">
                      Duration
                    </th>
                    <th scope="col" className="num">
                      Ran
                    </th>
                    <th scope="col" className="num">
                      Skipped
                    </th>
                    <th scope="col" className="num">
                      Failed
                    </th>
                    <th scope="col" className="num">
                      Saved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.items.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Run">
                        <span className="name-cell">
                          <span className="inline-pair">
                            <Link to={`/projects/${project.id}/runs/${r.id}`} className="row-link mono">
                              #{r.number}
                            </Link>
                            <RunStatusPill status={r.status} />
                          </span>
                          <span className="muted small">{formatRelative(r.startedAt, now)}</span>
                        </span>
                      </td>
                      <td data-label="Commit">
                        <span className="name-cell">
                          <span className="mono">{shortSha(r.commitSha)}</span>
                          <span className="muted small ellipsis commit-msg" title={r.commitMessage}>
                            {r.commitMessage}
                          </span>
                        </span>
                      </td>
                      <td data-label="Branch or pull request">
                        <span className="name-cell">
                          <span className="mono ellipsis branch-cell" title={r.branch}>
                            {r.pullRequest ? `#${r.pullRequest}` : r.branch}
                          </span>
                          <span className="muted small">{triggerLabel(r.trigger)}</span>
                        </span>
                      </td>
                      <td data-label="Duration" className="num mono">
                        {formatDuration(r.durationMs)}
                      </td>
                      <td data-label="Ran" className="num mono">
                        {formatCount(r.tests.ran)}
                      </td>
                      <td data-label="Skipped with proof" className="num mono">
                        {formatCount(r.tests.skippedWithProof)}
                      </td>
                      <td data-label="Failed" className="num mono">
                        {r.tests.failed > 0 ? (
                          <span className="fail-count">
                            {r.tests.failed}
                            {r.tests.flakyDefects > 0 && <span className="muted small"> ({r.tests.flakyDefects} flaky)</span>}
                          </span>
                        ) : (
                          0
                        )}
                      </td>
                      <td data-label="Saved" className="num mono">
                        {formatMinutes(runMinutes(r).skipped)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={runs.data.total} onPage={(p) => set("page", String(p))} />
          </>
        )}
      </Card>
    </>
  );
}

function SetupTab({ project }: { project: ProjectRow }) {
  const snippet = setupSnippet(project);
  return (
    <div className="grid-2">
      <Card id="snippet" title="The test job on fenvix" description="One line: runs-on: fenvix. The steps stay as they are; fenvix wraps the test command with the engine.">
        <CodeBlock code={snippet} what="setup snippet" label="Test job using runs-on: fenvix" />
        <SetupDiff project={project} />
      </Card>
      <Card id="status" title="Status" description="How this project was connected.">
        <dl className="facts">
          <div>
            <dt>Setup</dt>
            <dd>
              <SetupStatePill state={project.setupState} />
            </dd>
          </div>
          <div>
            <dt>Pull request</dt>
            <dd>
              {project.setupPullRequest ? (
                <a href={project.setupPullRequest.url} target="_blank" rel="noreferrer" className="row-link">
                  #{project.setupPullRequest.number} ({project.setupPullRequest.state})
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : (
                <Link to="/projects/connect" className="row-link">
                  Open it
                </Link>
              )}
            </dd>
          </div>
          <div>
            <dt>Connected</dt>
            <dd>{formatDate(project.connectedAt)}</dd>
          </div>
          <div>
            <dt>GitHub App installation</dt>
            <dd className="mono">{project.installationId}</dd>
          </div>
          {project.baseline && (
            <>
              <div>
                <dt>Before fenvix: time to green</dt>
                <dd className="mono">{seconds(project.baseline.medianTimeToGreenS)}</dd>
              </div>
              <div>
                <dt>Before fenvix: test job</dt>
                <dd className="mono">{formatMinutes(project.baseline.medianJobMinutes)}</dd>
              </div>
            </>
          )}
        </dl>
        {project.baseline && (
          <p className="muted small">
            Medians of {formatCount(project.baseline.runsSampled)} GitHub Actions runs from {formatDate(project.baseline.from)} to {formatDate(project.baseline.to)}, measured when the project was connected.
          </p>
        )}
      </Card>
    </div>
  );
}

function SettingsTab({ project, onSaved }: { project: ProjectRow; onSaved: () => void }) {
  const org = useOrg();
  const toast = useToast();
  const [form, setForm] = useState<ProjectSettings>(project.settings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(project.settings), [project.settings]);
  const readOnly = !org.canManage;
  const changed = JSON.stringify(form) !== JSON.stringify(project.settings);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await client.saveProjectSettings(project.id, form);
      toast("Project settings saved", "success");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the settings. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="project-settings" title="Settings" description={readOnly ? "Only an owner or admin can change these." : "How fenvix runs this project's tests."}>
      <form onSubmit={save} className="stack" noValidate>
        <fieldset disabled={readOnly} className="plain-fieldset stack">
          <Switch id="s-skip" checked={form.skipWithProof} onChange={(v) => setForm({ ...form, skipWithProof: v })} label="Skip tests with proof" help="Reuse a test's result only when the code it ran, the files and environment variables it read, the runtime and the configuration are all proven unchanged." disabled={readOnly} />
          <Switch id="s-comment" checked={form.commentOnPullRequests} onChange={(v) => setForm({ ...form, commentOnPullRequests: v })} label="Comment on pull requests" help="One comment per pull request: tests skipped with proof, failures, and the replay command of any flaky defect." disabled={readOnly} />
          <Switch id="s-nightly" checked={form.nightlyExploration} onChange={(v) => setForm({ ...form, nightlyExploration: v })} label="Nightly exploration" help="Runs the suite at night in many orders and seeds on fenvix machines to find hidden order and timing bugs. Not counted as runs." disabled={readOnly} />
          <div className="field">
            <label htmlFor="s-cmd">Test command</label>
            <input id="s-cmd" className="mono" value={form.testCommand} maxLength={500} placeholder={project.testRunner === "pytest" ? "pytest" : project.testRunner === "go test" ? "go test ./..." : `npx ${project.testRunner}`} onChange={(e) => setForm({ ...form, testCommand: e.target.value })} aria-describedby="s-cmd-help" />
            <span id="s-cmd-help" className="help">
              Leave empty to use the command in your workflow.
            </span>
          </div>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!readOnly && (
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !changed}>
              Save settings
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

export function ProjectPage({ section = "runs" }: { section?: "runs" | "settings" }) {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const project = useAsync(() => client.getProject(id), [id]);
  const p = project.status === "ready" ? project.data : null;
  useProjectTitle(p?.fullName, p ? { language: languageLabel(p.language), runner: p.testRunner, snippet: setupSnippet(p) } : undefined);

  // Old links (?tab=setup, ?tab=settings) open the project's Settings.
  if (params.get("tab")) return <Navigate to={`/projects/${id}/settings`} replace />;
  if (project.status === "loading") return <Message>Loading project</Message>;
  if (project.status === "error") return <Message role="alert">{project.message}</Message>;
  if (!p)
    return (
      <div className="empty not-found">
        <h1>Project not found</h1>
        <p className="muted">It may have been disconnected, or it belongs to another organization.</p>
        <Link to="/projects" className="btn btn-primary">
          Back to your projects
        </Link>
      </div>
    );

  if (section === "settings")
    return (
      <>
        <PageHeader back={<Kicker>{p.fullName}</Kicker>} title="Settings" meta={<SetupStatePill state={p.setupState} />} description="How fenvix runs this project's tests, and the one line that moves its test job to fenvix." />
        <SettingsTab project={p} onSaved={project.reload} />
        <SetupTab project={p} />
        <p className="muted small">
          Organization: <Link to="/settings" className="row-link">settings</Link> · <Link to="/settings/members" className="row-link">members</Link> · <Link to="/billing" className="row-link">plans and billing</Link>
        </p>
      </>
    );
  return (
    <>
      <h1 className="sr-only">{p.fullName}: runs</h1>
      <RunsTab project={p} />
    </>
  );
}
