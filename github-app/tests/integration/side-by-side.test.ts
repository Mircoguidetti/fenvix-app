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
import { makeWorkerHandler } from "../../src/lambda/handlers.ts";
import { jsonLogger, runWork } from "../../src/work.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, REPOS, resetDb, runnerCredential, workflowJob } from "../helpers/harness.ts";

const SUMMARY = JSON.parse(readFileSync(new URL("../fixtures/runner/job3-warm-pass.summary.json", import.meta.url), "utf8")) as Record<string, unknown>;
type Row = Record<string, any>;

/** Our fleet in memory: every launch recorded; `full` makes the region's fleet full, `places` its placement. */
class Fleet implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  /** Every call, launched or not. */
  tries: RunnerLaunch[] = [];
  capacityAsked: (string | undefined)[] = [];
  full = false;
  /** The fleet fills between the capacity check and the launch: hasCapacity says yes, a full launch is refused. */
  race = false;
  places = true;
  /** The next this many launches fail (an AWS error, not a full fleet). */
  failTimes = 0;
  /** Skip launches fail. */
  skipFails = false;
  /** EC2 answers that the machine exists already (the same ClientToken). */
  already = false;
  canPlace(_r: Region) { return this.places; }
  async hasCapacity(_r?: Region, instanceType?: string) { this.capacityAsked.push(instanceType); return !this.full; }
  async launch(l: RunnerLaunch) {
    this.tries.push(l);
    if ((this.full || this.race) && !l.skipCapacityCheck) throw new RetryLater("full");
    if (this.failTimes > 0) { this.failTimes--; throw new Error("InsufficientInstanceCapacity"); }
    if (this.skipFails && l.skip) throw new Error("InsufficientInstanceCapacity");
    this.launches.push(l);
    return { instanceId: `i-${l.jobId}`, already: this.already };
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

  // protects=onboard() again on a repository that runs side by side, when it now fails (his workflow file is gone),
  // keeps the repository side by side with what it stored (the merged file still runs); fails_when=the state becomes
  // no_workflow or failed (every side-by-side job would then get no machine); no_claim=-.
  it("running side by side, onboard() again fails: the repository stays side_by_side", async () => {
    const shop = h.gh.repos.get("acme/shop")!;
    const ci = shop.branches.get("main")!.files.get(".github/workflows/ci.yml")!;
    shop.branches.get("main")!.files.delete(".github/workflows/ci.yml");
    try {
      const res = await h.app.service.onboard(REPOS.shop.id);
      assert.notEqual(res.state, "side_by_side");
    } finally { shop.branches.get("main")!.files.set(".github/workflows/ci.yml", ci); }
    const row = (await admin.query("select onboarding_state, side_by_side_job_name, onboarding_detail from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.deepEqual({ s: row.onboarding_state, j: row.side_by_side_job_name }, { s: "side_by_side", j: "test" });
    assert.match(row.onboarding_detail, /the merged side-by-side file keeps running/);
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
    // protects=a pull request anyone opens from a branch named fenvix/side-by-side changes nothing: only the one
    // fenvix opened counts; fails_when=the repository turns side_by_side_pr_open (free machines); no_claim=-.
    await h.send("pull_request", pullRequest("opened", { number: 7, headRef: "fenvix/side-by-side", headSha: "7".repeat(40) }));
    assert.equal((await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].onboarding_state, "pr_open");
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
  const ourJob = async (id: number, o: { event?: string; start?: boolean; headRepoId?: number | null; branch?: string } = {}) => {
    const runId = ++runSeq;
    h.gh.addRun("acme/shop", runId, { event: o.event ?? "push", headSha: SHA, headBranch: o.branch ?? "main", message: "m", path: SIDE_BY_SIDE_PATH, ...(o.headRepoId !== undefined ? { headRepoId: o.headRepoId } : {}) });
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

  // protects=review fixes: a push to the default branch writes the cache, a pull request only reads it; no machine for
  // a fork pull request, for a repository not onboarded side by side (a hand-written file), and a failed lookup of the
  // run is retried rather than guessed as an ordinary billable job; fails_when=any of those gets a machine or a write
  // token; no_claim=GitHub's own fork handling.
  it("cache access by trust; no machine for a fork, a repository not side by side, or an unknown run", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    await ourJob(7401);
    assert.equal(fleet.launches.at(-1)!.cacheAccess, "write", "push to the default branch");
    await ourJob(7402, { event: "pull_request", branch: "feature" });
    assert.equal(fleet.launches.at(-1)!.cacheAccess, "read", "pull request");
    const n = fleet.launches.length;
    await ourJob(7403, { event: "pull_request", branch: "feature", headRepoId: 999_999 });
    assert.equal(fleet.launches.length, n, "fork pull request: no machine");
    await admin.query("update gh_repositories set onboarding_state = 'merged' where repository_id = $1", [REPOS.shop.id]);
    await ourJob(7404);
    await admin.query("update gh_repositories set onboarding_state = 'side_by_side_pr_open' where repository_id = $1", [REPOS.shop.id]);
    assert.equal(fleet.launches.length, n, "not onboarded side by side: no machine");
    // GitHub fails the run lookup: the delivery fails (retried later); nothing is launched or classified.
    const runId = ++runSeq;
    h.gh.addRun("acme/shop", runId, { event: "push", headSha: SHA, headBranch: "main", message: "m", path: SIDE_BY_SIDE_PATH });
    h.gh.failNext.set(`GET /repos/acme/shop/actions/runs/${runId}`, 502);
    await h.send("workflow_job", workflowJob("queued", { id: 7405, runId, sha: SHA, branch: "main", name: "fenvix side-by-side (does not gate)" }));
    assert.equal(fleet.launches.length, n, "lookup failed: no machine");
    assert.equal((await admin.query("select workflow_path from gh_jobs where job_id = 7405")).rows[0].workflow_path, null);
    assert.equal(githubWrites(h).length, 0, "no check run for it either");
  });

  // protects=the server-side fork check fails closed: a pull request whose head repository GitHub no longer shows (a
  // deleted fork), and a redelivery whose run lookup fails once the workflow file is known, get no machine (the
  // delivery is retried); fails_when=either gets a machine (the job-level guard is in a file the fork controls);
  // no_claim=GitHub's own fork handling.
  it("the fork check fails closed: no head repository, or a failed run lookup: no machine", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    const n = fleet.launches.length;
    await ourJob(7801, { event: "pull_request", branch: "feature", headRepoId: null });
    assert.equal(fleet.launches.length, n, "a deleted fork: no machine");
    // Classified (workflow file cached) while unlinked, then delivered again with a lookup that fails.
    await admin.query("update gh_installations set workspace_id = null where installation_id = $1", [INSTALLATION_ID]);
    const runId = await ourJob(7802);
    await admin.query("update gh_installations set workspace_id = $2 where installation_id = $1", [INSTALLATION_ID, org.workspaceId]);
    assert.equal((await admin.query("select workflow_path from gh_jobs where job_id = 7802")).rows[0].workflow_path, SIDE_BY_SIDE_PATH);
    h.gh.failNext.set(`GET /repos/acme/shop/actions/runs/${runId}`, 502);
    await h.send("workflow_job", workflowJob("queued", { id: 7802, runId, sha: SHA, branch: "main", name: "fenvix side-by-side (does not gate)" }));
    assert.equal(fleet.launches.length, n, "lookup failed: no machine");
    assert.equal((await admin.query("select launched_at from gh_jobs where job_id = 7802")).rows[0].launched_at, null);
    // GitHub answers again: the redelivery gets its machine.
    await h.send("workflow_job", workflowJob("queued", { id: 7802, runId, sha: SHA, branch: "main", name: "fenvix side-by-side (does not gate)" }));
    assert.equal(fleet.launches.at(-1)!.jobId, 7802);
  });

  // protects=a full machine's hard lifetime is the repository's stored timeout (60 for CI_YAML) + 10, the capacity is
  // asked for the side-by-side size, a retry after an AWS error gets a new ClientToken (retry 2), and three failures
  // release the cap slot (the next job still gets a full machine); fails_when=no lifetime, the capacity asked for one
  // slot, the retry reuses the token, or the slot stays taken; no_claim=EC2.
  it("lifetime, capacity in slots, a retry's own token, three failures release the slot", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    assert.equal((await admin.query("select side_by_side_timeout_minutes from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].side_by_side_timeout_minutes, 60);
    fleet.failTimes = 1;
    await ourJob(7811);
    const l = fleet.launches.at(-1)!;
    assert.deepEqual({ job: l.jobId, retry: l.retry, life: l.lifetimeMinutes }, { job: 7811, retry: 2, life: 70 });
    assert.equal(fleet.tries.filter((t) => t.jobId === 7811)[0]!.retry, 1);
    assert.equal(fleet.capacityAsked.at(-1), "c6i.2xlarge");
    fleet.failTimes = 3;
    await ourJob(7812);
    assert.equal((await admin.query("select launched_at from gh_jobs where job_id = 7812")).rows[0].launched_at, null, "the slot is released");
    await admin.query(`insert into gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, status, kind, launched_at, skip_machine)
      select 820000 + g, $1, $2, 1, $3, 'completed', 'side_by_side', now() - interval '1 hour', false from generate_series(1, 8) g`, [REPOS.shop.id, INSTALLATION_ID, SHA]);
    await ourJob(7813);
    assert.deepEqual({ job: fleet.launches.at(-1)!.jobId, skip: !!fleet.launches.at(-1)!.skip }, { job: 7813, skip: false }, "the 10th slot is free again");
    await admin.query("delete from gh_jobs where job_id > 820000");
  });

  // protects=the skip machine after a full fleet at launch: a machine EC2 already has (same token) deletes the unused
  // runner; a skip launch that fails deletes its runner and releases the slot; fails_when=a runner is left registered
  // or the job keeps launched_at; no_claim=-.
  it("skip after a full fleet: an existing machine or a failed launch leaves no runner behind", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    const deletes = () => h.gh.exchanges.filter((x) => x.method === "DELETE" && /\/actions\/runners\//.test(x.path)).length;
    let d = deletes();
    fleet.race = true; fleet.already = true;
    try { await ourJob(7821); } finally { fleet.race = false; fleet.already = false; }
    assert.equal(deletes() - d, 2, "the refused full runner and the unused skip runner");
    d = deletes();
    fleet.race = true; fleet.skipFails = true;
    try { await ourJob(7822); } finally { fleet.race = false; fleet.skipFails = false; }
    assert.equal(deletes() - d, 2, "both runners deleted");
    assert.equal((await admin.query("select launched_at from gh_jobs where job_id = 7822")).rows[0].launched_at, null);
  });

  // protects=a job whose every lookup failed (never classified) is classified when it is published: our job gets no
  // check run and is never billed; a failed lookup then leaves it unpublished (retried); fails_when=it is published as
  // an ordinary job; no_claim=-.
  it("never classified before it completed: classified at publish", async () => {
    const runId = ++runSeq;
    h.gh.addRun("acme/shop", runId, { event: "push", headSha: SHA, headBranch: "main", message: "m", path: SIDE_BY_SIDE_PATH });
    await admin.query(`insert into gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, head_branch, status, conclusion, labels, completed_at, job_name, workflow_name)
      values (7831, $1, $2, $3, $4, 'main', 'completed', 'cancelled', array['fenvix'], now() - interval '1 hour', 'fenvix side-by-side (does not gate)', 'fenvix side by side')`, [REPOS.shop.id, INSTALLATION_ID, runId, SHA]);
    const before = h.gh.exchanges.length;
    h.gh.failNext.set(`GET /repos/acme/shop/actions/runs/${runId}`, 502);
    await h.app.service.sweep();
    assert.equal((await admin.query("select published_at from gh_jobs where job_id = 7831")).rows[0].published_at, null, "not published on a failed lookup");
    await h.app.service.sweep();
    assert.deepEqual((await admin.query("select kind, published_at is not null as published from gh_jobs where job_id = 7831")).rows[0], { kind: "side_by_side", published: true });
    assert.deepEqual(githubWrites(h).filter((x) => h.gh.exchanges.indexOf(x) >= before), []);
    assert.equal((await admin.query("select billable from ci_usage_events where github_job_id = 7831")).rows[0]?.billable ?? false, false);
  });

  // protects=a side-by-side job that gets no machine (a fork, a cap) never counts as a customer job waiting, so it
  // cannot hold back the region's warm-ups; an ordinary queued job still does; fails_when=the count includes it;
  // no_claim=the warm-up policy itself (warmup.test.ts).
  it("a side-by-side job left queued does not hold back warm-ups", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    await ourJob(7841, { event: "pull_request", branch: "feature", headRepoId: 999_999 });
    assert.equal((await admin.query("select region, launched_at from gh_jobs where job_id = 7841")).rows[0].launched_at, null);
    const region = (await admin.query("select region from gh_jobs where job_id = 7841")).rows[0].region ?? "us";
    const base = await h.app.service.warmups.customerJobsWaiting(region, 3600);
    await admin.query(`insert into gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, status, kind, region, created_at)
      values (7842, $1, $2, 1, $3, 'queued', 'ci_run', $4, now())`, [REPOS.shop.id, INSTALLATION_ID, SHA, region]);
    assert.equal(await h.app.service.warmups.customerJobsWaiting(region, 3600), base + 1);
    assert.equal(base, 0, "the side-by-side job is not counted");
    await admin.query("delete from gh_jobs where job_id = 7842");
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

  // protects=the fleet filling between the check and the launch gives a skip machine (read cache), and turning
  // side-by-side runs off sends merged files' jobs to skip machines (as documented); fails_when=the job gets no machine,
  // a full machine, or a write token; no_claim=-.
  it("a full fleet at launch, and side-by-side runs turned off: skip machines", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    fleet.race = true;
    await ourJob(7701);
    fleet.race = false;
    const l = fleet.launches.at(-1)!;
    assert.deepEqual({ job: l.jobId, skip: !!l.skip, cache: l.cacheAccess }, { job: 7701, skip: true, cache: "read" });
    assert.deepEqual((await admin.query("select skip_machine, cache_access, launched_at is not null as launched from gh_jobs where job_id = 7701")).rows[0],
      { skip_machine: true, cache_access: "read", launched: true });
    const sbs = h.app.service.sbs as { enabled: boolean };
    sbs.enabled = false;
    try { await ourJob(7702); } finally { sbs.enabled = true; }
    assert.deepEqual({ job: fleet.launches.at(-1)!.jobId, skip: !!fleet.launches.at(-1)!.skip }, { job: 7702, skip: true });
  });

  // protects=the daily cap is decided atomically: two deliveries at once at count 9 give exactly one full machine;
  // fails_when=both get a full machine (the count read twice before either reserves); no_claim=SQS ordering.
  it("two concurrent deliveries at count 9: exactly one full machine", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    await admin.query(`insert into gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, status, kind, launched_at, skip_machine)
      select 810000 + g, $1, $2, 1, $3, 'completed', 'side_by_side', now() - interval '1 hour', false from generate_series(1, 9) g`, [REPOS.shop.id, INSTALLATION_ID, SHA]);
    const runA = ++runSeq; const runB = ++runSeq;
    for (const r of [runA, runB]) h.gh.addRun("acme/shop", r, { event: "push", headSha: SHA, headBranch: "main", message: "m", path: SIDE_BY_SIDE_PATH });
    const n = fleet.launches.length;
    await Promise.all([
      h.send("workflow_job", workflowJob("queued", { id: 7601, runId: runA, sha: SHA, branch: "main", name: "fenvix side-by-side (does not gate)" })),
      h.send("workflow_job", workflowJob("queued", { id: 7602, runId: runB, sha: SHA, branch: "main", name: "fenvix side-by-side (does not gate)" })),
    ]);
    const mine = fleet.launches.slice(n);
    assert.equal(mine.length, 2);
    assert.deepEqual(mine.map((l) => !!l.skip).sort(), [false, true], "one full, one skip");
    await admin.query("delete from gh_jobs where job_id > 800000");
  });

  // protects=a job on a skip machine publishes as not proven "skip machine: no test ran", never passed;
  // fails_when=it is stored passed; no_claim=-.
  it("a skip machine's job: not proven, 'skip machine: no test ran'", async () => {
    await admin.query("delete from gh_jobs where kind = 'side_by_side'");
    fleet.full = true;
    const runId = await ourJob(7501);
    fleet.full = false;
    await h.send("workflow_job", workflowJob("in_progress", { id: 7501, runId, sha: SHA, branch: "main", runner: "fenvix-s7501-1" }));
    await h.send("workflow_job", workflowJob("completed", { id: 7501, runId, sha: SHA, branch: "main", runner: "fenvix-s7501-1" }));
    await admin.query("update gh_jobs set completed_at = now() - interval '1 hour' where job_id = 7501");
    await h.app.service.sweep();
    const row = (await admin.query("select r.status, r.not_proven_reason, j.skip_machine from ci_runs r join gh_jobs j on j.ci_run_id = r.id where j.job_id = 7501")).rows[0];
    assert.deepEqual(row, { status: "not_proven", not_proven_reason: "skip machine: no test ran", skip_machine: true });
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

describe("side by side: his test job, from webhooks and from his history (item 17, AC 10)", () => {
  const h = new Harness();
  let admin: pg.Client;
  const CI = ".github/workflows/ci.yml";
  const jobs = (runId: number) => [
    { id: runId * 10 + 1, name: "test", conclusion: "success", steps: [{ name: "Run python -m pytest -q", number: 3, conclusion: "success" }] },
    { id: runId * 10 + 2, name: "lint", conclusion: "success" },
  ];
  const stored = async () => (await admin.query("select job_id, source, event, pr_number from gh_customer_jobs order by job_id")).rows;
  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "sbs-history-owner");
    await admin.query("update workspaces set onboarding_kind = 'side_by_side' where id = $1", [org.workspaceId]);
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { [CI]: CI_YAML } });
    for (const id of [30001, 30002, 30003]) h.gh.addRun("acme/shop", id, { event: "push", headSha: "e".repeat(40), headBranch: "main", message: "m", path: CI, jobs: jobs(id) });
    // GitHub's rate limit is low when the jobs of run 30002 come back.
    h.gh.rateRemaining = (path) => (path.endsWith("/actions/runs/30002/jobs") ? 99 : 5000);
    await h.send("installation", installationCreated([REPOS.shop]));
    await link(h, admin, org);
  });
  after(async () => { await h.stop(); await admin.end(); });

  // protects=his history stops below 100 requests left, keeps where it stopped and when to go on (24 hours), and the
  // sweep resumes it there; only his test job is kept; fails_when=it reads on, loses its place, reads a job twice, or
  // keeps other jobs; no_claim=GitHub's real limits.
  it("history: stops at X-RateLimit-Remaining 99 with its cursor and history_next_at; the sweep resumes it after 24 hours", async () => {
    const row = (await admin.query("select history_cursor, history_next_at, onboarding_state from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.equal(row.onboarding_state, "side_by_side_pr_open");
    assert.deepEqual({ page: row.history_cursor.page, last: row.history_cursor.lastRunId }, { page: 1, last: 30002 });
    const in24h = Date.now() + 24 * 3_600_000;
    assert.ok(Math.abs(new Date(row.history_next_at).getTime() - in24h) < 60_000, `history_next_at ${row.history_next_at}`);
    assert.deepEqual(await stored(), [{ job_id: 300021, source: "history", event: "push", pr_number: null }, { job_id: 300031, source: "history", event: "push", pr_number: null }]);
    // Not due yet: the sweep leaves it.
    await h.app.service.sweep();
    await h.app.service.idle();
    assert.equal((await stored()).length, 2);
    // 24 hours later (the clock moved): the sweep resumes after run 30002.
    h.gh.rateRemaining = 5000;
    await admin.query("update gh_repositories set history_next_at = now() - interval '1 second' where repository_id = $1", [REPOS.shop.id]);
    const listed = h.gh.exchanges.filter((x) => x.path.endsWith("/jobs")).length;
    await h.app.service.sweep();
    await h.app.service.idle();
    assert.deepEqual((await stored()).map((r) => r.job_id), [300011, 300021, 300031]);
    assert.deepEqual(h.gh.exchanges.filter((x) => x.path.endsWith("/jobs")).slice(listed).map((x) => x.path), ["/repos/acme/shop/actions/runs/30001/jobs"], "resumed after its cursor");
    const done = (await admin.query("select history_cursor, history_next_at from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.deepEqual({ done: done.history_cursor.done, next: done.history_next_at }, { done: true, next: null });
  });

  // protects=a history reading takes at most 30 s per message and stops with 30 s of the Lambda left (through the
  // worker's handler too), keeping its place; a workflow file GitHub no longer has ends it for good; fails_when=it
  // reads on past the budget, starts with too little time, loses its cursor, or retries a missing file;
  // no_claim=Lambda's real clock.
  it("history: 30 s per message at most, 30 s of the Lambda kept, a missing workflow file ends it", async () => {
    const reset = async () => {
      await admin.query("delete from gh_customer_jobs where source = 'history'");
      await admin.query("update gh_repositories set history_cursor = null, history_next_at = null where repository_id = $1", [REPOS.shop.id]);
    };
    const cursor = async () => (await admin.query("select history_cursor, history_next_at from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    h.gh.rateRemaining = 5000;
    await reset();
    let t = Date.now();
    assert.equal(await h.app.service.readHistory(REPOS.shop.id, { clock: () => (t += 20_000) }), "paused");
    const one = (await admin.query("select job_id from gh_customer_jobs where source = 'history'")).rows;
    assert.equal(one.length, 1, "one run read in the 30 s");
    const c = await cursor();
    assert.equal(c.history_cursor.lastRunId, Math.floor(one[0].job_id / 10));
    assert.ok(new Date(c.history_next_at).getTime() <= Date.now() + 1000, "the sweep goes on at once");
    await reset();
    assert.equal(await h.app.service.readHistory(REPOS.shop.id, { deadline: Date.now() + 25_000 }), "paused");
    assert.equal((await admin.query("select count(*)::int as n from gh_customer_jobs where source = 'history'")).rows[0].n, 0, "25 s left: nothing read");
    await reset();
    const handler = makeWorkerHandler(async () => ({ service: h.app.service, log: jsonLogger("error"), blobs: null }));
    const out = await handler({ Records: [{ messageId: "m-1", body: JSON.stringify({ v: 1, work: { kind: "side_by_side_history", repositoryId: REPOS.shop.id } }) }] }, { getRemainingTimeInMillis: () => 20_000 });
    assert.deepEqual(out.batchItemFailures, []);
    assert.equal((await admin.query("select count(*)::int as n from gh_customer_jobs where source = 'history'")).rows[0].n, 0, "the handler passes the Lambda's deadline");
    await reset();
    h.gh.failNext.set("GET /repos/acme/shop/actions/workflows/ci.yml/runs", 404);
    assert.equal(await h.app.service.readHistory(REPOS.shop.id), "done");
    const gone = await cursor();
    assert.deepEqual({ done: gone.history_cursor.done, missing: gone.history_cursor.missing, next: gone.history_next_at }, { done: true, missing: "ci.yml", next: null });
  });

  // protects=a completed job of his test job (by name and workflow file) is stored with the run's event and pull
  // request; other jobs and other workflows are not; fails_when=lint is stored, another file's "test" is stored, or
  // the PR number is missing; no_claim=-.
  it("webhooks: his completed test job is stored with event and PR; lint and another workflow's job are not", async () => {
    h.gh.addRun("acme/shop", 30010, { event: "pull_request", headSha: "f".repeat(40), headBranch: "feature", message: "m", path: CI, pullRequests: [5] });
    h.gh.addRun("acme/shop", 30011, { event: "push", headSha: "f".repeat(40), headBranch: "feature", message: "m", path: ".github/workflows/nightly.yml" });
    // A push run lists the open pull requests of its branch: a push is keyed without them.
    h.gh.addRun("acme/shop", 30012, { event: "push", headSha: "f".repeat(40), headBranch: "feature", message: "m", path: CI, pullRequests: [5] });
    const done = (id: number, runId: number, name: string) => h.send("workflow_job", workflowJob("completed", { id, runId, sha: "f".repeat(40), branch: "feature", labels: ["ubuntu-latest"], name, runner: "GitHub Actions 2" }));
    await done(301001, 30010, "test");
    await done(301002, 30010, "lint");
    await done(301003, 30011, "test");
    await done(301004, 30012, "test");
    const rows = (await admin.query("select job_id, source, event, pr_number, steps is not null as steps from gh_customer_jobs where job_id > 301000 order by job_id")).rows;
    assert.deepEqual(rows, [{ job_id: 301001, source: "webhook", event: "pull_request", pr_number: 5, steps: true },
      { job_id: 301004, source: "webhook", event: "push", pr_number: null, steps: true }]);
  });
});

describe("side by side: turned off, and the pull request closed (state matrix)", () => {
  const h = new Harness();
  let admin: pg.Client;
  after(async () => { await h.stop(); await admin.end(); });

  // protects=SIDE_BY_SIDE_ENABLED=false opens no side-by-side pull request for an organization that chose it;
  // fails_when=a PR is opened; no_claim=the Connect page hiding the choice (the API's sideBySideAvailable).
  it("turned off: no pull request, the detail says why", async () => {
    admin = await resetDb();
    await h.start({ SIDE_BY_SIDE_ENABLED: "false" });
    const org = await makeOrg(admin, "sbs-off-owner");
    await admin.query("update workspaces set onboarding_kind = 'side_by_side' where id = $1", [org.workspaceId]);
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await link(h, admin, org);
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0);
    assert.deepEqual((await admin.query("select onboarding_state, onboarding_detail from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0],
      { onboarding_state: "pending", onboarding_detail: "side-by-side runs are turned off: no pull request was opened" });
  });

  // protects=the side-by-side pull request closed without merging maps to state closed; fails_when=it stays open or
  // becomes side_by_side; no_claim=-.
  it("the side-by-side pull request closed without merging: state closed", async () => {
    await h.stop();
    admin = await resetDb().then(async (a) => { await admin.end(); return a; });
    await h.start();
    const org = await makeOrg(admin, "sbs-closed-owner");
    await admin.query("update workspaces set onboarding_kind = 'side_by_side' where id = $1", [org.workspaceId]);
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await link(h, admin, org);
    const pr = h.gh.repos.get("acme/shop")!.pulls[0]!;
    await h.send("pull_request", pullRequest("closed", { number: pr.number, headRef: "fenvix/side-by-side", headSha: pr.headSha, merged: false }));
    const row = (await admin.query("select onboarding_state, onboarding_detail from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.equal(row.onboarding_state, "closed");
    assert.match(row.onboarding_detail, /side-by-side pull request #1 was closed without merging/);
    // protects=reopened, the repository runs side by side again and its history reading, stopped while it was closed,
    // goes on; fails_when=the history stays partial for good; no_claim=-.
    await admin.query("update gh_repositories set history_cursor = $2::jsonb, history_next_at = null where repository_id = $1", [REPOS.shop.id, JSON.stringify({ page: 1, lastRunId: null, since: "2026-10-27" })]);
    await h.send("pull_request", pullRequest("reopened", { number: pr.number, headRef: "fenvix/side-by-side", headSha: pr.headSha }));
    await h.app.service.idle();
    const again = (await admin.query("select onboarding_state, history_cursor from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.deepEqual({ s: again.onboarding_state, done: again.history_cursor?.done }, { s: "side_by_side_pr_open", done: true });
  });
});

describe("side by side: a GitHub error never delays an ordinary job", () => {
  const h = new Harness();
  const fleet = new Fleet();
  let admin: pg.Client;
  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher: fleet });
    const org = await makeOrg(admin, "sbs-move-5xx-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await link(h, admin, org);
  });
  after(async () => { await h.stop(); await admin.end(); });

  // protects=in a repository never set up side by side, a GitHub 5xx on the run lookup launches the job at once, as
  // before side-by-side runs (only the side-by-side decision waits for GitHub); fails_when=the delivery fails and the
  // job waits for the queue's retry; no_claim=-.
  it("a move repository: the run lookup fails, the machine starts anyway", async () => {
    const SHA = "6".repeat(40);
    h.gh.addRun("acme/shop", 40001, { event: "push", headSha: SHA, headBranch: "main", message: "m", path: ".github/workflows/ci.yml" });
    h.gh.failNext.set("GET /repos/acme/shop/actions/runs/40001", 502);
    await h.send("workflow_job", workflowJob("queued", { id: 9101, runId: 40001, sha: SHA, branch: "main" }));
    assert.equal(fleet.launches.at(-1)?.jobId, 9101);
    assert.equal((await admin.query("select kind from gh_jobs where job_id = 9101")).rows[0].kind, "ci_run");
  });
});
