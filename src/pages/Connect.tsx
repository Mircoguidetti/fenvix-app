import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, CircleCheck, ExternalLink, Lock, TriangleAlert } from "lucide-react";
import { client, type GitHubRepository, type Installation, type OnboardingKind, type SetupChange } from "../data";
import { Segmented } from "../components/Segmented";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { InstallationStatusPill, OnboardingPill } from "../components/StateBadge";
import { useToast } from "../components/Toast";
import { WarmCacheNote } from "../components/ci";
import { useAsync } from "../lib/useAsync";
import { useOrg } from "../session/OrgProvider";
import { activeOrgId, setActiveOrgId } from "../lib/org";
import { formatDate } from "../lib/format";
import { languageLabel } from "./Projects";
import { installationConfigureUrl } from "../lib/github";

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: ReactNode }) {
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
export function SetupDiff({ change }: { change: SetupChange }) {
  return (
    <figure className="diff" aria-label={`Change in ${change.path}`}>
      <figcaption className="mono small">
        {change.path} · job <strong>{change.job}</strong>
      </figcaption>
      <pre className="mono">
        <span className="diff-del">- {change.before}</span>
        {"\n"}
        <span className="diff-add">+ {change.after}</span>
      </pre>
    </figure>
  );
}

/** What GitHub's return to /projects/connect?github=error&reason=… means, in words a person can act on. */
export const INSTALL_ERRORS: Record<string, string> = {
  expired: "The install link expired: it works for one hour. Start again with Install the GitHub App.",
  incomplete: "GitHub did not finish the installation. Start again, and choose the repositories on GitHub's page.",
  oauth: "GitHub could not confirm who you are. Start again, and approve fenvix when GitHub asks.",
  not_yours: "That install link was made for someone else. Start again from this page, signed in as yourself.",
  github_not_admin: "Only an admin of the GitHub account can connect its installation: the account itself, or an owner of the GitHub organization. Nothing was connected. Ask one of them to install fenvix from this page.",
  not_admin: "Only an owner or admin of this organization can link a GitHub installation to it.",
  used: "That install link was already used. Start again with Install the GitHub App.",
  removed: "That GitHub installation was removed on GitHub. Install the GitHub App again.",
  other_organization: "That GitHub installation is already linked to another fenvix organization. Remove it there first, or install fenvix on another GitHub account.",
  github: "GitHub did not answer while the installation was being linked. Try again in a few minutes.",
  error: "Something went wrong while the installation was being linked. Try again.",
};

/** On fenvix: the shared cache of the default branch is warmed for these (after the merge and each push). */
const ONBOARDED = new Set(["merged", "already_fenvix"]);

/** States from which the App can open (or open again) the setup pull request. */
const CAN_OPEN = new Set(["pending", "closed", "failed"]);
const POLLS = 6;
const POLL_MS = 1500;

function runnerText(r: GitHubRepository): string {
  if (!r.language && !r.testRunner) return "Language and test runner not detected";
  return `${r.language ? languageLabel(r.language) : "Language not detected"} · ${r.testRunner ?? "test runner not detected"}`;
}

function RepoRow({ repo, installation, queued, onOpen }: { repo: GitHubRepository; installation: Installation | undefined; queued: boolean; onOpen: (r: GitHubRepository) => void }) {
  const org = useOrg();
  const active = installation?.status === "active";
  const canOpen = CAN_OPEN.has(repo.onboardingState);
  return (
    <li className="setup-row repo-row" data-state={repo.onboardingState}>
      <div className="setup-row-head">
        <span className="name-cell">
          {repo.projectId ? (
            <Link to={`/projects/${repo.projectId}`} className="row-link mono break-anywhere">
              {repo.fullName}
            </Link>
          ) : (
            <span className="mono break-anywhere repo-name">{repo.fullName}</span>
          )}
          <span className="muted small">
            {repo.private ? "Private" : "Public"} · {runnerText(repo)}
          </span>
        </span>
        <OnboardingPill state={repo.onboardingState} />
      </div>
      <p className="small repo-detail">{repo.onboardingDetail}</p>
      {(ONBOARDED.has(repo.onboardingState) || repo.warmCache.state !== "cold" || repo.warmCache.warmup) && (
        <p className="small repo-cache">
          <WarmCacheNote cache={repo.warmCache} now={client.now()} full />
        </p>
      )}
      {canOpen && repo.workflowPath && repo.job && <SetupDiff change={{ path: repo.workflowPath, job: repo.job, before: "runs-on: ubuntu-latest", after: "runs-on: fenvix" }} />}
      {(repo.setupPullRequest || repo.projectId || (repo.workflowPath && !canOpen)) && (
        <p className="setup-done">
          {repo.setupPullRequest && (
            <a href={repo.setupPullRequest.url} target="_blank" rel="noreferrer" className="row-link">
              Setup pull request #{repo.setupPullRequest.number} ({repo.setupPullRequest.state})
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          {repo.projectId && (
            <Link to={`/projects/${repo.projectId}`} className="row-link">
              Open the project
            </Link>
          )}
          {repo.workflowPath && !canOpen && (
            <span className="muted small mono">
              {repo.workflowPath}
              {repo.job ? ` · job ${repo.job}` : ""}
            </span>
          )}
        </p>
      )}
      {canOpen && (
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={() => onOpen(repo)} disabled={queued || !active || !org.canManage} aria-label={`Open setup pull request on ${repo.fullName}`}>
            {repo.onboardingState === "pending" ? "Open setup pull request" : "Open setup pull request again"}
          </button>
          <span className="muted small" role="status">
            {queued ? "Queued: the fenvix GitHub App is opening it." : !active ? "The installation must be active first." : "fenvix opens it; you review and merge it."}
          </span>
        </div>
      )}
    </li>
  );
}

function InstallationBlock({ installation, repos, queued, onOpen, highlight }: { installation: Installation; repos: GitHubRepository[]; queued: Set<number>; onOpen: (r: GitHubRepository) => void; highlight: boolean }) {
  const mine = repos.filter((r) => r.installationId === installation.installationId && !r.removed);
  const headingId = `inst-${installation.installationId}`;
  return (
    <section className="install" aria-labelledby={headingId} data-highlight={highlight || undefined} data-status={installation.status}>
      <div className="install-head">
        <span className="name-cell">
          <h3 id={headingId} className="mono break-anywhere">
            {installation.account}
          </h3>
          <span className="muted small">
            {installation.accountType === "User" ? "Personal account" : installation.accountType === "Enterprise" ? "Enterprise" : "GitHub organization"} · {installation.repositorySelection === "all" ? "all repositories" : "selected repositories"} · {installation.repositories}{" "}
            {installation.repositories === 1 ? "repository" : "repositories"}
            {installation.linkedAt ? ` · linked ${formatDate(installation.linkedAt)}` : ""}
          </span>
        </span>
        <span className="install-tags">
          {highlight && <span className="tag">Just linked</span>}
          <InstallationStatusPill status={installation.status} />
        </span>
      </div>
      {installation.status === "suspended" && (
        <Message tone="warning">Suspended on GitHub: fenvix cannot open pull requests or run jobs for these repositories until an owner of {installation.account} unsuspends the app on GitHub.</Message>
      )}
      {installation.status === "deleted" ? (
        <p className="muted small">Uninstalled from GitHub: fenvix no longer sees the repositories of {installation.account}. Install the app again to bring them back.</p>
      ) : mine.length === 0 ? (
        <p className="muted small">No repository yet. Choose repositories for the app on GitHub.</p>
      ) : (
        <ul className="setup-list">
          {mine.map((r) => (
            <RepoRow key={r.repositoryId} repo={r} installation={installation} queued={queued.has(r.repositoryId)} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Onboarding with the fenvix GitHub App: install it on a GitHub account (the API makes the link; GitHub sends the
 * browser back here with ?github=…), then the setup pull request of each repository moves its test job to
 * runs-on: fenvix. An organization can link several installations.
 *
 * GitHub's return with ?github=confirm#completion=<code>: the App checked the GitHub side; the link is completed here,
 * through the API with the signed-in person's own session, and only if this person asked for the install link
 * (review R-016 F2). The code leaves the address bar at once.
 */
export function ConnectPage() {
  const org = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const github = params.get("github");
  const connection = useAsync(() => client.getGitHubConnection(), []);
  const kindState = useAsync(() => client.getOnboardingKind(), []);
  const [kind, setKind] = useState<OnboardingKind | null>(null);
  const [savingKind, setSavingKind] = useState(false);
  const repos = useAsync(() => client.listGitHubRepositories(), []);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<Set<number>>(new Set());
  const polls = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const completed = useRef<string | null>(null);
  // Set when the person went to GitHub's page of an installation to choose more repositories: coming back reads the list again.
  const [chose, setChose] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (github !== "confirm") return;
    const completion = new URLSearchParams(window.location.hash.slice(1)).get("completion");
    if (!completion) {
      if (!completed.current) navigate("/projects/connect?github=error&reason=incomplete", { replace: true });
      return;
    }
    if (completed.current === completion) return;
    completed.current = completion;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setCompleting(true);
    setCompleteError(null);
    client.completeGitHubInstall(completion).then(
      (r) => {
        if (r.organizationId !== activeOrgId()) setActiveOrgId(r.organizationId);
        navigate(`/projects/connect?github=connected&installation=${r.installationId}&account=${encodeURIComponent(r.account)}`, { replace: true });
        connection.reload();
        repos.reload();
      },
      (e: unknown) => {
        setCompleteError(e instanceof Error ? e.message : "The installation could not be linked. Try again.");
        navigate("/projects/connect", { replace: true });
      },
    ).finally(() => setCompleting(false));
  }, [github]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a pull request is queued, ask for the repositories a few times until the App has done it.
  useEffect(() => {
    if (queued.size === 0) return;
    if (polls.current >= POLLS) {
      setQueued(new Set());
      return;
    }
    timer.current = window.setTimeout(async () => {
      polls.current++;
      try {
        const list = await client.listGitHubRepositories();
        repos.setData(list);
        const still = new Set([...queued].filter((id) => CAN_OPEN.has(list.find((r) => r.repositoryId === id)?.onboardingState ?? "")));
        for (const id of queued) {
          const r = list.find((x) => x.repositoryId === id);
          if (r && !still.has(id)) toast(r.setupPullRequest ? `Opened pull request #${r.setupPullRequest.number} on ${r.fullName}` : `${r.fullName}: ${r.onboardingDetail}`, "success");
        }
        setQueued(still);
      } catch {
        setQueued(new Set());
      }
    }, POLL_MS);
    return () => window.clearTimeout(timer.current);
  }, [queued]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    setRefreshing(true);
    try {
      const [c, list] = await Promise.all([client.getGitHubConnection(), client.listGitHubRepositories()]);
      connection.setData(c);
      repos.setData(list);
    } catch {
      /* the lists on show stay; the next try may work */
    } finally {
      setRefreshing(false);
    }
  }

  // The GitHub page opens in another tab. When this tab is looked at again, the repositories chosen there are listed here.
  useEffect(() => {
    if (!chose) return;
    const back = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [chose]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownKind: OnboardingKind = kind ?? (kindState.status === "ready" ? kindState.data.kind : "move");
  async function chooseKind(next: OnboardingKind) {
    if (next === shownKind || savingKind) return;
    setSavingKind(true);
    try {
      const saved = await client.setOnboardingKind(next);
      setKind(saved.kind);
      toast(saved.kind === "side_by_side" ? "New pull requests will add a side-by-side workflow; your workflow stays as it is." : "New pull requests will move the test job to fenvix.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "The choice could not be saved.", "error");
    } finally {
      setSavingKind(false);
    }
  }

  async function install() {
    setInstalling(true);
    setError(null);
    try {
      const url = await client.createInstallLink();
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the installation. Try again.");
      setInstalling(false);
    }
  }

  async function open(repo: GitHubRepository) {
    setError(null);
    try {
      const now = await client.openSetupPullRequest(repo.repositoryId);
      repos.setData((repos.status === "ready" ? repos.data : []).map((r) => (r.repositoryId === now.repositoryId ? now : r)));
      polls.current = 0;
      setQueued((q) => new Set([...q, repo.repositoryId]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the pull request. Try again.");
    }
  }

  const installations = connection.status === "ready" ? connection.data.installations : [];
  const anyActive = installations.some((i) => i.status === "active");
  const list = repos.status === "ready" ? repos.data : [];
  const live = list.filter((r) => !r.removed && installations.find((i) => i.installationId === r.installationId)?.status !== "deleted");
  const opened = live.some((r) => r.setupPullRequest);
  const merged = live.some((r) => r.onboardingState === "merged" || r.onboardingState === "already_fenvix");
  const highlighted = github === "connected" ? Number(params.get("installation")) : null;
  const reason = params.get("reason") ?? "error";
  const dismiss = () => navigate("/projects/connect", { replace: true });

  return (
    <>
      <PageHeader back={<Kicker>Projects</Kicker>} title="Connect a project" description="Install the fenvix GitHub App, then let it open one pull request per repository. Nothing changes in a repository until you merge that pull request." />
      {!org.canManage && <Message tone="warning">Only an owner or admin can connect repositories.</Message>}

      {(github === "confirm" || completing) && (
        <Message role="status">Connecting the GitHub installation{params.get("account") ? ` on ${params.get("account")}` : ""}…</Message>
      )}
      {completeError && (
        <div className="install-error">
          <Message role="alert">{completeError}</Message>
          <button type="button" className="btn btn-sm" onClick={() => setCompleteError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {github === "connected" && (
        <div className="callout callout-success" role="status">
          <p className="callout-row">
            <CircleCheck size={16} aria-hidden="true" />
            <span>
              <strong>The fenvix GitHub App is installed on {params.get("account") ?? "your GitHub account"}.</strong> Its repositories are listed below: open the setup pull request of each one you want on fenvix.
            </span>
          </p>
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {github === "requested" && (
        <div className="callout callout-warning" role="status">
          <p className="callout-row">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>
              <strong>Waiting for an owner of the GitHub organization.</strong> You asked to install the fenvix GitHub App; GitHub sent the request to the organization's owners. Once one approves it on GitHub, the
              installation and its repositories appear here.
            </span>
          </p>
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={dismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {github === "error" && (
        <div className="install-error">
          <Message role="alert">{INSTALL_ERRORS[reason] ?? INSTALL_ERRORS.error}</Message>
          <button type="button" className="btn btn-sm" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      )}

      <ol className="steps">
        <Step n={1} done={anyActive} title="Choose the repositories fenvix may see">
          <p className="muted">On a GitHub account or organization, for the repositories you choose. It reads code and workflow files, posts results on pull requests and opens the setup pull request. It never pushes to a branch.</p>
          {connection.status === "loading" && <Message>Loading installations</Message>}
          {connection.status === "error" && <Message role="alert">{connection.message}</Message>}
          {connection.status === "ready" && installations.length > 0 && (
            <ul className="install-more" aria-label="Your GitHub installations">
              {installations.map((i) => (
                <li key={i.installationId} className="install-more-row">
                  <span className="name-cell">
                    <span className="mono break-anywhere">{i.account}</span>
                    <span className="muted small">
                      {i.repositorySelection === "all" ? "All repositories" : "Selected repositories"} · {i.repositories} {i.repositories === 1 ? "repository" : "repositories"}
                    </span>
                  </span>
                  {i.status !== "deleted" && (
                    <a href={installationConfigureUrl(i)} target="_blank" rel="noreferrer" className="btn btn-sm" onClick={() => setChose(true)} aria-label={`Choose more repositories for ${i.account} on GitHub`}>
                      Choose more repositories
                      <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {kindState.status === "ready" && kindState.data.sideBySideAvailable && (
            <div className="connect-kind">
              <Segmented<OnboardingKind>
                label="How fenvix runs your tests"
                value={shownKind}
                disabled={!org.canManage || savingKind}
                onChange={(v) => void chooseKind(v)}
                options={[
                  { value: "move", label: "Move the test job to fenvix" },
                  { value: "side_by_side", label: "Run side by side (your workflow stays as it is)" },
                ]}
              />
              <p className="muted small">
                {shownKind === "side_by_side"
                  ? "The pull request adds one new workflow file that runs a copy of your test job on fenvix. Your workflow is not changed and decides green or red alone; fenvix shows both side by side."
                  : "The pull request changes one line in your test job: runs-on: fenvix."}
                {!org.canManage && " Only an owner or admin can change this."}
              </p>
            </div>
          )}
          <div className="row-actions">
            <button type="button" className={installations.length ? "btn" : "btn btn-primary"} onClick={install} disabled={installing || !org.canManage || connection.status !== "ready"}>
              {installations.length ? "Add another GitHub account" : "Install the GitHub App"}
            </button>
            {installations.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh repositories"}
              </button>
            )}
            <span className="muted small">
              {installations.length
                ? "Choose more repositories of an account you already connected on GitHub's page for it, or add another account or organization. New repositories appear below with their setup pull request."
                : "GitHub asks which repositories fenvix may see, then sends you back here."}
            </span>
          </div>
        </Step>
        <Step n={2} done={opened} title="Open the setup pull request">
          <p className="muted">One line changes in the test job: runs-on: fenvix. Your workflow, secrets and other jobs stay as they are.</p>
          {repos.status === "loading" && <Message>Loading repositories</Message>}
          {repos.status === "error" && <Message role="alert">{repos.message}</Message>}
          {connection.status === "ready" && repos.status === "ready" && installations.length === 0 && <p className="muted small">No installation yet: install the app first.</p>}
          {connection.status === "ready" && repos.status === "ready" && installations.map((i) => <InstallationBlock key={i.installationId} installation={i} repos={list} queued={queued} onOpen={open} highlight={i.installationId === highlighted} />)}
        </Step>
        <Step n={3} done={merged} title="Merge it on GitHub">
          <p className="muted">After the merge, the next test run goes to fenvix and the repository becomes a project, with its runs, defects and minutes saved. fenvix also runs the test job once on the default branch, at no charge, so your first pull request finds the cache warm.</p>
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
            <Lock size={14} aria-hidden="true" /> Test jobs run on fenvix machines in your organization's region, with the secrets your workflow already passes to them.
          </li>
        </ul>
      </Card>
    </>
  );
}
