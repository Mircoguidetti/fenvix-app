import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { ACCOUNT, CI_YAML, DASHBOARD, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, push, REPOS, resetDb, workflowJob, RUNNER_TOKEN, runnerCredential } from "../helpers/harness.ts";

const summary = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("run results on GitHub, runs and usage events", () => {
  const h = new Harness();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  const PR_SHA = "4bec63ba31437dbe83826d4643ae63b6ad03fead";

  before(async () => {
    admin = await resetDb();
    await h.start();
    org = await makeOrg(admin, "results-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    // Linked to the organization (the setup callback's checks are tested in link.test.ts).
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
    // A pull request on a feature branch, and the push that brought its commit.
    h.gh.repos.get("acme/shop")!.pulls.push({ number: 7, title: "Tax change", body: "", head: "feature", base: "main", state: "open", headSha: PR_SHA });
    await h.send("push", push(PR_SHA, "refs/heads/feature", 1795424000));
    await h.send("pull_request", pullRequest("opened", { number: 7, headRef: "feature", headSha: PR_SHA }));
    h.gh.addRun("acme/shop", 9001, { event: "pull_request", headSha: PR_SHA, headBranch: "feature", message: "Tax change\n\nlonger text", pullRequests: [7] });
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("a job not on fenvix is ignored", async () => {
    await h.send("workflow_job", workflowJob("completed", { id: 501, runId: 9001, sha: PR_SHA, branch: "feature", labels: ["ubuntu-latest"], name: "lint" }));
    assert.equal((await admin.query("select count(*)::int as n from gh_jobs")).rows[0].n, 0);
  });

  it("queued, then in progress: a check run in progress on the commit", async () => {
    await h.send("workflow_job", workflowJob("queued", { id: 601, runId: 9001, sha: PR_SHA, branch: "feature" }));
    await h.send("workflow_job", workflowJob("in_progress", { id: 601, runId: 9001, sha: PR_SHA, branch: "feature" }));
    const shop = h.gh.repos.get("acme/shop")!;
    const runs = [...shop.checkRuns.values()];
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "in_progress");
    assert.equal(runs[0]!.name, "fenvix");
    assert.equal(runs[0]!.head_sha, PR_SHA);
    const job = (await admin.query("select status, check_run_id, runner_name from gh_jobs where job_id = 601")).rows[0];
    assert.equal(job.status, "in_progress");
    assert.equal(job.check_run_id, runs[0]!.id);
    assert.equal(job.runner_name, "fenvix-m1");
  });

  it("the summary, then completed: check run completed, one PR comment, a run row and a usage event", async () => {
    assert.equal((await h.summary({ runId: 9001, summary: summary("job2-warm-real-failure"), receiptsUrl: "https://github.com/acme/shop/actions/runs/9001#artifacts" })).statusCode, 202);
    // Nothing is published before GitHub says the job is over.
    assert.equal((await admin.query("select published_at from gh_jobs where job_id = 601")).rows[0].published_at, null);
    await h.send("workflow_job", workflowJob("completed", { id: 601, runId: 9001, sha: PR_SHA, branch: "feature", conclusion: "failure" }));
    const shop = h.gh.repos.get("acme/shop")!;
    const cr = [...shop.checkRuns.values()][0]!;
    assert.equal(shop.checkRuns.size, 1, "the check run in progress was completed, not duplicated");
    assert.equal(cr.status, "completed");
    assert.equal(cr.conclusion, "failure");
    const out = cr.output as { title: string; summary: string };
    assert.equal(out.title, "45 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · 1 failed");
    assert.match(out.summary, /\[receipts\]\(https:\/\/github\.com\/acme\/shop\/actions\/runs\/9001#artifacts\)/);
    assert.match(out.summary, /test_vat\[3\]/);

    const comments = [...shop.comments.values()];
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.issue, 7);
    assert.match(comments[0]!.body, /^<!-- fenvix:run-summary -->/);
    assert.match(comments[0]!.body, /\[Check run\]\(https:\/\/github\.com\/acme\/shop\/runs\/\d+\)/);

    const run = (await admin.query("select * from ci_runs")).rows[0];
    assert.equal(run.workspace_id, org.workspaceId);
    assert.equal(run.number, 1);
    assert.equal(run.commit_sha, PR_SHA);
    assert.equal(run.commit_message, "Tax change");
    assert.equal(run.pull_request, 7);
    assert.equal(run.trigger, "pull_request");
    assert.equal(run.status, "failed");
    assert.equal(run.tests_total, 56);
    assert.equal(run.tests_skipped, 45);
    assert.equal(run.tests_ran, 11);
    assert.equal(run.tests_failed, 1);
    assert.equal(run.test_time_skipped_ms, 238);
    assert.equal(new Date(run.pushed_at).getTime(), 1795424000 * 1000);
    assert.equal(run.duration_ms, 180_000);
    assert.equal(Number(run.other_step_minutes), Number(((180 - 1.459) / 60).toFixed(2)));
    assert.deepEqual(run.skip_misses, { new: 1, code: 10 });
    assert.equal(cr.details_url, `${DASHBOARD}/projects/${run.project_id}/runs/${run.id}`);

    const project = (await admin.query("select * from ci_projects")).rows[0];
    assert.equal(project.full_name, "acme/shop");
    assert.equal(project.setup_state, "active");
    assert.equal(project.language, "python");

    const ev = (await admin.query("select * from ci_usage_events")).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].workspace_id, org.workspaceId);
    assert.equal(ev[0].ci_run_id, run.id);
    assert.equal(ev[0].billable, true);
    assert.equal(ev[0].reason, "failed");
    assert.equal(ev[0].plan_id, "team");
    assert.equal(ev[0].github_job_id, 601);
    assert.equal(new Date(ev[0].month).toISOString().slice(0, 7), "2026-11");
  });

  it("the same completed event again changes nothing (no second event, run or comment)", async () => {
    await h.send("workflow_job", workflowJob("completed", { id: 601, runId: 9001, sha: PR_SHA, branch: "feature", conclusion: "failure" }));
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events")).rows[0].n, 1);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs")).rows[0].n, 1);
    assert.equal(h.gh.repos.get("acme/shop")!.comments.size, 1);
  });

  it("the next run on the same pull request updates the one comment in place", async () => {
    const sha2 = "e8206072cf839808186d220d829f342a5e080c88";
    h.gh.repos.get("acme/shop")!.pulls[0]!.headSha = sha2;
    await h.send("pull_request", pullRequest("synchronize", { number: 7, headRef: "feature", headSha: sha2 }));
    h.gh.addRun("acme/shop", 9002, { event: "pull_request", headSha: sha2, headBranch: "feature", message: "Fix tax", pullRequests: [7] });
    await h.send("workflow_job", workflowJob("in_progress", { id: 602, runId: 9002, sha: sha2, branch: "feature" }));
    await h.summary({ runId: 9002, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", workflowJob("completed", { id: 602, runId: 9002, sha: sha2, branch: "feature", conclusion: "success" }));
    const shop = h.gh.repos.get("acme/shop")!;
    assert.equal(shop.comments.size, 1);
    const body = [...shop.comments.values()][0]!.body;
    assert.match(body, /✅ fenvix · 46 of 56 tests skipped with proof/);
    const patched = h.gh.exchanges.filter((x) => x.method === "PATCH" && /\/issues\/comments\/\d+$/.test(x.path));
    assert.equal(patched.length, 1);
    const runs = (await admin.query("select number, status from ci_runs order by number")).rows;
    assert.deepEqual(runs.map((r) => [r.number, r.status]), [[1, "failed"], [2, "passed"]]);
  });

  it("the comment is found again by its marker when our record of it is lost", async () => {
    await admin.query("update gh_pull_requests set fenvix_comment_id = null");
    const sha3 = "f".repeat(40);
    h.gh.addRun("acme/shop", 9003, { event: "pull_request", headSha: sha3, headBranch: "feature", message: "x", pullRequests: [7] });
    await h.send("workflow_job", workflowJob("in_progress", { id: 603, runId: 9003, sha: sha3, branch: "feature" }));
    await h.summary({ runId: 9003, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", workflowJob("completed", { id: 603, runId: 9003, sha: sha3, branch: "feature" }));
    assert.equal(h.gh.repos.get("acme/shop")!.comments.size, 1);
  });

  it("a summary that comes after completion is published when it arrives", async () => {
    const sha = "1".repeat(40);
    h.gh.addRun("acme/shop", 9004, { event: "push", headSha: sha, headBranch: "main", message: "on main" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 604, runId: 9004, sha, branch: "main" }));
    await h.send("workflow_job", workflowJob("completed", { id: 604, runId: 9004, sha, branch: "main" }));
    assert.equal((await admin.query("select published_at from gh_jobs where job_id = 604")).rows[0].published_at, null);
    await h.summary({ runId: 9004, summary: summary("job1-cold-flaky") });
    const job = (await admin.query("select published_at, check_run_id from gh_jobs where job_id = 604")).rows[0];
    assert.ok(job.published_at);
    const cr = h.gh.repos.get("acme/shop")!.checkRuns.get(job.check_run_id)!;
    assert.match((cr.output as { summary: string }).summary, /Flaky tests, explained[\s\S]*replay: `python -m pytest --det/);
    const run = (await admin.query("select trigger, pull_request, tests_flaky_defects, tests_failed from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { trigger: "push", pull_request: null, tests_flaky_defects: 1, tests_failed: 1 });
  });

  it("no summary at all: the sweep publishes it after the wait; billed as a run that used a machine", async () => {
    const sha = "2".repeat(40);
    h.gh.addRun("acme/shop", 9005, { event: "push", headSha: sha, headBranch: "main", message: "setup broke" });
    // Times relative to now: the wait is measured from the job's completion, and a fixed date would be old already.
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const completedAt = new Date().toISOString();
    await h.send("workflow_job", workflowJob("in_progress", { id: 605, runId: 9005, sha, branch: "main", startedAt }));
    await h.send("workflow_job", workflowJob("completed", { id: 605, runId: 9005, sha, branch: "main", conclusion: "failure", startedAt, completedAt }));
    assert.equal(await h.app.service.sweep(), 0, "not yet: the summary may still come");
    await admin.query("update gh_jobs set completed_at = now() - interval '11 minutes' where job_id = 605");
    assert.equal(await h.app.service.sweep(), 1);
    const job = (await admin.query("select published_at, check_run_id from gh_jobs where job_id = 605")).rows[0];
    const cr = h.gh.repos.get("acme/shop")!.checkRuns.get(job.check_run_id)!;
    assert.equal(cr.conclusion, "failure");
    assert.match((cr.output as { title: string }).title, /No fenvix summary/);
    const ev = (await admin.query("select billable, reason from ci_usage_events where github_job_id = 605")).rows[0];
    assert.deepEqual(ev, { billable: true, reason: "no_summary" });
  });

  it("cancelled before it started on our machine: published at once, not billable", async () => {
    const sha = "3".repeat(40);
    await h.send("workflow_job", workflowJob("queued", { id: 606, runId: 9006, sha, branch: "main" }));
    const p = workflowJob("completed", { id: 606, runId: 9006, sha, branch: "main", conclusion: "cancelled" });
    const wj = p.workflow_job as Record<string, unknown>;
    wj.runner_name = null; wj.runner_id = null; wj.runner_group_id = null; wj.runner_group_name = null; wj.started_at = wj.created_at;
    await h.send("workflow_job", p);
    const ev = (await admin.query("select billable, reason from ci_usage_events where github_job_id = 606")).rows[0];
    assert.deepEqual(ev, { billable: false, reason: "cancelled_before_tests" });
    // No run row: the dashboard counts every ci_runs row as a used run.
    assert.equal((await admin.query("select count(*)::int as n from ci_runs where commit_sha = $1", [sha])).rows[0].n, 0);
  });

  it("GitHub failing on the check run: the run is retried by the sweep, never billed twice", async () => {
    const sha = "4".repeat(40);
    h.gh.addRun("acme/shop", 9007, { event: "push", headSha: sha, headBranch: "main", message: "retry" });
    await h.summary({ runId: 9007, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", workflowJob("in_progress", { id: 607, runId: 9007, sha, branch: "main" }));
    h.gh.failNext.set("PATCH *", 502);
    await h.send("workflow_job", workflowJob("completed", { id: 607, runId: 9007, sha, branch: "main" }));
    let job = (await admin.query("select published_at, publish_error, publish_attempts from gh_jobs where job_id = 607")).rows[0];
    assert.equal(job.published_at, null);
    assert.match(job.publish_error, /502/);
    await admin.query("update gh_jobs set completed_at = now() - interval '11 minutes' where job_id = 607");
    assert.equal(await h.app.service.sweep(), 1);
    job = (await admin.query("select published_at, publish_attempts from gh_jobs where job_id = 607")).rows[0];
    assert.ok(job.published_at);
    assert.equal(job.publish_attempts, 2);
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where github_job_id = 607")).rows[0].n, 1);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs where commit_sha = $1", [sha])).rows[0].n, 1);
  });

  it("the runner endpoint needs the machine's own credential and a well-formed body", async () => {
    const bad = await h.app.fastify.inject({ method: "POST", url: "/v1/runner/summaries", headers: { authorization: "Bearer nope" }, payload: {} });
    assert.equal(bad.statusCode, 401);
    const fleet = await h.app.fastify.inject({ method: "POST", url: "/v1/runner/summaries", headers: { authorization: `Bearer ${RUNNER_TOKEN}` }, payload: { repositoryId: 1, runId: 1, runnerName: "x", summary: {} } });
    assert.equal(fleet.statusCode, 401, "the fleet-wide key is not a credential");
    const noRun = await h.app.fastify.inject({ method: "POST", url: "/v1/runner/summaries", headers: { authorization: `Bearer ${runnerCredential("x", 1)}` }, payload: { summary: {} } });
    assert.equal(noRun.statusCode, 400);
    // The identity is the credential's: another runner, repository or run in the body is refused.
    const job = runnerCredential("fenvix-j5", REPOS.shop.id, 77);
    for (const payload of [{ runId: 77, runnerName: "fenvix-j6" }, { runId: 77, repositoryId: REPOS.web.id }, { runId: 78 }]) {
      const r = await h.app.fastify.inject({ method: "POST", url: "/v1/runner/summaries", headers: { authorization: `Bearer ${job}` }, payload: { ...payload, summary: {} } });
      assert.equal(r.statusCode, 403, JSON.stringify(payload));
    }
    const badSummary = await h.summary({ runId: 1, summary: { tests: 2, reused_with_proof: 5 } });
    assert.equal(badSummary.statusCode, 422);
  });

  it("every call the App made matches GitHub's REST description", () => {
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path} ${x.status}: ${JSON.stringify(x.problems)}`), []);
  });
});

describe("an installation not linked yet", () => {
  const h = new Harness();
  let admin: pg.Client;
  before(async () => {
    admin = await resetDb();
    await h.start();
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("still gets its check run; the usage event waits without an organization, and linking gives it one", async () => {
    const sha = "5".repeat(40);
    h.gh.addRun("acme/shop", 9100, { event: "push", headSha: sha, headBranch: "main", message: "m" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 700, runId: 9100, sha, branch: "main" }));
    await h.summary({ runId: 9100, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", workflowJob("completed", { id: 700, runId: 9100, sha, branch: "main" }));
    const cr = [...h.gh.repos.get("acme/shop")!.checkRuns.values()][0]!;
    assert.equal(cr.conclusion, "success");
    assert.match(String(cr.details_url), /^https:\/\/github\.com\/acme\/shop\/actions\/runs\/9100\/job\/700$/);
    let ev = (await admin.query("select workspace_id, billable, ci_run_id from ci_usage_events")).rows;
    assert.deepEqual(ev, [{ workspace_id: null, billable: true, ci_run_id: null }]);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs")).rows[0].n, 0);

    const org = await makeOrg(admin, "late-owner", "starter");
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
    ev = (await admin.query("select workspace_id from ci_usage_events")).rows;
    assert.deepEqual(ev, [{ workspace_id: org.workspaceId }]);
    assert.equal((await admin.query("select github_account from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0].github_account, "acme");
    // The project appears with the onboarding pull request the App opened before the link.
    const p = (await admin.query("select full_name, setup_state, setup_pr_number, setup_pr_state from ci_projects")).rows[0];
    assert.deepEqual(p, { full_name: "acme/shop", setup_state: "pr_open", setup_pr_number: 1, setup_pr_state: "open" });
  });
});
