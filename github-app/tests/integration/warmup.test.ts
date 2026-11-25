import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { signState } from "../../src/auth.ts";
import { verifySummaryCredential } from "../../src/runners/credentials.ts";
import { type Region, RetryLater, type RunnerLaunch, type RunnerLauncher, type WarmupLaunch } from "../../src/runners/launcher.ts";
import {
  ACCOUNT, CI_YAML, completeLink, githubSetup, githubUser, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, push, REPOS, resetDb,
  RUNNER_TOKEN, runnerCredential, workflowJob,
} from "../helpers/harness.ts";

const SUMMARY = JSON.parse(readFileSync(new URL("../fixtures/runner/job3-warm-pass.summary.json", import.meta.url), "utf8")) as Record<string, unknown>;

/** Our fleet in memory: customer jobs and warm-ups share the region's limit; warm-ups can be terminated. */
class FakeFleet implements RunnerLauncher {
  jobs: RunnerLaunch[] = [];
  warmups: WarmupLaunch[] = [];
  terminated: number[] = [];
  live = new Map<number, Region>();
  busy = 0;
  max = 4;
  regions: Region[] = ["us"];
  private used(region: Region) { return this.busy + [...this.live.values()].filter((r) => r === region).length; }
  canPlace(region: Region) { return this.regions.includes(region); }
  async hasCapacity(region: Region = "us") { return this.used(region) < this.max; }
  async launch(l: RunnerLaunch) {
    if (this.used(l.region ?? "us") >= this.max) throw new RetryLater("full");
    this.jobs.push(l); this.busy++;
    return { instanceId: `i-j${l.jobId}`, already: false, imageId: "ami-test", instanceType: "m7i.large" };
  }
  async slots(region: Region) { return { running: this.used(region), warmups: [...this.live.values()].filter((r) => r === region).length, max: this.max }; }
  /** The next warm-up launch fails (EC2 refused it): the App releases the warm-up. */
  failNextWarmup: Error | null = null;
  async launchWarmup(w: WarmupLaunch) {
    if (this.failNextWarmup) { const e = this.failNextWarmup; this.failNextWarmup = null; throw e; }
    if (this.used(w.region) >= this.max) throw new RetryLater("full");
    this.warmups.push(w); this.live.set(w.warmupId, w.region);
    return { instanceId: `i-w${w.warmupId}-${w.attempt}`, already: false, imageId: "ami-test", instanceType: "m7i.large" };
  }
  async terminateWarmup(_region: Region, id: number) {
    if (!this.live.delete(id)) return [];
    this.terminated.push(id);
    return [`i-w${id}`];
  }
  /** The warm-up machine powered off by itself at its end. */
  done(id: number) { this.live.delete(id); }
}

type Row = Record<string, unknown>;

describe("warm cache at install: warm-up runs of the default branch", () => {
  const h = new Harness();
  const fleet = new FakeFleet();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  const shaN = (n: number) => n.toString(16).padStart(40, "c");
  const warmups = async (repo = REPOS.shop.id): Promise<Row[]> => (await admin.query("select * from gh_warmups where repository_id = $1 order by id", [repo])).rows;
  const one = async (sha: string, repo = REPOS.shop.id): Promise<Row> => (await admin.query("select * from gh_warmups where repository_id = $1 and commit_sha = $2", [repo, sha])).rows[0];
  /** The grace period is over (a test does not wait three minutes). */
  const due = () => admin.query("update gh_warmups set not_before = now() - interval '1 second' where status = 'pending'");
  const report = (cred: string, body: Row) => h.app.fastify.inject({ method: "POST", url: "/v1/runner/warmups", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: body });
  const pushTo = (sha: string, pushedAt: number) => h.send("push", push(sha, "refs/heads/main", pushedAt));

  before(async () => {
    admin = await resetDb();
    await h.start({ WARMUP_GRACE_SECONDS: "180", WARMUP_DAILY_CAP: "6" }, { launcher: fleet });
    org = await makeOrg(admin, "warm-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("before the link: the setup pull request merged on a stranger's installation starts nothing", async () => {
    await h.send("installation", installationCreated([REPOS.shop]));
    const pr = (await admin.query("select setup_pr_number from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].setup_pr_number as number;
    assert.ok(pr > 0, "the setup pull request was opened");
    await h.send("pull_request", pullRequest("closed", { number: pr, headRef: "fenvix/runs-on", headSha: "1".repeat(40), merged: true, mergeSha: shaN(1) }));
    assert.deepEqual(await warmups(), [], "no organization: no machine for a stranger");
  });

  it("the link of an installation whose repository is already on fenvix: a warm-up of the default branch's head, at once", async () => {
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
    const head = h.gh.repos.get("acme/shop")!.branches.get("main")!.sha;
    const [w] = await warmups();
    assert.deepEqual({ sha: w!.commit_sha, trigger: w!.trigger, status: w!.status, ref: w!.ref }, { sha: head, trigger: "linked", status: "pending", ref: "refs/heads/main" });
    assert.ok((w!.not_before as Date).getTime() <= Date.now(), "no grace period: no customer run is coming for it");
  });

  it("the tick gives it a machine: our fleet, the organization's region, the customer's own workflow file and job, a read-only token", async () => {
    const r = await h.app.service.warmups.tick();
    assert.equal(r.dispatched, 1);
    const l = fleet.warmups[0]!;
    const head = h.gh.repos.get("acme/shop")!.branches.get("main")!.sha;
    assert.deepEqual({ ...l, checkoutToken: "", summaryToken: "", cacheToken: undefined }, {
      warmupId: l.warmupId, attempt: 1, repositoryId: REPOS.shop.id, repositoryFullName: "acme/shop", installationId: INSTALLATION_ID, commitSha: head, ref: "refs/heads/main",
      workflowPath: ".github/workflows/ci.yml", job: "test", runnerName: `fenvix-w${l.warmupId}`, checkoutToken: "", summaryToken: "", cacheToken: undefined, region: "us",
    });
    // The machine's App credential names this warm-up only.
    const scope = verifySummaryCredential([RUNNER_TOKEN], `Bearer ${l.summaryToken}`)!;
    assert.deepEqual({ ...scope, exp: 0 }, { runnerName: `fenvix-w${l.warmupId}`, repositoryId: REPOS.shop.id, warmupId: l.warmupId, exp: 0 });
    // The checkout token: this repository only, read only (GitHub refuses the rest).
    const tokenCall = h.gh.exchanges.filter((x) => x.method === "POST" && x.path.endsWith("/access_tokens")).at(-1)!;
    assert.deepEqual(tokenCall.body, { repository_ids: [REPOS.shop.id], permissions: { contents: "read", metadata: "read" } });
    const as = (path: string, method = "GET", body?: unknown) => fetch(`${h.gh.url}${path}`, { method, headers: { authorization: `Bearer ${l.checkoutToken}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await as("/repos/acme/shop")).status, 200);
    assert.equal((await as("/repos/acme/web")).status, 404, "another repository of the installation");
    assert.equal((await as("/repos/acme/shop/check-runs", "POST", { name: "x", head_sha: head })).status, 403, "no check run with it");
    const row = await one(head);
    assert.deepEqual({ status: row.status, region: row.region, attempts: row.attempts, runner: row.runner_name }, { status: "dispatched", region: "us", attempts: 1, runner: `fenvix-w${l.warmupId}` });
  });

  it("the machine reports; its credential works for warm-ups only, and a job's credential is refused there", async () => {
    const l = fleet.warmups[0]!;
    const cred = l.summaryToken;
    assert.equal((await report(cred, { warmupId: l.warmupId, event: "started" })).statusCode, 202);
    assert.equal((await one(l.commitSha)).status, "running");
    // Never a run: summaries, progress and results refuse a warm-up machine's credential.
    for (const url of ["/v1/runner/summaries", "/v1/runner/progress", "/v1/runner/results", "/v1/runner/explorations"]) {
      const res = await h.app.fastify.inject({ method: "POST", url, headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: { runId: 1, summary: SUMMARY, seq: 1, phase: "testing", testsDone: 0, passed: 0, failed: 0, skippedWithProof: 0, elapsedMs: 0, chunk: 0 } });
      assert.equal(res.statusCode, 403, url);
    }
    assert.equal((await report(runnerCredential("fenvix-j1", REPOS.shop.id, 99), { warmupId: l.warmupId, event: "started" })).statusCode, 403, "a job's credential");
    assert.equal((await report(cred, { warmupId: l.warmupId + 1, event: "started" })).statusCode, 403, "another warm-up's id");
    assert.equal((await report(cred, { warmupId: l.warmupId, event: "finished" })).statusCode, 400, "finished without an outcome");
    assert.equal((await report("fxr1.bad.sig", { warmupId: l.warmupId, event: "started" })).statusCode, 401);
  });

  it("finished with the summary: the cache is warm since that commit; one usage event, never billable, reason warm-up; nothing on GitHub", async () => {
    const l = fleet.warmups[0]!;
    const checksBefore = h.gh.repos.get("acme/shop")!.checkRuns.size;
    const res = await report(l.summaryToken, { warmupId: l.warmupId, event: "finished", outcome: "succeeded", summary: SUMMARY });
    assert.equal(res.statusCode, 202);
    fleet.done(l.warmupId);
    const row = await one(l.commitSha);
    assert.equal(row.status, "succeeded");
    assert.ok(Number(row.machine_seconds) >= 0);
    const repo = (await admin.query("select cache_warm_sha, cache_warm_source from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.deepEqual(repo, { cache_warm_sha: l.commitSha, cache_warm_source: "warmup" });
    const ev = (await admin.query("select kind, billable, reason, github_job_id, warmup_id, workspace_id, test_minutes_ran, minutes_saved from ci_usage_events where warmup_id is not null")).rows;
    assert.equal(ev.length, 1);
    assert.deepEqual({ ...ev[0], test_minutes_ran: undefined, minutes_saved: undefined }, { kind: "warmup", billable: false, reason: "warm-up", github_job_id: null, warmup_id: l.warmupId, workspace_id: org.workspaceId, test_minutes_ran: undefined, minutes_saved: undefined });
    // Our cost, from the summary (never billed): its test minutes run and saved, as for a run.
    const sum = SUMMARY as { test_seconds_run: number; test_seconds_saved: number };
    assert.equal(Number(ev[0]!.test_minutes_ran), Math.round((sum.test_seconds_run / 60) * 100) / 100);
    assert.equal(Number(ev[0]!.minutes_saved), Math.round((sum.test_seconds_saved / 60) * 100) / 100);
    // The same report again: nothing more.
    assert.equal((await report(l.summaryToken, { warmupId: l.warmupId, event: "finished", outcome: "succeeded", summary: SUMMARY })).statusCode, 202);
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where warmup_id is not null")).rows[0].n, 1);
    // Not a run: no run row, no check run, no comment, no billable usage.
    assert.equal((await admin.query("select count(*)::int as n from ci_runs")).rows[0].n, 0);
    assert.equal(h.gh.repos.get("acme/shop")!.checkRuns.size, checksBefore);
    assert.equal(h.gh.repos.get("acme/shop")!.comments.size, 0);
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where billable")).rows[0].n, 0);
  });

  it("a push to the default branch waits out the grace period; a newer push supersedes it; an older one never replaces it", async () => {
    await pushTo(shaN(10), 1_795_500_000);
    const w10 = await one(shaN(10));
    assert.deepEqual({ status: w10.status, trigger: w10.trigger }, { status: "pending", trigger: "push" });
    assert.ok((w10.not_before as Date).getTime() > Date.now() + 170_000, "three minutes for the customer's own push run");
    assert.equal((await h.app.service.warmups.tick()).dispatched, 0);
    // A push to another branch: no warm-up.
    await h.send("push", push(shaN(11), "refs/heads/feature", 1_795_500_100));
    assert.equal(await one(shaN(11)), undefined);
    await pushTo(shaN(12), 1_795_500_200);
    assert.equal((await one(shaN(10))).status, "superseded");
    assert.match(String((await one(shaN(10))).detail), /superseded by a newer commit on main \(cccccc/);
    // Delivered late: an older commit than the one in flight is stored superseded at once.
    await pushTo(shaN(9), 1_795_499_000);
    assert.equal((await one(shaN(9))).status, "superseded");
    assert.equal((await one(shaN(12))).status, "pending");
  });

  it("a running warm-up superseded by a newer commit: its machine is terminated, its machine time recorded (not billed)", async () => {
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    const w12 = await one(shaN(12));
    const l = fleet.warmups.at(-1)!;
    assert.equal(l.warmupId, w12.id);
    await report(l.summaryToken, { warmupId: l.warmupId, event: "started" });
    await admin.query("update gh_warmups set dispatched_at = now() - interval '5 minutes' where id = $1", [w12.id]);
    await pushTo(shaN(13), 1_795_500_300);
    assert.equal((await one(shaN(12))).status, "superseded");
    assert.ok((await one(shaN(12))).terminate_requested_at);
    const t = await h.app.service.warmups.tick();
    assert.equal(t.terminated, 1);
    assert.ok(fleet.terminated.includes(Number(w12.id)));
    const ev = (await admin.query("select billable, reason, other_step_minutes from ci_usage_events where warmup_id = $1", [w12.id])).rows[0];
    assert.equal(ev.billable, false);
    assert.equal(ev.reason, "warm-up");
    assert.ok(Number(ev.other_step_minutes) >= 4.9, "about five minutes of machine time");
    // Its old machine reporting after the termination changes nothing.
    assert.equal((await report(l.summaryToken, { warmupId: l.warmupId, event: "finished", outcome: "failed" })).statusCode, 202);
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where warmup_id = $1", [w12.id])).rows[0].n, 1);
  });

  it("the customer's own trusted run of the commit covers its warm-up; its published results warm the cache; one without results re-arms it", async () => {
    // shaN(13) is pending (grace). The customer's push workflow takes it on fenvix (cache write: a trusted ref).
    h.gh.addRun("acme/shop", 7001, { event: "push", headSha: shaN(13), headBranch: "main", message: "main" });
    await h.send("workflow_job", workflowJob("queued", { id: 801, runId: 7001, sha: shaN(13), branch: "main" }));
    assert.equal(fleet.jobs.at(-1)!.cacheAccess, "write");
    const w13 = await one(shaN(13));
    assert.deepEqual({ status: w13.status, by: w13.covered_by_job }, { status: "covered", by: 801 });
    await h.send("workflow_job", workflowJob("in_progress", { id: 801, runId: 7001, sha: shaN(13), branch: "main", runner: "fenvix-j801" }));
    await h.send("workflow_job", workflowJob("completed", { id: 801, runId: 7001, sha: shaN(13), branch: "main", runner: "fenvix-j801" }));
    await h.summary({ runId: 7001, runner: "fenvix-j801", summary: SUMMARY });
    const repo = (await admin.query("select cache_warm_sha, cache_warm_source from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.deepEqual(repo, { cache_warm_sha: shaN(13), cache_warm_source: "run" });

    // Next commit: covered by a run that is cancelled before its tests: the warm-up runs after all.
    await pushTo(shaN(14), 1_795_500_400);
    h.gh.addRun("acme/shop", 7002, { event: "push", headSha: shaN(14), headBranch: "main", message: "main" });
    await h.send("workflow_job", workflowJob("queued", { id: 802, runId: 7002, sha: shaN(14), branch: "main" }));
    assert.equal((await one(shaN(14))).status, "covered");
    await h.send("workflow_job", workflowJob("completed", { id: 802, runId: 7002, sha: shaN(14), branch: "main", conclusion: "cancelled", runner: null }));
    const w14 = await one(shaN(14));
    assert.equal(w14.status, "pending");
    assert.match(String(w14.detail), /ended without results/);
    // A pull request's run (read-only cache) never covers anything.
    h.gh.addRun("acme/shop", 7003, { event: "pull_request", headSha: shaN(14), headBranch: "feature", message: "pr" });
    await h.send("workflow_job", workflowJob("queued", { id: 803, runId: 7003, sha: shaN(14), branch: "feature" }));
    assert.equal((await one(shaN(14))).status, "pending");
    fleet.busy = 0;
  });

  it("customers come first: a customer job queued in the region blocks warm-ups; the reserve stays free", async () => {
    await due();
    await admin.query("insert into gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, status, region, created_at) values (990, $1, $2, 1, $3, 'queued', 'us', now())",
      [REPOS.shop.id, INSTALLATION_ID, "e".repeat(40)]);
    assert.equal((await h.app.service.warmups.tick()).dispatched, 0);
    assert.match(String((await one(shaN(14))).detail), /a customer job is waiting for a machine in us/);
    await admin.query("update gh_jobs set status = 'completed' where job_id = 990");
    fleet.busy = 3;
    assert.equal((await h.app.service.warmups.tick()).dispatched, 0);
    assert.match(String((await one(shaN(14))).detail), /3 of 4 busy; 1 kept for customer jobs/);
    fleet.busy = 2;
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
  });

  it("a customer job that finds the fleet full takes the warm-up's machine (preemption); the warm-up runs again later", async () => {
    const w14 = await one(shaN(14));
    fleet.busy = 3; // 3 customer machines + the warm-up = the limit of 4
    h.gh.addRun("acme/shop", 7004, { event: "pull_request", headSha: "f".repeat(40), headBranch: "feature", message: "pr" });
    const jobsBefore = fleet.jobs.length;
    await h.send("workflow_job", workflowJob("queued", { id: 804, runId: 7004, sha: "f".repeat(40), branch: "feature" }));
    assert.equal(fleet.jobs.length, jobsBefore + 1, "the customer's job got a machine at once");
    assert.ok(fleet.terminated.includes(Number(w14.id)));
    const after = await one(shaN(14));
    assert.deepEqual({ status: after.status, preemptions: after.preemptions }, { status: "pending", preemptions: 1 });
    assert.ok((after.not_before as Date).getTime() > Date.now(), "it waits before it tries again");
    // Back later on a fresh machine (attempt 2, a new runner name); the old machine's late report is ignored.
    const old = fleet.warmups.at(-1)!;
    fleet.busy = 0;
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    const again = fleet.warmups.at(-1)!;
    assert.deepEqual({ attempt: again.attempt, runner: again.runnerName }, { attempt: 2, runner: `fenvix-w${w14.id}-2` });
    assert.equal((await report(old.summaryToken, { warmupId: old.warmupId, event: "started" })).statusCode, 403, "the old machine's runner name");
    await report(again.summaryToken, { warmupId: again.warmupId, event: "finished", outcome: "succeeded", summary: SUMMARY });
    fleet.done(again.warmupId);
    assert.equal((await one(shaN(14))).status, "succeeded");
    assert.equal((await admin.query("select cache_warm_sha from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].cache_warm_sha, shaN(14));
  });

  it("one warm-up per organization at once", async () => {
    // A second repository of the organization, already on fenvix.
    await admin.query(
      `insert into gh_repositories (repository_id, installation_id, full_name, default_branch, onboarding_state, onboarding_workflow_path, onboarding_job)
       values ($1, $2, 'acme/web', 'main', 'merged', '.github/workflows/ci.yml', 'test')`, [REPOS.web.id, INSTALLATION_ID]);
    // Its default branch on GitHub is at the commit warmed below (a machine starts only for the branch's head).
    const web = h.gh.repos.get("acme/web")!;
    web.branches.set("main", { ...web.branches.get("main")!, sha: "d".repeat(40) });
    await pushTo(shaN(20), 1_795_500_500);
    assert.equal(await h.app.service.warmups.request({ repositoryId: REPOS.web.id, sha: "d".repeat(40), trigger: "push", grace: false }), "created");
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1, "only one of the two");
    const waiting = (await admin.query("select repository_id, detail from gh_warmups where status = 'pending'")).rows;
    assert.equal(waiting.length, 1);
    assert.match(String(waiting[0]!.detail), /organization's other warm-up is running \(at most 1 at once\)/);
    // The first ends (its tests failed: the cache keeps what passed); the other gets the machine.
    const active = Number((await admin.query("select id from gh_warmups where status = 'dispatched'")).rows[0]!.id);
    assert.equal((await report(fleet.warmups.find((x) => x.warmupId === active)!.summaryToken, { warmupId: active, event: "finished", outcome: "failed", detail: "2 tests failed" })).statusCode, 202);
    fleet.done(active);
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    const second = Number((await admin.query("select id from gh_warmups where status = 'dispatched'")).rows[0]!.id);
    await report(fleet.warmups.find((x) => x.warmupId === second)!.summaryToken, { warmupId: second, event: "finished", outcome: "unsupported", detail: "the job needs the outputs of job build" });
    fleet.done(second);
    assert.deepEqual((await admin.query("select status from gh_warmups where id = any($1::bigint[]) order by id", [[active, second]])).rows.map((r) => r.status), ["failed", "unsupported"]);
    // After "unsupported", the repository's next warm-up waits a day: one try a day, not one machine per push.
    assert.equal(await h.app.service.warmups.request({ repositoryId: REPOS.web.id, sha: "e".repeat(40), trigger: "push", grace: false }), "created");
    const next = await one("e".repeat(40), REPOS.web.id);
    assert.ok((next.not_before as Date).getTime() > Date.now() + 23 * 3_600_000);
    assert.match(String(next.detail), /the last warm-up could not run this job \(the job needs the outputs of job build\); trying again after/);
    await admin.query("update gh_warmups set status = 'cancelled' where repository_id = $1 and status = 'pending'", [REPOS.web.id]);
  });

  it("a daily cap per repository: the next warm-up waits until the oldest of the day is 24 hours old", async () => {
    // Six warm-ups of shop had a machine in the last 24 hours (cap 6).
    for (let i = 0; i < 6; i++) {
      await admin.query(
        `insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, pushed_at, dispatched_at, finished_at)
         values ($1, $2, $3, 'refs/heads/main', 'push', 'superseded', now() - interval '2 days', now() - make_interval(hours => $4), now())`,
        [REPOS.shop.id, INSTALLATION_ID, shaN(100 + i), 23 - i]);
    }
    await pushTo(shaN(21), 1_795_500_550);
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 0);
    const w = await one(shaN(21));
    assert.equal(w.status, "pending");
    assert.match(String(w.detail), /daily cap reached: 6 warm-ups of this repository in 24 hours/);
    const oldest = (await admin.query("select min(dispatched_at) as t from gh_warmups where repository_id = $1 and dispatched_at > now() - interval '24 hours'", [REPOS.shop.id])).rows[0].t as Date;
    assert.equal((w.not_before as Date).getTime(), oldest.getTime() + 86_400_000, "it waits for the window, then runs");
  });

  it("an EU organization: never placed in the US; with an EU placement, there", async () => {
    await admin.query("update gh_warmups set status = 'cancelled', finished_at = now() where status in ('pending', 'dispatched', 'running')");
    // A new day for the cap (the case above filled it).
    await admin.query("update gh_warmups set dispatched_at = dispatched_at - interval '2 days' where dispatched_at is not null");
    for (const id of [...fleet.live.keys()]) fleet.done(id);
    await admin.query("update workspaces set region = 'eu' where id = $1", [org.workspaceId]);
    await pushTo(shaN(30), 1_795_500_600);
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 0);
    assert.match(String((await one(shaN(30))).detail), /\(eu\) yet: a warm-up never runs in another region/);
    fleet.regions = ["us", "eu"];
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    assert.equal(fleet.warmups.at(-1)!.region, "eu");
    assert.equal((await one(shaN(30))).region, "eu");
  });

  it("a machine that never starts is given up and tried again; one that runs too long is stopped", async () => {
    const w30 = await one(shaN(30));
    await admin.query("update gh_warmups set dispatched_at = now() - interval '20 minutes' where id = $1", [w30.id]);
    await h.app.service.warmups.tick();
    const back = await one(shaN(30));
    assert.equal(back.status === "pending" || back.status === "dispatched", true, String(back.status));
    assert.ok(fleet.terminated.includes(Number(w30.id)));
    await admin.query("update gh_warmups set status = 'running', started_at = now() - interval '4 hours', dispatched_at = now() - interval '4 hours' where id = $1", [w30.id]);
    fleet.live.set(Number(w30.id), "eu");
    await h.app.service.warmups.tick();
    const stopped = await one(shaN(30));
    assert.equal(stopped.status, "failed");
    assert.match(String(stopped.detail), /ran longer than 180 minutes/);
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where warmup_id = $1 and billable = false", [w30.id])).rows[0].n, 1);
  });

  it("suspended or uninstalled: warm-ups in flight are cancelled and their machines terminated", async () => {
    await admin.query("update workspaces set region = 'us' where id = $1", [org.workspaceId]);
    await pushTo(shaN(40), 1_795_500_700);
    await due();
    await h.app.service.warmups.tick();
    const w40 = await one(shaN(40));
    assert.equal(w40.status, "dispatched");
    await h.send("installation", { ...installationCreated([REPOS.shop]), action: "suspend" });
    const c = await one(shaN(40));
    assert.deepEqual({ status: c.status, detail: c.detail }, { status: "cancelled", detail: "the installation was suspended on GitHub" });
    await h.app.service.warmups.tick();
    assert.ok(fleet.terminated.includes(Number(w40.id)));
    // While suspended, a push asks for nothing.
    await pushTo(shaN(41), 1_795_500_800);
    assert.equal(await one(shaN(41)), undefined);
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path}: ${JSON.stringify(x.problems)}`), [], "every GitHub call matches GitHub's REST description");
  });
});

describe("review R-018 follow-ups: only the default branch's head runs; a reset commit is warmed again; machine time by the App's clock", () => {
  const h = new Harness();
  const fleet = new FakeFleet();
  let admin: pg.Client;
  const sha = (c: string) => c.repeat(40);
  const one = async (s: string): Promise<Row | undefined> =>
    (await admin.query("select * from gh_warmups where repository_id = $1 and commit_sha = $2", [REPOS.shop.id, s])).rows[0];
  const due = () => admin.query("update gh_warmups set not_before = now() - interval '1 second' where status = 'pending'");
  const report = (cred: string, body: Row) => h.app.fastify.inject({ method: "POST", url: "/v1/runner/warmups", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: body });
  const pushTo = (s: string, at: number) => h.send("push", push(s, "refs/heads/main", at));
  const main = () => h.gh.repos.get("acme/shop")!.branches.get("main")!;
  let head = "";

  before(async () => {
    admin = await resetDb();
    await h.start({ WARMUP_GRACE_SECONDS: "180", WARMUP_DAILY_CAP: "50" }, { launcher: fleet });
    const org = await makeOrg(admin, "r018-follow");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    const pr = (await admin.query("select setup_pr_number from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].setup_pr_number as number;
    await h.send("pull_request", pullRequest("closed", { number: pr, headRef: "fenvix/runs-on", headSha: "1".repeat(40), merged: true, mergeSha: sha("a") }));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
    head = main().sha;
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("the branch moved with no webhook (lost delivery, force push): the warm-up is superseded before any machine, and the new head is requested instead", async () => {
    assert.equal((await one(head))?.status, "pending");
    const moved = sha("e");
    main().sha = moved;
    const before = fleet.warmups.length;
    const t = await h.app.service.warmups.tick();
    assert.equal(t.dispatched, 0);
    assert.equal(fleet.warmups.length, before, "no machine for a commit that is not the branch's head");
    const old = await one(head);
    assert.equal(old?.status, "superseded");
    assert.match(String(old?.detail), /is no longer the head of main \(now eeeeeee\)/);
    const next = await one(moved);
    assert.deepEqual({ status: next?.status, trigger: next?.trigger }, { status: "pending", trigger: "linked" });
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    assert.equal(fleet.warmups.at(-1)!.commitSha, moved);
  });

  it("a warm-up's usage event: held minutes are its machine time by the App's clock, and bound its test minutes (the summary cannot raise them)", async () => {
    const l = fleet.warmups.at(-1)!;
    await admin.query("update gh_warmups set dispatched_at = now() - interval '2 minutes' where id = $1", [l.warmupId]);
    // The job user writes summary.json: it claims an hour of tests on a machine that ran two minutes.
    const forged = { ...SUMMARY, test_seconds_run: 3600 };
    assert.equal((await report(l.summaryToken, { warmupId: l.warmupId, event: "finished", outcome: "succeeded", summary: forged })).statusCode, 202);
    fleet.done(l.warmupId);
    const ev = (await admin.query("select billable, held_minutes, baseline_minutes, units, test_minutes_ran from ci_usage_events where warmup_id = $1", [l.warmupId])).rows[0];
    assert.equal(ev.billable, false);
    const held = Number(ev.held_minutes);
    assert.ok(held >= 1.9 && held <= 2.5, `about two minutes held, got ${held}`);
    assert.equal(Number(ev.baseline_minutes), held);
    assert.ok(Number(ev.test_minutes_ran) <= held, "test minutes bounded by the machine time");
  });

  it("a commit superseded before its machine is warmed again when the branch is pushed back to it later; a replay of the old push changes nothing", async () => {
    const x = sha("f"); const y = sha("9");
    await pushTo(x, 1_795_800_000);
    await pushTo(y, 1_795_800_060);
    assert.equal((await one(x))?.status, "superseded");
    // A replay of x's original push (same push time): nothing.
    await pushTo(x, 1_795_800_000);
    assert.equal((await one(x))?.status, "superseded");
    assert.equal((await one(y))?.status, "pending");
    // The maintainers reset main back to x (pushed again, later): y's warm-up ends, x's is pending again.
    await pushTo(x, 1_795_800_120);
    assert.equal((await one(y))?.status, "superseded");
    assert.equal((await one(x))?.status, "pending");
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    assert.equal(fleet.warmups.at(-1)!.commitSha, x);
  });
  // Merge with review R-016b (G1): a covering push run that started on our machine and cancelled itself without a
  // summary is billed by GitHub's data; its warm-up is re-armed (R-018 F2) and, once its machine ran, recorded never
  // billable, by the App's clock, whatever its summary says.
  it("merge R-016b: a covering run that cancels itself without results is billed (GitHub's data); its re-armed warm-up runs and is never billed", async () => {
    await admin.query("update gh_warmups set status = 'cancelled', finished_at = now() where status in ('pending', 'dispatched', 'running')");
    const c = sha("7");
    await pushTo(c, 1_795_800_200);
    h.gh.addRun("acme/shop", 9201, { event: "push", headSha: c, headBranch: "main", message: "main" });
    await h.send("workflow_job", workflowJob("queued", { id: 9201, runId: 9201, sha: c, branch: "main" }));
    assert.equal((await one(c))?.status, "covered");
    await h.send("workflow_job", workflowJob("in_progress", { id: 9201, runId: 9201, sha: c, branch: "main", runner: "fenvix-j9201", startedAt: "2026-11-19T10:00:00Z" }));
    await h.send("workflow_job", workflowJob("completed", { id: 9201, runId: 9201, sha: c, branch: "main", runner: "fenvix-j9201", conclusion: "cancelled", startedAt: "2026-11-19T10:00:00Z", completedAt: "2026-11-19T10:30:00Z" }));
    await h.app.service.tryPublish(9201, true);
    const job = (await admin.query("select billable, reason, held_minutes from ci_usage_events where github_job_id = 9201")).rows[0];
    assert.deepEqual({ billable: job.billable, reason: job.reason, held: Number(job.held_minutes) }, { billable: true, reason: "cancelled_after_start", held: 30 });
    assert.equal((await one(c))?.status, "pending", "no results: the warm-up is re-armed");
    await due();
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    const l = fleet.warmups.at(-1)!;
    assert.equal(l.commitSha, c);
    await admin.query("update gh_warmups set dispatched_at = now() - interval '3 minutes' where id = $1", [l.warmupId]);
    // Its credential cannot send an exploration (only warm-up reports), and its summary cannot make it billable.
    const ex = await h.app.fastify.inject({ method: "POST", url: "/v1/runner/explorations", headers: { authorization: `Bearer ${l.summaryToken}`, "content-type": "application/json" }, payload: {} });
    assert.equal(ex.statusCode, 403);
    assert.equal((await report(l.summaryToken, { warmupId: l.warmupId, event: "finished", outcome: "failed", summary: { ...SUMMARY, test_seconds_run: 7200 } })).statusCode, 202);
    fleet.done(l.warmupId);
    const ev = (await admin.query("select billable, reason, held_minutes, test_minutes_ran from ci_usage_events where warmup_id = $1", [l.warmupId])).rows[0];
    assert.equal(ev.billable, false);
    assert.equal(ev.reason, "warm-up");
    const held = Number(ev.held_minutes);
    assert.ok(held >= 2.9 && held <= 3.5, `about three minutes held by the App's clock, got ${held}`);
    assert.ok(Number(ev.test_minutes_ran) <= held);
  });
});

describe("the usual path: the installation is linked, then the setup pull request is merged", () => {
  const h = new Harness();
  const fleet = new FakeFleet();
  let admin: pg.Client;
  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher: fleet });
    const org = await makeOrg(admin, "warm-merge");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("linked with the pull request still open: no warm-up yet (the job is not on fenvix until the merge)", async () => {
    assert.equal((await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].onboarding_state, "pr_open");
    assert.equal((await admin.query("select count(*)::int as n from gh_warmups")).rows[0].n, 0);
  });

  it("merged: one warm-up of the merge commit, ordered by GitHub's merged_at, after the grace period; the merge commit's push adds nothing", async () => {
    const pr = (await admin.query("select setup_pr_number from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].setup_pr_number as number;
    const merge = "9".repeat(40);
    await h.send("pull_request", pullRequest("closed", { number: pr, headRef: "fenvix/runs-on", headSha: "1".repeat(40), merged: true, mergeSha: merge, mergedAt: "2026-11-18T10:00:00Z" }));
    const [w] = (await admin.query("select * from gh_warmups")).rows;
    assert.deepEqual({ sha: w.commit_sha, trigger: w.trigger, status: w.status, pushed: (w.pushed_at as Date).toISOString() },
      { sha: merge, trigger: "onboarded", status: "pending", pushed: "2026-11-18T10:00:00.000Z" });
    assert.ok((w.not_before as Date).getTime() > Date.now() + 170_000);
    await h.send("push", push(merge, "refs/heads/main", Date.parse("2026-11-18T10:00:01Z") / 1000));
    assert.equal((await admin.query("select count(*)::int as n from gh_warmups")).rows[0].n, 1);
    // A pull request on the merge commit's branch is not a default-branch push.
    await h.send("push", push("8".repeat(40), "refs/heads/feature", Date.parse("2026-11-18T10:05:00Z") / 1000));
    assert.equal((await admin.query("select count(*)::int as n from gh_warmups")).rows[0].n, 1);
  });
  // protects=acceptance 1 and 5 for warm-ups: the launched machine's image and type are stored with kind 'ec2', and a
  // re-claim clears them until its own launch writes them; fails_when=a failed re-launch leaves the previous attempt's
  // machine on the row, or the columns are not written; no_claim=EC2's real answer (unit tests cover Ec2Launcher).
  it("C4: the warm-up stores its machine (kind 'ec2'); a re-claim clears it until the new launch writes it", async () => {
    const machine = async () => (await admin.query("select status, attempts, instance_id, image_id, instance_type, machine_kind from gh_warmups")).rows[0];
    await admin.query("update gh_warmups set not_before = now() - interval '1 second' where status = 'pending'");
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    const first = await machine();
    assert.deepEqual({ ...first, instance_id: undefined }, { status: "dispatched", attempts: 1, instance_id: undefined, image_id: "ami-test", instance_type: "m7i.large", machine_kind: "ec2" });
    // The machine never started: the App gives it up and claims the warm-up again; that launch fails.
    await admin.query("update gh_warmups set dispatched_at = now() - interval '20 minutes'");
    fleet.failNextWarmup = new Error("InsufficientInstanceCapacity");
    await h.app.service.warmups.tick();
    assert.equal(fleet.failNextWarmup, null, "the re-claim tried a launch");
    assert.deepEqual(await machine(), { status: "pending", attempts: 1, instance_id: null, image_id: null, instance_type: null, machine_kind: null });
    await admin.query("update gh_warmups set not_before = now() - interval '1 second' where status = 'pending'");
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    const again = await machine();
    assert.deepEqual({ status: again.status, attempts: again.attempts, image_id: again.image_id, instance_type: again.instance_type, machine_kind: again.machine_kind },
      { status: "dispatched", attempts: 2, image_id: "ami-test", instance_type: "m7i.large", machine_kind: "ec2" });
  });
});

describe("linked through the dashboard (review R-016: /github/setup, then POST /v1/github/installations/complete) with the setup pull request already merged", () => {
  const h = new Harness();
  const fleet = new FakeFleet();
  let admin: pg.Client;
  let owner: { workspaceId: string; userId: string };
  let mallory: { workspaceId: string; userId: string };
  const warmups = async () => (await admin.query("select commit_sha, trigger, status, workspace_id from gh_warmups order by id")).rows;
  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher: fleet });
    owner = await makeOrg(admin, "warm-link-owner");
    mallory = await makeOrg(admin, "warm-link-mallory");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    const pr = (await admin.query("select setup_pr_number from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].setup_pr_number as number;
    await h.send("pull_request", pullRequest("closed", { number: pr, headRef: "fenvix/runs-on", headSha: "1".repeat(40), merged: true, mergeSha: "a".repeat(40) }));
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("not linked yet: the merge requests no warm-up", async () => {
    assert.equal((await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].onboarding_state, "merged");
    assert.deepEqual(await warmups(), []);
  });

  it("someone who only sees the installation (not an admin of the account) gets no link, so no machine runs the repository's code", async () => {
    githubUser(h, { code: "warm-mallory", token: "gho_warm_mallory", login: "warm-mallory", id: 7701, installations: [INSTALLATION_ID] });
    const state = signState(h.cfg.stateSigningKey, { workspaceId: mallory.workspaceId, userId: mallory.userId });
    const r = await githubSetup(h, { installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "warm-mallory" });
    assert.equal(r.completion, null);
    assert.deepEqual(await warmups(), []);
    assert.equal((await h.app.service.warmups.tick()).dispatched, 0);
  });

  it("the account's admin completes the link: the worker warms the default branch's head (trigger linked), in the owner's organization", async () => {
    githubUser(h, { code: "warm-owner", token: "gho_warm_owner", login: "warm-link-owner", id: 7702, installations: [INSTALLATION_ID], adminOf: [ACCOUNT.login] });
    const state = signState(h.cfg.stateSigningKey, { workspaceId: owner.workspaceId, userId: owner.userId });
    const r = await githubSetup(h, { installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "warm-owner" });
    assert.ok(r.completion);
    assert.equal((await completeLink(h, r.completion!, owner.userId))?.workspace_id, owner.workspaceId);
    const head = h.gh.repos.get("acme/shop")!.branches.get("main")!.sha;
    assert.deepEqual(await warmups(), [{ commit_sha: head, trigger: "linked", status: "pending", workspace_id: owner.workspaceId }]);
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    assert.equal(fleet.warmups.at(-1)!.commitSha, head);
  });
});

describe("warm-ups off (WARMUP_ENABLED=false, or no per-job launcher): nothing is requested; the cache state still follows the customer's runs", () => {
  const h = new Harness();
  let admin: pg.Client;
  before(async () => {
    admin = await resetDb();
    await h.start({ WARMUP_ENABLED: "false" }, { launcher: new FakeFleet() });
    const org = await makeOrg(admin, "warm-off");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("a merge and a push request nothing", async () => {
    const pr = (await admin.query("select setup_pr_number from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].setup_pr_number as number;
    await h.send("pull_request", pullRequest("closed", { number: pr, headRef: "fenvix/runs-on", headSha: "1".repeat(40), merged: true, mergeSha: "2".repeat(40) }));
    await h.send("push", push("3".repeat(40), "refs/heads/main"));
    assert.equal((await admin.query("select count(*)::int as n from gh_warmups")).rows[0].n, 0);
    assert.equal((await h.app.service.warmups.tick()).dispatched, 0);
  });
});
