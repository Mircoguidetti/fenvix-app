import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, ExternalLink, Lock } from "lucide-react";
import { client, type Project, type SetupPullRequest } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { SetupStatePill, languageLabel } from "./Projects";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../session/SessionProvider";
import { useOrg } from "../session/OrgProvider";
import { setupChange } from "../data/ci";

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="step" data-done={done || undefined}>
      <span className="step-n" aria-hidden="true">
        {done ? <Check size={14} strokeWidth={2.5} /> : n}
      </span>
      <div className="step-body">
        <h2 className="step-title">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h2>
        {children}
      </div>
    </li>
  );
}

/** The change the setup pull request makes, as a two-line diff. */
export function SetupDiff({ project }: { project: Pick<Project, "language"> }) {
  const c = setupChange(project);
  return (
    <figure className="diff" aria-label={`Change in ${c.path}`}>
      <figcaption className="mono small">
        {c.path} · job <strong>{c.job}</strong>
      </figcaption>
      <pre className="mono">
        <span className="diff-del">- {c.before}</span>
        {"\n"}
        <span className="diff-add">+ {c.after}</span>
      </pre>
    </figure>
  );
}

function SetupRow({ project, onOpened }: { project: Project; onOpened: (pr: SetupPullRequest) => void }) {
  const toast = useToast();
  const org = useOrg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    setBusy(true);
    setError(null);
    try {
      const pr = await client.openSetupPullRequest(project.id);
      onOpened(pr);
      toast(`Opened pull request #${pr.number} on ${project.fullName}`, "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the pull request. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="setup-row">
      <div className="setup-row-head">
        <span className="name-cell">
          <Link to={`/projects/${project.id}`} className="row-link mono break-anywhere">
            {project.fullName}
          </Link>
          <span className="muted small">
            {languageLabel(project.language)} · {project.testRunner}
          </span>
        </span>
        <SetupStatePill state={project.setupState} />
      </div>
      <SetupDiff project={project} />
      {project.setupPullRequest ? (
        <p className="setup-done">
          <a href={project.setupPullRequest.url} target="_blank" rel="noreferrer" className="row-link">
            Pull request #{project.setupPullRequest.number}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <span className="muted small">Merge it and the next test run goes to fenvix.</span>
        </p>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={open} disabled={busy || !org.canManage}>
            Open the pull request
          </button>
          <span className="muted small">fenvix opens it on {project.fullName}; you review and merge it.</span>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * Onboarding: signed in with GitHub → install the fenvix GitHub App on chosen repositories (on GitHub; the mock stands
 * in for that page) → GitHub sends the browser back here with ?installation_id=… → the repositories are projects → a
 * pull request moves each test job to runs-on: fenvix.
 */
export function ConnectPage() {
  const { user } = useSession();
  const org = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const installationId = Number(params.get("installation_id")) || null;
  const connection = useAsync(() => client.getGitHubConnection(), []);
  const repos = useAsync(() => client.listGitHubRepositories(), []);
  const projects = useAsync(() => client.listProjects(), []);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Project[] | null>(null);
  const [opened, setOpened] = useState<Record<string, SetupPullRequest>>({});
  const finishing = useRef<number | null>(null);

  // Back from GitHub: the installation's repositories become projects, once.
  useEffect(() => {
    if (!installationId || finishing.current === installationId) return;
    finishing.current = installationId;
    client
      .completeInstallation(installationId)
      .then((ps) => {
        setAdded(ps);
        projects.reload();
        repos.reload();
        connection.reload();
        if (ps.length) toast(`Connected ${ps.length === 1 ? ps[0].fullName : `${ps.length} repositories`}`, "success");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not finish the installation."));
  }, [installationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const available = repos.status === "ready" ? repos.data.filter((r) => !r.connected) : [];
  const waiting = projects.status === "ready" ? projects.data.filter((p) => p.setupState !== "active") : [];
  const installed = connection.status === "ready" && connection.data.account !== null;
  const installUrl = connection.status === "ready" ? connection.data.installUrl : null;

  async function install() {
    setBusy(true);
    setError(null);
    try {
      const id = await client.installGitHubApp(chosen);
      setPicking(false);
      setChosen([]);
      // Where GitHub sends the browser after an installation (the GitHub App's setup URL).
      navigate(`/projects/connect?installation_id=${id}&setup_action=install`, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not install the app.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader back={<Kicker>Projects</Kicker>} title="Connect a project" description="Three steps. Nothing changes in a repository until you merge the pull request fenvix opens." />
      {!org.canManage && <Message tone="warning">Only an owner or admin can connect repositories.</Message>}
      <ol className="steps">
        <Step n={1} done={!!user} title="Sign in with GitHub">
          <p className="muted">Signed in as {user?.email}.</p>
        </Step>
        <Step n={2} done={installed && (projects.status === "ready" && projects.data.length > 0)} title="Install the fenvix GitHub App">
          <p className="muted">Choose the repositories fenvix may see. It reads the code and the workflow files, posts results on pull requests, and opens the setup pull request. It never pushes to a branch.</p>
          {connection.status === "ready" && connection.data.account && <p className="small">Installed on GitHub account <strong className="mono">{connection.data.account}</strong>.</p>}
          {client.sample ? (
            <div className="row-actions">
              <button type="button" className="btn btn-primary" onClick={() => (setPicking(true), setError(null))} disabled={!org.canManage || available.length === 0}>
                {installed ? "Add repositories on GitHub" : "Install on GitHub"}
              </button>
              {available.length === 0 && repos.status === "ready" && <span className="muted small">Every repository the app can see is connected.</span>}
            </div>
          ) : installUrl ? (
            <div className="row-actions">
              <a href={installUrl} className="btn btn-primary">
                Install on GitHub
              </a>
            </div>
          ) : (
            <Message tone="warning">The fenvix GitHub App is not set up for this deployment yet.</Message>
          )}
        </Step>
        <Step n={3} done={projects.status === "ready" && projects.data.length > 0 && waiting.length === 0} title="Move the test job to fenvix">
          <p className="muted">One line changes in the test job. Your workflow, secrets and other jobs stay as they are.</p>
          {added && added.length > 0 && <p className="small">Just connected: {added.map((p) => p.fullName).join(", ")}.</p>}
          {projects.status === "ready" && waiting.length > 0 && (
            <ul className="setup-list">
              {waiting.map((p) => (
                <SetupRow key={p.id} project={opened[p.id] ? { ...p, setupPullRequest: opened[p.id], setupState: "pr_open" } : p} onOpened={(pr) => setOpened((o) => ({ ...o, [p.id]: pr }))} />
              ))}
            </ul>
          )}
          {projects.status === "ready" && projects.data.length > 0 && waiting.length === 0 && <p className="small">Every connected project already runs on fenvix.</p>}
        </Step>
      </ol>
      {error && <Message role="alert">{error}</Message>}

      <Card id="what" title="What fenvix does with access" description="The GitHub App asks for the least it needs.">
        <ul className="plain-list">
          <li>
            <Lock size={14} aria-hidden="true" /> Reads code, workflow files and pull requests of the repositories you choose.
          </li>
          <li>
            <Lock size={14} aria-hidden="true" /> Writes check results and one comment per pull request, and opens the setup pull request.
          </li>
          <li>
            <Lock size={14} aria-hidden="true" /> Test jobs run on fenvix machines, with the secrets your workflow already passes to them.
          </li>
        </ul>
      </Card>

      <ConfirmDialog open={picking} title={`GitHub: install fenvix${connection.status === "ready" && connection.data.account ? ` on ${connection.data.account}` : ""}`} confirmLabel="Install" busy={busy} confirmDisabled={chosen.length === 0} onConfirm={install} onCancel={() => (setPicking(false), setChosen([]))}>
        <p className="muted small">This stands in for GitHub's own page while the fenvix GitHub App is being set up.</p>
        <fieldset className="plain-fieldset stack">
          <legend className="label">Only select repositories</legend>
          {available.map((r) => (
            <label key={r.fullName} className="check">
              <input type="checkbox" checked={chosen.includes(r.fullName)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.fullName] : c.filter((x) => x !== r.fullName)))} />
              <span className="mono">{r.fullName}</span>
              <span className="muted small">
                {r.private ? "private" : "public"} · {r.testRunner}
              </span>
            </label>
          ))}
        </fieldset>
      </ConfirmDialog>
    </>
  );
}
