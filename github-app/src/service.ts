import type { Client, Db } from "./db.ts";
import { GitHubError, type GitHubApp, type GitHubHttp, repoPath } from "./github/client.ts";
import { onboardRepository, type OnboardingResult } from "./onboarding/onboard.ts";
import { COMMENT_MARKER, checkName, checkRunOutput, conclusionOf, type RenderContext } from "./results/render.ts";
import { combinedComment, type DefectView, type JobView } from "./results/comment.ts";
import { pullCommand, replayCommand } from "./api/shared.js";
import { parseSummary, type RunSummary } from "./results/summary.ts";
import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { applyChunks, applyExploration, type JobKey, recordReportedFlaky } from "./results/apply.ts";
import { projectStack, type Stack } from "./results/detect.ts";
import { parseResults, progressRecord, type RunnerExploration, type RunnerProgress, type RunnerResults } from "./results/runner-records.ts";
import { signCacheToken, signSummaryCredential } from "./runners/credentials.ts";
import { type Region, RetryLater, type RunMode, type RunnerLauncher } from "./runners/launcher.ts";
import { DEFAULT_WARMUP, type WarmupSettings } from "./warmup/policy.ts";
import { Warmups } from "./warmup/warmups.ts";
import { Tasks } from "./tasks/tasks.ts";

export interface ServiceSettings {
  runsOnLabel: string;
  onboardingBranch: string;
  onboardAllRepositories: boolean;
  dashboardUrl: string;
  webUrl: string;
  summaryWaitSeconds: number;
  /** Signs each per-job machine's summary credential (RUNNER_TOKEN). Required to start machines. */
  summaryKey?: string;
  /** Signs each per-job cache token (the shared cache, per-job mode). Absent: jobs get no cache token. */
  cacheSigningKey?: KeyObject | null;
  /** Warm-up runs (src/warmup/): they need a per-job launcher too. Absent: off. */
  warmup?: WarmupSettings;
  /**
   * SHADOW_MODE: the runner runs the engine in shadow mode for FENVIX_MODE=shadow (every test runs; would-skip numbers
   * reported). Default off, because no runner does yet (G-0187): the trial's runs are then labelled what they are,
   * enforce.
   */
  shadowMode?: boolean;
  /** The API's own address (https://api.fenvix.dev): what task machines are told to call. */
  apiUrl?: string;
}

/**
 * What one job (repository, run, attempt, runner) may stage in gh_run_results (review R-016 F7): 200 chunks (one million
 * tests at 5,000 a chunk) and 256 MB. docs/data-contract.md "Results".
 */
export const RESULTS_JOB_LIMITS = { chunks: 200, bytes: 256 * 1024 * 1024 } as const;
/** Staged results are deleted after this many days (the sweep): far past the credentials' lifetime. */
const RESULTS_KEEP_DAYS = 7;
/** Explorations a project keeps (review R-016b G2): the newest, by when the App received them. */
export const EXPLORATION_KEEP_NIGHTS = 90;

/** How long a per-job machine's credentials live: past the reaper's hard limit and the poster's retries. */
const JOB_CREDENTIAL_SECONDS = 24 * 3600;

export interface Logger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

// ---------------------------------------------------------------- the parts of GitHub's payloads the App reads

interface Account { id: number; login: string; type: string }
interface InstallationP {
  id: number; account: Account | null; repository_selection?: string; permissions?: Record<string, string>; events?: string[];
}
interface RepoLite { id: number; full_name: string; private?: boolean }
interface RepoFull extends RepoLite { default_branch?: string; pushed_at?: number | string | null }
interface PullP { number: number; state: string; merged?: boolean | null; merge_commit_sha?: string | null; merged_at?: string | null; html_url: string; head: { sha: string; ref: string; repo: { id: number } | null }; base: { ref: string } }
interface JobP {
  id: number; run_id: number; run_attempt?: number; workflow_name?: string | null; name: string; head_sha: string; head_branch?: string | null;
  labels: string[]; runner_name?: string | null; status: string; conclusion?: string | null; created_at?: string; started_at?: string | null;
  completed_at?: string | null; html_url?: string | null;
}

interface JobRow {
  job_id: number; repository_id: number; installation_id: number; run_id: number; run_attempt: number; workflow_name: string; job_name: string;
  head_sha: string; head_branch: string | null; labels: string[]; runner_name: string | null; status: string; conclusion: string | null;
  created_at: Date | null; started_at: Date | null; completed_at: Date | null; check_run_id: number | null; ci_run_id: string | null;
  published_at: Date | null; publish_attempts: number; region: Region | null; cache_access: "read" | "write" | null;
  /** The run mode the App chose when the job started (its organization's: shadow during the trial), never the job's. */
  mode: RunMode | null;
  launched_at?: Date | null;
  no_machine?: string | null;
}
/** The workflow run of a job (GET /repos/{o}/{r}/actions/runs/{id}), the parts the App reads. */
interface WorkflowRunP {
  event?: string; created_at?: string; head_commit?: { message?: string } | null;
  pull_requests?: { number: number; head: { ref: string; sha: string }; base: { ref: string } }[];
}
/** What the organization's settings say for a job: where its machine runs, and the trial's mode. */
interface OrgContext { region: Region; mode: RunMode }
/** The values of a run row the job gives; no completion time: the run is still running. */
interface RunValues { startedAt: Date; completedAt: Date | null; durationMs: number; otherStepMinutes: number; mode: RunMode; region: Region | null }
interface RepoRow {
  repository_id: number; installation_id: number; workspace_id: string | null; full_name: string; default_branch: string | null;
  project_id: string | null; onboarding_state: string; setup_pr_number: number | null; setup_pr_url: string | null;
  detected_language: string | null; detected_test_runner: string | null; removed_at?: Date | null; disconnected_at?: Date | null;
}

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");

const STATUS_RANK: Record<string, number> = { queued: 1, waiting: 1, in_progress: 2, completed: 3 };
const TRIGGERS = new Set(["push", "pull_request", "merge_group", "schedule", "workflow_dispatch"]);
const SHA = /^[0-9a-f]{40}$/;
/** gh_repositories.onboarding_detail of a repository the App has not tried to onboard yet (state pending). */
const PENDING_DETAIL = "the setup pull request has not been opened yet";

export type HandleResult = "processed" | "duplicate" | "ignored";

/**
 * Everything the App does in answer to GitHub and to our runners. Webhooks are acknowledged at once and handled in
 * the background (GitHub waits 10 seconds at most); `idle()` waits for that work (tests, shutdown).
 */
export class GitHubService {
  private readonly pending = new Set<Promise<unknown>>();

  private readonly db: Db;
  private readonly gh: GitHubApp;
  private readonly s: ServiceSettings;
  private readonly log: Logger;
  /** "One machine per job" mode: starts a runner machine for each queued fenvix job. Absent: an always-on runner. */
  private readonly launcher: RunnerLauncher | null;

  /** Warm-up runs of onboarded repositories' default branches (src/warmup/warmups.ts). */
  readonly warmups: Warmups;
  /** Replays, explorations and stopping runs on our machines (src/tasks/tasks.ts). */
  readonly tasks: Tasks;

  constructor(db: Db, gh: GitHubApp, s: ServiceSettings, log: Logger, launcher: RunnerLauncher | null = null) {
    this.db = db; this.gh = gh; this.s = s; this.log = log; this.launcher = launcher;
    this.tasks = new Tasks(db, gh, { ...(s.summaryKey ? { summaryKey: s.summaryKey } : {}), apiUrl: s.apiUrl ?? "https://api.fenvix.dev" }, log, launcher);
    this.warmups = new Warmups(db, gh, s.warmup ?? { ...DEFAULT_WARMUP, enabled: false }, { ...(s.summaryKey ? { summaryKey: s.summaryKey } : {}), cacheSigningKey: s.cacheSigningKey ?? null }, log, launcher);
  }

  /** Warm-up requests never fail the webhook that caused them: logged, and the next push asks again. */
  private async warm(what: string, fn: () => Promise<unknown>): Promise<void> {
    if (!this.warmups.active) return;
    try { await fn(); } catch (e) { this.log.warn({ what, err: e instanceof Error ? e.message : String(e) }, "warm-up request failed"); }
  }

  background(what: string, fn: () => Promise<unknown>): void {
    const p = fn().catch((e) => this.log.error({ err: e instanceof Error ? e.message : String(e), what }, "background work failed"));
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ---------------------------------------------------------------- webhooks

  /** Records the delivery (once) and runs its handler. A delivery whose handling failed may come again and is retried. */
  async handle(event: string, deliveryId: string, payload: Record<string, unknown>): Promise<HandleResult> {
    const action = typeof payload.action === "string" ? payload.action : null;
    const installationId = (payload.installation as { id?: number } | undefined)?.id ?? null;
    const fresh = await this.db.q(
      `insert into gh_webhook_deliveries (delivery_id, event, action, installation_id) values ($1, $2, $3, $4)
       on conflict (delivery_id) do update set received_at = now(), error = null where gh_webhook_deliveries.processed_at is null
       returning delivery_id`, [deliveryId, event, action, installationId]);
    if (!fresh.length) return "duplicate";
    const done = (error: string | null) => this.db.q("update gh_webhook_deliveries set processed_at = case when $2::text is null then now() end, error = $2 where delivery_id = $1", [deliveryId, error]);
    try {
      const handled = await this.route(event, payload);
      await done(null);
      return handled ? "processed" : "ignored";
    } catch (e) {
      await done((e instanceof Error ? e.message : String(e)).slice(0, 1000));
      throw e;
    }
  }

  private async route(event: string, p: Record<string, unknown>): Promise<boolean> {
    switch (event) {
      case "installation": await this.onInstallation(p); return true;
      case "installation_repositories": await this.onInstallationRepositories(p); return true;
      case "repository": return this.onRepository(p);
      case "push": return this.onPush(p);
      case "pull_request": await this.onPullRequest(p); return true;
      case "workflow_job": return this.onWorkflowJob(p);
      case "workflow_run": return this.onWorkflowRun(p);
      case "check_run": return this.onCheckRun(p);
      case "check_suite": return this.onCheckSuite(p);
      case "installation_target": return this.onInstallationTarget(p);
      // A person revoked their authorization of the App: the App keeps no person's token (the OAuth token of the setup
      // callback is used once and dropped), so there is nothing to forget. Recorded (G-2300).
      case "github_app_authorization": return true;
      default: return false;
    }
  }

  private async upsertInstallation(i: InstallationP): Promise<void> {
    const type = i.account && ["User", "Organization", "Enterprise"].includes(i.account.type) ? i.account.type : "User";
    await this.db.q(
      `insert into gh_installations (installation_id, account_id, account_login, account_type, repository_selection, permissions, events)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (installation_id) do update set account_id = excluded.account_id, account_login = excluded.account_login,
         account_type = excluded.account_type, repository_selection = excluded.repository_selection, permissions = excluded.permissions,
         events = excluded.events, updated_at = now()`,
      [i.id, i.account?.id ?? 0, i.account?.login ?? "unknown", type, i.repository_selection === "all" ? "all" : "selected", JSON.stringify(i.permissions ?? {}), i.events ?? []]);
  }

  /** Our row of an installation GitHub tells us about only now (e.g. installed before this service stored anything). */
  private async ensureInstallation(installationId: number): Promise<void> {
    const have = await this.db.q("select 1 from gh_installations where installation_id = $1", [installationId]);
    if (have.length) return;
    const r = await this.gh.app.request<InstallationP>("GET", `/app/installations/${installationId}`);
    await this.upsertInstallation(r.data);
  }

  private async upsertRepositories(installationId: number, repos: RepoLite[]): Promise<void> {
    for (const r of repos) {
      await this.db.q(
        `insert into gh_repositories (repository_id, installation_id, full_name, private, onboarding_detail) values ($1, $2, $3, $4, $5)
         on conflict (repository_id) do update set installation_id = excluded.installation_id, full_name = excluded.full_name,
           private = excluded.private, removed_at = null, updated_at = now()`,
        [r.id, installationId, r.full_name, r.private ?? true, PENDING_DETAIL]);
    }
  }

  private async ensureRepository(installationId: number, repo: RepoFull): Promise<void> {
    await this.ensureInstallation(installationId);
    await this.db.q(
      `insert into gh_repositories (repository_id, installation_id, full_name, private, default_branch, onboarding_detail) values ($1, $2, $3, $4, $5, $6)
       on conflict (repository_id) do update set full_name = excluded.full_name,
         default_branch = coalesce(excluded.default_branch, gh_repositories.default_branch), updated_at = now()`,
      [repo.id, installationId, repo.full_name, repo.private ?? true, repo.default_branch ?? null, PENDING_DETAIL]);
  }

  private async onInstallation(p: Record<string, unknown>): Promise<void> {
    const i = p.installation as InstallationP;
    const action = p.action as string;
    await this.upsertInstallation(i);
    if (action === "deleted") {
      await this.db.q("update gh_installations set deleted_at = now(), updated_at = now() where installation_id = $1", [i.id]);
      await this.db.q("update gh_repositories set removed_at = now(), updated_at = now() where installation_id = $1 and removed_at is null", [i.id]);
      await this.warmups.cancelInstallation(i.id, "the GitHub App was uninstalled");
      this.gh.forget(i.id);
      return;
    }
    if (action === "suspend") {
      await this.db.q("update gh_installations set suspended_at = now() where installation_id = $1", [i.id]);
      await this.warmups.cancelInstallation(i.id, "the installation was suspended on GitHub");
      this.gh.forget(i.id);
      return;
    }
    if (action === "unsuspend") { await this.db.q("update gh_installations set suspended_at = null where installation_id = $1", [i.id]); return; }
    if (action === "created") {
      // A captured installation.created sent again under a new delivery id must not bring back an uninstalled
      // installation (G-2301): GitHub gives a reinstallation a new installation id, so a deleted one stays deleted.
      const [was] = await this.db.q<{ deleted_at: Date | null }>("select deleted_at from gh_installations where installation_id = $1", [i.id]);
      if (was?.deleted_at) {
        this.log.warn({ installation: i.id }, "installation.created for an uninstalled installation ignored (a replay)");
        return;
      }
      await this.db.q("update gh_installations set suspended_at = null where installation_id = $1", [i.id]);
      const repos = (p.repositories as RepoLite[] | undefined) ?? [];
      await this.upsertRepositories(i.id, repos);
      await this.onboardAdded(repos.map((r) => r.id), i.repository_selection === "all");
    }
  }

  private async onInstallationRepositories(p: Record<string, unknown>): Promise<void> {
    const i = p.installation as InstallationP;
    await this.upsertInstallation(i);
    const added = (p.repositories_added as RepoLite[] | undefined) ?? [];
    const removed = (p.repositories_removed as RepoLite[] | undefined) ?? [];
    await this.upsertRepositories(i.id, added);
    if (removed.length) {
      await this.db.q("update gh_repositories set removed_at = now(), updated_at = now() where repository_id = any($1::bigint[])", [removed.map((r) => r.id)]);
      await this.warmups.cancelRepositories(removed.map((r) => r.id), "the repository was removed from the installation");
    }
    if (p.action === "added") await this.onboardAdded(added.map((r) => r.id), (p.repository_selection ?? i.repository_selection) === "all");
  }

  /**
   * Repositories the customer chose one by one get their onboarding pull request at once. With "All repositories" the
   * App does not open pull requests across a whole account by itself (unless ONBOARD_ALL_REPOSITORIES=true): the
   * dashboard opens them per project.
   */
  private async onboardAdded(repoIds: number[], all: boolean): Promise<void> {
    if (all && !this.s.onboardAllRepositories) {
      await this.db.q(`update gh_repositories set onboarding_detail = 'All repositories selected: open the pull request from the dashboard', updated_at = now()
        where repository_id = any($1::bigint[]) and onboarding_state = 'pending'`, [repoIds]);
      return;
    }
    for (const id of repoIds) await this.onboard(id);
  }

  /** Opens (or finds) the onboarding pull request of one repository and records the outcome. */
  async onboard(repositoryId: number): Promise<OnboardingResult> {
    const [repo] = await this.db.q<RepoRow>("select * from gh_repositories where repository_id = $1", [repositoryId]);
    if (!repo) throw new Error(`repository ${repositoryId} is not known`);
    const res = await onboardRepository(this.gh.installation(repo.installation_id), repo.full_name, {
      label: this.s.runsOnLabel, branch: this.s.onboardingBranch, dashboardUrl: this.s.dashboardUrl,
    });
    // A pull request that is already open (or merged) keeps its state when the repository is added again.
    await this.db.q(
      `update gh_repositories set onboarding_state = $2, onboarding_detail = $3, onboarding_workflow_path = $4, onboarding_job = $5,
         setup_pr_number = coalesce($6, setup_pr_number), setup_pr_url = coalesce($7, setup_pr_url),
         detected_language = coalesce($8, detected_language), detected_test_runner = coalesce($9, detected_test_runner),
         default_branch = coalesce($10, default_branch), disconnected_at = null, updated_at = now()
       where repository_id = $1`,
      [repositoryId, res.state, res.detail, res.workflowPath ?? null, res.job ?? null, res.pr?.number ?? null, res.pr?.url ?? null,
        res.language, res.testRunner, res.defaultBranch]);
    this.log.info({ repository: repo.full_name, state: res.state, pr: res.pr?.number }, "onboarding");
    const fresh = await this.repo(repositoryId);
    if (fresh?.workspace_id) await this.db.tx(fresh.workspace_id, (c) => this.syncProject(c, fresh, null));
    // Already on runs-on: fenvix: nothing to merge, so the default branch is warmed now.
    if (res.state === "already_fenvix") await this.warm("onboarded", () => this.warmups.requestHead(repositoryId, "onboarded"));
    return res;
  }

  private async repo(repositoryId: number): Promise<RepoRow | undefined> {
    return (await this.db.q<RepoRow>("select * from gh_repositories where repository_id = $1", [repositoryId]))[0];
  }

  /**
   * The dashboard's project for a repository of a linked installation (ci_projects), created when its language and
   * test runner are known (src/results/detect.ts: the workflow analysis, else the run's summary, else not yet).
   * Returns the project id, or null when it cannot be created yet. A repository keeps its project when it is renamed
   * or moves to another installation of the same organization (found by gh_repositories.project_id).
   */
  private async syncProject(c: Client, repo: RepoRow, fromRun: Stack | null): Promise<string | null> {
    // An owner disconnected it (DELETE /v1/projects/{id}): no project until its setup is asked for again.
    if (repo.disconnected_at) return null;
    const prState = repo.onboarding_state === "merged" ? "merged" : repo.onboarding_state === "closed" ? "closed" : repo.setup_pr_number ? "open" : null;
    const setup = repo.onboarding_state === "pr_open" ? "pr_open" : "app_installed";
    if (repo.project_id) {
      const moved = await c.query<{ id: string }>(
        `update ci_projects set full_name = $2, installation_id = $3, default_branch = coalesce($4, default_branch),
           setup_state = case when setup_state = 'active' then 'active' else $5 end,
           setup_pr_number = coalesce($6, setup_pr_number), setup_pr_url = coalesce($7, setup_pr_url), setup_pr_state = coalesce($8, setup_pr_state)
         where id = $1 and workspace_id = public.cp_workspace() returning id`,
        [repo.project_id, repo.full_name, repo.installation_id, repo.default_branch, setup, repo.setup_pr_number, repo.setup_pr_url, prState]);
      if (moved.rows[0]) return moved.rows[0].id;
    }
    const stack = projectStack({ language: repo.detected_language, testRunner: repo.detected_test_runner }, fromRun);
    if (!stack) return null;
    const rows = await c.query<{ id: string }>(
      `insert into ci_projects (workspace_id, full_name, language, test_runner, default_branch, installation_id, setup_state, setup_pr_number, setup_pr_url, setup_pr_state)
       values (public.cp_workspace(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (workspace_id, full_name) do update set installation_id = excluded.installation_id,
         default_branch = excluded.default_branch,
         setup_state = case when ci_projects.setup_state = 'active' then 'active' else excluded.setup_state end,
         setup_pr_number = coalesce(excluded.setup_pr_number, ci_projects.setup_pr_number),
         setup_pr_url = coalesce(excluded.setup_pr_url, ci_projects.setup_pr_url),
         setup_pr_state = coalesce(excluded.setup_pr_state, ci_projects.setup_pr_state)
       returning id`,
      [repo.full_name, stack.language, stack.testRunner, repo.default_branch ?? "main", repo.installation_id, setup, repo.setup_pr_number, repo.setup_pr_url, prState]);
    const id = rows.rows[0]!.id;
    if (repo.project_id !== id) await c.query("update gh_repositories set project_id = $2 where repository_id = $1", [repo.repository_id, id]);
    return id;
  }

  /** After a link: every repository of the installation gets its project where the language is known. */
  async syncInstallation(installationId: number): Promise<void> {
    const repos = await this.db.q<RepoRow>("select * from gh_repositories where installation_id = $1 and removed_at is null order by repository_id", [installationId]);
    for (const r of repos) if (r.workspace_id) await this.db.tx(r.workspace_id, (c) => this.syncProject(c, r, null));
  }

  /**
   * repository events (G-2297): `edited` with a new default branch; `renamed` and `transferred` (the new name, on the
   * repository and its project); `deleted` and `archived` (removed: no machine, no warm-up, the project keeps its
   * history); `unarchived` (back).
   */
  private async onRepository(p: Record<string, unknown>): Promise<boolean> {
    const repo = p.repository as { id?: number; default_branch?: string; full_name?: string } | undefined;
    if (!repo?.id) return false;
    const changes = p.changes as { default_branch?: unknown } | undefined;
    if (p.action === "edited") {
      if (!changes || !("default_branch" in changes) || !repo.default_branch) return false;
      await this.storeDefaultBranch(repo.id, repo.default_branch);
      return true;
    }
    if ((p.action === "renamed" || p.action === "transferred") && repo.full_name) {
      const [row] = await this.db.q<RepoRow>("update gh_repositories set full_name = $2, updated_at = now() where repository_id = $1 returning *", [repo.id, repo.full_name]);
      if (row?.project_id && row.workspace_id) {
        await this.db.tx(row.workspace_id, (c) => c.query("update ci_projects set full_name = $2 where id = $1 and workspace_id = public.cp_workspace()", [row.project_id, repo.full_name]));
      }
      return !!row;
    }
    if (p.action === "deleted" || p.action === "archived") {
      const r = await this.db.q("update gh_repositories set removed_at = coalesce(removed_at, now()), updated_at = now() where repository_id = $1 returning 1", [repo.id]);
      await this.warmups.cancelRepositories([repo.id], p.action === "deleted" ? "the repository was deleted" : "the repository was archived");
      return r.length > 0;
    }
    if (p.action === "unarchived") {
      const r = await this.db.q("update gh_repositories set removed_at = null, updated_at = now() where repository_id = $1 returning 1", [repo.id]);
      return r.length > 0;
    }
    return false;
  }

  /** installation_target.renamed (G-2298): the account's new login. */
  private async onInstallationTarget(p: Record<string, unknown>): Promise<boolean> {
    const id = (p.installation as { id?: number } | undefined)?.id;
    const login = (p.account as { login?: string } | undefined)?.login;
    if (p.action !== "renamed" || !id || !login) return false;
    const r = await this.db.q("update gh_installations set account_login = $2, updated_at = now() where installation_id = $1 returning 1", [id, login]);
    return r.length > 0;
  }

  /**
   * The "Re-run" button of a fenvix check run (check_run.rerequested, G-1647) and "Re-run all checks" (check_suite
   * .rerequested, G-2295): the job behind it is run again on GitHub (POST .../actions/jobs/{id}/rerun, which needs the
   * App's "Actions: Read and write"; without it the check run says how to re-run it from the Actions tab).
   */
  private async onCheckRun(p: Record<string, unknown>): Promise<boolean> {
    if (p.action !== "rerequested") return false;
    const cr = p.check_run as { id?: number; external_id?: string | null; app?: { id?: number } | null } | undefined;
    const jobId = Number(cr?.external_id ?? NaN);
    if (!cr?.id || !Number.isInteger(jobId) || jobId <= 0) return false;
    const [job] = await this.db.q<JobRow & { full_name: string }>(
      "select j.*, r.full_name from gh_jobs j join gh_repositories r on r.repository_id = j.repository_id where j.job_id = $1 and j.check_run_id = $2", [jobId, cr.id]);
    if (!job) return false;
    await this.rerunJob(job);
    return true;
  }

  private async onCheckSuite(p: Record<string, unknown>): Promise<boolean> {
    if (p.action !== "rerequested") return false;
    const cs = p.check_suite as { head_sha?: string } | undefined;
    const repoId = (p.repository as { id?: number } | undefined)?.id;
    if (!cs?.head_sha || !repoId) return false;
    const jobs = await this.db.q<JobRow & { full_name: string }>(
      `select distinct on (j.workflow_name, j.job_name) j.*, r.full_name from gh_jobs j join gh_repositories r on r.repository_id = j.repository_id
       where j.repository_id = $1 and j.head_sha = $2 and j.status = 'completed' order by j.workflow_name, j.job_name, j.run_id desc, j.run_attempt desc`, [repoId, cs.head_sha]);
    for (const j of jobs) await this.rerunJob(j);
    return jobs.length > 0;
  }

  private async rerunJob(job: JobRow & { full_name: string }): Promise<void> {
    const gh = this.gh.installation(job.installation_id);
    const base = repoPath(job.full_name);
    const r = await gh.request("POST", `${base}/actions/jobs/${job.job_id}/rerun`, { allow: [403, 404, 409, 422] });
    if (r.status < 300) { this.log.info({ job: job.job_id }, "job re-run from its check run"); return; }
    if (job.check_run_id && job.check_run_id > 0) {
      const why = r.status === 403 ? "the fenvix App needs the \"Actions: Read and write\" permission to re-run jobs; re-run it from the job's Actions page"
        : "GitHub did not re-run this job (it may still be running, or too old); re-run it from the job's Actions page";
      await gh.request("PATCH", `${base}/check-runs/${job.check_run_id}`, { body: { output: { title: "Could not re-run this job", summary: why } }, allow: [404] })
        .catch(() => undefined);
    }
    this.log.warn({ job: job.job_id, status: r.status }, "job not re-run");
  }

  /**
   * workflow_run.completed (G-2296): jobs of the run the App still has as queued or running were cancelled or lost
   * their events; each is read from GitHub and handled as its workflow_job event would have been (lost webhooks, G-1729).
   */
  private async onWorkflowRun(p: Record<string, unknown>): Promise<boolean> {
    const run = p.workflow_run as { id?: number } | undefined;
    if (p.action !== "completed" || !run?.id) return false;
    const open = await this.db.q<{ job_id: number }>("select job_id from gh_jobs where run_id = $1 and status <> 'completed'", [run.id]);
    for (const j of open) await this.recoverJob(j.job_id);
    return true;
  }

  /** A job read back from GitHub (GET .../actions/jobs/{id}) and handled as its workflow_job event: lost events recovered. */
  async recoverJob(jobId: number): Promise<"recovered" | "unchanged" | "unknown"> {
    const [row] = await this.db.q<JobRow & { full_name: string }>(
      "select j.*, r.full_name, r.private, r.default_branch from gh_jobs j join gh_repositories r on r.repository_id = j.repository_id where j.job_id = $1", [jobId]);
    if (!row) return "unknown";
    const gh = this.gh.installation(row.installation_id);
    const r = await gh.request<JobP>("GET", `${repoPath(row.full_name)}/actions/jobs/${jobId}`, { allow: [404] });
    if (r.status === 404) return "unknown";
    if ((STATUS_RANK[r.data.status] ?? 0) <= (STATUS_RANK[row.status] ?? 0) && !(r.data.status === "queued" && !row.launched_at && !row.no_machine)) return "unchanged";
    const action = r.data.status === "completed" ? "completed" : r.data.status === "in_progress" ? "in_progress" : "queued";
    await this.onWorkflowJob({ action, workflow_job: r.data, installation: { id: row.installation_id },
      repository: { id: row.repository_id, full_name: row.full_name, private: (row as unknown as { private: boolean }).private, default_branch: (row as unknown as { default_branch: string | null }).default_branch } });
    return "recovered";
  }

  /**
   * Lost webhooks (G-1729): GitHub does not send a failed delivery again by itself. Every sweep the App lists its recent
   * deliveries (GET /app/hook/deliveries) and asks GitHub to send again the ones that failed and that it never
   * processed (POST /app/hook/deliveries/{id}/attempts), and reads back fenvix jobs still queued with no machine after
   * three minutes (a lost workflow_job.queued). Returns how many it asked for and recovered.
   */
  async recoverLostWebhooks(): Promise<{ redelivered: number; jobs: number }> {
    let redelivered = 0;
    const list = await this.gh.app.request<{ id: number; guid: string; status_code: number; redelivery: boolean; delivered_at: string }[]>(
      "GET", "/app/hook/deliveries", { query: { per_page: 100 }, allow: [403, 404] }).catch(() => null);
    if (list && list.status === 200 && Array.isArray(list.data)) {
      const failed = list.data.filter((d) => (d.status_code === 0 || d.status_code >= 400) && Date.now() - Date.parse(d.delivered_at) < 24 * 3600_000);
      const guids = [...new Set(failed.map((d) => d.guid))];
      const done = new Set((await this.db.q<{ delivery_id: string }>(
        "select delivery_id from gh_webhook_deliveries where delivery_id = any($1::text[]) and processed_at is not null", [guids])).map((r) => r.delivery_id));
      // One new attempt per lost delivery (the newest failure of each), and none for one a later attempt delivered.
      const ok = new Set(list.data.filter((d) => d.status_code >= 200 && d.status_code < 300).map((d) => d.guid));
      const seen = new Set<string>();
      for (const d of failed.sort((a, b) => Date.parse(b.delivered_at) - Date.parse(a.delivered_at))) {
        if (done.has(d.guid) || ok.has(d.guid) || seen.has(d.guid) || redelivered >= 20) continue;
        seen.add(d.guid);
        const r = await this.gh.app.request("POST", `/app/hook/deliveries/${d.id}/attempts`, { allow: [404, 422] }).catch(() => null);
        if (r && r.status < 300) redelivered++;
      }
    }
    const stuck = await this.db.q<{ job_id: number }>(
      `select job_id from gh_jobs where status = 'queued' and launched_at is null and no_machine is null
         and coalesce(created_at, updated_at) < now() - interval '3 minutes' and coalesce(created_at, updated_at) > now() - interval '1 day'
       order by job_id limit 20`);
    let jobs = 0;
    for (const j of stuck) {
      const out = await this.recoverJob(j.job_id).catch((e: unknown) => { this.log.warn({ job: j.job_id, err: e instanceof Error ? e.message : String(e) }, "job not recovered"); return "unknown" as const; });
      if (out === "recovered") jobs++;
    }
    if (redelivered || jobs) this.log.info({ redelivered, jobs }, "lost webhooks recovered");
    return { redelivered, jobs };
  }

  /** A delivery of an event the App does not handle, recorded (G-2302). */
  async recordIgnored(deliveryId: string, event: string, action: string | null, installationId: number | null): Promise<void> {
    await this.db.q(
      `insert into gh_webhook_deliveries (delivery_id, event, action, installation_id, processed_at, error) values ($1, $2, $3, $4, now(), 'ignored: not an event the App handles')
       on conflict (delivery_id) do nothing`, [deliveryId, event, action, installationId]);
  }

  /** Writes a repository's default branch (and its project's) and when it was read; false for a repository we do not know. */
  private async storeDefaultBranch(repositoryId: number, branch: string): Promise<boolean> {
    const [row] = await this.db.q<RepoRow>(
      "update gh_repositories set default_branch = $2, updated_at = now() where repository_id = $1 returning *",
      [repositoryId, branch]);
    if (!row) return false;
    if (row.project_id && row.workspace_id) {
      await this.db.tx(row.workspace_id, (c) => c.query("update ci_projects set default_branch = $2 where id = $1 and workspace_id = public.cp_workspace()", [row.project_id, branch]));
    }
    return true;
  }

  /**
   * The worker (work kind "refresh_default_branch", queued by the dashboard API when a project page loads with a default
   * branch older than a few minutes): reads the repository from GitHub with the installation's token. A repository that
   * was touched in the last minute (gh_repositories.updated_at, which every write here sets) is not read again: several
   * page loads queue several messages.
   */
  async refreshDefaultBranch(repositoryId: number): Promise<void> {
    const repo = await this.repo(repositoryId);
    if (!repo || repo.removed_at) return;
    const fresh = await this.db.q("select 1 from gh_repositories where repository_id = $1 and updated_at > now() - interval '1 minute'", [repositoryId]);
    if (fresh.length) return;
    const r = await this.gh.installation(repo.installation_id).request<{ default_branch?: string }>("GET", `/repos/${repo.full_name}`);
    if (r.data.default_branch) await this.storeDefaultBranch(repositoryId, r.data.default_branch);
  }

  private async onPush(p: Record<string, unknown>): Promise<boolean> {
    const after = p.after as string | undefined;
    const installationId = (p.installation as { id: number } | undefined)?.id;
    if (!installationId || p.deleted === true || !after || !SHA.test(after) || /^0+$/.test(after)) return false;
    const repo = p.repository as RepoFull;
    await this.ensureRepository(installationId, repo);
    const pushedAt = typeof repo.pushed_at === "number" ? new Date(repo.pushed_at * 1000) : typeof repo.pushed_at === "string" ? new Date(repo.pushed_at) : new Date();
    const at = Number.isNaN(pushedAt.getTime()) ? new Date() : pushedAt;
    await this.db.q("insert into gh_pushes (repository_id, sha, ref, pushed_at) values ($1, $2, $3, $4) on conflict do nothing",
      [repo.id, after, String(p.ref ?? ""), at]);
    // A push to the default branch: its warm-up (after the grace period that lets the customer's own push run cover it).
    const defaultBranch = repo.default_branch ?? (await this.repo(repo.id))?.default_branch ?? null;
    if (defaultBranch && p.ref === `refs/heads/${defaultBranch}`) {
      await this.warm("push", () => this.warmups.request({ repositoryId: repo.id, sha: after, trigger: "push", pushedAt: at }));
    }
    return true;
  }

  private async onPullRequest(p: Record<string, unknown>): Promise<void> {
    const pr = p.pull_request as PullP;
    const repo = p.repository as RepoFull;
    const installationId = (p.installation as { id: number } | undefined)?.id;
    if (!installationId) return;
    await this.ensureRepository(installationId, repo);
    const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    await this.db.q(
      `insert into gh_pull_requests (repository_id, number, head_sha, head_ref, base_ref, state) values ($1, $2, $3, $4, $5, $6)
       on conflict (repository_id, number) do update set head_sha = excluded.head_sha, head_ref = excluded.head_ref,
         base_ref = excluded.base_ref, state = excluded.state, updated_at = now()`,
      [repo.id, pr.number, pr.head.sha, pr.head.ref, pr.base.ref, state]);
    // The onboarding pull request: its state is the project's setup state.
    if (pr.head.ref === this.s.onboardingBranch && pr.head.repo?.id === repo.id) {
      const onboarding = state === "open" ? "pr_open" : state;
      const detail = state === "open" ? `the setup pull request #${pr.number} is open`
        : state === "merged" ? `the setup pull request #${pr.number} was merged: the test job runs on ${this.s.runsOnLabel}`
        : `the setup pull request #${pr.number} was closed without merging`;
      await this.db.q(
        `update gh_repositories set onboarding_state = $2, setup_pr_number = $3, setup_pr_url = $4, onboarding_detail = $5, updated_at = now()
         where repository_id = $1 and (setup_pr_number is null or setup_pr_number = $3)`,
        [repo.id, onboarding, pr.number, pr.html_url, detail]);
      const row = await this.repo(repo.id);
      if (row?.workspace_id && row.project_id) {
        await this.db.tx(row.workspace_id, (c) => c.query(
          `update ci_projects set setup_pr_number = $2, setup_pr_url = $3, setup_pr_state = $4 where id = $1`,
          [row.project_id, pr.number, pr.html_url, state]));
      }
      // Merged: the test job is on fenvix from the merge commit on. Warm the cache at it before the first pull request.
      if (state === "merged" && row?.onboarding_state === "merged" && row.setup_pr_number === pr.number) {
        const onDefault = !row.default_branch || pr.base.ref === row.default_branch;
        const sha = onDefault && pr.merge_commit_sha && SHA.test(pr.merge_commit_sha) ? pr.merge_commit_sha : null;
        // Ordered by GitHub's own clock (merged_at), like the pushes that come after it.
        const mergedAt = pr.merged_at ? new Date(pr.merged_at) : null;
        const pushedAt = mergedAt && !Number.isNaN(mergedAt.getTime()) ? { pushedAt: mergedAt } : {};
        await this.warm("onboarded", () => (sha ? this.warmups.request({ repositoryId: repo.id, sha, trigger: "onboarded", ...pushedAt }) : this.warmups.requestHead(repo.id, "onboarded")));
      }
    }
  }

  private async onWorkflowJob(p: Record<string, unknown>): Promise<boolean> {
    const job = p.workflow_job as JobP;
    if (!job.labels?.includes(this.s.runsOnLabel)) return false;
    const installationId = (p.installation as { id: number } | undefined)?.id;
    if (!installationId) return false;
    const repo = p.repository as RepoFull;
    await this.ensureRepository(installationId, repo);
    const status = STATUS_RANK[job.status] ? job.status : "queued";
    // Events can arrive out of order: a row never goes back from completed to in_progress.
    await this.db.q(
      `insert into gh_jobs (job_id, repository_id, installation_id, run_id, run_attempt, workflow_name, job_name, head_sha, head_branch, labels,
         runner_name, status, conclusion, created_at, started_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (job_id) do update set
         runner_name = coalesce(excluded.runner_name, gh_jobs.runner_name),
         status = case when (case excluded.status when 'completed' then 3 when 'in_progress' then 2 else 1 end)
                         >= (case gh_jobs.status when 'completed' then 3 when 'in_progress' then 2 else 1 end) then excluded.status else gh_jobs.status end,
         conclusion = coalesce(excluded.conclusion, gh_jobs.conclusion),
         started_at = coalesce(excluded.started_at, gh_jobs.started_at),
         completed_at = coalesce(excluded.completed_at, gh_jobs.completed_at),
         updated_at = now()`,
      [job.id, repo.id, installationId, job.run_id, job.run_attempt ?? 1, job.workflow_name ?? "", job.name, job.head_sha, job.head_branch ?? null,
        job.labels, job.runner_name || null, status, job.conclusion ?? null, job.created_at ?? null, job.started_at ?? null, job.completed_at ?? null]);
    if (status === "queued" && p.action === "queued" && this.launcher) await this.launchRunner(job.id, installationId, repo);
    if (status === "in_progress") {
      await this.startRun(job.id);
      await this.startCheckRun(job.id, job.html_url ?? null);
    }
    if (status === "completed") await this.tryPublish(job.id);
    return true;
  }

  /**
   * The organization of the transaction (`app.workspace_id`): its region (workspaces.region) and its mode, shadow
   * while its 30-day trial runs (ci_subscriptions.trial_ends_at in the future), else enforce.
   */
  private async orgContext(c: Client): Promise<OrgContext> {
    const r = (await c.query<{ region: string | null; trial: boolean | null }>(
      `select (select region from public.workspaces where id = public.cp_workspace()) as region,
              (select trial_ends_at > now() from public.ci_subscriptions where workspace_id = public.cp_workspace()) as trial`)).rows[0];
    // Shadow mode only where the runner really runs it (G-0187): without that, a trial run would be labelled shadow while
    // the engine skipped tests for real. Off: every run is enforce, as it really is.
    return { region: r?.region === "eu" ? "eu" : "us", mode: r?.trial && this.s.shadowMode ? "shadow" : "enforce" };
  }

  private async workflowRun(gh: GitHubHttp, base: string, runId: number): Promise<WorkflowRunP | null> {
    return gh.request<WorkflowRunP>("GET", `${base}/actions/runs/${runId}`, { allow: [404] }).then((r) => (r.status === 404 ? null : r.data)).catch(() => null);
  }

  /** The job's pull request: from pull_request events, else from the workflow run (then recorded). */
  private async pullRequestOf(job: JobRow, run: WorkflowRunP | null): Promise<{ number: number; fenvix_comment_id: number | null } | null> {
    const known = (await this.db.q<{ number: number; fenvix_comment_id: number | null }>(
      "select number, fenvix_comment_id from gh_pull_requests where repository_id = $1 and head_sha = $2 and state = 'open' order by updated_at desc limit 1",
      [job.repository_id, job.head_sha]))[0];
    if (known) return known;
    if (!run?.pull_requests?.length) return null;
    const r0 = run.pull_requests[0]!;
    await this.db.q(
      `insert into gh_pull_requests (repository_id, number, head_sha, head_ref, base_ref, state) values ($1, $2, $3, $4, $5, 'open')
       on conflict (repository_id, number) do update set head_sha = excluded.head_sha, updated_at = now()`,
      [job.repository_id, r0.number, job.head_sha, r0.head.ref, r0.base.ref]);
    return (await this.db.q<{ number: number; fenvix_comment_id: number | null }>("select number, fenvix_comment_id from gh_pull_requests where repository_id = $1 and number = $2", [job.repository_id, r0.number]))[0]!;
  }

  /**
   * A fenvix job started on a machine: its run row, status running, for the dashboard's live view (the runner's
   * progress goes into it). Only for a linked installation whose repository has a project (or can get one now); the
   * row is finished at publish (the same row, never a second one). gh_jobs.ci_run_id, under a row lock, makes it once.
   */
  private async startRun(jobId: number): Promise<void> {
    const [job] = await this.db.q<JobRow>("select * from gh_jobs where job_id = $1", [jobId]);
    if (!job || job.ci_run_id || job.published_at || !job.runner_name) return;
    const [inst] = await this.db.q<{ workspace_id: string | null }>("select workspace_id from gh_installations where installation_id = $1", [job.installation_id]);
    const ws = inst?.workspace_id;
    const repo = await this.repo(job.repository_id);
    if (!ws || !repo) return;
    const run = await this.workflowRun(this.gh.installation(job.installation_id), repoPath(repo.full_name), job.run_id);
    const pr = await this.pullRequestOf(job, run);
    const created = await this.db.tx(ws, async (c) => {
      const lock = (await c.query<{ ci_run_id: string | null; published_at: Date | null; region: Region | null; mode: RunMode | null }>(
        "select ci_run_id, published_at, region, mode from gh_jobs where job_id = $1 for update", [jobId])).rows[0];
      if (!lock || lock.ci_run_id || lock.published_at) return null;
      const projectId = await this.syncProject(c, repo, null);
      if (!projectId) return null;
      await c.query("select 1 from ci_projects where id = $1 for update", [projectId]);
      // The mode the machine was started with (launchRunner), else the organization's now; recorded on the job.
      const mode = lock.mode ?? (await this.orgContext(c)).mode;
      const id = await this.insertRun(c, projectId, job, null, run, pr?.number ?? null, {
        startedAt: job.started_at ?? new Date(), completedAt: null, durationMs: 0, otherStepMinutes: 0, mode, region: lock.region,
      });
      await c.query("update gh_jobs set ci_run_id = $2, mode = coalesce(mode, $3) where job_id = $1", [jobId, id, mode]);
      return { id, mode };
    });
    if (created) this.log.info({ job: jobId, repository: repo.full_name, run: created.id, mode: created.mode }, "run started");
  }

  /**
   * One machine for one queued job: a just-in-time runner configuration from GitHub (repository permission
   * "Administration: Read and write"), then the machine. Only for installations linked to an organization, so a
   * stranger installing the App cannot start machines; only while the job is still queued.
   */
  private async launchRunner(jobId: number, installationId: number, repo: RepoFull): Promise<void> {
    const [row] = await this.db.q<{ status: string; run_id: number; run_attempt: number; head_sha: string }>("select status, run_id, run_attempt, head_sha from gh_jobs where job_id = $1", [jobId]);
    if (!row || row.status !== "queued") return;
    const [inst] = await this.db.q<{ workspace_id: string | null; suspended_at: Date | null; deleted_at: Date | null }>(
      "select workspace_id, suspended_at, deleted_at from gh_installations where installation_id = $1", [installationId]);
    if (!inst?.workspace_id || inst.suspended_at || inst.deleted_at) {
      this.log.warn({ job: jobId, installation: installationId }, "no runner machine: the installation is not linked to an organization");
      await this.noMachine(jobId, inst?.suspended_at ? "the fenvix GitHub App is suspended on this account"
        : inst?.deleted_at ? "the fenvix GitHub App was uninstalled from this account"
        : "this GitHub account is not connected to a fenvix organization yet (Projects → Connect a project)");
      return;
    }
    const known = await this.repo(repo.id);
    if (known?.disconnected_at) {
      await this.noMachine(jobId, "this repository was disconnected from fenvix; connect it again from the dashboard to run its jobs");
      return;
    }
    // The machine runs in the organization's region, or not at all: an EU organization's job never runs in the US.
    // Skip with proof is real (G-1757, the project's setting): off, or paused after a wrong skip, the machine gets no
    // shared cache, so the engine has nothing to reuse and every test runs.
    const { org, skip } = await this.db.tx(inst.workspace_id, async (c) => {
      const p = (await c.query<{ skip_with_proof: boolean; skip_paused_at: Date | null }>(
        "select p.skip_with_proof, p.skip_paused_at from ci_projects p join gh_repositories r on r.project_id = p.id where r.repository_id = $1", [repo.id])).rows[0];
      return { org: await this.orgContext(c), skip: !p || (p.skip_with_proof && !p.skip_paused_at) };
    });
    // The mode the machine gets (FENVIX_MODE) is the run's mode, whatever the job later reports (review R-016 F4).
    await this.db.q("update gh_jobs set region = $2, mode = $3 where job_id = $1", [jobId, org.region, org.mode]);
    if (this.launcher!.canPlace && !this.launcher!.canPlace(org.region)) {
      this.log.error({ job: jobId, installation: installationId, region: org.region }, "no runner machine: no placement for the organization's region (the job stays queued; GitHub times it out)");
      await this.noMachine(jobId, `fenvix has no machines in your organization's region (${org.region.toUpperCase()}) yet; the job is not run anywhere else`);
      return;
    }
    const gh = this.gh.installation(installationId);
    const base = repoPath(repo.full_name);
    // Cache writes only for trusted refs: a push, schedule or manual run on the default branch of this repository.
    const run = await gh.request<{ event?: string; head_branch?: string | null; head_repository?: { id: number } | null }>(
      "GET", `${base}/actions/runs/${row.run_id}`, { allow: [404] }).then((r) => (r.status === 404 ? null : r.data)).catch(() => null);
    const defaultBranch = repo.default_branch ?? (await this.repo(repo.id))?.default_branch ?? null;
    const trusted = !!run && ["push", "schedule", "workflow_dispatch", "merge_group"].includes(run.event ?? "")
      && !!defaultBranch && run.head_branch === defaultBranch && run.head_repository?.id === repo.id;
    if (!this.s.summaryKey) throw new Error("no summary signing key (RUNNER_TOKEN): no machine is started without its own credential");
    const cacheAccess = !skip ? "none" as const : trusted ? "write" as const : "read" as const;
    await this.db.q("update gh_jobs set cache_access = $2 where job_id = $1", [jobId, cacheAccess === "none" ? null : cacheAccess]);
    // A trusted run of a default-branch commit fills the cache itself: its warm-up is not needed.
    if (trusted) await this.warm("covered", () => this.warmups.onTrustedJob(repo.id, row.head_sha, jobId));
    // The fleet at its limit: a warm-up gives its machine back first (customers' jobs come before warm-ups); else no
    // just-in-time runner is registered for a job that gets no machine (R-012 F12) and the queue tries again later.
    if (this.launcher!.hasCapacity && !(await this.launcher!.hasCapacity(org.region))) {
      const freed = await this.warmups.preemptOne(org.region).catch((e: unknown) => {
        this.log.warn({ job: jobId, err: e instanceof Error ? e.message : String(e) }, "no warm-up could be preempted");
        return false;
      });
      if (!freed || !(await this.launcher!.hasCapacity(org.region))) throw new RetryLater(`the fleet is full; job ${jobId} waits`);
    }
    // A retry after a partial failure finds the first name taken (409): a fresh one; EC2 still starts one machine.
    type Jit = { encoded_jit_config: string; runner?: { id?: number } };
    let runnerName = `fenvix-j${jobId}`;
    let jit = await gh.request<Jit>("POST", `${base}/actions/runners/generate-jitconfig`, {
      body: { name: runnerName, runner_group_id: 1, labels: [this.s.runsOnLabel], work_folder: "_work" }, allow: [403, 409],
    });
    // The installation has not accepted a permission the App needs (Administration: write, added after the first
    // installs): no retries into the dead-letter queue, but a check run that says what to accept (G-1725).
    if (jit.status === 403) {
      await this.noMachine(jobId, "the fenvix GitHub App lacks the repository permission \"Administration: Read and write\" here; an owner of the account accepts the App's new permissions on GitHub (Settings → GitHub Apps → fenvix)");
      return;
    }
    if (jit.status === 409) {
      runnerName = `fenvix-j${jobId}-${Date.now().toString(36)}`;
      jit = await gh.request<Jit>("POST", `${base}/actions/runners/generate-jitconfig`, {
        body: { name: runnerName, runner_group_id: 1, labels: [this.s.runsOnLabel], work_folder: "_work" },
      });
    }
    const unregister = async (why: string) => {
      const id = jit.data.runner?.id;
      if (!id) return;
      await gh.request("DELETE", `${base}/actions/runners/${id}`, { allow: [404, 422] })
        .catch((e: unknown) => this.log.warn({ job: jobId, runner: runnerName, err: e instanceof Error ? e.message : String(e) }, "could not delete an unused just-in-time runner"));
      this.log.info({ job: jobId, runner: runnerName, why }, "unused just-in-time runner deleted");
    };
    // This machine's own credentials (R-012 F1, F3): its summaries count only for this runner, repository and run;
    // its cache token reaches only this installation's cache organization, and writes only on a trusted ref.
    const exp = Math.floor(Date.now() / 1000) + JOB_CREDENTIAL_SECONDS;
    const summaryToken = signSummaryCredential(this.s.summaryKey, { runnerName, repositoryId: repo.id, runId: row.run_id, runAttempt: row.run_attempt, exp });
    const cacheToken = this.s.cacheSigningKey && cacheAccess !== "none" ? signCacheToken(this.s.cacheSigningKey, { installationId, write: trusted, exp, jobId }) : undefined;
    let res: { instanceId: string | null; already: boolean };
    try {
      res = await this.launcher!.launch({
        jobId, runId: row.run_id, repositoryId: repo.id, repositoryFullName: repo.full_name, installationId, runnerName,
        jitConfig: jit.data.encoded_jit_config, cacheAccess, summaryToken, ...(cacheToken ? { cacheToken } : {}), region: org.region, mode: org.mode,
      });
    } catch (e) {
      await unregister(e instanceof RetryLater ? "the fleet is full" : "the machine did not start");
      throw e;
    }
    await this.db.q("update gh_jobs set launched_at = coalesce(launched_at, now()) where job_id = $1", [jobId]);
    // A redelivery after a partial failure: EC2 returned the first machine (same client token), which has the first
    // just-in-time configuration; this one would never be used.
    if (res.already) await unregister("the job's machine already exists");
    this.log.info({ job: jobId, repository: repo.full_name, runner: runnerName, instance: res.instanceId, already: res.already, cache: cacheAccess, region: org.region, mode: org.mode }, "runner machine requested");
  }

  /**
   * A fenvix job that no machine will take (G-1648): GitHub would show it queued until it times out. It gets its check
   * run, completed "action required" with why, and the pull request comment says it too.
   */
  private async noMachine(jobId: number, why: string): Promise<void> {
    const rows = await this.db.q<JobRow & { full_name: string }>(
      `update gh_jobs j set no_machine = $2 from gh_repositories r where j.job_id = $1 and r.repository_id = j.repository_id
       returning j.*, r.full_name, (select no_machine from gh_jobs where job_id = $1) as previous`, [jobId, why.slice(0, 500)]);
    const job = rows[0] as (JobRow & { full_name: string; previous: string | null }) | undefined;
    if (!job || job.previous === why) return;
    try {
      const gh = this.gh.installation(job.installation_id);
      const r = await gh.request<{ id: number; html_url: string | null }>("POST", `${repoPath(job.full_name)}/check-runs`, {
        body: {
          name: checkName(job.job_name), head_sha: job.head_sha, status: "completed", conclusion: "action_required", external_id: String(job.job_id),
          completed_at: new Date().toISOString(), details_url: `${this.s.dashboardUrl}/projects/connect`,
          output: { title: "No fenvix machine for this job", summary: `**${job.workflow_name} / ${job.job_name}** cannot run on fenvix: ${why}. It stays queued on GitHub until GitHub times it out.` },
        },
      });
      await this.db.q("update gh_jobs set check_run_id = $2, check_run_url = $3 where job_id = $1", [jobId, r.data.id, r.data.html_url]);
    } catch (e) {
      this.log.warn({ job: jobId, err: e instanceof Error ? e.message : String(e) }, "the no-machine check run could not be written");
    }
    await this.refreshComments(job.repository_id, job.head_sha).catch((e: unknown) =>
      this.log.warn({ job: jobId, err: e instanceof Error ? e.message : String(e) }, "the pull request comment could not be updated"));
  }

  /** A check run "in progress" on the commit while the job runs on fenvix. */
  private async startCheckRun(jobId: number, jobUrl: string | null): Promise<void> {
    const claimed = await this.db.q<JobRow & { full_name: string }>(
      `update gh_jobs j set check_run_id = -1 from gh_repositories r
       where j.job_id = $1 and j.check_run_id is null and j.status = 'in_progress' and r.repository_id = j.repository_id
       returning j.*, r.full_name`, [jobId]);
    const job = claimed[0];
    if (!job) return;
    try {
      const gh = this.gh.installation(job.installation_id);
      const r = await gh.request<{ id: number }>("POST", `${repoPath(job.full_name)}/check-runs`, {
        body: {
          name: checkName(job.job_name), head_sha: job.head_sha, status: "in_progress", external_id: String(job.job_id),
          started_at: (job.started_at ?? new Date()).toISOString(), ...(jobUrl ? { details_url: jobUrl } : {}),
          output: { title: "Running on fenvix", summary: `**${job.workflow_name} / ${job.job_name}** is running on a fenvix machine.` },
        },
      });
      await this.db.q("update gh_jobs set check_run_id = $2 where job_id = $1", [jobId, r.data.id]);
    } catch (e) {
      await this.db.q("update gh_jobs set check_run_id = null where job_id = $1 and check_run_id = -1", [jobId]);
      throw e;
    }
  }

  // ---------------------------------------------------------------- run summaries from our runners

  async receiveSummary(o: { repositoryId: number; runId: number; runAttempt: number; runnerName: string; receiptsUrl: string | null; summary: Record<string, unknown> }): Promise<void> {
    await this.db.q(
      `insert into gh_run_summaries (repository_id, run_id, run_attempt, runner_name, summary, receipts_url) values ($1, $2, $3, $4, $5, $6)
       on conflict (repository_id, run_id, run_attempt, runner_name) do update set summary = excluded.summary, receipts_url = excluded.receipts_url, received_at = now()`,
      [o.repositoryId, o.runId, o.runAttempt, o.runnerName, JSON.stringify(o.summary), o.receiptsUrl]);
    const jobs = await this.db.q<{ job_id: number }>(
      "select job_id from gh_jobs where repository_id = $1 and run_id = $2 and run_attempt = $3 and runner_name = $4 and status = 'completed' and published_at is null",
      [o.repositoryId, o.runId, o.runAttempt, o.runnerName]);
    for (const j of jobs) await this.tryPublish(j.job_id);
  }

  /**
   * POST /v1/runner/progress, written at once (no queue): the run's latest progress record, when its `seq` is newer
   * than the stored one and the run is still running. "no_run": the job or its run row is not known yet (the
   * workflow_job event that starts it has not arrived, or the repository has no project): nothing is stored.
   */
  async receiveProgress(o: { repositoryId: number; runId: number; runAttempt: number; runnerName: string; progress: RunnerProgress }): Promise<"stored" | "stale" | "no_run"> {
    const [j] = await this.db.q<{ ci_run_id: string; workspace_id: string | null }>(
      `select j.ci_run_id, i.workspace_id from gh_jobs j join gh_installations i on i.installation_id = j.installation_id
       where j.repository_id = $1 and j.run_id = $2 and j.run_attempt = $3 and j.runner_name = $4 and j.ci_run_id is not null
       order by j.job_id desc limit 1`,
      [o.repositoryId, o.runId, o.runAttempt, o.runnerName]);
    if (!j?.workspace_id) return "no_run";
    const updated = await this.db.tx(j.workspace_id, (c) => c.query(
      `update ci_runs set progress = $2::jsonb, progress_at = now()
       where id = $1 and status = 'running' and coalesce((progress->>'seq')::bigint, -1) < $3`,
      [j.ci_run_id, JSON.stringify(progressRecord(o.progress)), o.progress.seq]));
    return updated.rowCount ? "stored" : "stale";
  }

  /**
   * POST /v1/runner/results (queued): the chunk is stored (gh_run_results; sent again before it was applied: replaced)
   * and applied to the run once the run is published. Chunks that come before are applied at publish.
   *
   * What one job may store (review R-016 F7): only for its own job, a chunk number below the count its chunk 0
   * declared, at most RESULTS_JOB_LIMITS per job. The job is the one GitHub ran on this runner (gh_jobs: repository,
   * run, attempt, runner name); a per-job credential names the attempt itself (`attemptBound`), so its chunks are kept
   * even before the job's start is recorded. A chunk for another attempt, past the count or past the limits is dropped
   * (logged); a chunk whose job is not known yet, from a credential that does not name the attempt, is retried (thrown).
   */
  async receiveResults(o: { repositoryId: number; runId: number; runAttempt: number; runnerName: string; results: RunnerResults; attemptBound?: boolean }): Promise<"stored" | "dropped"> {
    const key = [o.repositoryId, o.runId, o.runAttempt, o.runnerName] as const;
    const drop = (why: string) => {
      this.log.warn({ repositoryId: o.repositoryId, runId: o.runId, runAttempt: o.runAttempt, runner: o.runnerName, chunk: o.results.chunk, why }, "runner results dropped");
      return "dropped" as const;
    };
    const known = await this.db.q<{ run_attempt: number }>(
      "select distinct run_attempt from gh_jobs where repository_id = $1 and run_id = $2 and runner_name = $3", [o.repositoryId, o.runId, o.runnerName]);
    if (known.length && !known.some((k) => k.run_attempt === o.runAttempt)) return drop("not an attempt this runner ran");
    if (!known.length && !o.attemptBound) {
      throw new Error(`results for ${o.repositoryId}/${o.runId}/${o.runAttempt} from ${o.runnerName}: the job's start is not recorded yet (tried again later)`);
    }
    if (o.results.chunks !== undefined && o.results.chunk >= o.results.chunks) return drop(`chunk ${o.results.chunk} of ${o.results.chunks}`);
    const payload = JSON.stringify(o.results);
    const stored = await this.db.tx(null, async (c) => {
      // One writer per job at a time: the count and the limits are checked against what is stored.
      await c.query("select pg_advisory_xact_lock(hashtext('gh_run_results:' || $1::text || '/' || $2::text || '/' || $3::text || '/' || $4))", [...key]);
      const declared = (await c.query<{ chunks: number | null }>(
        `select (payload->>'chunks')::int as chunks from gh_run_results
         where repository_id = $1 and run_id = $2 and run_attempt = $3 and runner_name = $4 and chunk = 0`, [...key])).rows[0]?.chunks ?? null;
      if (declared !== null && o.results.chunk >= declared) return `chunk ${o.results.chunk} of ${declared}`;
      const have = (await c.query<{ n: number; bytes: string }>(
        `select count(*)::int as n, coalesce(sum(octet_length(payload::text)), 0)::bigint as bytes from gh_run_results
         where repository_id = $1 and run_id = $2 and run_attempt = $3 and runner_name = $4 and chunk <> $5`, [...key, o.results.chunk])).rows[0]!;
      if (have.n + 1 > RESULTS_JOB_LIMITS.chunks) return `more than ${RESULTS_JOB_LIMITS.chunks} chunks`;
      if (Number(have.bytes) + Buffer.byteLength(payload) > RESULTS_JOB_LIMITS.bytes) return `more than ${RESULTS_JOB_LIMITS.bytes} bytes`;
      // A chunk already applied stays as it was applied (sending it again changes nothing).
      await c.query(
        `insert into gh_run_results (repository_id, run_id, run_attempt, runner_name, chunk, payload) values ($1, $2, $3, $4, $5, $6)
         on conflict (repository_id, run_id, run_attempt, runner_name, chunk) do update set payload = excluded.payload, received_at = now(),
           applied_at = null, apply_error = null
         where gh_run_results.applied_at is null`,
        [...key, o.results.chunk, payload]);
      // Chunk 0 declares the count: chunks stored past it go.
      if (o.results.chunk === 0 && o.results.chunks !== undefined) {
        await c.query("delete from gh_run_results where repository_id = $1 and run_id = $2 and run_attempt = $3 and runner_name = $4 and chunk >= $5", [...key, o.results.chunks]);
      }
      return null;
    });
    if (stored) return drop(stored);
    const jobs = await this.db.q<{ job_id: number; ci_run_id: string; workspace_id: string }>(
      `select j.job_id, j.ci_run_id, i.workspace_id from gh_jobs j join gh_installations i on i.installation_id = j.installation_id
       where j.repository_id = $1 and j.run_id = $2 and j.run_attempt = $3 and j.runner_name = $4
         and j.published_at is not null and j.ci_run_id is not null and i.workspace_id is not null`,
      [...key]);
    for (const j of jobs) await this.applyResults(j.workspace_id, j.ci_run_id, o);
    return "stored";
  }

  /** Applies the job's chunks not applied yet to its run (src/results/apply.ts). Marks each applied, or why not. */
  private async applyResults(ws: string, ciRunId: string, key: JobKey): Promise<void> {
    const rows = await this.db.q<{ id: number; chunk: number; payload: unknown }>(
      `select id, chunk, payload from gh_run_results
       where repository_id = $1 and run_id = $2 and run_attempt = $3 and runner_name = $4 and applied_at is null order by chunk, id`,
      [key.repositoryId, key.runId, key.runAttempt, key.runnerName]);
    if (!rows.length) return;
    const chunks: { id: number; chunk: number; payload: RunnerResults }[] = [];
    for (const r of rows) {
      try { chunks.push({ id: r.id, chunk: r.chunk, payload: parseResults(r.payload) }); } catch (e) {
        await this.db.q("update gh_run_results set apply_error = $2 where id = $1", [r.id, (e instanceof Error ? e.message : String(e)).slice(0, 1000)]);
      }
    }
    if (!chunks.length) return;
    try {
      const out = await this.db.tx(ws, async (c) => {
        // One application at a time per run (chunks arriving together).
        const run = (await c.query<{ id: string; project_id: string; seen_at: Date; language: string; duration_ms: number | string | null }>(
          `select r.id, r.project_id, coalesce(r.finished_at, r.started_at) as seen_at, p.language, r.duration_ms
           from ci_runs r join ci_projects p on p.id = r.project_id where r.id = $1 for update of r`, [ciRunId])).rows[0];
        if (!run) return null;
        const res = await applyChunks(c, { id: run.id, projectId: run.project_id, language: run.language, seenAt: run.seen_at, maxTestMs: run.duration_ms === null ? null : Number(run.duration_ms) }, key, chunks);
        if (res.applied.length) await c.query("update gh_run_results set applied_at = now(), apply_error = null where id = any($1::bigint[])", [res.applied]);
        for (const p of res.pending) await c.query("update gh_run_results set apply_error = $2 where id = $1", [p.id, p.error]);
        return res;
      });
      if (out) this.log.info({ run: ciRunId, applied: out.applied.length, pending: out.pending.length }, "runner results applied");
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      await this.db.q("update gh_run_results set apply_error = $2 where id = any($1::bigint[])", [chunks.map((c) => c.id), msg]);
      throw e;
    }
  }

  /**
   * POST /v1/runner/explorations (queued): one night of exploration of the credential's repository, written to its
   * project (ci_explorations), with the defects it produced (ci_defects; new_defect_ids: those it found first). A
   * repository without a project (not linked, or its language not known) keeps nothing: logged.
   *
   * Limits (review R-016b G2), by the App's clock: a project gets at most one NEW exploration per UTC day (the same
   * one sent again, same startedAt and commit, is updated), so at most 6 MB a night; it keeps the newest
   * EXPLORATION_KEEP_NIGHTS. A second exploration the same day is dropped (logged). A CI job's credential is refused at
   * intake (src/app.ts).
   */
  async receiveExploration(o: { repositoryId: number; runnerName: string; exploration: RunnerExploration; taskId?: string }): Promise<"stored" | "no_project" | "dropped"> {
    if (o.taskId) return this.receiveScheduledExploration({ ...o, taskId: o.taskId });
    const repo = await this.repo(o.repositoryId);
    if (!repo?.workspace_id) {
      this.log.warn({ repositoryId: o.repositoryId, runner: o.runnerName }, "exploration dropped: the repository is not in a linked installation");
      return "no_project";
    }
    const res = await this.db.tx(repo.workspace_id, async (c) => {
      const projectId = await this.syncProject(c, repo, null);
      if (!projectId) return null;
      const lang = (await c.query<{ language: string }>("select language from ci_projects where id = $1 for update", [projectId])).rows[0]!.language;
      const e = o.exploration;
      const tonight = (await c.query(
        `select 1 from ci_explorations where project_id = $1 and received_at >= date_trunc('day', now(), 'UTC')
           and not (started_at = $2 and commit_sha = $3) limit 1`, [projectId, e.startedAt, e.commitSha])).rowCount;
      if (tonight) return "dropped" as const;
      const out = await applyExploration(c, projectId, lang, e);
      await c.query(
        `delete from ci_explorations where project_id = $1 and id not in
           (select id from ci_explorations where project_id = $1 order by received_at desc, started_at desc limit $2)`, [projectId, EXPLORATION_KEEP_NIGHTS]);
      return out;
    });
    if (res === "dropped") {
      this.log.warn({ repository: repo.full_name, runner: o.runnerName, startedAt: o.exploration.startedAt }, "exploration dropped: the project has one for today already");
      return "dropped";
    }
    if (!res) {
      this.log.warn({ repository: repo.full_name, runner: o.runnerName }, "exploration dropped: the repository has no project yet");
      return "no_project";
    }
    this.log.info({ repository: repo.full_name, exploration: res.id, newDefects: res.newDefectIds.length }, "exploration stored");
    return "stored";
  }

  /**
   * An exploration the App scheduled (ci_exploration_jobs), reported by its own machine: stored as that job's night,
   * whatever else the project stored that day (G-1722: a targeted exploration for a pull request is kept too).
   */
  private async receiveScheduledExploration(o: { repositoryId: number; runnerName: string; exploration: RunnerExploration; taskId: string }): Promise<"stored" | "no_project"> {
    const job = await this.tasks.explorationJob(o.taskId, o);
    if (!job) {
      this.log.warn({ repositoryId: o.repositoryId, runner: o.runnerName, task: o.taskId }, "exploration dropped: not this machine's exploration job");
      return "no_project";
    }
    const out = await this.db.tx(job.ws, async (c) => {
      const lang = (await c.query<{ language: string }>("select language from ci_projects where id = $1 for update", [job.projectId])).rows[0]!.language;
      const res = await applyExploration(c, job.projectId, lang, o.exploration, o.taskId);
      await c.query("update ci_exploration_jobs set status = 'finished', exploration_id = $2, finished_at = now(), detail = '' where id = $1", [o.taskId, res.id]);
      await c.query(
        `delete from ci_explorations where project_id = $1 and id not in
           (select id from ci_explorations where project_id = $1 order by received_at desc, started_at desc limit $2)`, [job.projectId, EXPLORATION_KEEP_NIGHTS]);
      return res;
    });
    this.log.info({ task: o.taskId, exploration: out.id, newDefects: out.newDefectIds.length }, "scheduled exploration stored");
    return "stored";
  }

  /**
   * POST /v1/runner/bundles: the replay bundle of one defect of the machine's own job (a .tar.gz of bundle.json,
   * order.txt and the run's traces, at most BUNDLE_MAX_BYTES), stored under the organization's row level security and
   * made the defect's current bundle. A bundle that comes before its defect's results chunk makes the defect (status
   * reported) so the order of the records does not matter; the chunk then fills it in. "no_run": the job's run row is
   * not there yet (the machine retries).
   */
  async receiveBundle(o: { repositoryId: number; runId: number; runAttempt: number; runnerName: string; testId: string; fingerprint: string | null; content: Buffer }): Promise<"stored" | "no_run"> {
    const [j] = await this.db.q<{ ci_run_id: string; workspace_id: string | null }>(
      `select j.ci_run_id, i.workspace_id from gh_jobs j join gh_installations i on i.installation_id = j.installation_id
       where j.repository_id = $1 and j.run_id = $2 and j.run_attempt = $3 and j.runner_name = $4 and j.ci_run_id is not null
       order by j.job_id desc limit 1`, [o.repositoryId, o.runId, o.runAttempt, o.runnerName]);
    if (!j?.workspace_id) return "no_run";
    const sha = createHash("sha256").update(o.content).digest("hex");
    await this.db.tx(j.workspace_id, async (c) => {
      const r = (await c.query<{ id: string; project_id: string; language: string; seen_at: Date }>(
        `select r.id, r.project_id, p.language, coalesce(r.finished_at, r.started_at) as seen_at from ci_runs r join ci_projects p on p.id = r.project_id
         where r.id = $1 for update of r`, [j.ci_run_id])).rows[0]!;
      let d = (await c.query<{ id: string }>("select id from ci_defects where project_id = $1 and test_id = $2", [r.project_id, o.testId])).rows[0];
      if (!d) {
        await recordReportedFlaky(c, { id: r.id, projectId: r.project_id, language: r.language, seenAt: r.seen_at }, [{ nodeid: o.testId, replay: "" }]);
        d = (await c.query<{ id: string }>("select id from ci_defects where project_id = $1 and test_id = $2", [r.project_id, o.testId])).rows[0];
        if (!d) throw new Error("the defect of this bundle could not be made (the project's language is not one fenvix runs)");
      }
      const b = (await c.query<{ id: string }>(
        `insert into ci_defect_bundles (workspace_id, defect_id, run_id, fingerprint, sha256, size_bytes, content)
         values (public.cp_workspace(), $1, $2, $3, $4, $5, $6)
         on conflict (defect_id, sha256) do update set received_at = now(), run_id = excluded.run_id returning id`,
        [d.id, r.id, o.fingerprint, sha, o.content.length, o.content])).rows[0]!;
      await c.query("update ci_defects set bundle_id = $2 where id = $1", [d.id, b.id]);
      // A defect keeps its 5 newest bundles.
      await c.query(
        `delete from ci_defect_bundles where defect_id = $1 and id not in (select id from ci_defect_bundles where defect_id = $1 order by received_at desc limit 5)`, [d.id]);
    });
    return "stored";
  }

  /** Completed jobs whose summary never came (or whose publication failed) are published after the wait. */
  async sweep(): Promise<number> {
    // Old staged results and summaries, and old link completions go (review R-016 F7, R-016b G2, R-016 F2).
    await this.db.q("delete from gh_run_results where received_at < now() - make_interval(days => $1)", [RESULTS_KEEP_DAYS]);
    await this.db.q("delete from gh_run_summaries where received_at < now() - make_interval(days => $1)", [RESULTS_KEEP_DAYS]);
    await this.db.q("delete from gh_install_completions where expires_at < now() - interval '1 day'");
    const due = await this.db.q<{ job_id: number }>(
      `select job_id from gh_jobs where status = 'completed' and published_at is null and publish_attempts < 5
         and coalesce(completed_at, updated_at) < now() - make_interval(secs => $1) order by job_id limit 50`, [this.s.summaryWaitSeconds]);
    for (const j of due) {
      try { await this.tryPublish(j.job_id, true); } catch (e) { this.log.warn({ job: j.job_id, err: e instanceof Error ? e.message : String(e) }, "sweep: publish failed"); }
    }
    // Runs stopped from the dashboard, replays and explorations, the retention of customer data.
    for (const r of await this.db.q<{ run_id: string; workspace_id: string }>("select run_id, workspace_id from public.gh_cancel_requests()")) {
      await this.tasks.cancelRun(r.workspace_id, r.run_id).catch((e: unknown) => this.log.warn({ run: r.run_id, err: e instanceof Error ? e.message : String(e) }, "sweep: stop failed"));
    }
    await this.tasks.tick().catch((e: unknown) => this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "sweep: tasks failed"));
    await this.recoverLostWebhooks().catch((e: unknown) => this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "sweep: webhook recovery failed"));
    const kept = await this.db.q<{ out: Record<string, number> }>("select public.gh_retention_sweep() as out").catch((e: unknown) => {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "sweep: retention failed");
      return [];
    });
    if (kept[0] && Object.values(kept[0].out).some((n) => n > 0)) this.log.info({ deleted: kept[0].out }, "retention");
    return due.length;
  }

  // ---------------------------------------------------------------- publishing a finished run

  /**
   * Publishes a completed fenvix job once: the run row and the usage event in Postgres, then the check run and the
   * pull request comment on GitHub. Waits for the runner's summary unless `force` (the sweep) or the job was cancelled.
   */
  async tryPublish(jobId: number, force = false): Promise<"published" | "waiting" | "already"> {
    const [job] = await this.db.q<JobRow>("select * from gh_jobs where job_id = $1", [jobId]);
    if (!job || job.status !== "completed") return "waiting";
    if (job.published_at) return "already";
    const [sumRow] = job.runner_name
      ? await this.db.q<{ summary: Record<string, unknown>; receipts_url: string | null }>(
        "select summary, receipts_url from gh_run_summaries where repository_id = $1 and run_id = $2 and run_attempt = $3 and runner_name = $4",
        [job.repository_id, job.run_id, job.run_attempt, job.runner_name])
      : [];
    const ended = job.conclusion === "cancelled" || job.conclusion === "skipped";
    if (!sumRow && !force && !ended) return "waiting";
    const claimed = await this.db.q("update gh_jobs set published_at = now(), publish_attempts = publish_attempts + 1 where job_id = $1 and published_at is null returning job_id", [jobId]);
    if (!claimed.length) return "already";
    try {
      await this.publish(job, sumRow ?? null);
      await this.db.q("update gh_jobs set publish_error = null where job_id = $1", [jobId]);
      return "published";
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      await this.db.q("update gh_jobs set published_at = null, publish_error = $2 where job_id = $1", [jobId, msg]);
      throw e;
    }
  }

  private async publish(job: JobRow, sumRow: { summary: Record<string, unknown>; receipts_url: string | null } | null): Promise<void> {
    const repo = (await this.repo(job.repository_id))!;
    let summary: RunSummary | null = null;
    let summaryError: string | null = null;
    if (sumRow) {
      try { summary = parseSummary(sumRow.summary); } catch (e) { summaryError = e instanceof Error ? e.message : String(e); }
    }
    const gh = this.gh.installation(job.installation_id);
    const base = repoPath(repo.full_name);

    const run = await this.workflowRun(gh, base, job.run_id);
    // The pull request: from pull_request events, else from the workflow run.
    const pr = await this.pullRequestOf(job, run);

    // Billing: one event per job. Whether it is billable rests on GitHub's data only (review R-016b G1): a job that
    // started on our machine (runner_name and started_at of the signed workflow_job) is billed its held minutes,
    // whatever its summary and its conclusion; a job that never started on our machine is not. The summary (a file the
    // job writes) and the conclusion "cancelled" (the job can cancel its own run) only name the reason.
    const startedOnFenvix = !!job.runner_name && !!job.started_at;
    const billable = startedOnFenvix;
    const reason = !startedOnFenvix ? "cancelled_before_tests"
      : job.conclusion === "cancelled" ? "cancelled_after_start"
      : !summary ? "no_summary"
      : job.conclusion === "success" ? "completed" : "failed";

    // GitHub's timings of the job (workflow_job started_at and completed_at, in webhooks signed by GitHub): how long the
    // job held our machine. The job cannot change them. Billing counts these minutes only (review R-016 F3).
    const startedAt = job.started_at ?? job.created_at ?? new Date();
    const completedAt = job.completed_at ?? new Date();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    const heldMinutes = durationMs / 60_000;
    // What the job's summary.json says, bounded by the job's own duration: shown, never billed. A job cannot report
    // more test time or wall time than it held the machine; its time "saved" is a claim (not a part of the units).
    const ranMinutes = summary ? Math.min(summary.testSecondsRun / 60, heldMinutes) : 0;
    const wallMinutes = summary ? Math.min(summary.wallSeconds / 60, heldMinutes) : 0;
    const otherStepMinutes = summary ? Math.max(0, heldMinutes - wallMinutes) : heldMinutes;
    const minutes = {
      ran: ranMinutes,
      saved: summary ? summary.testSecondsSaved / 60 : 0,
      other: otherStepMinutes,
      held: heldMinutes,
    };

    const [inst] = await this.db.q<{ workspace_id: string | null }>("select workspace_id from gh_installations where installation_id = $1", [job.installation_id]);
    const ws = inst?.workspace_id ?? null;
    let projectId: string | null = null;
    let ciRunId: string | null = null;
    let commentsOn = true;
    await this.db.tx(ws, async (c) => {
      let planId: string | null = null;
      if (ws) {
        planId = (await c.query<{ plan_id: string }>("select plan_id from ci_subscriptions where workspace_id = $1", [ws])).rows[0]?.plan_id ?? null;
        // The run row started at in_progress (startRun), if any: this job's row, locked so that it is finished once.
        const lock = (await c.query<{ ci_run_id: string | null; region: Region | null; mode: RunMode | null }>("select ci_run_id, region, mode from gh_jobs where job_id = $1 for update", [job.job_id])).rows[0];
        const started = lock?.ci_run_id
          ? (await c.query<{ id: string; project_id: string }>("select id, project_id from ci_runs where id = $1", [lock.ci_run_id])).rows[0] ?? null
          : null;
        projectId = started?.project_id ?? await this.syncProject(c, repo, summary?.stack ?? null);
        if (projectId) {
          const proj = (await c.query<{ comment_on_pull_requests: boolean }>("select comment_on_pull_requests from ci_projects where id = $1 for update", [projectId])).rows[0]!;
          commentsOn = proj.comment_on_pull_requests;
          // The run's mode: the one the App chose when the job started (gh_jobs.mode), else the organization's now.
          // Never summary.json's or the results' (review R-016 F4).
          const mode = lock?.mode ?? (await this.orgContext(c)).mode;
          if (!lock?.mode) await c.query("update gh_jobs set mode = $2 where job_id = $1 and mode is null", [job.job_id, mode]);
          const values: RunValues = { startedAt, completedAt, durationMs, otherStepMinutes, mode, region: lock?.region ?? null };
          if (started && billable) {
            await this.finishRun(c, started.id, job, summary, run, pr?.number ?? null, values);
            ciRunId = started.id;
          } else if (started) {
            // A run row without a start on our machine by GitHub's data (not billable): kept, marked cancelled (the App
            // may not delete runs); usage counts billable events only.
            await c.query("update ci_runs set status = 'cancelled', finished_at = $2, duration_ms = $3 where id = $1", [started.id, completedAt, durationMs]);
            ciRunId = started.id;
          } else if (billable) {
            // No run row yet (the job's start was not seen, or the project appeared only now): one row, finished.
            // A job that never ran on our machine (not billable) gets no run row: rows and billable usage events agree.
            ciRunId = await this.insertRun(c, projectId, job, summary, run, pr?.number ?? null, values);
          }
          if (summary) await c.query("update ci_projects set setup_state = 'active' where id = $1", [projectId]);
        }
        if (ciRunId) await c.query("update gh_jobs set ci_run_id = $2 where job_id = $1", [job.job_id, ciRunId]);
      }
      await c.query(
        `insert into ci_usage_events (installation_id, repository_id, repository_full_name, project_id, ci_run_id, github_job_id, github_run_id,
           github_run_attempt, billable, reason, plan_id, conclusion, test_minutes_ran, minutes_saved, other_step_minutes, held_minutes, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, round($13::numeric, 2), round($14::numeric, 2), round($15::numeric, 2),
           round($16::numeric, 2), $17)
         on conflict (github_job_id) do nothing`,
        [job.installation_id, job.repository_id, repo.full_name, projectId, ciRunId, job.job_id, job.run_id, job.run_attempt, billable, reason,
          planId, job.conclusion, minutes.ran, minutes.saved, minutes.other, minutes.held, completedAt]);
    });
    // The cache: warm at this commit when a trusted run published results; a warm-up it covered runs if it did not.
    // (Also where warm-ups are off, e.g. the sweep: the cache state comes from customers' runs too.)
    await this.warmups.onJobPublished(job, !!summary, completedAt)
      .catch((e: unknown) => this.log.warn({ job: job.job_id, err: e instanceof Error ? e.message : String(e) }, "cache state not updated"));
    // The runner's per-test results, receipts, defects and audit reruns that came before the end (staged).
    if (ws && ciRunId && job.runner_name) {
      await this.applyResults(ws, ciRunId, { repositoryId: job.repository_id, runId: job.run_id, runAttempt: job.run_attempt, runnerName: job.runner_name })
        .catch((e: unknown) => this.log.error({ job: job.job_id, err: e instanceof Error ? e.message : String(e) }, "the runner's results could not be applied"));
    }
    // Every flaky test the summary names is a defect, also without a bundle (G-0184).
    if (ws && ciRunId && summary?.flaky.length) {
      const flaky = summary.flaky;
      await this.db.tx(ws, async (c) => {
        const r = (await c.query<{ id: string; project_id: string; language: string; seen_at: Date }>(
          `select r.id, r.project_id, p.language, coalesce(r.finished_at, r.started_at) as seen_at from ci_runs r join ci_projects p on p.id = r.project_id
           where r.id = $1 for update of r`, [ciRunId])).rows[0];
        if (r) await recordReportedFlaky(c, { id: r.id, projectId: r.project_id, language: r.language, seenAt: r.seen_at }, flaky);
      }).catch((e: unknown) => this.log.error({ job: job.job_id, err: e instanceof Error ? e.message : String(e) }, "the summary's flaky tests could not be recorded"));
    }

    const dashboardRunUrl = projectId && ciRunId ? `${this.s.dashboardUrl}/projects/${projectId}/runs/${ciRunId}` : null;
    const jobUrl = `${this.s.webUrl}/${repo.full_name}/actions/runs/${job.run_id}/job/${job.job_id}`;
    const ctx: RenderContext = {
      repository: repo.full_name, headSha: job.head_sha, workflowName: job.workflow_name || "workflow", jobName: job.job_name, jobUrl,
      receiptsUrl: sumRow?.receipts_url ?? dashboardRunUrl, dashboardRunUrl, jobConclusion: job.conclusion,
    };
    const output: ReturnType<typeof checkRunOutput> & { annotations?: unknown[] } = checkRunOutput(summary, ctx);
    if (summaryError) output.summary = `The runner's summary could not be read (${summaryError}).\n\n` + output.summary;
    // Failures and flaky defects attached to their file and line in the pull request's diff (G-1646): from the run's
    // per-test results and its defects (the engine's `path:line` locations), at most 50 (GitHub's limit per request).
    if (ws && ciRunId) {
      const ann = await this.db.tx(ws, (c) => this.annotations(c, ciRunId!)).catch(() => []);
      if (ann.length) output.annotations = ann;
    }
    const conclusion = conclusionOf(summary, job.conclusion);
    const checkBody = {
      name: checkName(job.job_name), status: "completed", conclusion, completed_at: completedAt.toISOString(), external_id: String(job.job_id),
      details_url: dashboardRunUrl ?? jobUrl, output,
    };
    let check: { id: number; html_url: string | null };
    if (job.check_run_id && job.check_run_id > 0) {
      const r = await gh.request<{ id: number; html_url: string | null }>("PATCH", `${base}/check-runs/${job.check_run_id}`, { body: checkBody, allow: [404] });
      check = r.status === 404
        ? (await gh.request<{ id: number; html_url: string | null }>("POST", `${base}/check-runs`, { body: { ...checkBody, head_sha: job.head_sha, started_at: startedAt.toISOString() } })).data
        : r.data;
    } else {
      check = (await gh.request<{ id: number; html_url: string | null }>("POST", `${base}/check-runs`, { body: { ...checkBody, head_sha: job.head_sha, started_at: startedAt.toISOString() } })).data;
    }
    await this.db.q("update gh_jobs set check_run_id = $2 where job_id = $1", [job.job_id, check.id]);

    await this.db.q("update gh_jobs set check_run_url = $2 where job_id = $1", [job.job_id, check.html_url]);
    // The pull request comment: every fenvix job of this commit, combined (G-0189).
    if (commentsOn) await this.refreshComments(job.repository_id, job.head_sha, run);
    this.log.info({ repository: repo.full_name, job: job.job_id, conclusion, billable, pr: pr?.number ?? null }, "run published");
  }

  /** Check run annotations of a run: its flaky defects (warning) and real failures (failure) that name `path:line`. */
  private async annotations(c: Client, runId: string): Promise<{ path: string; start_line: number; end_line: number; annotation_level: string; title: string; message: string }[]> {
    const rows = (await c.query<{ test_id: string; kind: string; location: string | null; message: string | null; exception_type: string | null; cause: string | null; replay: string | null }>(
      `select t.test_id, coalesce(t.failure_kind, 'real') as kind, coalesce(d.exception->>'location', t.failure_location) as location,
         coalesce(d.exception->>'message', t.failure_message) as message, coalesce(d.exception->>'type', t.exception_type) as exception_type,
         d.cause, d.replay_command as replay
       from ci_test_results t left join ci_defects d on d.id = t.defect_id
       where t.run_id = $1 and t.outcome = 'failed' order by t.test_id limit 200`, [runId])).rows;
    const out = [];
    for (const r of rows) {
      const m = /^(.+?):(\d+)$/.exec(r.location ?? "");
      if (!m || m[1]!.startsWith("/") || m[1]!.includes("..")) continue;
      const line = Number(m[2]);
      const flaky = r.kind === "flaky_defect";
      out.push({
        path: m[1]!, start_line: line, end_line: line, annotation_level: flaky ? "warning" : "failure",
        title: `${flaky ? "Flaky (reproducible)" : "Failed"}: ${r.test_id}`.slice(0, 255),
        message: [r.exception_type && r.message ? `${r.exception_type}: ${r.message}` : r.message ?? "", flaky && r.cause ? `cause: ${r.cause}` : "", flaky && r.replay ? `replay: ${r.replay}` : ""]
          .filter(Boolean).join("\n").slice(0, 64_000) || r.test_id,
      });
      if (out.length >= 50) break;
    }
    return out;
  }

  /** The trigger, the status and the counts of a run from the job, its workflow run and the runner's summary. */
  private runFields(job: JobRow, s: RunSummary | null, run: WorkflowRunP | null, pr: number | null, durationMs: number | null = null) {
    const event = run?.event ?? (pr ? "pull_request" : "push");
    // Any other event (release, repository_dispatch, deployment, ...) is "other", never shown as a manual run (G-2343).
    const trigger = TRIGGERS.has(event) ? event : event === "pull_request_target" ? "pull_request" : "other";
    const fails = s ? s.failed.length + s.flaky.length : 0;
    const status = job.conclusion === "cancelled" ? "cancelled" : s ? (fails || s.exit !== 0 ? "failed" : "passed") : job.conclusion === "success" ? "passed" : "failed";
    const passedRan = s ? Math.max(0, Math.min(s.ran - fails, (s.outcomeCounts.passed ?? s.ran) - s.reusedWithProof)) : 0;
    return {
      trigger, status, commitMessage: (run?.head_commit?.message ?? "").split("\n")[0]!.slice(0, 500),
      tests: [s?.tests ?? 0, s?.ran ?? 0, passedRan, fails, s?.reusedWithProof ?? 0, s?.flaky.length ?? 0] as const,
      // Test time run: at most the job's own duration (GitHub's timings), whatever the summary says.
      timeRanMs: Math.round(Math.min((s?.testSecondsRun ?? 0) * 1000, durationMs ?? Infinity)), timeSkippedMs: Math.round((s?.testSecondsSaved ?? 0) * 1000),
    };
  }

  /** A new ci_runs row: status running at the job's start (startRun), or finished at publish when no row was started. */
  private async insertRun(c: Client, projectId: string, job: JobRow, s: RunSummary | null, run: WorkflowRunP | null, pr: number | null, v: RunValues): Promise<string> {
    const [push] = (await c.query<{ pushed_at: Date }>("select pushed_at from gh_pushes where repository_id = $1 and sha = $2", [job.repository_id, job.head_sha])).rows;
    const pushedAt = push?.pushed_at ?? (run?.created_at ? new Date(run.created_at) : job.created_at ?? v.startedAt);
    const f = this.runFields(job, s, run, pr, v.completedAt ? v.durationMs : null);
    const status = v.completedAt ? f.status : "running";
    const r = await c.query<{ id: string }>(
      `insert into ci_runs (workspace_id, project_id, number, commit_sha, commit_message, branch, pull_request, trigger, status, pushed_at, started_at,
         finished_at, duration_ms, tests_total, tests_ran, tests_passed, tests_failed, tests_skipped, tests_flaky_defects, test_time_ran_ms,
         test_time_skipped_ms, other_step_minutes, engine_version, skip_misses, mode, region)
       values (public.cp_workspace(), $1, (select coalesce(max(number), 0) + 1 from ci_runs where project_id = $1), $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, round($20::numeric, 2), $21, $22, $23, $24)
       returning id`,
      [projectId, job.head_sha, f.commitMessage, job.head_branch ?? "", pr, f.trigger, status,
        pushedAt, v.startedAt, v.completedAt, v.durationMs, ...f.tests, f.timeRanMs, f.timeSkippedMs, v.otherStepMinutes, s?.engineVersion ?? "",
        JSON.stringify(s?.notReusedReasons ?? {}), v.mode, v.region]);
    return r.rows[0]!.id;
  }

  /** The row started at in_progress gets the finished values (the same row: a job is one run). */
  private async finishRun(c: Client, id: string, job: JobRow, s: RunSummary | null, run: WorkflowRunP | null, pr: number | null, v: RunValues): Promise<void> {
    const f = this.runFields(job, s, run, pr, v.durationMs);
    await c.query(
      `update ci_runs set commit_message = case when $2 <> '' then $2 else commit_message end, pull_request = coalesce($3, pull_request), trigger = $4,
         status = $5, started_at = $6, finished_at = $7, duration_ms = $8, tests_total = $9, tests_ran = $10, tests_passed = $11, tests_failed = $12,
         tests_skipped = $13, tests_flaky_defects = $14, test_time_ran_ms = $15, test_time_skipped_ms = $16, other_step_minutes = round($17::numeric, 2),
         engine_version = $18, skip_misses = $19, mode = $20
       where id = $1`,
      [id, f.commitMessage, pr, f.trigger, f.status, v.startedAt, v.completedAt, v.durationMs, ...f.tests, f.timeRanMs, f.timeSkippedMs, v.otherStepMinutes,
        s?.engineVersion ?? "", JSON.stringify(s?.notReusedReasons ?? {}), v.mode]);
  }

  /**
   * One fenvix comment per pull request: updated in place; found again by its marker if our record of it is lost (all
   * the pull request's comments are searched, page by page: G-2317).
   */
  private async upsertComment(gh: GitHubHttp, base: string, number: number, known: number | null, body: string): Promise<number> {
    let id = known;
    for (let page = 1; !id && page <= 30; page++) {
      const list = await gh.request<{ id: number; body?: string; performed_via_github_app?: { id: number } | null; user?: { type?: string } | null }[]>(
        "GET", `${base}/issues/${number}/comments`, { query: { per_page: 100, page } });
      id = list.data.find((cm) => cm.body?.startsWith(COMMENT_MARKER) && cm.user?.type === "Bot")?.id ?? null;
      if (list.data.length < 100) break;
    }
    if (id) {
      const r = await gh.request<{ id: number }>("PATCH", `${base}/issues/comments/${id}`, { body: { body }, allow: [404] });
      if (r.status !== 404) return r.data.id;
    }
    const created = await gh.request<{ id: number }>("POST", `${base}/issues/${number}/comments`, { body: { body } });
    return created.data.id;
  }

  /**
   * The comment of every open pull request whose head is this commit (G-2318), made from ALL fenvix jobs of the commit
   * (G-0189): the latest attempt of each job (by workflow and job name: a matrix job's name carries its values). One
   * writer per pull request at a time (an advisory lock held while it renders and writes), so a job that finished
   * earlier never overwrites a later job's result with an older picture.
   */
  async refreshComments(repositoryId: number, headSha: string, run: WorkflowRunP | null = null): Promise<number> {
    const repo = await this.repo(repositoryId);
    if (!repo) return 0;
    if (run?.pull_requests?.length) {
      for (const p of run.pull_requests) {
        if (p.head.sha !== headSha) continue;
        await this.db.q(
          `insert into gh_pull_requests (repository_id, number, head_sha, head_ref, base_ref, state) values ($1, $2, $3, $4, $5, 'open')
           on conflict (repository_id, number) do update set head_sha = excluded.head_sha, updated_at = now() where gh_pull_requests.state = 'open'`,
          [repositoryId, p.number, headSha, p.head.ref, p.base.ref]);
      }
    }
    const prs = await this.db.q<{ number: number }>(
      "select number from gh_pull_requests where repository_id = $1 and head_sha = $2 and state = 'open' order by number", [repositoryId, headSha]);
    if (!prs.length) return 0;
    const gh = this.gh.installation(repo.installation_id);
    const base = repoPath(repo.full_name);
    let written = 0;
    for (const pr of prs) {
      await this.db.tx(null, async (c) => {
        await c.query("select pg_advisory_xact_lock(hashtext('pr-comment:' || $1::text || ':' || $2::text))", [repositoryId, pr.number]);
        const view = await this.commentView(repositoryId, headSha);
        if (!view) return;
        const known = (await c.query<{ fenvix_comment_id: number | null }>(
          "select fenvix_comment_id from gh_pull_requests where repository_id = $1 and number = $2", [repositoryId, pr.number])).rows[0]?.fenvix_comment_id ?? null;
        const body = combinedComment(view.jobs, view.defects, { repository: repo.full_name, headSha, dashboardUrl: this.s.dashboardUrl, receiptsUrl: view.receiptsUrl });
        const id = await this.upsertComment(gh, base, pr.number, known, body);
        await c.query("update gh_pull_requests set fenvix_comment_id = $3 where repository_id = $1 and number = $2", [repositoryId, pr.number, id]);
        written++;
      });
    }
    return written;
  }

  /** What the comment of a commit shows: its fenvix jobs and the defects they saw (null: comments are off). */
  async commentView(repositoryId: number, headSha: string): Promise<{ jobs: JobView[]; defects: DefectView[]; receiptsUrl: string | null } | null> {
    const repo = (await this.repo(repositoryId))!;
    const rows = await this.db.q<JobRow & { summary: Record<string, unknown> | null; check_run_url: string | null; no_machine: string | null }>(
      `select distinct on (j.workflow_name, j.job_name) j.*, s.summary
       from gh_jobs j left join gh_run_summaries s on s.repository_id = j.repository_id and s.run_id = j.run_id and s.run_attempt = j.run_attempt
         and s.runner_name = j.runner_name
       where j.repository_id = $1 and j.head_sha = $2
       order by j.workflow_name, j.job_name, j.run_id desc, j.run_attempt desc, j.job_id desc`, [repositoryId, headSha]);
    const [inst] = await this.db.q<{ workspace_id: string | null }>("select workspace_id from gh_installations where installation_id = $1", [repo.installation_id]);
    const ws = inst?.workspace_id ?? null;
    const runIds = rows.map((r) => r.ci_run_id).filter((x): x is string => !!x);
    let projectId: string | null = null;
    let commentsOn = true;
    let testRunner = "pytest";
    let defects: DefectView[] = [];
    const runOfJob = new Map(rows.map((r) => [r.ci_run_id, `${r.workflow_name || "workflow"} / ${r.job_name}`]));
    if (ws) {
      await this.db.tx(ws, async (c) => {
        const p = (await c.query<{ id: string; comment_on_pull_requests: boolean; test_runner: string }>(
          "select p.id, p.comment_on_pull_requests, p.test_runner from ci_projects p join gh_repositories r on r.project_id = p.id where r.repository_id = $1", [repositoryId])).rows[0];
        if (p) { projectId = p.id; commentsOn = p.comment_on_pull_requests; testRunner = p.test_runner; }
        if (!runIds.length) return;
        const ds = (await c.query<Record<string, unknown> & { run_ids: string[] }>(
          `select d.*, array_agg(distinct o.run_id::text) as run_ids,
             (select count(distinct (r2.pull_request)) from ci_defect_occurrences o2 join ci_runs r2 on r2.id = o2.run_id
               where o2.defect_id = d.id and r2.pull_request is not null) as prs,
             (select row_to_json(x) from (select status, runs, fails from ci_replays rp where rp.id = d.last_replay_id) x) as last_replay
           from ci_defect_occurrences o join ci_defects d on d.id = o.defect_id
           where o.run_id = any($1::uuid[]) group by d.id order by d.test_id`, [runIds])).rows;
        defects = ds.map((d) => this.defectView(d, testRunner, d.run_ids.map((id) => runOfJob.get(id) ?? "").filter(Boolean)));
      });
    }
    if (!commentsOn) return null;
    const jobs: JobView[] = rows.map((r) => {
      let summary: RunSummary | null = null;
      if (r.summary) { try { summary = parseSummary(r.summary); } catch { summary = null; } }
      return {
        jobId: r.job_id, name: `${r.workflow_name || "workflow"} / ${r.job_name}`, status: r.status as JobView["status"], conclusion: r.conclusion,
        summary, published: !!r.published_at, noMachine: r.no_machine,
        dashboardRunUrl: projectId && r.ci_run_id ? `${this.s.dashboardUrl}/projects/${projectId}/runs/${r.ci_run_id}` : null,
        checkRunUrl: r.check_run_url, jobUrl: `${this.s.webUrl}/${repo.full_name}/actions/runs/${r.run_id}/job/${r.job_id}`,
      };
    });
    const firstRun = rows.find((r) => r.ci_run_id)?.ci_run_id;
    return { jobs, defects, receiptsUrl: projectId && firstRun ? `${this.s.dashboardUrl}/projects/${projectId}/runs/${firstRun}` : null };
  }

  private defectView(d: Record<string, unknown>, testRunner: string, jobs: string[]): DefectView {
    const ex = (d.exception ?? {}) as Record<string, string>;
    const dv = d.divergence as DefectView["divergence"];
    const shape = { id: String(d.id), seed: d.seed === null || d.seed === undefined ? null : Number(d.seed), language: d.language as "python" | "node",
      testRunner: testRunner as "pytest", replayCommand: (d.replay_command as string | null) ?? null };
    const lr = d.last_replay as { status: string; runs: number | null; fails: number | null } | null;
    return {
      id: shape.id, testId: String(d.test_id), status: d.status as DefectView["status"], state: d.state as DefectView["state"], cause: String(d.cause),
      causeTests: (d.cause_tests as string[]) ?? [], minimalOrder: (d.minimal_order as string[]) ?? [], seed: shape.seed, divergence: dv ?? null,
      exception: { type: ex.type ?? "", message: ex.message ?? "", location: ex.location ?? "" },
      replays: { runs: Number(d.replay_runs ?? 0), fails: Number(d.replay_fails ?? 0) },
      replayCommand: replayCommand(shape), pullCommand: pullCommand(shape), dashboardUrl: `${this.s.dashboardUrl}/defects/${shape.id}`,
      occurrences: Number(d.occurrences ?? 1), pullRequests: Number(d.prs ?? 0), jobs,
      culprit: (d.culprit as DefectView["culprit"]) ?? null, dependencyVerdict: (d.dependency_verdict as DefectView["dependencyVerdict"]) ?? null,
      lastReplay: lr ? { status: lr.status, runs: lr.runs, fails: lr.fails } : null,
    };
  }

  // ---------------------------------------------------------------- linking (called after the setup callback checks)

  /**
   * /github/setup, once GitHub confirmed that the GitHub user sees and administers the installation (review R-016):
   * a single-use completion for the fenvix person the state names, valid 10 minutes. Returns its one-time code (only
   * its hash is stored), or why not: the person is not an owner or admin of the organization (not_admin), the
   * installation is another organization's (other_organization) or was removed (removed), the state was used (used).
   */
  async prepareLink(o: { installationId: number; workspaceId: string; userId: string; stateHash: string; githubUserId: number; githubLogin: string }):
    Promise<{ refused: null; code: string; account: string } | { refused: string; code?: undefined; account?: undefined }> {
    await this.ensureInstallation(o.installationId);
    if (!(await this.isAdmin(o.workspaceId, o.userId))) return { refused: "not_admin" };
    const [inst] = await this.db.q<{ workspace_id: string | null; account_login: string; deleted_at: Date | null }>(
      "select workspace_id, account_login, deleted_at from gh_installations where installation_id = $1", [o.installationId]);
    if (!inst || inst.deleted_at) return { refused: "removed" };
    if (inst.workspace_id && inst.workspace_id !== o.workspaceId) return { refused: "other_organization" };
    const code = randomBytes(32).toString("base64url");
    const stored = await this.db.q(
      `insert into gh_install_completions (code_hash, state_hash, installation_id, workspace_id, user_id, github_user_id, github_login, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 minutes') on conflict (state_hash) do nothing returning id`,
      [sha256Hex(code), o.stateHash, o.installationId, o.workspaceId, o.userId, o.githubUserId, o.githubLogin.slice(0, 100)]);
    if (!stored.length) return { refused: "used" };
    return { refused: null, code, account: inst.account_login };
  }

  /** Tests: links as the given person (what api_complete_github_link does for the dashboard), then as the worker. */
  async linkInstallation(installationId: number, workspaceId: string, userId: string): Promise<string> {
    await this.ensureInstallation(installationId);
    const r = await this.db.q<{ login: string }>("select public.gh_link_installation($1, $2, $3) as login", [installationId, workspaceId, userId]);
    await this.onInstallationLinked(installationId);
    return r[0]!.login;
  }

  /**
   * The worker (work kind "installation_linked", after POST /v1/github/installations/complete): the projects, then a
   * warm-up of every repository already on fenvix (setup pull request merged before the link, or never needed).
   * A forged message changes nothing for an installation that is not linked: syncInstallation and the warm-ups both
   * refuse it (Warmups.refuse requires a linked, unsuspended installation).
   */
  async onInstallationLinked(installationId: number): Promise<void> {
    await this.syncInstallation(installationId);
    const onboarded = await this.db.q<{ repository_id: number }>(
      "select repository_id from gh_repositories where installation_id = $1 and removed_at is null and onboarding_state in ('merged', 'already_fenvix') order by repository_id",
      [installationId]);
    for (const x of onboarded) await this.warm("linked", () => this.warmups.requestHead(x.repository_id, "linked"));
  }

  async isAdmin(workspaceId: string, userId: string): Promise<boolean> {
    const r = await this.db.q<{ ok: boolean }>("select public.gh_is_admin($1, $2) as ok", [workspaceId, userId]);
    return r[0]?.ok === true;
  }

  async repositoryWorkspace(repositoryId: number): Promise<string | null | undefined> {
    const r = await this.repo(repositoryId);
    return r ? r.workspace_id : undefined;
  }
}

export { GitHubError };
