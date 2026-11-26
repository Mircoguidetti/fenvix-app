/*
 * Side-by-side runs (spec 20261126-side-by-side-runs): the organization's choice, the pull request after the link,
 * our job through every publish path (no check run, no comment, never billed, its own run kind), the machines (full,
 * skip, none) and the customer's history. Each test states its card: protects=...; fails_when=...; no_claim=...
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { parse } from "yaml";
import type pg from "pg";
import { SIDE_BY_SIDE_PATH } from "../../src/onboarding/workflow.ts";
import { type Region, RetryLater, type RunnerLaunch, type RunnerLauncher } from "../../src/runners/launcher.ts";
import { runWork } from "../../src/work.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, REPOS, resetDb, runnerCredential, workflowJob } from "../helpers/harness.ts";

const SUMMARY = JSON.parse(readFileSync(new URL("../fixtures/runner/job3-warm-pass.summary.json", import.meta.url), "utf8")) as Record<string, unknown>;
type Row = Record<string, any>;

/** Our fleet in memory: every launch recorded; `full` makes the region's fleet full, `places` its placement. */
class Fleet implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  full = false;
  places = true;
  canPlace(_r: Region) { return this.places; }
  async hasCapacity() { return !this.full; }
  async launch(l: RunnerLaunch) {
    if (this.full && !l.skipCapacityCheck) throw new RetryLater("full");
    this.launches.push(l);
    return { instanceId: `i-${l.jobId}`, already: false };
  }
}

/** Links the installation the production way: the link, then the work installation_linked. */
async function link(h: Harness, admin: pg.Client, org: { userId: string; workspaceId: string }): Promise<void> {
  await admin.query("select public.gh_link_installation($1, $2, $3)", [INSTALLATION_ID, org.workspaceId, org.userId]);
  await runWork(h.app.service, { kind: "installation_linked", installationId: INSTALLATION_ID });
  await h.app.service.idle();
}

const githubWrites = (h: Harness) => h.gh.exchanges.filter((x) => x.method !== "GET" && (/\/check-runs/.test(x.path) || /\/issues\//.test(x.path)));

describe("side by side: the organization's choice, and the pull request after the link (AC 2, AC 5)", () => {
  const h = new Harness();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  before(async () => {
    admin = await resetDb();
    await h.start();
    org = await makeOrg(admin, "sbs-kind-owner");
    await admin.query("update workspaces set onboarding_kind = 'side_by_side' where id = $1", [org.workspaceId]);
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
  });
  after(async () => { await h.stop(); await admin.end(); });

  // protects=no pull request before the organization link, then one side-by-side pull request creating only the new
  // file on its own branch; fails_when=a PR at installation.created, a PR on fenvix/runs-on, a changed customer file, or
  // more than one file; no_claim=what GitHub shows on the PR (AC 12).
  it("installation.created unlinked: no PR, awaiting_link; installation_linked: one PR on fenvix/side-by-side creating only the new file", async () => {
    await h.send("installation", installationCreated([REPOS.shop]));
    const shop = h.gh.repos.get("acme/shop")!;
    assert.equal(shop.pulls.length, 0);
    assert.deepEqual((await admin.query("select onboarding_state, awaiting_link, onboarding_detail from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0],
      { onboarding_state: "pending", awaiting_link: true, onboarding_detail: "waiting for the organization link" });
    await link(h, admin, org);
    assert.equal(shop.pulls.length, 1);
    const pr = shop.pulls[0]!;
    assert.equal(pr.head, "fenvix/side-by-side");
    assert.equal(pr.title, "Run your tests side by side on fenvix (your workflow is unchanged)");
    assert.equal(shop.branches.has("fenvix/runs-on"), false);
    const main = shop.branches.get("main")!.files;
    const branch = shop.branches.get("fenvix/side-by-side")!.files;
    assert.deepEqual([...branch.keys()].filter((p) => !main.has(p)), [SIDE_BY_SIDE_PATH], "one new file");
    for (const [p, f] of main) assert.equal(branch.get(p)!.text, f.text, `${p} unchanged`);
    assert.equal(main.get(".github/workflows/ci.yml")!.text, CI_YAML, "his workflow byte for byte");
    const wf = parse(branch.get(SIDE_BY_SIDE_PATH)!.text) as Row;
    assert.equal(wf.jobs["fenvix-side-by-side"]["runs-on"], "fenvix");
    assert.match(pr.body, /adds \*\*one new file\*\*/);
    assert.match(pr.body, /Leave it out of your required checks/);
    assert.match(pr.body, /model API/);
    assert.match(pr.body, /To stop it, delete `\.github\/workflows\/fenvix-side-by-side\.yml`/);
    const row = (await admin.query("select * from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.deepEqual({ s: row.onboarding_state, a: row.awaiting_link, p: row.setup_pr_number, j: row.side_by_side_job_name, t: row.side_by_side_test_step, m: row.side_by_side_matrix_suffix },
      { s: "side_by_side_pr_open", a: false, p: 1, j: "test", t: "Run python -m pytest -q", m: null });
    // Every request checked against GitHub's REST description. One known difference is tolerated (rule 3): the
    // description types `created` as a date-time, while GitHub documents and accepts its search form (">=YYYY-MM-DD").
    const known = (x: { path: string; problems?: { where: string }[] }) => /\/actions\/workflows\/[^/]+\/runs$/.test(x.path) && (x.problems ?? []).every((p) => p.where === "query created");
    assert.deepEqual(h.gh.validateAll().filter((x) => !known(x)).map((x) => `${x.method} ${x.path}: ${JSON.stringify(x.problems)}`), []);
  });

  // protects=the merged PR maps to state side_by_side, and onboard() again keeps it (the file is on the default branch:
  // nothing is opened); fails_when=a second PR, or the state goes back; no_claim=-.
  it("merged, then onboard() again: state stays side_by_side, no second pull request", async () => {
    const shop = h.gh.repos.get("acme/shop")!;
    await h.send("pull_request", pullRequest("closed", { number: 1, headRef: "fenvix/side-by-side", headSha: shop.pulls[0]!.headSha, merged: true }));
    assert.equal((await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].onboarding_state, "side_by_side");
    // The merge brings the file to the default branch.
    const main = shop.branches.get("main")!;
    main.files.set(SIDE_BY_SIDE_PATH, shop.branches.get("fenvix/side-by-side")!.files.get(SIDE_BY_SIDE_PATH)!);
    shop.pulls[0]!.state = "closed";
    const res = await h.app.service.onboard(REPOS.shop.id);
    assert.equal(res.state, "side_by_side");
    assert.equal(shop.pulls.length, 1);
    assert.equal((await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].onboarding_state, "side_by_side");
  });
});

describe("side by side: the other kind and the other selection (AC 2)", () => {
  const h = new Harness();
  let admin: pg.Client;
  before(async () => { admin = await resetDb(); await h.start(); });
  after(async () => { await h.stop(); await admin.end(); });
  const scene = () => {
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
  };

  // protects=kind move keeps today's pull request, opened after the link; fails_when=no PR, a side-by-side PR, or a PR
  // before the link; no_claim=-.
  it("kind move: today's runs-on pull request, after the link", async () => {
    scene();
    const org = await makeOrg(admin, "sbs-move-owner");
    await h.send("installation", installationCreated([REPOS.shop]));
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0);
    await link(h, admin, org);
    const pulls = h.gh.repos.get("acme/shop")!.pulls;
    assert.deepEqual(pulls.map((p) => p.head), ["fenvix/runs-on"]);
  });

  // protects="All repositories" never opens pull requests by itself, in either kind; fails_when=a PR is opened at the
  // link; no_claim=the dashboard's per-project button.
  for (const kind of ["move", "side_by_side"] as const) {
    it(`"All repositories", kind ${kind}: no pull request, before or after the link`, async () => {
      admin = await resetDb().then(async (a) => { await admin.end(); return a; });
      await h.stop(); await h.start(); scene();
      const org = await makeOrg(admin, `sbs-all-${kind}`);
      await admin.query("update workspaces set onboarding_kind = $2 where id = $1", [org.workspaceId, kind]);
      await h.send("installation", installationCreated([REPOS.shop], "all"));
      await link(h, admin, org);
      assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0);
      assert.equal((await admin.query("select awaiting_link from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].awaiting_link, false);
    });
  }

  // protects=a repository that already has the file gets state side_by_side and no PR (not a refusal);
  // fails_when=a PR is opened or the state is unsupported/failed; no_claim=-.
  it("the file already on the default branch: state side_by_side, no pull request", async () => {
    admin = await resetDb().then(async (a) => { await admin.end(); return a; });
    await h.stop(); await h.start();
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML, [SIDE_BY_SIDE_PATH]: "name: fenvix side-by-side\n" } });
    const org = await makeOrg(admin, "sbs-present-owner");
    await admin.query("update workspaces set onboarding_kind = 'side_by_side' where id = $1", [org.workspaceId]);
    await h.send("installation", installationCreated([REPOS.shop]));
    await link(h, admin, org);
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0);
    const row = (await admin.query("select onboarding_state, onboarding_job from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.deepEqual(row, { onboarding_state: "side_by_side", onboarding_job: "test" });
  });
});

describe("side by side: our job (AC 3, AC 6)", () => {
  const h = new Harness();
  const fleet = new Fleet();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  const SHA = "5".repeat(40);
  let runSeq = 20_000;
  /** One of our jobs: a run of fenvix-side-by-side.yml, then its workflow_job events. */
  const ourJob = async (id: number, o: { event?: string; start?: boolean } = {}) => {
    const runId = ++runSeq;
    h.gh.addRun("acme/shop", runId, { event: o.event ?? "push", headSha: SHA, headBranch: "main", message: "m", path: SIDE_BY_SIDE_PATH });
    await h.send("workflow_job", workflowJob("queued", { id, runId, sha: SHA, branch: "main", name: "fenvix side-by-side (does not gate)" }));
    return runId;
  };

  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher: fleet });
    org = await makeOrg(admin, "sbs-job-owner");
    await admin.query("update workspaces set onboarding_kind = 'side_by_side' where id = $1", [org.workspaceId]);
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await link(h, admin, org);
  });
  after(async () => { await h.stop(); await admin.end(); });

  // protects=a side-by-side job never writes to GitHub, is never billed, always gets its own run row, and runs shadow
  // on the big machine; fails_when=a check run or a comment is posted, the event is billable, the row is kind ci_run or
  // missing, the machine is not shadow or not SIDE_BY_SIDE_INSTANCE_TYPE; no_claim=what EC2 does with the instance type.
  it("through the summary path: shadow on c6i.2xlarge, no check run, no comment, a finished side_by_side row, a non-billable event", async () => {
    // After the trial (enforce for the organization's own runs): still shadow.
    await admin.query("update ci_subscriptions set trial_started_at = now() - interval '40 days', trial_ends_at = now() - interval '10 days' where workspace_id = $1", [org.workspaceId]);
    await h.gh.repos.get("acme/shop")!.pulls.push({ number: 9, title: "x", body: "", head: "feature", base: "main", state: "open", headSha: SHA });
    const runId = await ourJob(7001);
    const l = fleet.launches.at(-1)!;
    assert.deepEqual({ job: l.jobId, mode: l.mode, type: l.instanceType, skip: l.skip, cap: l.skipCapacityCheck }, { job: 7001, mode: "shadow", type: "c6i.2xlarge", skip: undefined, cap: undefined });
    assert.deepEqual((await admin.query("select kind, workflow_path, event, skip_machine, mode from gh_jobs where job_id = 7001")).rows[0],
      { kind: "side_by_side", workflow_path: SIDE_BY_SIDE_PATH, event: "push", skip_machine: false, mode: "shadow" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 7001, runId, sha: SHA, branch: "main", runner: "fenvix-j7001" }));
    await h.summary({ runId, runner: "fenvix-j7001", summary: SUMMARY });
    await h.send("workflow_job", workflowJob("completed", { id: 7001, runId, sha: SHA, branch: "main", runner: "fenvix-j7001" }));
    assert.deepEqual(githubWrites(h), []);
    const run = (await admin.query("select r.kind, r.status, r.mode, r.finished_at is not null as finished from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 7001")).rows[0];
    assert.deepEqual(run, { kind: "side_by_side", status: "passed", mode: "shadow", finished: true });
    const ev = (await admin.query("select billable, reason, kind from ci_usage_events where github_job_id = 7001")).rows[0];
    assert.deepEqual(ev, { billable: false, reason: "side-by-side", kind: "side_by_side" });
    assert.equal((await admin.query("select has_summary from gh_jobs where job_id = 7001")).rows[0].has_summary, true);
    assert.notEqual((await admin.query("select setup_state from ci_projects")).rows[0].setup_state, "active", "the project is not turned active by a side-by-side run");
  });

  // protects=the late-results re-publish and the sweep also write nothing to GitHub; a job without a summary is not
  // proven (never green); fails_when=any of those paths posts a check run or comment; no_claim=-.
  it("through the late results (re-publish) and the sweep: still nothing written to GitHub; no summary is not proven", async () => {
    const before = h.gh.exchanges.length;
    // Late results of the published job: a not proven test re-publishes it.
    const cred = runnerCredential("fenvix-j7001", REPOS.shop.id);
    const res = await h.app.fastify.inject({
      method: "POST", url: "/v1/runner/results", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" },
      payload: { repositoryId: REPOS.shop.id, runId: runSeq, runAttempt: 1, runnerName: "fenvix-j7001", chunk: 0, chunks: 1, tests: [{ testId: "t::a", outcome: "not_proven", durationMs: 3 }] },
    });
    assert.equal(res.statusCode, 202, res.body);
    await h.app.service.idle();
    assert.equal((await admin.query("select r.status from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 7001")).rows[0].status, "not_proven");
    // A job whose summary never came: the sweep publishes it.
    const runId = await ourJob(7002);
    await h.send("workflow_job", workflowJob("in_progress", { id: 7002, runId, sha: SHA, branch: "main", runner: "fenvix-j7002" }));
    await h.send("workflow_job", workflowJob("completed", { id: 7002, runId, sha: SHA, branch: "main", runner: "fenvix-j7002" }));
    await admin.query("update gh_jobs set completed_at = now() - interval '1 hour' where job_id = 7002");
    await h.app.service.sweep();
    assert.deepEqual(githubWrites(h).filter((x) => h.gh.exchanges.indexOf(x) >= before), []);
    const row = (await admin.query("select r.kind, r.status, r.not_proven_reason, j.has_summary from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 7002")).rows[0];
    assert.deepEqual(row, { kind: "side_by_side", status: "not_proven", not_proven_reason: "no summary from the runner", has_summary: false });
  });

  // protects=the daily cap: the 10th job of 24 hours still gets a full machine, the 11th a skip machine (skip file,
  // its own ClientToken attempt, no capacity check); fails_when=the cap is off by one or the skip machine is full size;
  // no_claim=EC2's idempotency (unit tests of the launcher).
  it("the daily cap: the 10th job a full machine, the 11th a skip machine", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    for (let i = 1; i <= 11; i++) await ourJob(7100 + i);
    const mine = fleet.launches.filter((l) => l.jobId > 7100 && l.jobId <= 7111);
    assert.equal(mine.length, 11);
    assert.deepEqual(mine.slice(0, 10).map((l) => !!l.skip), Array(10).fill(false));
    const eleventh = mine[10]!;
    assert.deepEqual({ skip: eleventh.skip, cap: eleventh.skipCapacityCheck, type: eleventh.instanceType, mode: eleventh.mode, runner: eleventh.runnerName },
      { skip: { attempt: 1 }, cap: true, type: undefined, mode: "shadow", runner: "fenvix-s7111-1" });
    assert.equal((await admin.query("select skip_machine from gh_jobs where job_id = 7111")).rows[0].skip_machine, true);
  });

  // protects=a full fleet or a suspended installation gives a skip machine, never a wait; fails_when=the job throws
  // RetryLater (waits for a slot) or gets no machine; no_claim=that GitHub issues a token to a suspended installation.
  it("fleet full, suspended: a skip machine", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    fleet.full = true;
    await ourJob(7201);
    fleet.full = false;
    assert.deepEqual(fleet.launches.filter((l) => l.jobId === 7201).map((l) => [!!l.skip, l.skipCapacityCheck]), [[true, true]]);
    await admin.query("update gh_installations set suspended_at = now() where installation_id = $1", [INSTALLATION_ID]);
    await ourJob(7202);
    await admin.query("update gh_installations set suspended_at = null where installation_id = $1", [INSTALLATION_ID]);
    assert.deepEqual(fleet.launches.filter((l) => l.jobId === 7202).map((l) => !!l.skip), [true]);
  });

  // protects=no machine at all past the skip cap, without a placement, or unlinked: the job waits (GitHub cancels it);
  // fails_when=a machine is started anyway, or the job is retried; no_claim=GitHub's 24-hour cancel (AC 12 (c)).
  it("the 31st skip in 24 hours, no placement, unlinked: no machine", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    // 10 full machines and 30 skip machines already today.
    await admin.query(`insert into gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, status, kind, launched_at, skip_machine)
      select 800000 + g, $1, $2, 1, $3, 'completed', 'side_by_side', now() - interval '1 hour', g > 10 from generate_series(1, 40) g`, [REPOS.shop.id, INSTALLATION_ID, SHA]);
    const n = fleet.launches.length;
    await ourJob(7301);
    assert.equal(fleet.launches.length, n, "skip cap reached: no machine");
    await admin.query("delete from gh_jobs where job_id > 800000");
    fleet.places = false;
    await ourJob(7302);
    fleet.places = true;
    assert.equal(fleet.launches.length, n, "no placement: no machine");
    await admin.query("update gh_installations set workspace_id = null where installation_id = $1", [INSTALLATION_ID]);
    await ourJob(7303);
    await admin.query("update gh_installations set workspace_id = $2 where installation_id = $1", [INSTALLATION_ID, org.workspaceId]);
    assert.equal(fleet.launches.length, n, "unlinked: no machine");
    assert.deepEqual((await admin.query("select job_id, status, launched_at from gh_jobs where job_id in (7301, 7302, 7303) order by job_id")).rows.map((r) => [r.job_id, r.status, r.launched_at]),
      [[7301, "queued", null], [7302, "queued", null], [7303, "queued", null]]);
  });
});
