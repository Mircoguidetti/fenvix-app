import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { client, type ProjectRow, type ProjectSettings, type RunQuery } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { AreaSeriesChart } from "../components/charts";
import { CodeBlock, triggerLabel } from "../components/ci";
import { RunStatusPill } from "../components/StateBadge";
import { Pagination } from "../components/Pagination";
import { Segmented } from "../components/Segmented";
import { Switch } from "../components/Switch";
import { useProjectTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useOrg } from "../session/OrgProvider";
import { formatCount, formatDate, formatDuration, formatMinutes, formatPercent, formatRelative, shortSha } from "../lib/format";
import { setupSnippet } from "../data/ci";
import { SetupStatePill, languageLabel } from "./Projects";
import { SetupDiff } from "./Connect";
import { seconds } from "./Overview";

const PAGE_SIZE = 25;

function RunsTab({ project }: { project: ProjectRow }) {
  const [params, setParams] = useSearchParams();
  const scope = (["pr", "default"].includes(params.get("scope") ?? "") ? params.get("scope") : "all") as NonNullable<RunQuery["scope"]>;
  const status = (["passed", "failed"].includes(params.get("status") ?? "") ? params.get("status") : "all") as NonNullable<RunQuery["status"]>;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const runs = useAsync(() => client.listRuns(project.id, { scope, status, page, pageSize: PAGE_SIZE }), [project.id, scope, status, page]);
  const series = useAsync(() => client.getSkipShareSeries(project.id, 60), [project.id]);
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
      <Card id="skip-trend" title="Skipped with proof over time" description="Median share of test time skipped per run, day by day, over 60 days.">
        {series.status === "ready" ? <AreaSeriesChart points={series.data} range="30d" valueLabel={(n) => formatPercent(n)} /> : <Message>Loading the chart</Message>}
      </Card>

      <Card
        id="runs"
        title="Runs"
        description="Every test job that ran on fenvix, newest first."
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
            <div className="table-card flush table-scroll">
              <table className="data responsive runs-table">
                <caption className="sr-only">Runs</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Commit</th>
                    <th scope="col">Branch or pull request</th>
                    <th scope="col">Trigger</th>
                    <th scope="col" className="num">
                      Duration
                    </th>
                    <th scope="col" className="num">
                      Ran
                    </th>
                    <th scope="col" className="num">
                      Skipped with proof
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
                          <Link to={`/projects/${project.id}/runs/${r.id}`} className="row-link mono">
                            #{r.number}
                          </Link>
                          <span className="inline-pair">
                            <RunStatusPill status={r.status} />
                            <span className="muted small">{formatRelative(r.startedAt, now)}</span>
                          </span>
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
                      <td data-label="Branch or pull request" className="mono">
                        <span className="ellipsis branch-cell" title={r.branch}>
                          {r.pullRequest ? `#${r.pullRequest}` : r.branch}
                        </span>
                      </td>
                      <td data-label="Trigger">{triggerLabel(r.trigger)}</td>
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
                        {formatMinutes(r.minutesSaved)}
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

export function ProjectPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const tab = params.get("tab") === "setup" ? "setup" : params.get("tab") === "settings" ? "settings" : "runs";
  const project = useAsync(() => client.getProject(id), [id]);
  const p = project.status === "ready" ? project.data : null;
  useProjectTitle(p?.fullName, p ? { language: languageLabel(p.language), runner: p.testRunner, snippet: setupSnippet(p) } : undefined);

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

  return (
    <>
      <PageHeader
        back={<Kicker>Project</Kicker>}
        title={<span className="mono break-anywhere">{p.fullName}</span>}
        meta={<SetupStatePill state={p.setupState} />}
        description={`${languageLabel(p.language)} · ${p.testRunner} · ${formatCount(p.runsThisMonth)} runs this month · ${p.medianSkipShare === null ? "no runs yet" : `${formatPercent(p.medianSkipShare)} of test time skipped with proof (median)`}`}
      />
      <nav className="seg settings-tabs project-tabs" aria-label="Project sections">
        {(["runs", "setup", "settings"] as const).map((t) => (
          <Link key={t} to={t === "runs" ? `/projects/${p.id}` : `/projects/${p.id}?tab=${t}`} className={tab === t ? "seg-link active" : "seg-link"} aria-current={tab === t ? "page" : undefined}>
            {t === "runs" ? "Runs" : t === "setup" ? "Setup" : "Settings"}
          </Link>
        ))}
      </nav>
      {tab === "runs" && <RunsTab project={p} />}
      {tab === "setup" && <SetupTab project={p} />}
      {tab === "settings" && <SettingsTab project={p} onSaved={project.reload} />}
    </>
  );
}
