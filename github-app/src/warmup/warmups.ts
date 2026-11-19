import type { KeyObject } from "node:crypto";
import type { Db } from "../db.ts";
import { type GitHubApp, repoPath } from "../github/client.ts";
import { parseSummary, type RunSummary } from "../results/summary.ts";
import { signCacheToken, signSummaryCredential } from "../runners/credentials.ts";
import { type Region, RetryLater, type RunnerLauncher } from "../runners/launcher.ts";
import type { Logger } from "../service.ts";
import { ACTIVE, decide, short, type WarmupOutcome, type WarmupSettings, warmupRunnerName } from "./policy.ts";

/**
 * Warm cache at install (docs/data-contract.md "Warm-up runs"). The customer should almost never see a cold first run:
 *
 *   - when a repository is onboarded (its setup pull request merged, or found already on runs-on: fenvix) in an
 *     installation linked to an organization, when such an installation is linked, and after every push to the
 *     default branch, ONE warm-up of the repository's test job is requested for the default branch's commit;
 *   - the scheduler (`tick`, every minute) gives it a machine of our fleet in the organization's region, only when no
 *     customer job waits there, a machine stays free for customers (reserve), the organization has no other warm-up
 *     running (concurrency) and the repository is under its daily cap. A customer job that finds the fleet full takes
 *     the machine of a running warm-up (`preemptOne`): warm-ups never delay customers;
 *   - a newer default-branch commit supersedes it (a running machine is terminated); the customer's own trusted run on
 *     the same commit covers it (nothing to do);
 *   - the machine runs the test job of the customer's own workflow file at that commit (the same steps, so the cache
 *     keys are those of the customer's runs) outside GitHub Actions: no check run, no comment, no Actions minutes;
 *   - it is never billed: one non-billable usage event, reason "warm-up", per warm-up that used a machine.
 */

export interface WarmupDeps {
  /** Signs the warm-up machine's App credential (RUNNER_TOKEN). */
  summaryKey?: string;
  cacheSigningKey?: KeyObject | null;
}

interface Row {
  id: number; repository_id: number; installation_id: number; workspace_id: string | null; commit_sha: string; ref: string; trigger: string;
  status: string; detail: string; pushed_at: Date; not_before: Date; region: Region | null; runner_name: string | null; instance_id: string | null;
  attempts: number; preemptions: number; covered_by_job: number | null; machine_seconds: number; summary: Record<string, unknown> | null;
  usage_recorded_at: Date | null; terminate_requested_at: Date | null; terminated_at: Date | null; dispatched_at: Date | null;
  started_at: Date | null; finished_at: Date | null;
}

interface RepoCtx {
  repository_id: number; installation_id: number; workspace_id: string | null; full_name: string; default_branch: string | null; removed_at: Date | null;
  onboarding_state: string; onboarding_workflow_path: string | null; onboarding_job: string | null; project_id: string | null;
  cache_warm_sha: string | null; suspended_at: Date | null; deleted_at: Date | null; linked: boolean;
}

export type RequestResult = "created" | "exists" | "superseded" | "ignored";

const REPO_CTX = `select r.repository_id, r.installation_id, r.workspace_id, r.full_name, r.default_branch, r.removed_at, r.onboarding_state,
    r.onboarding_workflow_path, r.onboarding_job, r.project_id, r.cache_warm_sha, i.suspended_at, i.deleted_at, i.workspace_id is not null as linked
  from gh_repositories r join gh_installations i on i.installation_id = r.installation_id where r.repository_id = $1`;

const ONBOARDED = new Set(["merged", "already_fenvix"]);
const SHA = /^[0-9a-f]{40}$/;

const secondsSince = (from: Date | null, now: Date) => (from ? Math.max(0, (now.getTime() - from.getTime()) / 1000) : 0);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export class Warmups {
  private readonly db: Db;
  private readonly gh: GitHubApp;
  private readonly w: WarmupSettings;
  private readonly d: WarmupDeps;
  private readonly log: Logger;
  private readonly launcher: RunnerLauncher | null;
  private readonly now: () => Date;

  constructor(db: Db, gh: GitHubApp, w: WarmupSettings, d: WarmupDeps, log: Logger, launcher: RunnerLauncher | null, now: () => Date = () => new Date()) {
    this.db = db; this.gh = gh; this.w = w; this.d = d; this.log = log; this.launcher = launcher; this.now = now;
  }

  /** Warm-ups are possible: enabled, and a per-job launcher that can start warm-up machines. */
  get active(): boolean {
    return this.w.enabled && !!this.launcher?.launchWarmup && !!this.launcher.slots;
  }

  /** Why a repository gets no warm-up now (null: it may get one). */
  private refuse(r: RepoCtx | undefined): string | null {
    if (!r) return "unknown repository";
    if (!r.linked || !r.workspace_id) return "the installation is not linked to an organization";
    if (r.suspended_at || r.deleted_at) return "the installation is suspended or removed";
    if (r.removed_at) return "the repository was removed from the installation";
    if (!ONBOARDED.has(r.onboarding_state)) return `the repository is not on fenvix yet (${r.onboarding_state})`;
    if (!r.onboarding_workflow_path || !r.onboarding_job) return "the test job is not known";
    if (!r.default_branch) return "the default branch is not known";
    return null;
  }

  private async repoCtx(repositoryId: number): Promise<RepoCtx | undefined> {
    return (await this.db.q<RepoCtx>(REPO_CTX, [repositoryId]))[0];
  }

  // ---------------------------------------------------------------- requests (from webhooks and the link)

  /**
   * One warm-up for this default-branch commit. Supersedes the repository's warm-up in flight for an older commit
   * (by push time; its machine is terminated by the next tick); a warm-up for an older commit than the one in flight is
   * stored superseded at once. Idempotent per (repository, commit).
   */
  async request(o: { repositoryId: number; sha: string; trigger: "onboarded" | "push" | "linked"; pushedAt?: Date; grace?: boolean }): Promise<RequestResult> {
    if (!this.active) return "ignored";
    if (!SHA.test(o.sha)) return "ignored";
    const r = await this.repoCtx(o.repositoryId);
    const why = this.refuse(r);
    if (why || !r) {
      this.log.info({ repositoryId: o.repositoryId, sha: o.sha, trigger: o.trigger, why }, "no warm-up");
      return "ignored";
    }
    const now = this.now();
    const pushedAt = o.pushedAt ?? now;
    // Any default-branch push newer (by push time) than a warm-up in flight for ANOTHER commit takes that commit's
    // place on the branch: that warm-up ends now, before the "already warm" and "already requested" answers below. A
    // reset of the branch to a commit that is already warm (git push --force origin H:main) therefore stops the warm-up
    // of the commit it removed, which would otherwise run with a write cache token (review R-018 F1).
    await this.supersedeOlder(r, o.sha, pushedAt);
    if (r.cache_warm_sha === o.sha) return "exists";
    let notBefore = o.grace === false ? now : new Date(now.getTime() + this.w.graceSeconds * 1000);
    let waitDetail = o.grace === false ? "waiting for a machine" : `waiting ${this.w.graceSeconds} s for the customer's own run of this commit`;
    // The runner could not run this job outside GitHub Actions lately: one try a day, not one machine per push.
    const unsupported = (await this.db.q<{ finished_at: Date; detail: string }>(
      `select finished_at, detail from gh_warmups where repository_id = $1 and status = 'unsupported' and finished_at > $2::timestamptz - interval '24 hours'
       order by finished_at desc limit 1`, [o.repositoryId, now]))[0];
    if (unsupported) {
      const retry = new Date(unsupported.finished_at.getTime() + 86_400_000);
      if (retry > notBefore) {
        notBefore = retry;
        waitDetail = `the last warm-up could not run this job (${unsupported.detail.slice(0, 300)}); trying again after ${retry.toISOString().slice(0, 16).replace("T", " ")} UTC`;
      }
    }
    return this.db.tx(null, async (c) => {
      // One request at a time per repository (two pushes delivered together).
      await c.query("select 1 from gh_repositories where repository_id = $1 for update", [o.repositoryId]);
      const have = (await c.query<{ id: number; status: string; pushed_at: Date; had_machine: boolean }>(
        `select id, status, pushed_at, (attempts > 0 or machine_seconds > 0 or usage_recorded_at is not null or terminate_requested_at is not null) as had_machine
         from gh_warmups where repository_id = $1 and commit_sha = $2`, [o.repositoryId, o.sha])).rows[0];
      if (have) {
        // The branch was moved back to a commit whose warm-up was superseded before it got a machine (pushed again,
        // later): it is the head again, so it is warmed again. A replayed delivery carries the same push time and
        // changes nothing. (One that already had a machine keeps its record: one warm-up per commit.)
        if (have.status === "superseded" && !have.had_machine && pushedAt > have.pushed_at) {
          const newerInFlight = (await c.query("select 1 from gh_warmups where repository_id = $1 and status in ('pending', 'dispatched', 'running') and pushed_at > $2",
            [o.repositoryId, pushedAt])).rows.length > 0;
          if (!newerInFlight) {
            await c.query(
              `update gh_warmups set status = 'pending', trigger = $2, detail = $3, pushed_at = $4, not_before = $5, finished_at = null, covered_by_job = null,
                 runner_name = null, dispatched_at = null, started_at = null, updated_at = now()
               where id = $1 and status = 'superseded'`, [have.id, o.trigger, waitDetail, pushedAt, notBefore]);
            this.log.info({ repository: r.full_name, sha: o.sha, trigger: o.trigger }, "warm-up requested again (the branch is back at this commit)");
            return "created" as const;
          }
        }
        return "exists" as const;
      }
      const newer = (await c.query<{ commit_sha: string }>(
        `select commit_sha from gh_warmups where repository_id = $1 and status in ('pending', 'dispatched', 'running') and pushed_at > $2`,
        [o.repositoryId, pushedAt])).rows[0];
      if (newer) {
        await c.query(
          `insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, detail, pushed_at, not_before, finished_at)
           values ($1, $2, $3, $4, $5, 'superseded', $6, $7, $8, now())`,
          [o.repositoryId, r.installation_id, o.sha, `refs/heads/${r.default_branch}`, o.trigger, `a newer commit (${short(newer.commit_sha)}) is already being warmed`, pushedAt, now]);
        return "superseded" as const;
      }
      await c.query(
        `update gh_warmups set status = 'superseded', detail = $2, finished_at = now(), updated_at = now(),
           terminate_requested_at = case when status in ('dispatched', 'running') then now() end
         where repository_id = $1 and status in ('pending', 'dispatched', 'running')`,
        [o.repositoryId, `superseded by a newer commit on ${r.default_branch} (${short(o.sha)})`]);
      await c.query(
        `insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, detail, pushed_at, not_before)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [o.repositoryId, r.installation_id, o.sha, `refs/heads/${r.default_branch}`, o.trigger, waitDetail, pushedAt, notBefore]);
      this.log.info({ repository: r.full_name, sha: o.sha, trigger: o.trigger }, "warm-up requested");
      return "created" as const;
    });
  }

  /** Ends the warm-ups in flight of other commits pushed before `pushedAt` (their machines: terminated by the next tick). */
  private async supersedeOlder(r: RepoCtx, sha: string, pushedAt: Date): Promise<number> {
    const rows = await this.db.q(
      `update gh_warmups set status = 'superseded', detail = $4, finished_at = now(), updated_at = now(),
         terminate_requested_at = case when status in ('dispatched', 'running') then now() end
       where repository_id = $1 and commit_sha <> $2 and status in ('pending', 'dispatched', 'running') and pushed_at < $3
       returning id`,
      [r.repository_id, sha, pushedAt, `superseded by a newer commit on ${r.default_branch} (${short(sha)})`]);
    return rows.length;
  }

  /** A warm-up of the default branch's head (the link; a repository found already on fenvix). Asks GitHub for it. */
  async requestHead(repositoryId: number, trigger: "onboarded" | "linked"): Promise<RequestResult> {
    if (!this.active) return "ignored";
    const r = await this.repoCtx(repositoryId);
    if (this.refuse(r) || !r) return this.request({ repositoryId, sha: "", trigger });
    const gh = this.gh.installation(r.installation_id);
    const ref = await gh.request<{ object?: { sha?: string } }>("GET", `${repoPath(r.full_name)}/git/ref/heads/${encodeURIComponent(r.default_branch!)}`, { allow: [404, 409] });
    const sha = ref.status === 200 ? ref.data.object?.sha ?? "" : "";
    if (!SHA.test(sha)) {
      this.log.warn({ repository: r.full_name, status: ref.status }, "no warm-up: the default branch has no commit");
      return "ignored";
    }
    const pushed = (await this.db.q<{ pushed_at: Date }>("select pushed_at from gh_pushes where repository_id = $1 and sha = $2", [repositoryId, sha]))[0];
    return this.request({ repositoryId, sha, trigger, ...(pushed ? { pushedAt: pushed.pushed_at } : {}), grace: false });
  }

  /** The warm-ups in flight of these repositories end (cancelled); their machines are terminated by the next tick. */
  async cancelRepositories(repositoryIds: number[], detail: string): Promise<number> {
    if (!repositoryIds.length) return 0;
    const r = await this.db.q(
      `update gh_warmups set status = 'cancelled', detail = $2, finished_at = now(), updated_at = now(),
         terminate_requested_at = case when status in ('dispatched', 'running') then now() end
       where repository_id = any($1::bigint[]) and status in ('pending', 'dispatched', 'running') returning id`, [repositoryIds, detail]);
    return r.length;
  }

  async cancelInstallation(installationId: number, detail: string): Promise<number> {
    const repos = await this.db.q<{ repository_id: number }>("select repository_id from gh_repositories where installation_id = $1", [installationId]);
    return this.cancelRepositories(repos.map((x) => x.repository_id), detail);
  }

  // ---------------------------------------------------------------- the customer's own runs

  /**
   * A customer job with write access to the shared cache (a trusted run on the default branch) was given a machine:
   * a pending warm-up of the same commit is covered by it.
   */
  async onTrustedJob(repositoryId: number, sha: string, jobId: number): Promise<void> {
    await this.db.q(
      `update gh_warmups set status = 'covered', covered_by_job = $3, finished_at = now(), updated_at = now(),
         detail = 'the customer''s own run of this commit fills the cache'
       where repository_id = $1 and commit_sha = $2 and status = 'pending'`, [repositoryId, sha, jobId]);
  }

  /**
   * A customer's job was published. With write access and a summary: the cache is warm at its commit. Without a
   * summary (cancelled, or no result): a warm-up it covered is pending again (unless a newer one is in flight).
   */
  async onJobPublished(job: { job_id: number; repository_id: number; head_sha: string; cache_access: string | null }, hadSummary: boolean, at: Date): Promise<void> {
    if (job.cache_access !== "write") return;
    if (hadSummary) {
      await this.markWarm(job.repository_id, job.head_sha, "run", at);
      return;
    }
    await this.db.q(
      `update gh_warmups w set status = 'pending', covered_by_job = null, finished_at = null, not_before = now(), updated_at = now(),
         detail = 'the customer''s run of this commit ended without results: warming it up'
       where w.covered_by_job = $1 and w.status = 'covered'
         and not exists (select 1 from gh_warmups o where o.repository_id = w.repository_id and o.status in ('pending', 'dispatched', 'running'))`,
      [job.job_id]);
  }

  /**
   * The cache holds this default-branch commit's proofs. Ordered by push time: an older commit finishing late never
   * replaces a newer one. A pending warm-up of the same commit is no longer needed.
   */
  async markWarm(repositoryId: number, sha: string, source: "warmup" | "run", at: Date): Promise<boolean> {
    const pushed = (await this.db.q<{ pushed_at: Date }>(
      `select coalesce((select pushed_at from gh_pushes where repository_id = $1 and sha = $2),
                       (select pushed_at from gh_warmups where repository_id = $1 and commit_sha = $2), $3::timestamptz) as pushed_at`,
      [repositoryId, sha, at]))[0]!.pushed_at;
    const r = await this.db.q(
      `update gh_repositories set cache_warm_sha = $2, cache_warm_at = $3, cache_warm_source = $4, cache_warm_pushed_at = $5, updated_at = now()
       where repository_id = $1 and (cache_warm_pushed_at is null or cache_warm_pushed_at <= $5) returning repository_id`,
      [repositoryId, sha, at, source, pushed]);
    if (source === "run") {
      await this.db.q(
        `update gh_warmups set status = 'covered', finished_at = now(), updated_at = now(), detail = 'the customer''s own run of this commit filled the cache'
         where repository_id = $1 and commit_sha = $2 and status = 'pending'`, [repositoryId, sha]);
    }
    return r.length > 0;
  }

  // ---------------------------------------------------------------- what the machine reports

  /**
   * POST /v1/runner/warmups. `started`: the machine checked out the commit and is running the job. `finished`: the
   * outcome and, when the job's test step ran, the runner's summary.json. Late or repeated reports are answered like
   * the first (the machine does not retry them); "forbidden": the credential is not this warm-up's machine.
   */
  async report(scope: { warmupId: number; repositoryId: number; runnerName: string },
    body: { event: "started" | "finished"; outcome?: WarmupOutcome; detail?: string; summary?: Record<string, unknown> }): Promise<"stored" | "ignored" | "forbidden" | "unknown"> {
    const [row] = await this.db.q<Row>("select * from gh_warmups where id = $1", [scope.warmupId]);
    if (!row) return "unknown";
    if (row.repository_id !== scope.repositoryId || row.runner_name !== scope.runnerName) return "forbidden";
    const now = this.now();
    if (body.event === "started") {
      const r = await this.db.q("update gh_warmups set status = 'running', started_at = $2, detail = 'running the test job', updated_at = now() where id = $1 and status = 'dispatched' returning id", [row.id, now]);
      return r.length ? "stored" : "ignored";
    }
    // Only the machine of a warm-up in flight, or of one superseded or cancelled while its machine ran. A preempted
    // warm-up (pending again) ignores its old machine; a warm-up already ended ignores a repeated report.
    if (row.usage_recorded_at || !["dispatched", "running", "superseded", "cancelled"].includes(row.status)) return "ignored";
    if (["superseded", "cancelled"].includes(row.status) && !row.dispatched_at) return "ignored";
    let summary: RunSummary | null = null;
    if (body.summary) { try { summary = parseSummary(body.summary); } catch { summary = null; } }
    const outcome: WarmupOutcome = body.outcome ?? (summary ? "succeeded" : "failed");
    const detail = (body.detail ?? (outcome === "succeeded" ? "the cache holds this commit's proofs" : outcome === "unsupported" ? "the runner cannot run this job outside GitHub Actions" : "the test job failed"))
      .slice(0, 1000);
    const seconds = secondsSince(row.dispatched_at, now);
    const updated = await this.db.q<Row>(
      `update gh_warmups set status = case when status in ('dispatched', 'running') then $2 else status end,
         detail = case when status in ('dispatched', 'running') then $3 else detail end,
         summary = $4::jsonb, finished_at = coalesce(finished_at, $5),
         -- A machine already terminated by the scheduler had its time counted then.
         machine_seconds = machine_seconds + case when terminated_at is null then round($6::numeric, 2) else 0 end,
         terminated_at = case when terminate_requested_at is not null then coalesce(terminated_at, $5) end, updated_at = now()
       where id = $1 and usage_recorded_at is null returning *`,
      [row.id, outcome, detail, body.summary ? JSON.stringify(body.summary) : null, now, seconds]);
    const done = updated[0];
    if (!done) return "ignored";
    // A successful warm-up warms the cache at its commit, even when a newer one superseded it meanwhile (the push
    // order keeps the newest commit shown).
    if (outcome === "succeeded" && summary) await this.markWarm(row.repository_id, row.commit_sha, "warmup", now);
    await this.recordUsage(done);
    this.log.info({ warmup: row.id, repositoryId: row.repository_id, sha: row.commit_sha, outcome, status: done.status }, "warm-up finished");
    return "stored";
  }

  /** The warm-up's one non-billable usage event (reason "warm-up"), once a machine ran for it and it ended. */
  private async recordUsage(row: Row): Promise<void> {
    if (row.usage_recorded_at || ACTIVE.includes(row.status as (typeof ACTIVE)[number])) return;
    if (!(Number(row.machine_seconds) > 0) && !row.summary) return;
    if (row.terminate_requested_at && !row.terminated_at) return;
    const repo = await this.repoCtx(row.repository_id);
    if (!repo?.workspace_id) return;
    let s: RunSummary | null = null;
    if (row.summary) { try { s = parseSummary(row.summary); } catch { s = null; } }
    // The minutes our machine was held, by the App's own clock (dispatch to report or termination), never the
    // summary's: the summary is written by the job user (review R-016 F3). It is bounded by them, shown, never billed.
    const held = Math.max(0, Number(row.machine_seconds) / 60);
    const ran = s ? Math.min(s.testSecondsRun / 60, held) : 0;
    const saved = s ? s.testSecondsSaved / 60 : 0;
    const other = Math.max(0, held - ran);
    await this.db.tx(repo.workspace_id, async (c) => {
      const plan = (await c.query<{ plan_id: string }>("select plan_id from ci_subscriptions where workspace_id = $1", [repo.workspace_id])).rows[0]?.plan_id ?? null;
      await c.query(
        `insert into ci_usage_events (installation_id, repository_id, repository_full_name, project_id, warmup_id, kind, billable, reason, plan_id,
           conclusion, test_minutes_ran, minutes_saved, other_step_minutes, held_minutes, occurred_at)
         values ($1, $2, $3, $4, $5, 'warmup', false, 'warm-up', $6, $7, round($8::numeric, 2), round($9::numeric, 2), round($10::numeric, 2),
           round($11::numeric, 2), $12)
         on conflict (warmup_id) do nothing`,
        [row.installation_id, row.repository_id, repo.full_name, repo.project_id, row.id, plan, row.status, ran, saved, other, held, row.finished_at ?? this.now()]);
      await c.query("update gh_warmups set usage_recorded_at = now() where id = $1", [row.id]);
    });
  }

  // ---------------------------------------------------------------- preemption (a customer job needs the machine)

  /**
   * The fleet of `region` is full and a customer's job waits: the newest warm-up on a machine there gives its machine
   * back (terminated now) and goes back to pending (it runs again later). True if a machine was freed.
   */
  async preemptOne(region: Region): Promise<boolean> {
    if (!this.launcher?.terminateWarmup) return false;
    const [row] = await this.db.q<Row>(
      `update gh_warmups set status = 'pending', preemptions = preemptions + 1, not_before = now() + make_interval(secs => $2),
         detail = 'gave its machine to a customer job; it runs again later', terminate_requested_at = now(), terminated_at = null, updated_at = now()
       where id = (select id from gh_warmups where region = $1 and status in ('dispatched', 'running') order by dispatched_at desc limit 1 for update skip locked)
       returning *`, [region, this.w.preemptBackoffSeconds]);
    if (!row) return false;
    await this.terminate(row);
    this.log.warn({ warmup: row.id, region }, "warm-up preempted by a customer job");
    return true;
  }

  private async terminate(row: Row): Promise<void> {
    if (!row.region || !this.launcher?.terminateWarmup) return;
    const ids = await this.launcher.terminateWarmup(row.region, row.id);
    const now = this.now();
    await this.db.q(
      `update gh_warmups set terminated_at = $2, machine_seconds = machine_seconds + round($3::numeric, 2), updated_at = now()
       where id = $1 and terminated_at is null`, [row.id, now, secondsSince(row.dispatched_at, now)]);
    this.log.info({ warmup: row.id, instances: ids }, "warm-up machine terminated");
  }

  // ---------------------------------------------------------------- the scheduler

  /** One pass: give up stuck machines, terminate unneeded ones, record usage, mark covered, dispatch. */
  async tick(): Promise<{ dispatched: number; covered: number; terminated: number; expired: number; waiting: number }> {
    const out = { dispatched: 0, covered: 0, terminated: 0, expired: 0, waiting: 0 };
    if (!this.active) return out;
    const now = this.now();

    // 1. A machine that never said "started", or a warm-up running too long.
    const stuck = await this.db.q<Row>(
      `update gh_warmups set
         status = case when status = 'running' then 'failed' when attempts >= $3::int then 'cancelled' else 'pending' end,
         detail = case when status = 'running' then 'stopped: it ran longer than ' || ($4::int / 60) || ' minutes'
                       when attempts >= $3::int then 'no machine started for it after ' || attempts || ' tries'
                       else 'its machine did not start in time; it is tried again' end,
         finished_at = case when status = 'running' or attempts >= $3::int then $1::timestamptz end,
         terminate_requested_at = $1, terminated_at = null, updated_at = now()
       where (status = 'dispatched' and dispatched_at < $1::timestamptz - make_interval(secs => $2::int))
          or (status = 'running' and started_at < $1::timestamptz - make_interval(secs => $4::int))
       returning *`, [now, this.w.startTimeoutSeconds, this.w.maxAttempts, this.w.maxRunSeconds]);
    out.expired = stuck.length;

    // 2. Machines that are no longer needed (superseded, cancelled, given up).
    const toStop = await this.db.q<Row>("select * from gh_warmups where terminate_requested_at is not null and terminated_at is null and region is not null order by id limit 50");
    for (const r of toStop) {
      try { await this.terminate(r); out.terminated++; } catch (e) { this.log.warn({ warmup: r.id, err: errText(e) }, "warm-up machine not terminated (next tick)"); }
    }

    // 3. Usage of warm-ups that ended.
    const ended = await this.db.q<Row>(
      `select * from gh_warmups where usage_recorded_at is null and status not in ('pending', 'dispatched', 'running')
         and (machine_seconds > 0 or summary is not null) and (terminate_requested_at is null or terminated_at is not null) order by id limit 50`);
    for (const r of ended) await this.recordUsage(r).catch((e: unknown) => this.log.warn({ warmup: r.id, err: errText(e) }, "warm-up usage not recorded (next tick)"));

    // 4. Covered by the customer's own trusted run of the same commit, while that run has not been published yet. A
    //    published run either warmed the cache (then dispatchOne finds cache_warm_sha) or ended without results; the
    //    latter re-armed the warm-up (onJobPublished) and must never cover it again, whatever its conclusion
    //    (review R-018 F2: a run that failed before its tests left the commit cold).
    const covered = await this.db.q(
      `update gh_warmups w set status = 'covered', covered_by_job = j.job_id, finished_at = now(), updated_at = now(),
         detail = 'the customer''s own run of this commit fills the cache'
       from gh_jobs j
       where w.status = 'pending' and j.repository_id = w.repository_id and j.head_sha = w.commit_sha and j.cache_access = 'write'
         and j.published_at is null and coalesce(j.conclusion, '') not in ('cancelled', 'skipped')
       returning w.id`);
    out.covered = covered.length;

    // 5. Dispatch, oldest first, while the rules allow.
    const due = await this.db.q<Row>("select * from gh_warmups where status = 'pending' and not_before <= $1 order by not_before, id limit 25", [now]);
    const slots = new Map<Region, { running: number; max: number }>();
    for (const row of due) {
      try {
        const r = await this.dispatchOne(row, slots);
        if (r === "dispatched") out.dispatched++; else if (r === "waiting") out.waiting++;
      } catch (e) {
        this.log.error({ warmup: row.id, err: errText(e) }, "warm-up dispatch failed");
      }
    }
    if (out.dispatched || out.terminated || out.expired || out.covered) this.log.info(out, "warm-up tick");
    return out;
  }

  private async dispatchOne(row: Row, slots: Map<Region, { running: number; max: number }>): Promise<"dispatched" | "waiting" | "cancelled"> {
    const repo = await this.repoCtx(row.repository_id);
    const why = this.refuse(repo);
    if (why || !repo) {
      await this.db.q("update gh_warmups set status = 'cancelled', detail = $2, finished_at = now(), updated_at = now() where id = $1 and status = 'pending'", [row.id, why]);
      return "cancelled";
    }
    if (repo.cache_warm_sha === row.commit_sha) {
      await this.db.q("update gh_warmups set status = 'covered', detail = 'the cache already holds this commit', finished_at = now(), updated_at = now() where id = $1 and status = 'pending'", [row.id]);
      return "cancelled";
    }
    const ws = repo.workspace_id!;
    const region: Region = await this.db.tx(ws, async (c) =>
      ((await c.query<{ region: string | null }>("select region from public.workspaces where id = public.cp_workspace()")).rows[0]?.region === "eu" ? "eu" : "us"));
    const wait = async (detail: string, retryAt?: Date) => {
      await this.db.q("update gh_warmups set detail = $2, not_before = greatest(not_before, coalesce($3::timestamptz, not_before)), updated_at = now() where id = $1 and status = 'pending'",
        [row.id, detail, retryAt ?? null]);
      return "waiting" as const;
    };
    const canPlace = this.launcher!.canPlace ? this.launcher!.canPlace(region) : true;
    let slot = slots.get(region);
    if (canPlace && !slot) {
      const s = await this.launcher!.slots!(region);
      slot = { running: s.running, max: s.max };
      slots.set(region, slot);
    }
    const [counts] = await this.db.q<{ waiting: number; org_active: number; repo_24h: number; oldest: Date | null }>(
      `select (select count(*)::int from gh_jobs where status = 'queued' and launched_at is null and region = $1
                 and coalesce(created_at, updated_at) > now() - make_interval(secs => $2::int)) as waiting,
              (select count(*)::int from gh_warmups where workspace_id = $3 and status in ('dispatched', 'running')) as org_active,
              (select count(*)::int from gh_warmups where repository_id = $4 and dispatched_at > now() - interval '24 hours') as repo_24h,
              (select min(dispatched_at) from gh_warmups where repository_id = $4 and dispatched_at > now() - interval '24 hours') as oldest`,
      [region, this.w.waitingJobWindowSeconds, ws, row.repository_id]);
    const d = decide(this.w, region, {
      canPlace, customerJobsWaiting: counts!.waiting, running: slot?.running ?? 0, max: slot?.max ?? 0,
      orgActive: counts!.org_active, repoLast24h: counts!.repo_24h, oldestLast24h: counts!.oldest,
    });
    if (!d.dispatch) return wait(d.detail, d.retryAt);
    if (!this.d.summaryKey) return wait("no summary signing key (RUNNER_TOKEN): no machine is started without its own credential");

    // The commit must still be the default branch's head, read from GitHub now: a commit taken off the branch (reset,
    // force push) never runs with a write cache token, even when no webhook told us (review R-018 F1). A newer head is
    // requested in its place (a lost push webhook does not leave the cache cold).
    const gh = this.gh.installation(repo.installation_id);
    const ref = await gh.request<{ object?: { sha?: string } }>("GET", `${repoPath(repo.full_name)}/git/ref/heads/${encodeURIComponent(repo.default_branch!)}`, { allow: [404, 409] });
    const head = ref.status === 200 ? ref.data.object?.sha ?? "" : "";
    if (head !== row.commit_sha) {
      const detail = SHA.test(head)
        ? `superseded: ${short(row.commit_sha)} is no longer the head of ${repo.default_branch} (now ${short(head)})`
        : `superseded: ${repo.default_branch} has no head commit now`;
      const ended = await this.db.q("update gh_warmups set status = 'superseded', detail = $2, finished_at = now(), updated_at = now() where id = $1 and status = 'pending' returning id", [row.id, detail]);
      this.log.warn({ warmup: row.id, repository: repo.full_name, sha: row.commit_sha, head }, "warm-up superseded: the commit is no longer the default branch's head");
      if (ended.length && SHA.test(head)) {
        const pushed = (await this.db.q<{ pushed_at: Date }>("select pushed_at from gh_pushes where repository_id = $1 and sha = $2", [repo.repository_id, head]))[0];
        await this.request({ repositoryId: repo.repository_id, sha: head, trigger: row.trigger as "onboarded" | "push" | "linked", pushedAt: pushed?.pushed_at ?? this.now() });
      }
      return "cancelled";
    }

    // Claim it (one dispatcher wins), then the machine.
    const attempt = row.attempts + 1;
    const runnerName = warmupRunnerName(row.id, attempt);
    const claimed = await this.db.q<Row>(
      `update gh_warmups set status = 'dispatched', attempts = $2, runner_name = $3, region = $4, dispatched_at = now(), started_at = null,
         terminate_requested_at = null, terminated_at = null, instance_id = null, detail = $5, updated_at = now()
       where id = $1 and status = 'pending' returning *`,
      [row.id, attempt, runnerName, region, `a machine was requested in ${region}`]);
    if (!claimed[0]) return "waiting";
    const release = async (detail: string, final = false) => {
      await this.db.q(
        `update gh_warmups set status = $3, detail = $2, finished_at = case when $3 = 'failed' then now() end, dispatched_at = null, runner_name = null,
           attempts = attempts - case when $3 = 'pending' then 1 else 0 end, updated_at = now()
         where id = $1 and status = 'dispatched'`, [row.id, detail, final ? "failed" : "pending"]);
    };
    try {
      // The checkout: a token for this one repository, read-only (contents), one hour.
      const tok = await this.gh.app.request<{ token: string; expires_at: string }>("POST", `/app/installations/${repo.installation_id}/access_tokens`, {
        body: { repository_ids: [repo.repository_id], permissions: { contents: "read", metadata: "read" } },
      });
      const exp = Math.floor(Date.now() / 1000) + this.w.maxRunSeconds + 3600;
      const summaryToken = signSummaryCredential(this.d.summaryKey, { runnerName, repositoryId: repo.repository_id, warmupId: row.id, exp });
      const cacheToken = this.d.cacheSigningKey ? signCacheToken(this.d.cacheSigningKey, { installationId: repo.installation_id, write: true, exp, warmupId: row.id }) : undefined;
      const res = await this.launcher!.launchWarmup!({
        warmupId: row.id, attempt, repositoryId: repo.repository_id, repositoryFullName: repo.full_name, installationId: repo.installation_id,
        commitSha: row.commit_sha, ref: row.ref, workflowPath: repo.onboarding_workflow_path!, job: repo.onboarding_job!, runnerName,
        checkoutToken: tok.data.token, summaryToken, ...(cacheToken ? { cacheToken } : {}), region,
      });
      await this.db.q("update gh_warmups set instance_id = $2 where id = $1", [row.id, res.instanceId]);
      slot!.running++;
      this.log.info({ warmup: row.id, repository: repo.full_name, sha: row.commit_sha, region, instance: res.instanceId, attempt }, "warm-up machine requested");
      return "dispatched";
    } catch (e) {
      if (e instanceof RetryLater) { await release(`waiting for a free machine in ${region}`); return "waiting"; }
      await release(`the machine could not be requested: ${errText(e)}`, attempt >= this.w.maxAttempts);
      throw e;
    }
  }
}
