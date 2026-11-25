import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import type { LaunchResult, Region, RunnerLaunch, RunnerLauncher } from "../../src/runners/launcher.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, workflowJob } from "../helpers/harness.ts";

// C4 (idea 3, "is this red real?"): the machine that ran each job, migration 0022.

/** Records launches; `during` runs inside launch(), before the App writes the launch on the job row. */
class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  during: ((l: RunnerLaunch) => Promise<void>) | null = null;
  canPlace(region: Region) { return region === "us"; }
  async launch(l: RunnerLaunch): Promise<LaunchResult> {
    this.launches.push(l);
    if (this.during) { const f = this.during; this.during = null; await f(l); }
    return { instanceId: `i-${l.jobId}`, already: false, imageId: "ami-test", instanceType: "m7i.large" };
  }
}

describe("gh_machine_kind and the machine columns (migration 0022)", () => {
  let admin: pg.Client;
  before(async () => { admin = await resetDb(); });
  after(async () => { await admin.end(); });

  // protects=the rule C3 relies on to call two jobs comparable; fails_when=another job's JIT runner, a runner without a
  // known image, or a name that only starts like this job's id counts as 'ec2'; no_claim=GitHub's real runner names.
  it("the kind from (job id, runner name, image): 7 cases", async () => {
    const cases: [number, string | null, string | null, string | null][] = [
      [42, "fenvix-j42", "ami-1", "ec2"],
      [42, "fenvix-j42-k3x9", "ami-1", "ec2"],
      [42, "fenvix-j42", null, null],
      // The spec's acceptance 3 lists 'prototype' here; the SQL of its 1.1 (and its M6 rule) gives null: fenvix-j421 is
      // job 421's just-in-time runner, an EC2 machine whose image is not this row's. The SQL is kept (reported).
      [42, "fenvix-j421", "ami-1", null],
      [42, "fenvix-j43", "ami-1", null],
      [42, "fenvix-demo-20261125", null, "prototype"],
      [42, null, "ami-1", null],
    ];
    for (const [id, runner, image, want] of cases) {
      const r = await admin.query("select public.gh_machine_kind($1::bigint, $2::text, $3::text) as k", [id, runner, image]);
      assert.equal(r.rows[0].k, want, `${id} ${runner} ${image}`);
    }
  });

  // protects=the browser roles cannot call the App's function (as 0013's functions); fails_when=the revoke is missing;
  // no_claim=row-level security on the tables.
  it("only the App may execute gh_machine_kind", async () => {
    const r = await admin.query(`select has_function_privilege('fenvix_github_app', 'public.gh_machine_kind(bigint,text,text)', 'execute') as app,
      has_function_privilege('anon', 'public.gh_machine_kind(bigint,text,text)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.gh_machine_kind(bigint,text,text)', 'execute') as auth`);
    assert.deepEqual(r.rows[0], { app: true, anon: false, auth: false });
  });
});

describe("a launched job stores its machine; the kind follows the runner that took it, in both arrival orders", () => {
  const h = new Harness();
  const launcher = new FakeLauncher();
  let admin: pg.Client;
  const sha = "d".repeat(40);
  const row = async (id: number) =>
    (await admin.query("select image_id, instance_type, machine_kind, runner_name, launched_at is not null as launched from gh_jobs where job_id = $1", [id])).rows[0];

  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher });
    const org = await makeOrg(admin, "machine-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  // protects=acceptance 1 and 4 (launch then in_progress); fails_when=the image or type of the launch is not stored, or
  // the kind is set before the job's own runner took it; no_claim=EC2's real answer (unit tests cover Ec2Launcher).
  it("launch write, then in_progress with the job's own runner: image and type stored, kind 'ec2'", async () => {
    h.gh.addRun("acme/shop", 9501, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 1501, runId: 9501, sha, branch: "main" }));
    assert.equal(launcher.launches.at(-1)!.runnerName, "fenvix-j1501");
    assert.deepEqual(await row(1501), { image_id: "ami-test", instance_type: "m7i.large", machine_kind: null, runner_name: null, launched: true });
    await h.send("workflow_job", workflowJob("in_progress", { id: 1501, runId: 9501, sha, branch: "main", runner: "fenvix-j1501" }));
    assert.deepEqual(await row(1501), { image_id: "ami-test", instance_type: "m7i.large", machine_kind: "ec2", runner_name: "fenvix-j1501", launched: true });
  });

  // protects=acceptance 4 (in_progress first): the event lands while the launch is still in flight; fails_when=the
  // launch write does not recompute the kind from the stored runner name; no_claim=real webhook timing.
  it("in_progress first (while the launch is in flight), then the launch write: kind 'ec2'", async () => {
    h.gh.addRun("acme/shop", 9502, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    launcher.during = async (l) => {
      await h.app.service.handle("workflow_job", randomUUID(), workflowJob("in_progress", { id: l.jobId, runId: 9502, sha, branch: "main", runner: l.runnerName }));
      assert.deepEqual(await row(l.jobId), { image_id: null, instance_type: null, machine_kind: null, runner_name: l.runnerName, launched: false });
    };
    await h.send("workflow_job", workflowJob("queued", { id: 1502, runId: 9502, sha, branch: "main" }));
    assert.equal(launcher.during, null, "the in_progress event was delivered during the launch");
    assert.deepEqual(await row(1502), { image_id: "ami-test", instance_type: "m7i.large", machine_kind: "ec2", runner_name: "fenvix-j1502", launched: true });
  });

  // protects=the stricter rule of the spec: a job the App launched a machine for but another runner took is never
  // 'ec2'; fails_when=the kind is 'ec2' whenever the App launched; no_claim=how often this happens.
  it("in_progress with a demo runner on a job the App also launched: 'prototype'; another job's JIT runner: null", async () => {
    h.gh.addRun("acme/shop", 9503, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 1503, runId: 9503, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 1503, runId: 9503, sha, branch: "main", runner: "fenvix-demo-20261125" }));
    assert.deepEqual(await row(1503), { image_id: "ami-test", instance_type: "m7i.large", machine_kind: "prototype", runner_name: "fenvix-demo-20261125", launched: true });
    h.gh.addRun("acme/shop", 9504, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 1504, runId: 9504, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 1504, runId: 9504, sha, branch: "main", runner: "fenvix-j1503" }));
    assert.equal((await row(1504)).machine_kind, null);
    // completed keeps the runner GitHub reported and therefore the kind.
    await h.send("workflow_job", workflowJob("completed", { id: 1503, runId: 9503, sha, branch: "main", runner: "fenvix-demo-20261125" }));
    assert.equal((await row(1503)).machine_kind, "prototype");
  });

  // protects=acceptance 6, no other kind can be stored; fails_when=the CHECKs are missing or allow 'prototype' on a
  // warm-up; no_claim=what the App writes.
  it("the CHECKs refuse any other kind ('gpu' on a job, 'prototype' on a warm-up)", async () => {
    await assert.rejects(admin.query("update gh_jobs set machine_kind = 'gpu' where job_id = 1501"), /gh_jobs_machine_kind_check/);
    await assert.rejects(admin.query(`insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, machine_kind)
      values ($1, $2, $3, 'refs/heads/main', 'linked', 'pending', 'prototype')`, [REPOS.shop.id, INSTALLATION_ID, "b".repeat(40)]), /gh_warmups_machine_kind_check/);
    const ok = await admin.query(`insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, machine_kind)
      values ($1, $2, $3, 'refs/heads/main', 'linked', 'cancelled', 'ec2') returning machine_kind`, [REPOS.shop.id, INSTALLATION_ID, "c".repeat(40)]);
    assert.equal(ok.rows[0].machine_kind, "ec2");
  });
});
