/**
 * Work on our machines that is not a customer's CI job (docs/data-contract.md "Replays and explorations on our
 * machines"):
 *
 *   - replays: `fenvix replay` of one defect's bundle (or one test of a run) at a commit, asked for from the dashboard,
 *     the API (a key with the replay scope), the remote MCP server or the pull request; the machine reports the result,
 *     which goes to the defect (a defect whose minimal order passes 10 of 10 on a later commit is fixed);
 *   - explorations: the nightly exploration of every project that has it on (at its hour, under its time cap and seed
 *     budget, targeting all tests or only the unstable ones), and ones asked for a pull request or by hand. The machine
 *     reports through POST /v1/runner/explorations with its task credential; the report is stored as that job's night;
 *   - stopping a run: the GitHub job is cancelled and its machine ended.
 *
 * Machines come from the launcher (P-047's fleet: TaskLaunch, fenvix-task.target). Without one, tasks wait as requested
 * and say so. Every write names the organization (row level security); due tasks are found across organizations only
 * through gh_due_tasks(), which returns ids and organizations, nothing else.
 */
import type { Db } from "../db.ts";
import type { GitHubApp } from "../github/client.ts";
import { signSummaryCredential } from "../runners/credentials.ts";
import { type Region, RetryLater, type RunnerLauncher } from "../runners/launcher.ts";
import type { Logger } from "../service.ts";

/** A task machine's credential lives this long: past the longest exploration (4 hours) and the report's retries. */
const TASK_CREDENTIAL_SECONDS = 6 * 3600;
/** A dispatched task whose machine never reported is tried again after this long, three machines at most. */
const TASK_START_TIMEOUT_SECONDS = 1200;
const TASK_MAX_ATTEMPTS = 3;
/** Replays a defect gets at most per day (from any source): a loop of requests cannot hold the fleet. */
export const REPLAYS_PER_DEFECT_PER_DAY = 10;

export interface TaskSettings { summaryKey?: string; apiUrl: string }

export interface ReplayReport {
  replayId: string; event: "started" | "finished"; outcome?: "passed" | "failed" | "error"; runs?: number; fails?: number;
  fingerprint?: string; identicalFingerprint?: boolean; detail?: string; command?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class Tasks {
  private readonly db: Db;
  private readonly gh: GitHubApp;
  private readonly s: TaskSettings;
  private readonly log: Logger;
  private readonly launcher: RunnerLauncher | null;

  constructor(db: Db, gh: GitHubApp, s: TaskSettings, log: Logger, launcher: RunnerLauncher | null) {
    this.db = db; this.gh = gh; this.s = s; this.log = log; this.launcher = launcher;
  }

  get canLaunch(): boolean { return !!this.launcher?.launchTask && !!this.s.summaryKey; }

  // ---------------------------------------------------------------- scheduling

  /**
   * The scheduler (every minute, with the warm-ups): nightly explorations of the projects that have them on are
   * created once per UTC day at their hour; due replays and explorations get machines; tasks whose machine never
   * reported are tried again or fail.
   */
  async tick(now = new Date()): Promise<{ scheduled: number; dispatched: number }> {
    const scheduled = (await this.db.q<{ n: number }>("select public.gh_schedule_explorations($1::timestamptz) as n", [now]))[0]?.n ?? 0;
    const due = await this.db.q<{ kind: "replay" | "exploration"; id: string; workspace_id: string }>(
      "select kind, id, workspace_id from public.gh_due_tasks($1::timestamptz, $2::int)", [now, TASK_START_TIMEOUT_SECONDS]);
    let dispatched = 0;
    for (const t of due) {
      try {
        if (await this.dispatch(t.kind, t.id, t.workspace_id)) dispatched++;
      } catch (e) {
        if (e instanceof RetryLater) { this.log.info({ task: t.id, why: e.message }, "task waits for a machine"); continue; }
        this.log.warn({ task: t.id, kind: t.kind, err: e instanceof Error ? e.message : String(e) }, "task dispatch failed");
      }
    }
    return { scheduled: Number(scheduled), dispatched };
  }

  /** One task to a machine. Returns false when it waits (no launcher, no placement) or is done. */
  async dispatch(kind: "replay" | "exploration", id: string, ws: string): Promise<boolean> {
    if (!UUID.test(id)) throw new Error("not a task id");
    const t = await this.db.tx(ws, async (c) => {
      const table = kind === "replay" ? "ci_replays" : "ci_exploration_jobs";
      const row = (await c.query<{ id: string; project_id: string; status: string; attempts: number; commit_sha: string | null; dispatched_at: Date | null;
        test_id?: string; defect_id?: string | null; budget_seconds?: number; seeds?: number; targets?: string[]; reason?: string; branch?: string | null; command?: string | null }>(
        `select * from ${table} where id = $1 and workspace_id = public.cp_workspace() for update`, [id])).rows[0];
      if (!row || !["requested", "pending", "dispatched"].includes(row.status)) return null;
      const repo = (await c.query<{ repository_id: number; full_name: string; installation_id: number; default_branch: string | null }>(
        "select repository_id, full_name, installation_id, default_branch from gh_repositories where project_id = $1 and removed_at is null and disconnected_at is null",
        [row.project_id])).rows[0];
      const region = ((await c.query<{ region: string }>("select region from workspaces where id = public.cp_workspace()")).rows[0]?.region === "eu" ? "eu" : "us") as Region;
      const fail = async (detail: string) => {
        await c.query(`update ${table} set status = ${kind === "replay" ? "'error'" : "'failed'"}, detail = $2, finished_at = now() where id = $1`, [id, detail]);
        return null;
      };
      if (!repo) return fail("the repository is no longer connected to fenvix");
      if (row.attempts >= TASK_MAX_ATTEMPTS) return fail(`no machine reported after ${TASK_MAX_ATTEMPTS} tries`);
      let bundle: string | null = null;
      if (kind === "replay" && row.defect_id) {
        bundle = (await c.query<{ id: string }>("select bundle_id as id from ci_defects where id = $1", [row.defect_id])).rows[0]?.id ?? null;
      }
      return { row, repo, region, bundle };
    });
    if (!t) return false;
    if (!this.canLaunch || (this.launcher!.canPlace && !this.launcher!.canPlace(t.region))) {
      await this.db.tx(ws, (c) => c.query(`update ${kind === "replay" ? "ci_replays" : "ci_exploration_jobs"} set detail = $2 where id = $1 and detail = ''`,
        [id, `waiting for a fenvix machine in ${t.region.toUpperCase()}`]));
      return false;
    }
    const gh = this.gh.installation(t.repo.installation_id);
    let commit = t.row.commit_sha;
    if (!commit) {
      // A nightly exploration explores the default branch's head.
      const ref = await gh.request<{ object: { sha: string } }>("GET", `/repos/${t.repo.full_name}/git/ref/heads/${encodeURIComponent(t.repo.default_branch ?? "main")}`);
      commit = ref.data.object.sha;
    }
    const attempt = t.row.attempts + 1;
    const runnerName = `fenvix-${kind === "replay" ? "r" : "x"}${id.slice(0, 8)}-${attempt}`;
    const tok = await this.gh.app.request<{ token: string }>("POST", `/app/installations/${t.repo.installation_id}/access_tokens`, {
      body: { repository_ids: [t.repo.repository_id], permissions: { contents: "read", metadata: "read" } },
    });
    const exp = Math.floor(Date.now() / 1000) + TASK_CREDENTIAL_SECONDS;
    const summaryToken = signSummaryCredential(this.s.summaryKey!, { runnerName, repositoryId: t.repo.repository_id, task: { kind, id }, exp });
    const spec: Record<string, unknown> = kind === "replay"
      ? { defectId: t.row.defect_id ?? null, testId: t.row.test_id, command: t.row.command ?? null, runs: 10,
          bundleUrl: t.bundle ? `${this.s.apiUrl}/v1/runner/replays/${id}/bundle` : null }
      : { reason: t.row.reason, branch: t.row.branch ?? t.repo.default_branch, budgetSeconds: t.row.budget_seconds, seeds: t.row.seeds, targets: t.row.targets ?? [] };
    await this.launcher!.launchTask!({
      kind, taskId: id, attempt, repositoryId: t.repo.repository_id, repositoryFullName: t.repo.full_name, installationId: t.repo.installation_id,
      commitSha: commit, runnerName, checkoutToken: tok.data.token, summaryToken, region: t.region, spec,
    });
    await this.db.tx(ws, (c) => c.query(
      `update ${kind === "replay" ? "ci_replays" : "ci_exploration_jobs"} set status = 'dispatched', attempts = $2, runner_name = $3, region = $4,
         dispatched_at = now(), commit_sha = coalesce(commit_sha, $5), detail = 'a fenvix machine is starting' where id = $1`,
      [id, attempt, runnerName, t.region, commit]));
    this.log.info({ task: id, kind, runner: runnerName, region: t.region }, "task machine requested");
    return true;
  }

  // ---------------------------------------------------------------- what the machines report

  /** POST /v1/runner/replays: the replay machine's start and result. "forbidden": another task's machine. */
  async reportReplay(scope: { repositoryId: number; runnerName: string; taskId: string }, r: ReplayReport): Promise<"stored" | "unknown" | "forbidden"> {
    if (r.replayId !== scope.taskId) return "forbidden";
    const ws = (await this.db.q<{ workspace_id: string }>("select workspace_id from public.gh_task_workspace('replay', $1::uuid)", [r.replayId]))[0]?.workspace_id;
    if (!ws) return "unknown";
    return this.db.tx(ws, async (c) => {
      const row = (await c.query<{ id: string; runner_name: string | null; status: string; defect_id: string | null; commit_sha: string; project_id: string }>(
        "select id, runner_name, status, defect_id, commit_sha, project_id from ci_replays where id = $1 for update", [r.replayId])).rows[0];
      if (!row) return "unknown";
      const repo = (await c.query<{ repository_id: number }>("select repository_id from gh_repositories where project_id = $1", [row.project_id])).rows[0];
      if (row.runner_name !== scope.runnerName || repo?.repository_id !== scope.repositoryId) return "forbidden";
      if (!["dispatched", "running"].includes(row.status)) return "stored"; // late or repeated: nothing changes
      if (r.event === "started") {
        await c.query("update ci_replays set status = 'running', started_at = now(), detail = 'replaying' where id = $1", [r.replayId]);
        return "stored";
      }
      const status = r.outcome === "error" ? "error" : r.outcome === "passed" ? "passed" : "failed";
      await c.query(
        `update ci_replays set status = $2, runs = $3, fails = $4, fingerprint = $5, identical_fingerprint = $6, detail = $7,
           command = coalesce($8, command), finished_at = now() where id = $1`,
        [r.replayId, status, r.runs ?? null, r.fails ?? null, r.fingerprint ?? null, r.identicalFingerprint ?? null, (r.detail ?? "").slice(0, 2000), r.command ?? null]);
      if (row.defect_id) {
        await c.query("update ci_defects set last_replay_id = $2 where id = $1", [row.defect_id, r.replayId]);
        // The contract's rule: fixed once the minimal order passes 10 of 10 on a later commit than the last sighting.
        if (status === "passed" && (r.runs ?? 0) >= 10 && (r.fails ?? 1) === 0) {
          await c.query(
            `update ci_defects d set state = 'fixed', state_changed_at = now(), state_reason = $3, fixed_commit_sha = $2
             where d.id = $1 and d.state = 'open' and not exists (
               select 1 from ci_defect_occurrences o where o.defect_id = d.id and o.commit_sha = $2)`,
            [row.defect_id, row.commit_sha, `the minimal order passed ${r.runs} of ${r.runs} on ${row.commit_sha.slice(0, 7)}`]);
        }
      }
      return "stored";
    });
  }

  /** The bundle a replay machine replays (GET /v1/runner/replays/{id}/bundle with its own credential). */
  async replayBundle(scope: { repositoryId: number; runnerName: string; taskId: string }, replayId: string): Promise<Buffer | null | "forbidden"> {
    if (replayId !== scope.taskId) return "forbidden";
    const ws = (await this.db.q<{ workspace_id: string }>("select workspace_id from public.gh_task_workspace('replay', $1::uuid)", [replayId]))[0]?.workspace_id;
    if (!ws) return null;
    return this.db.tx(ws, async (c) => {
      const r = (await c.query<{ runner_name: string | null; content: Buffer | null }>(
        `select rp.runner_name, b.content from ci_replays rp left join ci_defects d on d.id = rp.defect_id left join ci_defect_bundles b on b.id = d.bundle_id
         where rp.id = $1`, [replayId])).rows[0];
      if (!r) return null;
      if (r.runner_name !== scope.runnerName) return "forbidden";
      return r.content;
    });
  }

  /** The exploration job a task credential names, for POST /v1/runner/explorations: its organization and project. */
  async explorationJob(taskId: string, scope: { repositoryId: number; runnerName: string }): Promise<{ ws: string; projectId: string } | null> {
    const ws = (await this.db.q<{ workspace_id: string }>("select workspace_id from public.gh_task_workspace('exploration', $1::uuid)", [taskId]))[0]?.workspace_id;
    if (!ws) return null;
    return this.db.tx(ws, async (c) => {
      const j = (await c.query<{ project_id: string; runner_name: string | null; status: string }>(
        "select project_id, runner_name, status from ci_exploration_jobs where id = $1", [taskId])).rows[0];
      const repo = j ? (await c.query<{ repository_id: number }>("select repository_id from gh_repositories where project_id = $1", [j.project_id])).rows[0] : undefined;
      if (!j || j.runner_name !== scope.runnerName || repo?.repository_id !== scope.repositoryId) return null;
      return { ws, projectId: j.project_id };
    });
  }

  // ---------------------------------------------------------------- stopping a run

  /**
   * A run stopped from the dashboard (ci_runs.stop_state requested): the GitHub job is cancelled (the App needs the
   * repository permission "Actions: Read and write"; without it GitHub answers 403 and only the machine is ended) and
   * its machine is ended, so the job fails on GitHub with the runner gone.
   */
  async cancelRun(ws: string, runId: string): Promise<"cancelled" | "not_running" | "unknown"> {
    const job = await this.db.tx(ws, async (c) => {
      const r = (await c.query<{ status: string; stop_state: string | null }>("select status, stop_state from ci_runs where id = $1", [runId])).rows[0];
      if (!r) return "unknown" as const;
      if (r.status !== "running" || r.stop_state !== "requested") return "not_running" as const;
      return (await c.query<{ job_id: number; run_id: number; runner_name: string | null; region: Region | null; installation_id: number; full_name: string }>(
        `select j.job_id, j.run_id, j.runner_name, j.region, j.installation_id, g.full_name from gh_jobs j join gh_repositories g on g.repository_id = j.repository_id
         where j.ci_run_id = $1`, [runId])).rows[0] ?? ("unknown" as const);
    });
    if (typeof job === "string") return job;
    const gh = this.gh.installation(job.installation_id);
    const r = await gh.request("POST", `/repos/${job.full_name}/actions/runs/${job.run_id}/cancel`, { allow: [403, 404, 409] }).catch(() => ({ status: 0 }));
    if (r.status === 403) this.log.warn({ run: runId }, "the GitHub job could not be cancelled: the App lacks Actions: Read and write (the machine is ended)");
    let ended = 0;
    if (job.runner_name && this.launcher?.terminateRunner) ended = (await this.launcher.terminateRunner(job.region ?? "us", job.runner_name)).length;
    if (r.status >= 300 && !ended) {
      await this.db.tx(ws, (c) => c.query("update ci_runs set stop_state = 'failed', stop_detail = $2 where id = $1 and stop_state = 'requested'",
        [runId, r.status === 403 ? "GitHub refused to cancel the job (the App needs Actions: Read and write) and no fenvix machine was found to end" : "the job could not be cancelled and no fenvix machine was found to end"]));
    }
    this.log.info({ run: runId, job: job.job_id, github: r.status }, "run stopped from the dashboard");
    return "cancelled";
  }
}
