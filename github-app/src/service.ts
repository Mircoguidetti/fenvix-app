import type { Client, Db } from "./db.ts";
import { GitHubError, type GitHubApp, type GitHubHttp, repoPath } from "./github/client.ts";
import { onboardRepository, type OnboardingResult } from "./onboarding/onboard.ts";
import { CHECK_NAME, COMMENT_MARKER, checkRunOutput, conclusionOf, prComment, type RenderContext } from "./results/render.ts";
import { parseSummary, type RunSummary } from "./results/summary.ts";
import type { KeyObject } from "node:crypto";
import { signCacheToken, signSummaryCredential } from "./runners/credentials.ts";
import { RetryLater, type RunnerLauncher } from "./runners/launcher.ts";

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
}

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
interface PullP { number: number; state: string; merged?: boolean | null; html_url: string; head: { sha: string; ref: string; repo: { id: number } | null }; base: { ref: string } }
interface JobP {
  id: number; run_id: number; run_attempt?: number; workflow_name?: string | null; name: string; head_sha: string; head_branch?: string | null;
  labels: string[]; runner_name?: string | null; status: string; conclusion?: string | null; created_at?: string; started_at?: string | null;
  completed_at?: string | null; html_url?: string | null;
}

interface JobRow {
  job_id: number; repository_id: number; installation_id: number; run_id: number; run_attempt: number; workflow_name: string; job_name: string;
  head_sha: string; head_branch: string | null; labels: string[]; runner_name: string | null; status: string; conclusion: string | null;
  created_at: Date | null; started_at: Date | null; completed_at: Date | null; check_run_id: number | null; ci_run_id: string | null;
  published_at: Date | null; publish_attempts: number;
}
interface RepoRow {
  repository_id: number; installation_id: number; workspace_id: string | null; full_name: string; default_branch: string | null;
  project_id: string | null; onboarding_state: string; setup_pr_number: number | null; setup_pr_url: string | null;
  detected_language: string | null; detected_test_runner: string | null;
}

const STATUS_RANK: Record<string, number> = { queued: 1, waiting: 1, in_progress: 2, completed: 3 };
const TRIGGERS = new Set(["push", "pull_request", "merge_group", "schedule", "workflow_dispatch"]);
const SHA = /^[0-9a-f]{40}$/;

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

  constructor(db: Db, gh: GitHubApp, s: ServiceSettings, log: Logger, launcher: RunnerLauncher | null = null) {
    this.db = db; this.gh = gh; this.s = s; this.log = log; this.launcher = launcher;
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
      case "push": return this.onPush(p);
      case "pull_request": await this.onPullRequest(p); return true;
      case "workflow_job": return this.onWorkflowJob(p);
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
        `insert into gh_repositories (repository_id, installation_id, full_name, private) values ($1, $2, $3, $4)
         on conflict (repository_id) do update set installation_id = excluded.installation_id, full_name = excluded.full_name,
           private = excluded.private, removed_at = null, updated_at = now()`,
        [r.id, installationId, r.full_name, r.private ?? true]);
    }
  }

  private async ensureRepository(installationId: number, repo: RepoFull): Promise<void> {
    await this.ensureInstallation(installationId);
    await this.db.q(
      `insert into gh_repositories (repository_id, installation_id, full_name, private, default_branch) values ($1, $2, $3, $4, $5)
       on conflict (repository_id) do update set full_name = excluded.full_name,
         default_branch = coalesce(excluded.default_branch, gh_repositories.default_branch), updated_at = now()`,
      [repo.id, installationId, repo.full_name, repo.private ?? true, repo.default_branch ?? null]);
  }

  private async onInstallation(p: Record<string, unknown>): Promise<void> {
    const i = p.installation as InstallationP;
    const action = p.action as string;
    await this.upsertInstallation(i);
    if (action === "deleted") {
      await this.db.q("update gh_installations set deleted_at = now(), updated_at = now() where installation_id = $1", [i.id]);
      await this.db.q("update gh_repositories set removed_at = now(), updated_at = now() where installation_id = $1 and removed_at is null", [i.id]);
      this.gh.forget(i.id);
      return;
    }
    if (action === "suspend") { await this.db.q("update gh_installations set suspended_at = now() where installation_id = $1", [i.id]); this.gh.forget(i.id); return; }
    if (action === "unsuspend") { await this.db.q("update gh_installations set suspended_at = null where installation_id = $1", [i.id]); return; }
    if (action === "created") {
      await this.db.q("update gh_installations set deleted_at = null, suspended_at = null where installation_id = $1", [i.id]);
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
         default_branch = coalesce($10, default_branch), updated_at = now()
       where repository_id = $1`,
      [repositoryId, res.state, res.detail, res.workflowPath ?? null, res.job ?? null, res.pr?.number ?? null, res.pr?.url ?? null,
        res.language, res.testRunner, res.defaultBranch]);
    this.log.info({ repository: repo.full_name, state: res.state, pr: res.pr?.number }, "onboarding");
    const fresh = await this.repo(repositoryId);
    if (fresh?.workspace_id) await this.db.tx(fresh.workspace_id, (c) => this.syncProject(c, fresh, null));
    return res;
  }

  private async repo(repositoryId: number): Promise<RepoRow | undefined> {
    return (await this.db.q<RepoRow>("select * from gh_repositories where repository_id = $1", [repositoryId]))[0];
  }

  /**
   * The dashboard's project for a repository of a linked installation (ci_projects), created when its language is
   * known (from the workflow, or from the first run). Returns the project id, or null when it cannot be created yet.
   */
  private async syncProject(c: Client, repo: RepoRow, fromRun: { language: string; testRunner: string } | null): Promise<string | null> {
    const language = repo.detected_language ?? fromRun?.language ?? null;
    // The run's test runner only for its own language: a Node repository is never labelled pytest.
    const runner = repo.detected_test_runner ?? (fromRun && fromRun.language === language ? fromRun.testRunner : null)
      ?? (language === "python" ? "pytest" : language === "go" ? "go test" : null);
    if (!language || !runner) return null;
    const prState = repo.onboarding_state === "merged" ? "merged" : repo.onboarding_state === "closed" ? "closed" : repo.setup_pr_number ? "open" : null;
    const setup = repo.onboarding_state === "pr_open" ? "pr_open" : "app_installed";
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
      [repo.full_name, language, runner, repo.default_branch ?? "main", repo.installation_id, setup, repo.setup_pr_number, repo.setup_pr_url, prState]);
    const id = rows.rows[0]!.id;
    if (repo.project_id !== id) await c.query("update gh_repositories set project_id = $2 where repository_id = $1", [repo.repository_id, id]);
    return id;
  }

  /** After a link: every repository of the installation gets its project where the language is known. */
  async syncInstallation(installationId: number): Promise<void> {
    const repos = await this.db.q<RepoRow>("select * from gh_repositories where installation_id = $1 and removed_at is null order by repository_id", [installationId]);
    for (const r of repos) if (r.workspace_id) await this.db.tx(r.workspace_id, (c) => this.syncProject(c, r, null));
  }

  private async onPush(p: Record<string, unknown>): Promise<boolean> {
    const after = p.after as string | undefined;
    const installationId = (p.installation as { id: number } | undefined)?.id;
    if (!installationId || p.deleted === true || !after || !SHA.test(after) || /^0+$/.test(after)) return false;
    const repo = p.repository as RepoFull;
    await this.ensureRepository(installationId, repo);
    const pushedAt = typeof repo.pushed_at === "number" ? new Date(repo.pushed_at * 1000) : typeof repo.pushed_at === "string" ? new Date(repo.pushed_at) : new Date();
    await this.db.q("insert into gh_pushes (repository_id, sha, ref, pushed_at) values ($1, $2, $3, $4) on conflict do nothing",
      [repo.id, after, String(p.ref ?? ""), Number.isNaN(pushedAt.getTime()) ? new Date() : pushedAt]);
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
      await this.db.q(
        `update gh_repositories set onboarding_state = $2, setup_pr_number = $3, setup_pr_url = $4, updated_at = now()
         where repository_id = $1 and (setup_pr_number is null or setup_pr_number = $3)`,
        [repo.id, onboarding, pr.number, pr.html_url]);
      const row = await this.repo(repo.id);
      if (row?.workspace_id && row.project_id) {
        await this.db.tx(row.workspace_id, (c) => c.query(
          `update ci_projects set setup_pr_number = $2, setup_pr_url = $3, setup_pr_state = $4 where id = $1`,
          [row.project_id, pr.number, pr.html_url, state]));
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
    if (status === "in_progress") await this.startCheckRun(job.id, job.html_url ?? null);
    if (status === "completed") await this.tryPublish(job.id);
    return true;
  }

  /**
   * One machine for one queued job: a just-in-time runner configuration from GitHub (repository permission
   * "Administration: Read and write"), then the machine. Only for installations linked to an organization, so a
   * stranger installing the App cannot start machines; only while the job is still queued.
   */
  private async launchRunner(jobId: number, installationId: number, repo: RepoFull): Promise<void> {
    const [row] = await this.db.q<{ status: string; run_id: number }>("select status, run_id from gh_jobs where job_id = $1", [jobId]);
    if (!row || row.status !== "queued") return;
    const [inst] = await this.db.q<{ workspace_id: string | null; suspended_at: Date | null; deleted_at: Date | null }>(
      "select workspace_id, suspended_at, deleted_at from gh_installations where installation_id = $1", [installationId]);
    if (!inst?.workspace_id || inst.suspended_at || inst.deleted_at) {
      this.log.warn({ job: jobId, installation: installationId }, "no runner machine: the installation is not linked to an organization");
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
    // The fleet at its limit: no just-in-time runner is registered for a job that gets no machine (R-012 F12). The
    // queue tries again later.
    if (this.launcher!.hasCapacity && !(await this.launcher!.hasCapacity())) throw new RetryLater(`the fleet is full; job ${jobId} waits`);
    // A retry after a partial failure finds the first name taken (409): a fresh one; EC2 still starts one machine.
    type Jit = { encoded_jit_config: string; runner?: { id?: number } };
    let runnerName = `fenvix-j${jobId}`;
    let jit = await gh.request<Jit>("POST", `${base}/actions/runners/generate-jitconfig`, {
      body: { name: runnerName, runner_group_id: 1, labels: [this.s.runsOnLabel], work_folder: "_work" }, allow: [409],
    });
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
    const cacheAccess = trusted ? "write" as const : "read" as const;
    const summaryToken = signSummaryCredential(this.s.summaryKey, { runnerName, repositoryId: repo.id, runId: row.run_id, exp });
    const cacheToken = this.s.cacheSigningKey ? signCacheToken(this.s.cacheSigningKey, { installationId, write: trusted, exp, jobId }) : undefined;
    let res: { instanceId: string | null; already: boolean };
    try {
      res = await this.launcher!.launch({
        jobId, runId: row.run_id, repositoryId: repo.id, repositoryFullName: repo.full_name, installationId, runnerName,
        jitConfig: jit.data.encoded_jit_config, cacheAccess, summaryToken, ...(cacheToken ? { cacheToken } : {}),
      });
    } catch (e) {
      await unregister(e instanceof RetryLater ? "the fleet is full" : "the machine did not start");
      throw e;
    }
    // A redelivery after a partial failure: EC2 returned the first machine (same client token), which has the first
    // just-in-time configuration; this one would never be used.
    if (res.already) await unregister("the job's machine already exists");
    this.log.info({ job: jobId, repository: repo.full_name, runner: runnerName, instance: res.instanceId, already: res.already, cache: cacheAccess }, "runner machine requested");
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
          name: CHECK_NAME, head_sha: job.head_sha, status: "in_progress", external_id: String(job.job_id),
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

  /** Completed jobs whose summary never came (or whose publication failed) are published after the wait. */
  async sweep(): Promise<number> {
    const due = await this.db.q<{ job_id: number }>(
      `select job_id from gh_jobs where status = 'completed' and published_at is null and publish_attempts < 5
         and coalesce(completed_at, updated_at) < now() - make_interval(secs => $1) order by job_id limit 50`, [this.s.summaryWaitSeconds]);
    for (const j of due) {
      try { await this.tryPublish(j.job_id, true); } catch (e) { this.log.warn({ job: j.job_id, err: e instanceof Error ? e.message : String(e) }, "sweep: publish failed"); }
    }
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

    const run = await gh.request<{ event?: string; created_at?: string; head_commit?: { message?: string } | null; pull_requests?: { number: number; head: { ref: string; sha: string }; base: { ref: string } }[] }>(
      "GET", `${base}/actions/runs/${job.run_id}`, { allow: [404] }).then((r) => (r.status === 404 ? null : r.data)).catch(() => null);

    // The pull request: from pull_request events, else from the workflow run.
    let pr = (await this.db.q<{ number: number; fenvix_comment_id: number | null }>(
      "select number, fenvix_comment_id from gh_pull_requests where repository_id = $1 and head_sha = $2 and state = 'open' order by updated_at desc limit 1",
      [job.repository_id, job.head_sha]))[0] ?? null;
    if (!pr && run?.pull_requests?.length) {
      const r0 = run.pull_requests[0]!;
      await this.db.q(
        `insert into gh_pull_requests (repository_id, number, head_sha, head_ref, base_ref, state) values ($1, $2, $3, $4, $5, 'open')
         on conflict (repository_id, number) do update set head_sha = excluded.head_sha, updated_at = now()`,
        [job.repository_id, r0.number, job.head_sha, r0.head.ref, r0.base.ref]);
      pr = (await this.db.q<{ number: number; fenvix_comment_id: number | null }>("select number, fenvix_comment_id from gh_pull_requests where repository_id = $1 and number = $2", [job.repository_id, r0.number]))[0]!;
    }

    // Billing: one event per job that ran on our machines.
    const startedOnFenvix = !!job.runner_name && !!job.started_at;
    let billable: boolean; let reason: string;
    if (summary) { billable = true; reason = job.conclusion === "cancelled" ? "cancelled_after_start" : job.conclusion === "success" ? "completed" : "failed"; }
    else if (job.conclusion === "cancelled" || job.conclusion === "skipped" || !startedOnFenvix) { billable = false; reason = "cancelled_before_tests"; }
    else { billable = true; reason = "no_summary"; }

    const startedAt = job.started_at ?? job.created_at ?? new Date();
    const completedAt = job.completed_at ?? new Date();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    const otherStepMinutes = summary ? Math.max(0, durationMs / 1000 - summary.wallSeconds) / 60 : durationMs / 60_000;
    const minutes = {
      ran: summary ? summary.testSecondsRun / 60 : 0,
      saved: summary ? summary.testSecondsSaved / 60 : 0,
      other: otherStepMinutes,
    };

    const [inst] = await this.db.q<{ workspace_id: string | null }>("select workspace_id from gh_installations where installation_id = $1", [job.installation_id]);
    const ws = inst?.workspace_id ?? null;
    let projectId: string | null = null;
    let ciRunId: string | null = job.ci_run_id;
    let commentsOn = true;
    await this.db.tx(ws, async (c) => {
      let planId: string | null = null;
      if (ws) {
        planId = (await c.query<{ plan_id: string }>("select plan_id from ci_subscriptions where workspace_id = $1", [ws])).rows[0]?.plan_id ?? null;
        projectId = await this.syncProject(c, repo, summary ? { language: "python", testRunner: "pytest" } : null);
        if (projectId) {
          const proj = (await c.query<{ comment_on_pull_requests: boolean }>("select comment_on_pull_requests from ci_projects where id = $1 for update", [projectId])).rows[0]!;
          commentsOn = proj.comment_on_pull_requests;
          // A job that never ran on our machine (not billable) gets no run row: the dashboard counts every row of
          // ci_runs as a used run (src/data/ci.ts usageFrom on main), so rows and billable usage events agree.
          if (!ciRunId && billable) ciRunId = await this.insertRun(c, projectId, job, summary, run, pr?.number ?? null, startedAt, completedAt, durationMs, otherStepMinutes);
          if (summary) await c.query("update ci_projects set setup_state = 'active' where id = $1", [projectId]);
        }
      }
      await c.query(
        `insert into ci_usage_events (installation_id, repository_id, repository_full_name, project_id, ci_run_id, github_job_id, github_run_id,
           github_run_attempt, billable, reason, plan_id, conclusion, test_minutes_ran, minutes_saved, other_step_minutes, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, round($13::numeric, 2), round($14::numeric, 2), round($15::numeric, 2), $16)
         on conflict (github_job_id) do nothing`,
        [job.installation_id, job.repository_id, repo.full_name, projectId, ciRunId, job.job_id, job.run_id, job.run_attempt, billable, reason,
          planId, job.conclusion, minutes.ran, minutes.saved, minutes.other, completedAt]);
    });
    if (ciRunId) await this.db.q("update gh_jobs set ci_run_id = $2 where job_id = $1", [job.job_id, ciRunId]);

    const dashboardRunUrl = projectId && ciRunId ? `${this.s.dashboardUrl}/projects/${projectId}/runs/${ciRunId}` : null;
    const jobUrl = `${this.s.webUrl}/${repo.full_name}/actions/runs/${job.run_id}/job/${job.job_id}`;
    const ctx: RenderContext = {
      repository: repo.full_name, headSha: job.head_sha, workflowName: job.workflow_name || "workflow", jobName: job.job_name, jobUrl,
      receiptsUrl: sumRow?.receipts_url ?? dashboardRunUrl, dashboardRunUrl, jobConclusion: job.conclusion,
    };
    const output = checkRunOutput(summary, ctx);
    if (summaryError) output.summary = `The runner's summary could not be read (${summaryError}).\n\n` + output.summary;
    const conclusion = conclusionOf(summary, job.conclusion);
    const checkBody = {
      name: CHECK_NAME, status: "completed", conclusion, completed_at: completedAt.toISOString(), external_id: String(job.job_id),
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

    if (pr && commentsOn) {
      const body = prComment(summary, { ...ctx, checkRunUrl: check.html_url });
      const id = await this.upsertComment(gh, base, pr.number, pr.fenvix_comment_id, body);
      await this.db.q("update gh_pull_requests set fenvix_comment_id = $3 where repository_id = $1 and number = $2", [job.repository_id, pr.number, id]);
    }
    this.log.info({ repository: repo.full_name, job: job.job_id, conclusion, billable, pr: pr?.number ?? null }, "run published");
  }

  private async insertRun(c: Client, projectId: string, job: JobRow, s: RunSummary | null, run: { event?: string; created_at?: string; head_commit?: { message?: string } | null } | null,
    pr: number | null, startedAt: Date, completedAt: Date, durationMs: number, otherStepMinutes: number): Promise<string> {
    const [push] = (await c.query<{ pushed_at: Date }>("select pushed_at from gh_pushes where repository_id = $1 and sha = $2", [job.repository_id, job.head_sha])).rows;
    const pushedAt = push?.pushed_at ?? (run?.created_at ? new Date(run.created_at) : job.created_at ?? startedAt);
    const event = run?.event ?? (pr ? "pull_request" : "push");
    const trigger = TRIGGERS.has(event) ? event : event === "pull_request_target" ? "pull_request" : "workflow_dispatch";
    const fails = s ? s.failed.length + s.flaky.length : 0;
    const status = job.conclusion === "cancelled" ? "cancelled" : s ? (fails || s.exit !== 0 ? "failed" : "passed") : job.conclusion === "success" ? "passed" : "failed";
    const passedRan = s ? Math.max(0, Math.min(s.ran - fails, (s.outcomeCounts.passed ?? s.ran) - s.reusedWithProof)) : 0;
    const r = await c.query<{ id: string }>(
      `insert into ci_runs (workspace_id, project_id, number, commit_sha, commit_message, branch, pull_request, trigger, status, pushed_at, started_at,
         finished_at, duration_ms, tests_total, tests_ran, tests_passed, tests_failed, tests_skipped, tests_flaky_defects, test_time_ran_ms,
         test_time_skipped_ms, other_step_minutes, engine_version, skip_misses)
       values (public.cp_workspace(), $1, (select coalesce(max(number), 0) + 1 from ci_runs where project_id = $1), $2, $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, round($20::numeric, 2), $21, $22)
       returning id`,
      [projectId, job.head_sha, (run?.head_commit?.message ?? "").split("\n")[0]!.slice(0, 500), job.head_branch ?? "", pr, trigger, status,
        pushedAt, startedAt, completedAt, durationMs, s?.tests ?? 0, s?.ran ?? 0, passedRan, fails, s?.reusedWithProof ?? 0, s?.flaky.length ?? 0,
        Math.round((s?.testSecondsRun ?? 0) * 1000), Math.round((s?.testSecondsSaved ?? 0) * 1000), otherStepMinutes, s?.engineVersion ?? "",
        JSON.stringify(s?.notReusedReasons ?? {})]);
    return r.rows[0]!.id;
  }

  /** One fenvix comment per pull request: updated in place; found again by its marker if our record of it is lost. */
  private async upsertComment(gh: GitHubHttp, base: string, number: number, known: number | null, body: string): Promise<number> {
    let id = known;
    if (!id) {
      const list = await gh.request<{ id: number; body?: string; performed_via_github_app?: { id: number } | null; user?: { type?: string } | null }[]>(
        "GET", `${base}/issues/${number}/comments`, { query: { per_page: 100 } });
      id = list.data.find((cm) => cm.body?.startsWith(COMMENT_MARKER) && cm.user?.type === "Bot")?.id ?? null;
    }
    if (id) {
      const r = await gh.request<{ id: number }>("PATCH", `${base}/issues/comments/${id}`, { body: { body }, allow: [404] });
      if (r.status !== 404) return r.data.id;
    }
    const created = await gh.request<{ id: number }>("POST", `${base}/issues/${number}/comments`, { body: { body } });
    return created.data.id;
  }

  // ---------------------------------------------------------------- linking (called after the setup callback checks)

  async linkInstallation(installationId: number, workspaceId: string, userId: string): Promise<string> {
    await this.ensureInstallation(installationId);
    const r = await this.db.q<{ login: string }>("select public.gh_link_installation($1, $2, $3) as login", [installationId, workspaceId, userId]);
    await this.syncInstallation(installationId);
    return r[0]!.login;
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
