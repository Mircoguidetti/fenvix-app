import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { client, type GitHubRepository, type OnboardingKind } from "../data";
import { isSetupMerged } from "../data/ci-rows";
import { Segmented } from "../components/Segmented";
import { Message, PageHeader } from "../components/PageHeader";
import { OnboardingPill } from "../components/StateBadge";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useOrg } from "../session/OrgProvider";
import { useSettingUp } from "../components/Shell";
import { SetupDiff, Step, runnerText } from "./Connect";
import { CAN_OPEN, PR_OPEN } from "../lib/setup";

const POLLS = 6;
const POLL_MS = 1500;
/** While the pull request waits for its merge (or the project for its first run), the state is read again this often. */
const LIVE_MS = 5000;
/** Live reads that may fail in a row before the page says the state shown may be old. */
const LIVE_FAILS = 3;

/** What to do when the App found nothing it can move to fenvix. */
const WHAT_TO_DO: Partial<Record<GitHubRepository["onboardingState"], string>> = {
  no_workflow: "Add a workflow under .github/workflows that runs your tests, push it to the default branch, then check again.",
  no_test_job: "Add a job that runs your tests (pytest, vitest, jest, node:test or go test) to a workflow on the default branch, then check again.",
  unsupported: "fenvix runs pytest, vitest, jest, node:test and go test today. This repository can be set up once its test runner is supported.",
};

/**
 * Setting up one repository (founder, 28 Nov: "if I connect a repo it must have its own project with the steps"). A
 * project exists only once the language and test runner are detected and the setup pull request is merged
 * (ci_projects needs both), so until then this page is the repository's place: how fenvix runs it, the setup pull
 * request, its merge, and the first run. A repository that already has its project goes straight to it.
 */
export function ConnectSetupPage() {
  // Keyed by the repository: going from one setup page to another starts fresh (its first look included).
  const { repositoryId } = useParams();
  return <SetupPage key={repositoryId} id={Number(repositoryId)} />;
}

function SetupPage({ id }: { id: number }) {
  const org = useOrg();
  const toast = useToast();
  const repos = useAsync(() => client.listGitHubRepositories(), []);
  const connection = useAsync(() => client.getGitHubConnection(), []);
  const kindState = useAsync(() => client.getOnboardingKind(), []);
  const [kind, setKind] = useState<OnboardingKind | null>(null);
  const [savingKind, setSavingKind] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [tick, setTick] = useState(0);
  // Set before the request, so a second click cannot send a second one.
  const [opening, setOpening] = useState(false);
  // The App did not open it within the polling budget: said, with Check again.
  const [slow, setSlow] = useState(false);
  // Live reads that failed in a row: after LIVE_FAILS the page says the state shown may be old.
  const [liveFails, setLiveFails] = useState(0);
  const polls = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  // The redirect to the project happens only for a repository that had its project when the page opened; one that
  // gets it while the page is open shows "Open project" instead of moving the person away.
  const firstLook = useRef<GitHubRepository | null | undefined>(undefined);

  const listed = repos.status === "ready" ? repos.data : null;
  const list = listed ?? [];
  // The sidebar's "Setting up" follows the list read here (opened, merged, first run).
  const { update: updateSettingUp } = useSettingUp();
  useEffect(() => {
    if (listed) updateSettingUp(listed);
  }, [listed, updateSettingUp]);
  const reading = useRef(false);
  const repo = list.find((r) => r.repositoryId === id && !r.removed) ?? null;
  if (repos.status === "ready" && firstLook.current === undefined) firstLook.current = repo;
  const installation = connection.status === "ready" ? connection.data.installations.find((i) => i.installationId === repo?.installationId) : undefined;
  const active = installation?.status === "active";
  const state = repo?.onboardingState;
  const prOpen = !!state && PR_OPEN.has(state);
  const merged = !!state && isSetupMerged(state);

  async function read() {
    reading.current = true;
    try {
      const now = await client.listGitHubRepositories();
      repos.setData(now);
      return now;
    } finally {
      reading.current = false;
    }
  }

  // After "Open setup pull request": ask a few times until the App has opened it; one toast then.
  useEffect(() => {
    if (!queued) return;
    if (polls.current >= POLLS) {
      setQueued(false);
      setSlow(true);
      return;
    }
    const t = window.setTimeout(async () => {
      polls.current++;
      try {
        const now = (await read()).find((r) => r.repositoryId === id);
        if (!mounted.current) return;
        if (now && !CAN_OPEN.has(now.onboardingState)) {
          setQueued(false);
          // Opened: one success toast. The App could not open it (no workflow, unsupported…): its reason, as an error.
          if (PR_OPEN.has(now.onboardingState) && now.setupPullRequest) toast(`Opened pull request #${now.setupPullRequest.number} on ${now.fullName}`, "success");
          else toast(`Could not open a pull request on ${now.fullName}: ${now.onboardingDetail}`, "error");
        } else setTick((n) => n + 1);
      } catch {
        if (!mounted.current) return;
        setQueued(false);
        setSlow(true);
      }
    }, POLL_MS);
    return () => window.clearTimeout(t);
  }, [queued, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live state: while the pull request waits for its merge, or the project for its first run. Not while the pull
  // request is being opened (that has its own polling), not while the tab is hidden (read once when it is shown
  // again), and never two reads at once.
  useEffect(() => {
    if (queued || !(prOpen || (merged && !repo?.projectId))) return;
    const tick = () => {
      if (document.visibilityState !== "visible" || reading.current) return;
      read().then(
        () => mounted.current && setLiveFails(0),
        () => mounted.current && setLiveFails((n) => n + 1),
      );
    };
    const t = window.setInterval(tick, LIVE_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [queued, prOpen, merged, repo?.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function open() {
    if (!repo || opening) return;
    setOpening(true);
    setError(null);
    setSlow(false);
    try {
      const now = await client.openSetupPullRequest(repo.repositoryId);
      if (!mounted.current) return;
      // The list as it is now (a live read may have landed meanwhile), with this repository's answer.
      const current = repos.status === "ready" ? repos.data : list;
      repos.setData(current.map((r) => (r.repositoryId === now.repositoryId ? now : r)));
      polls.current = 0;
      setQueued(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the pull request. Try again.");
    } finally {
      if (mounted.current) setOpening(false);
    }
  }

  async function checkAgain() {
    setChecking(true);
    setSlow(false);
    try {
      await read();
      setLiveFails(0);
    } catch {
      /* the state on show stays */
    } finally {
      setChecking(false);
    }
  }

  const back = (
    <Link to="/projects/connect" className="page-kicker row-link">
      Connect a project
    </Link>
  );
  if (repos.status === "loading") return <Message>Loading the repository</Message>;
  if (repos.status === "error") return <Message role="alert">{repos.message}</Message>;
  if (firstLook.current?.projectId && !firstLook.current.excludedAt && isSetupMerged(firstLook.current.onboardingState)) return <Navigate to={`/projects/${firstLook.current.projectId}`} replace />;
  if (!repo)
    return (
      <>
        <PageHeader back={back} title="Repository not found" />
        <div className="empty">
          <p className="muted">This repository is not in your organization's GitHub installations. Choose it for the fenvix GitHub App on GitHub, then pick it from Connect a project.</p>
          <Link to="/projects/connect" className="btn btn-primary">
            Back to Connect a project
          </Link>
        </div>
      </>
    );

  const canOpen = CAN_OPEN.has(repo.onboardingState);
  const detected = canOpen || prOpen || merged;
  const pr = repo.setupPullRequest;
  return (
    <>
      <PageHeader back={back} title={<span className="mono break-anywhere">{repo.fullName}</span>} docTitle={repo.fullName} description={`${repo.private ? "Private" : "Public"} · ${runnerText(repo)}. Nothing changes in the repository until you merge the pull request fenvix opens.`} meta={<OnboardingPill state={repo.onboardingState} />} />
      {!org.canManage && <Message tone="warning">Only an owner or admin can set up repositories.</Message>}
      {repo.excludedAt ? (
        <div className="card">
          <p>This repository was removed from fenvix. Add it again from the Removed list of Connect a project.</p>
          <Link to="/projects/connect" className="btn">
            Connect a project
          </Link>
        </div>
      ) : (
        <>
        {liveFails >= LIVE_FAILS && (
          <div className="install-error">
            <Message role="alert">{`The state shown may be old: fenvix could not read it the last ${liveFails} times.`}</Message>
            <button type="button" className="btn btn-sm" onClick={() => void checkAgain()} disabled={checking}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </div>
        )}
        <ol className="steps setup-steps">
          <Step n={1} done={!!pr || merged} title="How fenvix runs it">
            {kindState.status === "ready" && kindState.data.sideBySideAvailable ? (
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
              </div>
            ) : null}
            <p className="muted small">
              {shownKind === "side_by_side"
                ? "The pull request adds one new workflow file that runs a copy of your test job on fenvix. Your workflow is not changed and decides green or red alone; fenvix shows both side by side."
                : "The pull request changes one line in your test job: runs-on: fenvix."}{" "}
              {pr || merged ? "This repository's pull request keeps the way it was opened; the choice applies to your organization's next setup pull requests." : "This choice applies to your organization: every new setup pull request uses it."}
            </p>
            {kindState.status === "error" && <Message role="alert">{`Could not read how fenvix runs your tests: ${kindState.message} Reload the page before opening the pull request.`}</Message>}
          </Step>
          <Step n={2} done={!!pr || merged} title="Open the setup pull request">
            {!detected ? (
              <>
                <p className="small">{repo.onboardingDetail}</p>
                {WHAT_TO_DO[repo.onboardingState] && <p className="muted small">{WHAT_TO_DO[repo.onboardingState]}</p>}
                <div className="row-actions">
                  <button type="button" className="btn" onClick={() => void checkAgain()} disabled={checking}>
                    {checking ? "Checking…" : "Check again"}
                  </button>
                </div>
              </>
            ) : canOpen ? (
              <>
                {repo.onboardingState !== "pending" && <p className="small">{repo.onboardingDetail}</p>}
                {repo.workflowPath && repo.job && (shownKind === "side_by_side" ? (
                  <p className="small muted">
                    It adds <span className="mono">.github/workflows/fenvix-side-by-side.yml</span>, a copy of job <strong>{repo.job}</strong> on fenvix; <span className="mono">{repo.workflowPath}</span> stays as it is.
                  </p>
                ) : (
                  <SetupDiff change={{ path: repo.workflowPath, job: repo.job, before: "runs-on: ubuntu-latest", after: "runs-on: fenvix" }} />
                ))}
                <div className="row-actions">
                  <button type="button" className="btn btn-primary" onClick={() => void open()} disabled={opening || queued || !active || !org.canManage || kindState.status !== "ready"}>
                    {repo.onboardingState === "pending" ? "Open setup pull request" : "Open setup pull request again"}
                  </button>
                  <span className="muted small" role="status">
                    {queued || opening
                      ? "Queued: the fenvix GitHub App is opening it."
                      : slow
                        ? "The fenvix GitHub App has not opened it yet. Check again in a minute."
                        : !active
                          ? "The installation must be active first."
                          : "fenvix opens it; you review and merge it."}
                  </span>
                  {slow && (
                    <button type="button" className="btn btn-sm" onClick={() => void checkAgain()} disabled={checking}>
                      {checking ? "Checking…" : "Check again"}
                    </button>
                  )}
                </div>
                {error && <Message role="alert">{error}</Message>}
              </>
            ) : (
              <p className="muted small">{pr ? `Opened: pull request #${pr.number}.` : repo.onboardingDetail}</p>
            )}
          </Step>
          <Step n={3} done={merged} title="Merge it on GitHub">
            {prOpen ? (
              <>
                <div className="row-actions">
                  {pr && (
                    <a href={pr.url} target="_blank" rel="noreferrer" className="btn btn-primary" aria-label={`Merge it on GitHub: pull request #${pr.number}`}>
                      Merge it on GitHub
                      <ExternalLink size={14} aria-hidden="true" />
                    </a>
                  )}
                  <span className="muted small" role="status">
                    {pr ? `Pull request #${pr.number} is open.` : repo.onboardingDetail} fenvix checks it every few seconds.
                  </span>
                </div>
              </>
            ) : merged ? (
              <p className="small">
                {repo.onboardingState === "already_fenvix" ? repo.onboardingDetail : pr ? `Pull request #${pr.number} is merged.` : "Merged."}
                {pr && (
                  <>
                    {" "}
                    <a href={pr.url} target="_blank" rel="noreferrer" className="row-link">
                      See it on GitHub
                    </a>
                  </>
                )}
              </p>
            ) : (
              <p className="muted small">Once the pull request is open, merge it on GitHub. Nothing runs on fenvix before that.</p>
            )}
          </Step>
          <Step n={4} done={!!repo.projectId} title="First run">
            {repo.projectId ? (
              <div className="row-actions">
                <Link to={`/projects/${repo.projectId}`} className="btn btn-primary">
                  Open project
                </Link>
                <span className="muted small">Its runs, defects and minutes saved are in the project.</span>
              </div>
            ) : merged ? (
              <p className="small" role="status">
                Waiting for the first test run on fenvix: push a commit or open a pull request. fenvix also runs the test job once on the default branch, at no charge, so the cache is warm.
              </p>
            ) : (
              <p className="muted small">After the merge, the next test run goes to fenvix and the repository becomes a project.</p>
            )}
          </Step>
        </ol>
        </>
      )}
    </>
  );
}
