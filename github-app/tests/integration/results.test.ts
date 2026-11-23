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

  it("a test not proven identical to the serial run: status not_proven, N stored, never a green check (console proof)", async () => {
    // node-mocha-verify-failed: exit 0, verify_status diverged, one diverged test, no proof block.
    const sha = "a".repeat(40);
    h.gh.addRun("acme/shop", 9101, { event: "push", headSha: sha, headBranch: "main", message: "verify diverged" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6101, runId: 9101, sha, branch: "main" }));
    await h.summary({ runId: 9101, summary: summary("node-mocha-verify-failed") });
    await h.send("workflow_job", workflowJob("completed", { id: 6101, runId: 9101, sha, branch: "main", conclusion: "success" }));
    const job = (await admin.query("select check_run_id from gh_jobs where job_id = 6101")).rows[0];
    const cr = h.gh.repos.get("acme/shop")!.checkRuns.get(job.check_run_id)!;
    assert.equal(cr.conclusion, "failure");
    assert.match((cr.output as { title: string }).title, /1 not proven$/);
    const run = (await admin.query("select status, tests_not_proven, tests_passed, tests_ran, proof, exit_code from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 1, tests_passed: 4, tests_ran: 5, proof: null, exit_code: 0 });

    // A parallel run with a proof block: stored as the contract's RunProof.
    const sha2 = "b".repeat(40);
    h.gh.addRun("acme/shop", 9102, { event: "push", headSha: sha2, headBranch: "main", message: "parallel" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6102, runId: 9102, sha: sha2, branch: "main" }));
    await h.summary({ runId: 9102, summary: { ...summary("job3-warm-pass"), proof: { workers: 4, proven: 4, not_proven: 6, rerun_one_lane: 6, parallel_seconds: 2.5, serial_seconds_estimate: null, order_digest: "ab12", not_proven_causes: [{ cause: "file read outside the project", tests: 6 }] } } });
    await h.send("workflow_job", workflowJob("completed", { id: 6102, runId: 9102, sha: sha2, branch: "main", conclusion: "success" }));
    const run2 = (await admin.query("select status, tests_not_proven, proof from ci_runs where commit_sha = $1", [sha2])).rows[0];
    assert.equal(run2.status, "not_proven");
    assert.equal(run2.tests_not_proven, 6);
    // job3-warm-pass ran 10 tests: the proof covers them (4 proven + 6 not proven).
    assert.deepEqual(run2.proof, { workers: 4, proven: 4, notProven: 6, ranExecuted: 10, rerunOneLane: 6, parallelMs: 2500, serialMsEstimate: null, orderDigest: "ab12", notProvenCauses: [{ cause: "file read outside the project", tests: 6 }] });
  });

  it("a results chunk with not_proven tests, with and without a cause, is stored through apply.ts (console proof review)", async () => {
    const sha = "c".repeat(40);
    h.gh.addRun("acme/shop", 9103, { event: "push", headSha: sha, headBranch: "main", message: "chunk with not proven" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6103, runId: 9103, sha, branch: "main" }));
    const cred = runnerCredential("fenvix-m1", REPOS.shop.id);
    const res = await h.app.fastify.inject({
      method: "POST", url: "/v1/runner/results", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" },
      payload: {
        repositoryId: REPOS.shop.id, runId: 9103, runAttempt: 1, runnerName: "fenvix-m1", chunk: 0, chunks: 1,
        tests: [
          { testId: "tests/test_io.py::test_home", outcome: "not_proven", durationMs: 7, notProvenCause: "file read outside the project" },
          { testId: "tests/test_io.py::test_env", outcome: "not_proven", durationMs: 3 },
          { testId: "tests/test_io.py::test_ok", outcome: "passed", durationMs: 2 },
        ],
      },
    });
    assert.equal(res.statusCode, 202, res.body);
    await h.app.service.idle();
    await h.summary({ runId: 9103, summary: { tests: 3, reused_with_proof: 0, ran: 3, exit: 1, failed: [], flaky: [], not_proven: 2, outcome_counts: { passed: 3 } } });
    await h.send("workflow_job", workflowJob("completed", { id: 6103, runId: 9103, sha, branch: "main", conclusion: "failure" }));
    const run = (await admin.query("select id, status, tests_not_proven, tests_passed from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual([run.status, run.tests_not_proven, run.tests_passed], ["not_proven", 2, 1]);
    const rows = (await admin.query("select test_id, outcome, not_proven_cause, failure_kind from ci_test_results where run_id = $1 order by test_id", [run.id])).rows;
    assert.deepEqual(rows, [
      { test_id: "tests/test_io.py::test_env", outcome: "not_proven", not_proven_cause: null, failure_kind: null },
      { test_id: "tests/test_io.py::test_home", outcome: "not_proven", not_proven_cause: "file read outside the project", failure_kind: null },
      { test_id: "tests/test_io.py::test_ok", outcome: "passed", not_proven_cause: null, failure_kind: null },
    ]);
  });

  // ---------------------------------------------------------------- console proof review 2: never green when unsure

  const chunk = async (runId: number, tests: { testId: string; outcome: string; durationMs: number; notProvenCause?: string | null }[]) => {
    const cred = runnerCredential("fenvix-m1", REPOS.shop.id);
    const res = await h.app.fastify.inject({
      method: "POST", url: "/v1/runner/results", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" },
      payload: { repositoryId: REPOS.shop.id, runId, runAttempt: 1, runnerName: "fenvix-m1", chunk: 0, chunks: 1, tests },
    });
    assert.equal(res.statusCode, 202, res.body);
    await h.app.service.idle();
  };
  const checkOf = async (jobId: number) => {
    const job = (await admin.query("select check_run_id from gh_jobs where job_id = $1", [jobId])).rows[0];
    return h.gh.repos.get("acme/shop")!.checkRuns.get(job.check_run_id)!;
  };
  const allPassed = { tests: 3, reused_with_proof: 0, ran: 3, exit: 0, failed: [], flaky: [], outcome_counts: { passed: 3 } };
  const rowsSent = [
    { testId: "tests/test_late.py::test_home", outcome: "not_proven", durationMs: 7, notProvenCause: "file read outside the project" },
    { testId: "tests/test_late.py::test_env", outcome: "not_proven", durationMs: 3 },
    { testId: "tests/test_late.py::test_ok", outcome: "passed", durationMs: 2 },
  ];

  it("a summary that came but cannot be read: not proven (N 1, its reason), never passed, the check run fails", async () => {
    const sha = "d".repeat(40);
    h.gh.addRun("acme/shop", 9104, { event: "push", headSha: sha, headBranch: "main", message: "unreadable summary" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6104, runId: 9104, sha, branch: "main" }));
    // reused_with_proof + ran != tests: parseSummary refuses it. The intake refuses it too (422), so it is stored here as
    // a summary accepted earlier that today's parser cannot read (a runner or App version change).
    assert.equal((await h.summary({ runId: 9104, summary: { tests: 10, reused_with_proof: 3, ran: 3, exit: 0 } })).statusCode, 422);
    // The 422 also stored a rejected row (summary null, follow-up A1.2): the old summary replaces it here.
    await h.app.service.idle();
    await admin.query(`insert into gh_run_summaries (repository_id, run_id, run_attempt, runner_name, summary) values ($1, 9104, 1, 'fenvix-m1', $2)
      on conflict (repository_id, run_id, run_attempt, runner_name) do update set summary = excluded.summary, rejected_at = null, rejected_reason = null`,
      [REPOS.shop.id, JSON.stringify({ tests: 10, reused_with_proof: 3, ran: 3, exit: 0 })]);
    await h.send("workflow_job", workflowJob("completed", { id: 6104, runId: 9104, sha, branch: "main", conclusion: "success" }));
    const run = (await admin.query("select status, tests_not_proven, not_proven_reason from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 1, not_proven_reason: "the runner's summary could not be read" });
    const cr = await checkOf(6104);
    assert.equal(cr.conclusion, "failure");
    assert.match((cr.output as { title: string }).title, /could not be read/);
  });

  it("per-test not_proven rows sent before the summary make the run not proven (the summary said all passed)", async () => {
    const sha = "e".repeat(40);
    h.gh.addRun("acme/shop", 9105, { event: "push", headSha: sha, headBranch: "main", message: "rows first" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6105, runId: 9105, sha, branch: "main" }));
    await chunk(9105, rowsSent);
    await h.summary({ runId: 9105, summary: allPassed });
    await h.send("workflow_job", workflowJob("completed", { id: 6105, runId: 9105, sha, branch: "main", conclusion: "success" }));
    const run = (await admin.query("select status, tests_not_proven, tests_passed from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 2, tests_passed: 1 });
    const cr = await checkOf(6105);
    assert.equal(cr.conclusion, "failure");
    assert.match((cr.output as { title: string }).title, /2 not proven/);
  });

  it("per-test not_proven rows arriving after publication flip a passed run and publish its check run again as failure", async () => {
    const sha = "9".repeat(40);
    h.gh.addRun("acme/shop", 9106, { event: "push", headSha: sha, headBranch: "main", message: "rows late" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6106, runId: 9106, sha, branch: "main" }));
    await h.summary({ runId: 9106, summary: allPassed });
    await h.send("workflow_job", workflowJob("completed", { id: 6106, runId: 9106, sha, branch: "main", conclusion: "success" }));
    assert.equal((await admin.query("select status from ci_runs where commit_sha = $1", [sha])).rows[0].status, "passed");
    const before = await checkOf(6106);
    assert.equal(before.conclusion, "success");
    const checks = h.gh.repos.get("acme/shop")!.checkRuns.size;
    const events = (await admin.query("select count(*)::int as n from ci_usage_events where github_job_id = 6106")).rows[0].n;
    await chunk(9106, rowsSent);
    const run = (await admin.query("select status, tests_not_proven, tests_passed from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 2, tests_passed: 1 });
    const after = await checkOf(6106);
    assert.equal(after.conclusion, "failure", "the check run was not published again");
    assert.equal(h.gh.repos.get("acme/shop")!.checkRuns.size, checks, "the check run was updated in place, not duplicated");
    assert.equal((await admin.query("select count(*)::int as n from ci_usage_events where github_job_id = 6106")).rows[0].n, events, "billed once");
  });

  it("one N: nothing ran and verify crashed (null status, verify_exit 2): not proven with tests_not_proven 1", async () => {
    const sha = "8".repeat(40);
    h.gh.addRun("acme/shop", 9107, { event: "push", headSha: sha, headBranch: "main", message: "verify crashed" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6107, runId: 9107, sha, branch: "main" }));
    await h.summary({ runId: 9107, summary: { tests: 0, reused_with_proof: 0, ran: 0, exit: 0, verify_status: null, verify_exit: 2 } });
    await h.send("workflow_job", workflowJob("completed", { id: 6107, runId: 9107, sha, branch: "main", conclusion: "success" }));
    const run = (await admin.query("select status, tests_not_proven, tests_passed, not_proven_reason from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 1, tests_passed: 0, not_proven_reason: "the comparison of two runs failed" });
  });

  // ---------------------------------------------------------------- console proof follow-ups (A1.1, A1.2, A1.4)

  // protects=a job with no summary whose runner sent per-test not_proven rows is never green; fails_when=the run stays
  // passed or the check run is neutral/success; no_claim=what the console shows for such a run.
  it("A1.1 no summary, per-test not_proven rows: the run is not_proven and the check run fails (published by the sweep)", async () => {
    const sha = "7".repeat(40);
    h.gh.addRun("acme/shop", 9108, { event: "push", headSha: sha, headBranch: "main", message: "rows, no summary" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6108, runId: 9108, sha, branch: "main" }));
    await chunk(9108, rowsSent);
    await h.send("workflow_job", workflowJob("completed", { id: 6108, runId: 9108, sha, branch: "main", conclusion: "success" }));
    await admin.query("update gh_jobs set completed_at = now() - interval '11 minutes' where job_id = 6108");
    assert.equal(await h.app.service.sweep(), 1);
    const run = (await admin.query("select status, tests_not_proven from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 2 });
    const cr = await checkOf(6108);
    assert.equal(cr.conclusion, "failure");
    assert.match((cr.output as { title: string }).title, /2 not proven, no fenvix summary/);
  });

  // protects=a summary refused at intake publishes the run not proven at once (no wait for the sweep), with the
  // refusal's reason; fails_when=the 422 stores nothing, the run waits or is green; no_claim=the runner retrying.
  it("A1.2 a summary refused at intake (422): stored as rejected, the run is published not_proven at once, the check run fails", async () => {
    const sha = "6".repeat(40);
    h.gh.addRun("acme/shop", 9109, { event: "push", headSha: sha, headBranch: "main", message: "rejected summary" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6109, runId: 9109, sha, branch: "main" }));
    const res = await h.summary({ runId: 9109, summary: { tests: 10, reused_with_proof: 3, ran: 3, exit: 0 } });
    assert.equal(res.statusCode, 422);
    await h.app.service.idle();
    const row = (await admin.query("select summary, rejected_at is not null as rejected, rejected_reason from gh_run_summaries where run_id = 9109")).rows[0];
    assert.deepEqual(row, { summary: null, rejected: true, rejected_reason: JSON.parse(res.body).error.message });
    await h.send("workflow_job", workflowJob("completed", { id: 6109, runId: 9109, sha, branch: "main", conclusion: "success" }));
    assert.ok((await admin.query("select published_at from gh_jobs where job_id = 6109")).rows[0].published_at, "published without the sweep");
    const run = (await admin.query("select status, tests_not_proven, not_proven_reason from ci_runs where commit_sha = $1", [sha])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 1, not_proven_reason: "the runner's summary could not be read" });
    const cr = await checkOf(6109);
    assert.equal(cr.conclusion, "failure");
    assert.match((cr.output as { summary: string }).summary, /reused_with_proof \+ ran must equal tests/);
  });

  // protects=the upsert rules: a valid summary replaces a rejection and clears it; a rejection never overwrites a valid
  // summary; fails_when=either order loses the valid summary or keeps a stale rejection; no_claim=publication timing.
  it("A1.2 a later valid summary replaces a rejection; a later rejection never overwrites a valid summary", async () => {
    const row = async (runId: number) => (await admin.query(
      "select summary is not null as has_summary, rejected_at is not null as rejected, rejected_reason from gh_run_summaries where run_id = $1", [runId])).rows[0];
    assert.equal((await h.summary({ runId: 9110, summary: { nope: true } })).statusCode, 422);
    await h.app.service.idle();
    assert.equal((await row(9110)).rejected, true);
    assert.equal((await h.summary({ runId: 9110, summary: allPassed })).statusCode, 202);
    await h.app.service.idle();
    assert.deepEqual(await row(9110), { has_summary: true, rejected: false, rejected_reason: null });
    assert.equal((await h.summary({ runId: 9110, summary: { nope: true } })).statusCode, 422);
    await h.app.service.idle();
    assert.deepEqual(await row(9110), { has_summary: true, rejected: false, rejected_reason: null });
  });

  // protects=finishRun's race rule: not_proven rows stored after publish counted them (live_n) still raise the run;
  // fails_when=status passed with live rows, tests_not_proven below live_n, passed not lowered; no_claim=the lock
  // order under real concurrency (one connection here).
  it("A1.4 finishRun with per-test not_proven rows publish did not count: N = live_n, status not_proven, passed lowered", async () => {
    const sha = "5".repeat(40);
    h.gh.addRun("acme/shop", 9111, { event: "push", headSha: sha, headBranch: "main", message: "race" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 6111, runId: 9111, sha, branch: "main" }));
    const job = (await admin.query("select * from gh_jobs where job_id = 6111")).rows[0];
    const runId = job.ci_run_id as string;
    // Two not_proven rows written as if a results chunk was applied between publish's count and finishRun.
    for (const t of ["a::x", "a::y"]) {
      await admin.query("insert into ci_test_results (run_id, workspace_id, test_id, outcome) select id, workspace_id, $2, 'not_proven' from ci_runs where id = $1", [runId, t]);
    }
    const { parseSummary } = await import("../../src/results/summary.ts");
    const svc = h.app.service as unknown as {
      db: { tx: <T>(ws: string, fn: (c: unknown) => Promise<T>) => Promise<T> };
      finishRun: (c: unknown, id: string, job: unknown, s: unknown, run: unknown, pr: null, v: unknown) => Promise<void>;
    };
    const now = new Date();
    await svc.db.tx(org.workspaceId, (c) => svc.finishRun(c, runId, { ...job, conclusion: "success" }, parseSummary(allPassed), null, null,
      { startedAt: now, completedAt: now, durationMs: 1000, otherStepMinutes: 0, mode: job.mode ?? "shadow", region: null, notProvenRows: 0 }));
    const run = (await admin.query("select status, tests_not_proven, tests_passed from ci_runs where id = $1", [runId])).rows[0];
    assert.deepEqual(run, { status: "not_proven", tests_not_proven: 2, tests_passed: 1 });
    // Finishing again with the same values never lowers it (not_proven stays, N stays 2).
    await svc.db.tx(org.workspaceId, (c) => svc.finishRun(c, runId, { ...job, conclusion: "success" }, parseSummary(allPassed), null, null,
      { startedAt: now, completedAt: now, durationMs: 1000, otherStepMinutes: 0, mode: job.mode ?? "shadow", region: null, notProvenRows: 0 }));
    assert.deepEqual((await admin.query("select status, tests_not_proven, tests_passed from ci_runs where id = $1", [runId])).rows[0],
      { status: "not_proven", tests_not_proven: 2, tests_passed: 1 });
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
