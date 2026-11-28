import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, CircleCheck, ExternalLink, Lock, TriangleAlert } from "lucide-react";
import { client, type GitHubRepository, type Installation, type OnboardingKind, type SetupChange } from "../data";
import { Segmented } from "../components/Segmented";
import { Message, PageHeader, Kicker } from "../components/PageHeader";
import { OnboardingPill, StatusPill } from "../components/StateBadge";
import { useToast } from "../components/Toast";
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
        <h3 className="step-title">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h3>
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

/**
 * Repositories already on fenvix or with their setup pull request open: not offered in "Pick a repository to connect".
 * The connected ones live in /projects; the open pull requests are under "Waiting for your merge" (founder, 28 Nov:
 * the page is built around connecting a new project).
 */
const CONNECTED_OR_OPEN = new Set(["pr_open", "side_by_side_pr_open", "merged", "already_fenvix", "side_by_side"]);
const isConnectedOrOpen = (r: GitHubRepository) => CONNECTED_OR_OPEN.has(r.onboardingState) || !!r.projectId;
const PR_OPEN = new Set(["pr_open", "side_by_side_pr_open"]);

/** States from which the App can open (or open again) the setup pull request. */
const CAN_OPEN = new Set(["pending", "closed", "failed"]);
const POLLS = 6;
const POLL_MS = 1500;

function runnerText(r: GitHubRepository): string {
  if (!r.language && !r.testRunner) return "Language and test runner not detected";
  return `${r.language ? languageLabel(r.language) : "Language not detected"} · ${r.testRunner ?? "test runner not detected"}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * A repository its organization removed from fenvix (Remove project): no project, no runs, no setup pull request until
 * an owner or admin adds it again (POST /github/repositories/{id}/restore; the App creates its project again).
 */
function RemovedRepoRow({ repo, installation, restoring, onRestore }: { repo: GitHubRepository; installation: Installation | undefined; restoring: boolean; onRestore: (r: GitHubRepository) => void }) {
  const org = useOrg();
  const active = installation?.status === "active";
  return (
    <li className="setup-row repo-row" data-state="excluded">
      <div className="setup-row-head">
        <span className="name-cell">
          <span className="mono break-anywhere repo-name">{repo.fullName}</span>
          <span className="muted small">
            {repo.private ? "Private" : "Public"} · {runnerText(repo)}
          </span>
        </span>
        <StatusPill tone="neutral">Removed from fenvix</StatusPill>
      </div>
      <p className="small repo-detail">Its project was removed{repo.excludedAt ? ` on ${formatDate(repo.excludedAt)}` : ""}. fenvix runs none of its jobs until it is added again.</p>
      <div className="row-actions">
        <button type="button" className="btn" onClick={() => onRestore(repo)} disabled={restoring || !active || !org.canManage} aria-label={`Add ${repo.fullName} again`}>
          Add again
        </button>
        <span className="muted small" role="status">
          {restoring ? "Adding it again" : !org.canManage ? "Only an owner or admin can add it again." : !active ? "The installation must be active first." : "Its project comes back; its earlier runs do not."}
        </span>
      </div>
    </li>
  );
}

/**
 * One repository fenvix can see and that is not connected yet: its name, language and test runner, a state pill when
 * it is not ready, and "Connect" (the App opens the setup pull request). What the pull request changes is one click away.
 */
function PickRow({ repo, installation, queued, onOpen, kind }: { repo: GitHubRepository; installation: Installation | undefined; queued: boolean; onOpen: (r: GitHubRepository) => void; kind: OnboardingKind }) {
  const org = useOrg();
  const active = installation?.status === "active";
  const canOpen = CAN_OPEN.has(repo.onboardingState);
  const ready = repo.onboardingState === "pending";
  const why = queued
    ? "Queued: the fenvix GitHub App is opening the pull request."
    : !active
      ? "The installation must be active first."
      : !canOpen
        ? repo.onboardingDetail
        : !org.canManage
          ? "Only an owner or admin can connect it."
          : ready
            ? null
            : repo.onboardingDetail;
  return (
    <li className="pick-row repo-row" data-state={repo.onboardingState}>
      <div className="pick-main">
        <span className="name-cell">
          <span className="mono break-anywhere repo-name">{repo.fullName}</span>
          <span className="muted small">
            {repo.private ? "Private" : "Public"} · {runnerText(repo)}
          </span>
        </span>
        <span className="pick-end">
          {!ready && !queued && <OnboardingPill state={repo.onboardingState} />}
          <button type="button" className="btn btn-primary" onClick={() => onOpen(repo)} disabled={queued || !canOpen || !active || !org.canManage} aria-label={`Connect ${repo.fullName}`}>
            {queued ? "Connecting…" : "Connect"}
          </button>
        </span>
      </div>
      {why && (
        <p className="small muted repo-detail" role="status">
          {why}
        </p>
      )}
      {canOpen && repo.workflowPath && repo.job && (
        <details className="pick-change">
          <summary className="small">What the pull request changes</summary>
          {kind === "side_by_side" ? (
            <p className="small muted">
              It adds <span className="mono">.github/workflows/fenvix-side-by-side.yml</span>, a copy of job <strong>{repo.job}</strong> on fenvix; <span className="mono">{repo.workflowPath}</span> stays as it is.
            </p>
          ) : (
            <SetupDiff change={{ path: repo.workflowPath, job: repo.job, before: "runs-on: ubuntu-latest", after: "runs-on: fenvix" }} />
          )}
        </details>
      )}
    </li>
  );
}

/** One compact line per GitHub installation: the account, how many repositories, Choose more, and its state if not active. */
function GitHubLine({ installation, highlight, onChoose, last, onAdd, addDisabled }: { installation: Installation; highlight: boolean; onChoose: () => void; last: boolean; onAdd: () => void; addDisabled: boolean }) {
  const i = installation;
  return (
    <li className="gh-line" data-status={i.status} data-highlight={highlight || undefined}>
      <span>
        GitHub: <span className="mono break-anywhere gh-account">{i.account}</span> · {plural(i.repositories, "repository", "repositories")}
      </span>
      {highlight && <span className="tag">Just linked</span>}
      {i.status === "suspended" && (
        <span className="gh-warn">
          <TriangleAlert size={14} aria-hidden="true" /> Suspended on GitHub: unsuspend the app there to connect its repositories.
        </span>
      )}
      {i.status === "deleted" && (
        <span className="gh-warn">
          <TriangleAlert size={14} aria-hidden="true" /> Uninstalled from GitHub: install the app again to see its repositories.
        </span>
      )}
      {i.status !== "deleted" && (
        <>
          <span className="gh-sep" aria-hidden="true">·</span>
          <a href={installationConfigureUrl(i)} target="_blank" rel="noreferrer" className="row-link" onClick={onChoose} aria-label={`Choose more repositories for ${i.account} on GitHub`}>
            Choose more
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </>
      )}
      {last && (
        <>
          <span className="gh-sep" aria-hidden="true">·</span>
          <button type="button" className="btn-link" onClick={onAdd} disabled={addDisabled}>
            Add another account
          </button>
        </>
      )}
    </li>
  );
}

function WhatAccess() {
  return (
    <details className="card connect-what" id="what">
      <summary>What fenvix does with access</summary>
      <ul className="plain-list">
        <li>
          <Lock size={14} aria-hidden="true" /> Reads code, workflow files and pull requests of the repositories you choose.
        </li>
        <li>
          <Lock size={14} aria-hidden="true" /> Writes check results and one comment per pull request, and opens the setup pull request. It never pushes to a branch.
        </li>
        <li>
          <Lock size={14} aria-hidden="true" /> Test jobs run on fenvix machines in your organization's region, with the secrets your workflow already passes to them.
        </li>
      </ul>
    </details>
  );
}

/**
 * Connect a new project with the fenvix GitHub App. With no installation yet, one card: install the App on a GitHub
 * account (the API makes the link; GitHub sends the browser back here with ?github=…). With an installation, the page
 * is the list of repositories fenvix can see and that are not connected yet, each with "Connect" (the App opens the
 * setup pull request); then one line per installation, the pull requests waiting for a merge, and the removed
 * repositories. Connected repositories are in /projects, not here.
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
  const [restoring, setRestoring] = useState<Set<number>>(new Set());
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
        const done = new Set([...queued].filter((id) => !CAN_OPEN.has(list.find((r) => r.repositoryId === id)?.onboardingState ?? "")));
        for (const id of done) {
          const r = list.find((x) => x.repositoryId === id);
          if (r) toast(r.setupPullRequest ? `Opened pull request #${r.setupPullRequest.number} on ${r.fullName}` : `${r.fullName}: ${r.onboardingDetail}`, "success");
        }
        // Functional update: a Connect clicked while this request was in flight stays queued.
        setQueued((q) => new Set([...q].filter((id) => !done.has(id))));
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

  // Back from GitHub's own settings of an installation ("Choose more" in this tab): read the list again,
  // quietly (no toast: fenvix created or changed nothing), and take the flag out of the address.
  useEffect(() => {
    if (github !== "updated") return;
    void refresh();
    navigate("/projects/connect", { replace: true });
  }, [github]); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** Add again: the repository as the API answers it now (not excluded); the project shows up once the App made it. */
  async function restore(repo: GitHubRepository) {
    setError(null);
    setRestoring((q) => new Set([...q, repo.repositoryId]));
    try {
      const now = await client.restoreRepository(repo.repositoryId);
      repos.setData((repos.status === "ready" ? repos.data : []).map((r) => (r.repositoryId === now.repositoryId ? now : r)));
      toast(`Added ${repo.fullName} again`, "success");
      // The App's worker makes its project after this answer: read the list again shortly.
      setTimeout(() => void client.listGitHubRepositories().then((list) => repos.setData(list), () => undefined), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the repository again. Try again.");
    } finally {
      setRestoring((q) => new Set([...q].filter((id) => id !== repo.repositoryId)));
    }
  }

  /** Connect: the App opens the setup pull request; the list is asked again until it has (one toast then). */
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
  const seen = installations.filter((i) => i.status !== "deleted");
  const list = repos.status === "ready" ? repos.data : [];
  const instOf = (r: GitHubRepository) => installations.find((i) => i.installationId === r.installationId);
  // Repositories fenvix still sees: given to the App, on an installation that is not uninstalled.
  const live = list.filter((r) => !r.removed && !!instOf(r) && instOf(r)!.status !== "deleted");
  // Still to connect (and those whose pull request is being opened right now); removed ones have their own list.
  const toPick = live.filter((r) => !r.excludedAt && (queued.has(r.repositoryId) || !isConnectedOrOpen(r)));
  const waiting = live.filter((r) => !r.excludedAt && !queued.has(r.repositoryId) && PR_OPEN.has(r.onboardingState));
  const removed = live.filter((r) => !!r.excludedAt);
  const connectedCount = live.filter((r) => !r.excludedAt && isConnectedOrOpen(r) && !PR_OPEN.has(r.onboardingState)).length;
  // Where "Choose more repositories on GitHub" goes when nothing is left to pick: an active installation, else any still installed.
  const chooseMoreOn = seen.find((i) => i.status === "active") ?? seen[0];
  const noneYet = live.filter((r) => !r.excludedAt).length === 0;
  const highlighted = github === "connected" ? Number(params.get("installation")) : null;
  const reason = params.get("reason") ?? "error";
  const dismiss = () => navigate("/projects/connect", { replace: true });
  const ready = connection.status === "ready";
  const firstTime = ready && seen.length === 0;

  return (
    <>
      <PageHeader
        back={<Kicker>Projects</Kicker>}
        title="Connect a project"
        description={firstTime ? "Install the fenvix GitHub App, then pick a repository: fenvix opens one pull request on it. Nothing changes in a repository until you merge that pull request." : "Pick a repository and fenvix opens one pull request on it. Nothing changes in the repository until you merge that pull request."}
      />
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
              <strong>The fenvix GitHub App is installed on {params.get("account") ?? "your GitHub account"}.</strong> Its repositories are listed below: press Connect on each one you want on fenvix.
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

      {connection.status === "loading" && <Message>Loading installations</Message>}
      {connection.status === "error" && <Message role="alert">{connection.message}</Message>}

      {firstTime && (
        <section className="card connect-install" aria-labelledby="install-h">
          <div className="card-head">
            <div className="card-head-main">
              <h2 id="install-h">Install the fenvix GitHub App</h2>
              <p className="muted card-desc">It sees only the repositories you choose on GitHub: their code, workflow files and pull requests. It never pushes to a branch.</p>
            </div>
          </div>
          <ol className="steps steps-compact">
            <Step n={1} done={false} title="Install the GitHub App">
              <div className="row-actions">
                <button type="button" className="btn btn-primary" onClick={install} disabled={installing || completing || !org.canManage}>
                  Install the GitHub App
                </button>
                <span className="muted small">GitHub asks which repositories fenvix may see, then sends you back here.</span>
              </div>
            </Step>
            <Step n={2} done={false} title="Pick a repository">
              <p className="muted small">Press Connect on it: fenvix opens one setup pull request on it.</p>
            </Step>
            <Step n={3} done={false} title="Merge the pull request">
              <p className="muted small">The next test run goes to fenvix and the repository becomes a project.</p>
            </Step>
          </ol>
          {installations.length > 0 && (
            <ul className="gh-lines" aria-label="Your GitHub installations">
              {installations.map((i) => (
                <GitHubLine key={i.installationId} installation={i} highlight={false} onChoose={() => setChose(true)} last={false} onAdd={install} addDisabled />
              ))}
            </ul>
          )}
        </section>
      )}

      {ready && !firstTime && (
        <>
          <section className="card connect-pick" aria-labelledby="pick-h">
            <div className="card-head">
              <div className="card-head-main">
                <h2 id="pick-h">Pick a repository to connect</h2>
                <p className="muted card-desc">fenvix opens one pull request on it; you review and merge it on GitHub.</p>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh repositories"}
              </button>
            </div>
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
            {repos.status === "loading" && <Message>Loading repositories</Message>}
            {repos.status === "error" && <Message role="alert">{repos.message}</Message>}
            {repos.status === "ready" && toPick.length > 0 && (
              <ul className="pick-list" aria-label="Repositories to connect">
                {toPick.map((r) => (
                  <PickRow key={r.repositoryId} repo={r} installation={instOf(r)} queued={queued.has(r.repositoryId)} onOpen={open} kind={shownKind} />
                ))}
              </ul>
            )}
            {repos.status === "ready" && toPick.length === 0 && (
              <div className="pick-empty">
                <p>{noneYet ? "No repository yet: choose the repositories fenvix may see on GitHub." : "All the repositories fenvix can see are connected."}</p>
                {chooseMoreOn && (
                  <a href={installationConfigureUrl(chooseMoreOn)} target="_blank" rel="noreferrer" className="btn" onClick={() => setChose(true)}>
                    Choose more repositories on GitHub
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                )}
              </div>
            )}
            {error && <Message role="alert">{error}</Message>}
          </section>

          <ul className="gh-lines" aria-label="Your GitHub installations">
            {installations.map((i, n) => (
              <GitHubLine key={i.installationId} installation={i} highlight={i.installationId === highlighted} onChoose={() => setChose(true)} last={n === installations.length - 1} onAdd={install} addDisabled={installing || !org.canManage} />
            ))}
          </ul>

          {waiting.length > 0 && (
            <section className="card connect-waiting" aria-labelledby="waiting-h">
              <h2 id="waiting-h">Waiting for your merge</h2>
              <ul className="waiting-list">
                {waiting.map((r) => (
                  <li key={r.repositoryId} className="waiting-row repo-row" data-state={r.onboardingState}>
                    <span className="mono break-anywhere repo-name">{r.fullName}</span>
                    {r.setupPullRequest ? (
                      <>
                        <a href={r.setupPullRequest.url} target="_blank" rel="noreferrer" className="row-link">
                          Setup pull request #{r.setupPullRequest.number}
                          <ExternalLink size={13} aria-hidden="true" />
                        </a>
                        <a href={r.setupPullRequest.url} target="_blank" rel="noreferrer" className="btn btn-sm" aria-label={`Merge it on GitHub: ${r.fullName} pull request #${r.setupPullRequest.number}`}>
                          Merge it on GitHub
                        </a>
                      </>
                    ) : (
                      <span className="muted small">{r.onboardingDetail}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {removed.length > 0 && (
            <details className="card connect-removed">
              <summary>
                <span>Removed</span>
                <span className="tag">{removed.length}</span>
              </summary>
              <ul className="setup-list">
                {removed.map((r) => (
                  <RemovedRepoRow key={r.repositoryId} repo={r} installation={instOf(r)} restoring={restoring.has(r.repositoryId)} onRestore={restore} />
                ))}
              </ul>
            </details>
          )}

          <p className="connect-projects muted">
            {connectedCount > 0 ? `${plural(connectedCount, "repository is", "repositories are")} already connected. ` : ""}
            <Link to="/projects" className="row-link">
              See your projects
            </Link>
          </p>
        </>
      )}
      {firstTime && error && <Message role="alert">{error}</Message>}

      <WhatAccess />
    </>
  );
}
