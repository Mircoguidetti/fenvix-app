// Review R-012 (docs/REVIEW-R-012.md): failing tests for defects of the App side of the AWS deploy kit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { jobUserData, RetryLater, type RunnerLaunch, type RunnerLauncher } from "../../src/runners/launcher.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, RUNNER_TOKEN, workflowJob } from "../helpers/harness.ts";

class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  refuse: Error | null = null;
  async launch(l: RunnerLaunch) {
    if (this.refuse) throw this.refuse;
    this.launches.push(l);
    return { instanceId: `i-${l.jobId}`, already: false };
  }
}

const SUMMARY = JSON.parse(readFileSync(new URL("../fixtures/runner/job3-warm-pass.summary.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("R-012 review: per-job runner credentials", () => {
  const h = new Harness();
  const launcher = new FakeLauncher();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher });
    const org = await makeOrg(admin, "r012-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop, REPOS.web]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("F1 the credential every job machine holds cannot publish a summary for another job (another repository's)", async () => {
    // Job 1001 (acme/shop, the attacker's) and job 1002 (acme/web, the victim's) each get a machine.
    h.gh.addRun("acme/shop", 9401, { event: "pull_request", headSha: "1".repeat(40), headBranch: "feature", message: "x" });
    h.gh.addRun("acme/web", 9402, { event: "pull_request", headSha: "2".repeat(40), headBranch: "feature", message: "y" });
    await h.send("workflow_job", workflowJob("queued", { id: 1001, runId: 9401, sha: "1".repeat(40), branch: "feature" }));
    await h.send("workflow_job", workflowJob("queued", { id: 1002, runId: 9402, sha: "2".repeat(40), branch: "feature", repo: REPOS.web }));
    assert.deepEqual(launcher.launches.map((l) => l.runnerName), ["fenvix-j1001", "fenvix-j1002"]);
    // Nothing per job reaches a machine: every machine authenticates with the one fleet-wide RUNNER_TOKEN (its role
    // reads it from SSM), and the body names any runner. One local root on job 1001's machine is enough:
    const forged = await h.app.fastify.inject({
      method: "POST", url: "/v1/runner/summaries", headers: { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" },
      payload: { repositoryId: REPOS.web.id, runId: 9402, runAttempt: 1, runnerName: "fenvix-j1002", summary: SUMMARY },
    });
    await h.app.service.idle();
    const stored = (await admin.query("select count(*)::int as n from gh_run_summaries where repository_id = $1 and run_id = 9402", [REPOS.web.id])).rows[0].n;
    assert.ok(forged.statusCode === 401 || forged.statusCode === 403,
      `a summary for acme/web's job, sent with the credential of acme/shop's machine, was accepted (${forged.statusCode}; ${stored} row stored): it becomes the victim's check run and PR comment`);
  });

  it("F12 the fleet at its limit: no just-in-time runner is registered on GitHub for a job that gets no machine", async () => {
    h.gh.addRun("acme/shop", 9403, { event: "push", headSha: "3".repeat(40), headBranch: "main", message: "z" });
    const before = h.gh.repos.get("acme/shop")!.jitRunners.length;
    launcher.refuse = new RetryLater("4 fenvix machines are running (limit 4)");
    // SQS delivers the job five times (maxReceiveCount) while the fleet stays full.
    for (let i = 0; i < 5; i++) await h.send("workflow_job", workflowJob("queued", { id: 1003, runId: 9403, sha: "3".repeat(40), branch: "main" }), { delivery: "q-1003" });
    launcher.refuse = null;
    const jit = h.gh.repos.get("acme/shop")!.jitRunners.slice(before).map((r) => r.name);
    assert.deepEqual(jit, [], `just-in-time runners registered with no machine to run them: ${jit.join(", ")}`);
  });
});

describe("R-012 review: the shared cache (per-job mode)", () => {
  it("F3 two customers' jobs never get the same cache credential (one cache organization lets any PR read every customer's entries and runs)", () => {
    const env = {
      FENVIX_CACHE_URL: "http://10.42.0.10:8787/fenvix", FENVIX_CACHE_READ_TOKEN_PARAM: "/fenvix/prod/cache/read-token",
      FENVIX_CACHE_WRITE_TOKEN_PARAM: "/fenvix/prod/cache/write-token",
    };
    const launch = (installationId: number, jobId: number, repo: string): RunnerLaunch => ({
      jobId, runId: jobId, repositoryId: jobId, repositoryFullName: repo, installationId, runnerName: `fenvix-j${jobId}`, jitConfig: "QUJD", cacheAccess: "read",
    });
    const cacheLines = (ud: string) => ud.split("\n").filter((l) => /^FENVIX_CACHE_/.test(l)).sort().join("\n");
    const a = cacheLines(jobUserData(launch(1, 11, "acme/shop"), env));
    const b = cacheLines(jobUserData(launch(2, 22, "globex/api"), env));
    assert.notEqual(a, b, `acme's and globex's pull requests get the same cache organization and token:\n${a}`);
  });
});

