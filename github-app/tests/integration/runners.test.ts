import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { RetryLater, type RunnerLaunch, type RunnerLauncher } from "../../src/runners/launcher.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, workflowJob } from "../helpers/harness.ts";

/** Records launches; can be told to refuse the next one. */
class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  refuseNext: Error | null = null;
  async launch(l: RunnerLaunch) {
    if (this.refuseNext) { const e = this.refuseNext; this.refuseNext = null; throw e; }
    this.launches.push(l);
    return { instanceId: `i-${l.jobId}`, already: false };
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
    assert.deepEqual({ ...l, jitConfig: "" }, { jobId: 901, runId: 9301, repositoryId: REPOS.shop.id, repositoryFullName: "acme/shop", installationId: INSTALLATION_ID, runnerName: "fenvix-j901", jitConfig: "", cacheAccess: "write" });
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
    // SQS delivers it again: the first runner name is taken on GitHub (409), a fresh one is used.
    await h.send("workflow_job", workflowJob("queued", { id: 908, runId: 9307, sha, branch: "main" }), { delivery: "q-908" });
    assert.equal(launcher.launches.length, before + 1);
    assert.match(launcher.launches.at(-1)!.runnerName, /^fenvix-j908-[a-z0-9]+$/);
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path}: ${JSON.stringify(x.problems)}`), []);
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
