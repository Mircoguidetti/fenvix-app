import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, ChevronRight, CircleCheck, ExternalLink, Lock, TriangleAlert } from "lucide-react";
import { client, type GitHubRepository, type Installation, type SetupChange } from "../data";
import { Message, PageHeader, Kicker } from "../components/PageHeader";
import { OnboardingPill, StatusPill } from "../components/StateBadge";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useOrg } from "../session/OrgProvider";
import { activeOrgId, setActiveOrgId } from "../lib/org";
import { formatDate } from "../lib/format";
import { languageLabel } from "./Projects";
import { isSetupMerged } from "../data/ci-rows";
import { installationConfigureUrl } from "../lib/github";

/** One numbered step. `heading` is its level in the page outline (h3 inside a card, h2 directly under the page title). */
export function Step({ n, done, title, heading = "h3", children }: { n: number; done: boolean; title: string; heading?: "h2" | "h3"; children?: ReactNode }) {
  const H = heading;
  return (
    <li className="step" data-done={done || undefined}>
      <span className="step-n" aria-hidden="true">
        {done ? <Check size={14} strokeWidth={2.5} /> : n}
      </span>
      <div className="step-body">
        <H className="step-title">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </H>
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
 * The connected ones live in /projects; those with a pull request open are "Setting up" (Projects and the sidebar),
 * each with its own setup page (founder, 28 Nov).
 */
const CONNECTED_OR_OPEN = new Set(["pr_open", "side_by_side_pr_open", "merged", "already_fenvix", "side_by_side"]);
export const isConnectedOrOpen = (r: GitHubRepository) => CONNECTED_OR_OPEN.has(r.onboardingState) || !!r.projectId;
export const PR_OPEN = new Set(["pr_open", "side_by_side_pr_open"]);
/** States from which the App can open (or open again) the setup pull request. */
export const CAN_OPEN = new Set(["pending", "closed", "failed"]);

/** In setup: its setup pull request is open, or merged with its project not made yet. Linked to its setup page. */
export const isSettingUp = (r: GitHubRepository) => !r.removed && !r.excludedAt && !r.projectId && (PR_OPEN.has(r.onboardingState) || isSetupMerged(r.onboardingState));
export const setupPath = (r: { repositoryId: number }) => `/projects/connect/${r.repositoryId}`;

export function runnerText(r: GitHubRepository): string {
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
 * One repository fenvix can see and that is not on fenvix yet: its name, language and test runner, a state pill when
 * it is not ready, and "Set up", which opens its own setup page.
 */
function PickRow({ repo, installation }: { repo: GitHubRepository; installation: Installation | undefined }) {
  const ready = repo.onboardingState === "pending";
  const note = installation?.status !== "active" ? "The installation must be active first." : ready ? null : repo.onboardingDetail;
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
          {!ready && <OnboardingPill state={repo.onboardingState} />}
          <Link to={setupPath(repo)} className="btn btn-primary" aria-label={`Set up ${repo.fullName}`}>
            Set up
            <ChevronRight size={15} aria-hidden="true" />
          </Link>
        </span>
      </div>
      {note && <p className="small muted repo-detail">{note}</p>}
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

export function WhatAccess() {
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
 * account (the API makes the link; GitHub sends the browser back here with ?github=…). With an installation: the
 * repositories fenvix can see and that are not on fenvix yet, each with "Set up" (its own page, ConnectSetupPage, with
 * the steps for that repository); one line per installation; the removed repositories. No numbered steps, no global
 * list of setup pull requests (founder, 28 Nov).
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
  const repos = useAsync(() => client.listGitHubRepositories(), []);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Set<number>>(new Set());
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

  const installations = connection.status === "ready" ? connection.data.installations : [];
  const seen = installations.filter((i) => i.status !== "deleted");
  const list = repos.status === "ready" ? repos.data : [];
  const instOf = (r: GitHubRepository) => installations.find((i) => i.installationId === r.installationId);
  // Repositories fenvix still sees: given to the App, on an installation that is not uninstalled.
  const live = list.filter((r) => !r.removed && !!instOf(r) && instOf(r)!.status !== "deleted");
  // Not on fenvix yet, no setup pull request open, not removed (removed ones have their own list).
  const toPick = live.filter((r) => !r.excludedAt && !isConnectedOrOpen(r));
  const removed = live.filter((r) => !!r.excludedAt);
  const settingUp = live.filter(isSettingUp).length;
  const connectedCount = live.filter((r) => !r.excludedAt && isConnectedOrOpen(r) && !isSettingUp(r)).length;
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
        description={firstTime ? "Install the fenvix GitHub App, then set up a repository: fenvix opens one pull request on it. Nothing changes in a repository until you merge that pull request." : "Pick a repository to set up on fenvix. Nothing changes in it until you merge the pull request fenvix opens."}
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
              <strong>The fenvix GitHub App is installed on {params.get("account") ?? "your GitHub account"}.</strong> Its repositories are listed below: press Set up on each one you want on fenvix.
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
          <div className="row-actions">
            <button type="button" className="btn btn-primary" onClick={install} disabled={installing || completing || !org.canManage}>
              Install the GitHub App
            </button>
            <span className="muted small">GitHub asks which repositories fenvix may see, then sends you back here to set one up.</span>
          </div>
          {installations.length > 0 && (
            <ul className="gh-lines" aria-label="Your GitHub installations">
              {installations.map((i) => (
                <GitHubLine key={i.installationId} installation={i} highlight={false} onChoose={() => setChose(true)} last={false} onAdd={install} addDisabled />
              ))}
            </ul>
          )}
          {error && <Message role="alert">{error}</Message>}
        </section>
      )}

      {ready && !firstTime && (
        <>
          <section className="card connect-pick" aria-labelledby="pick-h">
            <div className="card-head">
              <div className="card-head-main">
                <h2 id="pick-h">Pick a repository to connect</h2>
                <p className="muted card-desc">Set up opens its own page with the steps for that repository.</p>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? "Refreshing…" : "Refresh repositories"}
              </button>
            </div>
            {repos.status === "loading" && <Message>Loading repositories</Message>}
            {repos.status === "error" && <Message role="alert">{repos.message}</Message>}
            {repos.status === "ready" && toPick.length > 0 && (
              <ul className="pick-list" aria-label="Repositories to connect">
                {toPick.map((r) => (
                  <PickRow key={r.repositoryId} repo={r} installation={instOf(r)} />
                ))}
              </ul>
            )}
            {repos.status === "ready" && toPick.length === 0 && (
              <div className="pick-empty">
                <p>{noneYet ? "No repository yet: choose the repositories fenvix may see on GitHub." : "All the repositories fenvix can see are connected or being set up."}</p>
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
            {connectedCount > 0 ? `${plural(connectedCount, "repository is", "repositories are")} on fenvix` : "Nothing is on fenvix yet"}
            {settingUp > 0 ? `, ${plural(settingUp, "is", "are")} being set up. ` : ". "}
            <Link to="/projects" className="row-link">
              See your projects
            </Link>
          </p>
        </>
      )}

      <WhatAccess />
    </>
  );
}
