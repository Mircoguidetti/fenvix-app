import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { type Region, RetryLater, type RunnerLaunch, type RunnerLauncher } from "../../src/runners/launcher.ts";
import { verifySummaryCredential } from "../../src/runners/credentials.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, RUNNER_TOKEN, workflowJob } from "../helpers/harness.ts";

/** Records launches; can be told to refuse the next one. */
class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  refuseNext: Error | null = null;
  /** The regions with a placement (RUNNER_PLACEMENT). */
  regions: Region[] = ["us"];
  canPlace(region: Region) { return this.regions.includes(region); }
  async launch(l: RunnerLaunch) {
    if (this.refuseNext) { const e = this.refuseNext; this.refuseNext = null; throw e; }
    this.launches.push(l);
    return { instanceId: `i-${l.jobId}`, already: false, imageId: "ami-test", instanceType: "m7i.large" };
  }
}

describe("one machine per job: workflow_job.queued starts a runner machine", () => {
  const h = new Harness();
  const launcher = new FakeLauncher();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };

  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher });
    org = await makeOrg(admin, "runners-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("an installation not linked to an organization starts no machine (a stranger cannot spend our money)", async () => {
    h.gh.addRun("acme/shop", 9300, { event: "push", headSha: "a".repeat(40), headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 900, runId: 9300, sha: "a".repeat(40), branch: "main" }));
    assert.equal(launcher.launches.length, 0);
    assert.equal(h.gh.repos.get("acme/shop")!.jitRunners.length, 0);
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });

  it("a push on the default branch: one just-in-time runner (label fenvix, default group), one machine, cache writes allowed", async () => {
    const sha = "b".repeat(40);
    h.gh.addRun("acme/shop", 9301, { event: "push", headSha: sha, headBranch: "main", message: "main" });
    await h.send("workflow_job", workflowJob("queued", { id: 901, runId: 9301, sha, branch: "main" }), { delivery: "q-901" });
    assert.equal(launcher.launches.length, 1);
    const l = launcher.launches[0]!;
    // In the organization's region; shadow mode: linking the installation started the 30-day trial.
    assert.deepEqual({ ...l, jitConfig: "", summaryToken: "" }, { jobId: 901, runId: 9301, repositoryId: REPOS.shop.id, repositoryFullName: "acme/shop", installationId: INSTALLATION_ID, runnerName: "fenvix-j901", jitConfig: "", cacheAccess: "write", summaryToken: "", region: "us", mode: "shadow" });
    // The region and the mode the machine gets are recorded on the job: the run's mode is this one (review R-016 F4).
    assert.deepEqual((await admin.query("select region, mode from gh_jobs where job_id = 901")).rows[0], { region: "us", mode: "shadow" });
    // The machine's own summary credential: this runner, this repository, this run (R-012 F1), this attempt (R-016 F7).
    const scope = verifySummaryCredential([RUNNER_TOKEN], `Bearer ${l.summaryToken}`)!;
    assert.deepEqual({ ...scope, exp: 0 }, { runnerName: "fenvix-j901", repositoryId: REPOS.shop.id, runId: 9301, runAttempt: 1, exp: 0 });
    const jit = h.gh.repos.get("acme/shop")!.jitRunners;
    assert.equal(jit.length, 1);
    assert.deepEqual({ name: jit[0]!.name, labels: jit[0]!.labels, group: jit[0]!.runnerGroupId }, { name: "fenvix-j901", labels: ["fenvix"], group: 1 });
    assert.equal(l.jitConfig, jit[0]!.config);
    // The same delivery again: nothing more.
    await h.send("workflow_job", workflowJob("queued", { id: 901, runId: 9301, sha, branch: "main" }), { delivery: "q-901" });
    assert.equal(launcher.launches.length, 1);
  });

  it("a pull request, a fork, another branch: read-only cache (untrusted code never writes)", async () => {
    const cases: [number, { event: string; headBranch: string; headRepoId?: number }][] = [
      [9302, { event: "pull_request", headBranch: "feature" }],
      [9303, { event: "push", headBranch: "main", headRepoId: 99999 }],
      [9304, { event: "push", headBranch: "feature" }],
      [9305, { event: "pull_request_target", headBranch: "main" }],
    ];
    for (const [runId, r] of cases) {
      h.gh.addRun("acme/shop", runId, { ...r, headSha: "c".repeat(40), message: "x" });
      await h.send("workflow_job", workflowJob("queued", { id: runId - 8400, runId, sha: "c".repeat(40), branch: r.headBranch }));
    }
    assert.deepEqual(launcher.launches.slice(1).map((l) => l.cacheAccess), ["read", "read", "read", "read"]);
  });

  it("not a fenvix job, or a queued event that arrives after the job started: no machine", async () => {
    const before = launcher.launches.length;
    h.gh.addRun("acme/shop", 9306, { event: "push", headSha: "d".repeat(40), headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 906, runId: 9306, sha: "d".repeat(40), branch: "main", labels: ["ubuntu-latest"] }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 907, runId: 9306, sha: "d".repeat(40), branch: "main" }));
    await h.send("workflow_job", workflowJob("queued", { id: 907, runId: 9306, sha: "d".repeat(40), branch: "main" }));
    assert.equal(launcher.launches.length, before);
  });

  it("the fleet at its limit: the delivery fails (the queue retries); the retry gets a fresh runner name and a machine", async () => {
    const sha = "e".repeat(40);
    h.gh.addRun("acme/shop", 9307, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    launcher.refuseNext = new RetryLater("4 fenvix machines are running (limit 4)");
    const before = launcher.launches.length;
    await h.send("workflow_job", workflowJob("queued", { id: 908, runId: 9307, sha, branch: "main" }), { delivery: "q-908" });
    assert.equal(launcher.launches.length, before);
    const d = (await admin.query("select processed_at, error from gh_webhook_deliveries where delivery_id = 'q-908'")).rows[0];
    assert.equal(d.processed_at, null);
    assert.match(d.error, /limit 4/);
    // The just-in-time runner of the refused launch was deleted (R-012 F12), so the retry registers the same name again.
    assert.ok(!h.gh.repos.get("acme/shop")!.jitRunners.some((r) => r.name.startsWith("fenvix-j908")));
    await h.send("workflow_job", workflowJob("queued", { id: 908, runId: 9307, sha, branch: "main" }), { delivery: "q-908" });
    assert.equal(launcher.launches.length, before + 1);
    assert.equal(launcher.launches.at(-1)!.runnerName, "fenvix-j908");
    assert.deepEqual(h.gh.repos.get("acme/shop")!.jitRunners.filter((r) => r.name.startsWith("fenvix-j908")).map((r) => r.name), ["fenvix-j908"]);
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path}: ${JSON.stringify(x.problems)}`), []);
  });

  it("an EU organization with no EU placement: no machine anywhere, no just-in-time runner; the job stays queued", async () => {
    await admin.query("update workspaces set region = 'eu' where id = $1", [org.workspaceId]);
    const before = launcher.launches.length;
    const jitBefore = h.gh.repos.get("acme/shop")!.jitRunners.length;
    const sha = "9".repeat(40);
    h.gh.addRun("acme/shop", 9308, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 909, runId: 9308, sha, branch: "main" }), { delivery: "q-909" });
    assert.equal(launcher.launches.length, before, "never placed in the US");
    assert.equal(h.gh.repos.get("acme/shop")!.jitRunners.length, jitBefore);
    const job = (await admin.query("select status, region from gh_jobs where job_id = 909")).rows[0];
    assert.deepEqual(job, { status: "queued", region: "eu" });
    // Handled (not retried by the queue): GitHub times the job out.
    assert.ok((await admin.query("select processed_at from gh_webhook_deliveries where delivery_id = 'q-909'")).rows[0].processed_at);

    // With an EU placement, the next job starts there; after the trial, in enforce mode.
    launcher.regions = ["us", "eu"];
    await admin.query("update ci_subscriptions set trial_started_at = now() - interval '40 days', trial_ends_at = now() - interval '10 days' where workspace_id = $1", [org.workspaceId]);
    h.gh.addRun("acme/shop", 9309, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 910, runId: 9309, sha, branch: "main" }));
    assert.deepEqual({ region: launcher.launches.at(-1)!.region, mode: launcher.launches.at(-1)!.mode, job: launcher.launches.at(-1)!.jobId }, { region: "eu", mode: "enforce", job: 910 });
    await admin.query("update workspaces set region = 'us' where id = $1", [org.workspaceId]);
  });
});

describe("always-on runner stopped: queued jobs wait, nothing is failed or billed", () => {
  const h = new Harness();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "stopped-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("a job queued for hours: no check run, no run row, no usage event, the sweep leaves it alone", async () => {
    await h.send("workflow_job", workflowJob("queued", { id: 950, runId: 9350, sha: "f".repeat(40), branch: "main" }));
    await admin.query("update gh_jobs set created_at = now() - interval '5 hours', updated_at = now() - interval '5 hours' where job_id = 950");
    assert.equal(await h.app.service.sweep(), 0);
    assert.equal(h.gh.repos.get("acme/shop")!.checkRuns.size, 0);
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events")).rows[0].n, 0);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs")).rows[0].n, 0);
    assert.equal((await admin.query("select status from gh_jobs where job_id = 950")).rows[0].status, "queued");
  });
});
