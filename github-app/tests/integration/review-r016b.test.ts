// Review R-016b (docs/REVIEW-R-016b.md): failing tests for what remains after the R-016 fixes on claude/dashboard-wiring.
// Every test here fails on claude/dashboard-wiring at 48ae9c1 and describes the behaviour a fix must give.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { signSummaryCredential } from "../../src/runners/credentials.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, RUNNER_TOKEN, workflowJob } from "../helpers/harness.ts";

// ================================================================ billing: whether a job is billed at all

describe("R-016b billing: a job that held a fenvix machine is billed, whatever the job did with its summary", () => {
  const h = new Harness();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "r016b-units");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("G1 a job that ran 60 minutes on our machine and ended cancelled, without a summary, is billed its 60 held minutes", async () => {
    const sha = "a1".repeat(20);
    h.gh.addRun("acme/shop", 53001, { event: "push", headSha: sha, headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 63001, runId: 53001, sha, branch: "main" }));
    // GitHub (signed webhooks) says: the job started on our machine fenvix-m1 at 10:00 ...
    await h.send("workflow_job", workflowJob("in_progress", { id: 63001, runId: 53001, sha, branch: "main", runner: "fenvix-m1", startedAt: "2026-11-18T10:00:00Z" }));
    // ... and ended at 11:00, cancelled. The job sent no summary.json: whether it does is the customer's workflow's choice (it
    // runs fenvix-run or not, and can delete $RUNNER_TEMP/fenvix/summary.json), and so is the conclusion "cancelled" (a last
    // step that cancels its own run with the job's GITHUB_TOKEN, a click on Cancel, or a job-level timeout-minutes).
    await h.send("workflow_job", workflowJob("completed", { id: 63001, runId: 53001, sha, branch: "main", runner: "fenvix-m1", conclusion: "cancelled", startedAt: "2026-11-18T10:00:00Z", completedAt: "2026-11-18T11:00:00Z" }));
    const ev = (await admin.query("select billable, reason, held_minutes, units from ci_usage_events where github_job_id = 63001")).rows[0];
    assert.ok(ev, "no usage event");
    assert.equal(Number(ev.held_minutes), 60, "GitHub's timings: the job held our machine 60 minutes");
    assert.equal(ev.billable, true,
      `a job that held our machine for 60 minutes (GitHub's started_at -> completed_at, runner fenvix-m1) is not billed (reason ${ev.reason}): ` +
      "service.publish bills nothing when there is no summary and the conclusion is cancelled, and both are the job's to choose. Since F3 the " +
      "units are the held minutes, but WHETHER they count still rests on summary.json: any job, of any length, ends free by not sending its " +
      "summary and cancelling itself at its last step. docs/data-contract.md \"Run units\" says nothing the job writes changes the units.");
  });
});

// ================================================================ runner ingestion: what one job's credential may store

describe("R-016b runner records: one job's credential cannot fill the database through explorations", () => {
  const h = new Harness();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "r016b-explore");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("G2 the per-job credential of one CI job stores at most one night of exploration", async () => {
    // Exactly what launchRunner hands a per-job machine (service.ts): runner, repository, run AND attempt (the F7 fix). The
    // job's own steps can read it (the spool and the poster run as / next to the job user, review R-016 F3).
    const cred = signSummaryCredential(RUNNER_TOKEN, { runnerName: "fenvix-j64001", repositoryId: REPOS.shop.id, runId: 54001, runAttempt: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
    const night = (i: number) => ({
      startedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), finishedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000 + 1000).toISOString(),
      commitSha: "b".repeat(40), branch: "main", seeds: 1, runs: 1, collected: 1, seconds: 1, flakyFailing: [], alwaysFailing: [], notReproduced: [],
      familiesByPolluter: {}, seedsLog: [{ seed: 1, seconds: 1, failing: [] }], defects: [],
    });
    const answers: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await h.app.fastify.inject({ method: "POST", url: "/v1/runner/explorations", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: night(i) });
      answers.push(r.statusCode);
    }
    await h.app.service.idle();
    const n = Number((await admin.query("select count(*) from ci_explorations")).rows[0].count);
    assert.ok(n <= 1,
      `one CI job's credential stored ${n} explorations (answers: ${[...new Set(answers)].join(", ")}). Each distinct startedAt is a new ` +
      "ci_explorations row of up to 6 MB (seeds_log, families, up to 500 defects upserted into ci_defects), kept for good, with no count, byte " +
      "or rate limit and no check that the credential's job is a night of exploration: the F7 limits (200 chunks, 256 MB per job, staged " +
      "rows deleted after 7 days) cover POST /v1/runner/results only, so the same credential still fills the database every customer shares " +
      "through POST /v1/runner/explorations.");
  });
});
