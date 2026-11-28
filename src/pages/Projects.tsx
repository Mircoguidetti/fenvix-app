import { Link } from "react-router-dom";
import { client, type ProjectRow, type SetupState } from "../data";
import { Message, PageHeader, Kicker } from "../components/PageHeader";
import { RunStatusPill, StatusPill } from "../components/StateBadge";
import { SkipShare, WarmCacheNote } from "../components/ci";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatMinutes, formatRelative } from "../lib/format";
import { isSettingUp, setupPath } from "./Connect";

export function SetupStatePill({ state }: { state: SetupState }) {
  if (state === "active") return <StatusPill tone="ok">On fenvix</StatusPill>;
  if (state === "pr_open") return <StatusPill tone="warn">Pull request open</StatusPill>;
  return <StatusPill tone="warn">Waiting for setup</StatusPill>;
}

const LANG: Record<ProjectRow["language"], string> = { python: "Python", node: "TypeScript / Node", go: "Go" };
export const languageLabel = (l: ProjectRow["language"]) => LANG[l];

export function ProjectsPage() {
  const projects = useAsync(() => client.listProjects(), []);
  // Repositories in setup (no project yet): listed as "Setting up", each linked to its setup page. Optional: a failed
  // request just leaves them out.
  const repos = useAsync(() => client.listGitHubRepositories(), []);
  const settingUp = repos.status === "ready" ? repos.data.filter(isSettingUp) : [];
  const now = client.now();
  // One "Connect a project" button (founder, 28 Nov): the header's once there are projects, the empty state's before.
  const hasProjects = projects.status === "ready" && projects.data.length > 0;
  return (
    <>
      <PageHeader
        back={<Kicker />}
        title="Projects"
        description="Repositories connected through the fenvix GitHub App. Numbers are for this month. Minutes saved count skipped test time only: checkout, install and build still run on fenvix."
        actions={
          hasProjects ? (
            <Link to="/projects/connect" className="btn btn-primary">
              Connect a project
            </Link>
          ) : undefined
        }
      />
      {settingUp.length > 0 && (
        <section className="card setting-up" aria-labelledby="setting-up-h">
          <h2 id="setting-up-h">Setting up</h2>
          <ul className="setting-up-list">
            {settingUp.map((r) => (
              <li key={r.repositoryId} className="setting-up-row">
                <span className="name-cell">
                  <Link to={setupPath(r)} className="row-link mono break-anywhere">
                    {r.fullName}
                  </Link>
                  <span className="muted small">{r.setupPullRequest && r.setupPullRequest.state === "open" ? `Setup pull request #${r.setupPullRequest.number} waits for your merge` : "Waiting for its first run on fenvix"}</span>
                </span>
                <span className="setting-up-tag">Setting up</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {projects.status === "loading" && <Message>Loading projects</Message>}
      {projects.status === "error" && <Message role="alert">{projects.message}</Message>}
      {projects.status === "ready" && projects.data.length === 0 && (
        <div className="empty">
          <h2>No projects yet</h2>
          <p className="muted">Install the fenvix GitHub App on the repositories whose tests should run on fenvix.</p>
          <Link to="/projects/connect" className="btn btn-primary">
            Connect a project
          </Link>
        </div>
      )}
      {projects.status === "ready" && projects.data.length > 0 && (
        <div className="table-card">
          <table className="data responsive">
            <caption className="sr-only">Projects</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Setup</th>
                <th scope="col" className="num">
                  Runs
                </th>
                <th scope="col">Skipped with proof</th>
                <th scope="col" className="num">
                  Minutes saved
                </th>
                <th scope="col" className="num">
                  Open defects
                </th>
                <th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id}>
                  <td data-label="Project">
                    <span className="name-cell">
                      <Link to={`/projects/${p.id}`} className="row-link mono break-anywhere">
                        {p.fullName}
                      </Link>
                      <span className="muted small">
                        {languageLabel(p.language)} · {p.testRunner}
                      </span>
                    </span>
                  </td>
                  <td data-label="Setup">
                    <span className="setup-cell">
                      <SetupStatePill state={p.setupState} />
                      <span className="small">
                        <WarmCacheNote cache={p.warmCache} now={now} />
                      </span>
                    </span>
                  </td>
                  <td data-label="Runs" className="num mono">
                    {formatCount(p.runsThisMonth)}
                  </td>
                  <td data-label="Skipped with proof">
                    <SkipShare share={p.medianSkipShare} />
                  </td>
                  <td data-label="Minutes saved" className="num mono">
                    {formatMinutes(p.minutesSavedThisMonth)}
                  </td>
                  <td data-label="Open defects" className="num mono">
                    {p.openDefects > 0 ? (
                      <Link to={`/defects?project=${p.id}`} className="row-link">
                        {p.openDefects}
                      </Link>
                    ) : (
                      0
                    )}
                  </td>
                  <td data-label="Last run">
                    {p.lastRunAt && p.lastRunStatus ? (
                      <span className="inline-pair">
                        <RunStatusPill status={p.lastRunStatus} count={p.lastRunNotProven} />
                        <span className="muted small">{formatRelative(p.lastRunAt, now)}</span>
                      </span>
                    ) : (
                      <span className="muted">No runs yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
