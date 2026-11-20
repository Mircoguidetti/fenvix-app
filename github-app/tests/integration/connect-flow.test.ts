/**
 * The connect flow end to end, against Postgres and the fake GitHub: an organization connects GitHub (its 30-day
 * shadow trial starts), repositories arrive, the setup pull request is opened by repository id through the queue and
 * merged; a job runs on a fenvix machine in the organization's region: a running run row, live progress, per-test
 * results in chunks, the summary, the published run with per-test results, receipts, defects (with the runner's replay
 * command) and audit reruns; then a nightly exploration. What the App wrote is read through the dashboard's own row
 * mappers (src/data/ci-rows.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { signState } from "../../src/auth.ts";
import type { Region, RunnerLaunch, RunnerLauncher } from "../../src/runners/launcher.ts";
import { InProcessQueue } from "../../src/work.ts";
import {
  ACCOUNT, APP_ID, CI_YAML, completeLink, DASHBOARD, githubSetup, githubUser, Harness, hook, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, push, repoLite, REPOS, resetDb,
  runnerCredential, WEB_YAML, workflowJob,
} from "../helpers/harness.ts";

type Row = Record<string, unknown>;
// The dashboard's row mappers, loaded at run time (type-checked by the dashboard's own tsconfig).
const rows = (await import(new URL("../../../src/data/ci-rows.ts", import.meta.url).href)) as {
  mapRun: (r: Row) => { status: string; mode: string; region: string | null; progress: Row | null; engineRunId: string | null; seed: number | null; wouldSkipTests: number; wouldSaveMs: number; audit: { rerun: number; wrongSkips: number }; missDetails: unknown[]; tests: Row };
  mapTestResult: (r: Row) => { outcome: string; failure: { kind: string; defectId: string | null } | null; receiptId: string | null; file: string };
  mapDefect: (r: Row, p: { fullName: string; testRunner: string }) => { cause: string; causeTests: string[]; familyKey: string; replayCommand: string | null; occurrences: number; lastRunId: string | null; firstRunId: string | null; state: string };
  mapReceipt: (r: Row, n: number | null) => { reusedRunId: string | null; code: unknown[]; filesRead: unknown[] };
  mapAuditRerun: (r: Row) => { outcome: string; untrusted: boolean };
  mapExploration: (r: Row) => { newDefectIds: string[]; seeds: number; familiesByPolluter: { key: string; tests: number }[] };
  mapGitHubRepository: (r: Row) => { onboardingState: string; onboardingDetail: string; language: string | null; testRunner: string | null };
};
const plain = (r: unknown) => JSON.parse(JSON.stringify(r)) as Row;
const summary = (name: string, extra: Row = {}) => ({ ...(JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Row), ...extra });

class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  regions: Region[] = ["us", "eu"];
  canPlace(region: Region) { return this.regions.includes(region); }
  async launch(l: RunnerLaunch) { this.launches.push(l); return { instanceId: `i-${l.jobId}`, already: false }; }
}

const H = (c: string) => c.repeat(32);
const VAT = "tests/test_tax.py::test_vat[3]";
const EUR = "tests/test_money.py::test_default_currency_is_eur";
const POLLUTER = "tests/test_config.py::test_set_currency";
const TOTAL = "tests/test_cart.py::test_total";
const defectA = {
  testId: EUR, status: "reproduced", kind: "order", polluters: [POLLUTER], setters: [], order: [POLLUTER, EUR], prefixLength: 31, seed: 3, fingerprint: H("a"),
  replay: { runs: 10, fails: 10, identicalFingerprint: true }, outcome: "failed",
  exception: { type: "AssertionError", phase: "call", message: "assert 'USD' == 'EUR'", location: "tests/test_money.py:12" }, divergence: null,
  engineVersion: "0.1.0", language: "python", replayCommand: "pytest --det --det-seed=3 --det-order=<bundle>/order.txt -n 0",
};

describe("connect flow: link (trial) → setup pull request by repository id → a run on fenvix, live and complete", () => {
  const h = new Harness();
  const launcher = new FakeLauncher();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  let state = "";
  let run1 = "";
  let run2 = "";
  const MAIN_SHA = "c663f502f475eb0892fa2d8972fd322ce3bba456";
  const SHA2 = "d".repeat(40);

  const runner = (path: string, name: string, runId: number | undefined, body: Row, repositoryId = REPOS.shop.id) => h.app.fastify.inject({
    method: "POST", url: `/v1/runner/${path}`, headers: { authorization: `Bearer ${runnerCredential(name, repositoryId, runId)}`, "content-type": "application/json" }, payload: body,
  }).then(async (r) => { await h.app.service.idle(); return r; });
  const runRow = async (id: string) => (await admin.query("select * from ci_runs where id = $1", [id])).rows[0] as Row;

  before(async () => {
    admin = await resetDb();
    await h.start({ SHADOW_MODE: "true" }, { launcher });
    org = await makeOrg(admin, "flow-owner");
    // An EU organization: its machines run in the EU, or not at all.
    await admin.query("update workspaces set region = 'eu' where id = $1", [org.workspaceId]);
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "all" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/test.yml": WEB_YAML } });
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("1. the install link's signed state, then installation.created on All repositories: stored, pending, no pull request yet", async () => {
    // The dashboard API signs the state of the install link (POST /v1/github/install-link) with the same key.
    state = signState(h.cfg.stateSigningKey, { workspaceId: org.workspaceId, userId: org.userId });
    assert.equal((await h.send("installation", installationCreated([REPOS.shop], "all"))).statusCode, 202);
    const repo = (await admin.query("select * from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.equal(repo.onboarding_state, "pending");
    assert.ok(repo.onboarding_detail.length > 0);
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, 0);
  });

  it("2. /github/setup with the OAuth code, then the signed-in person completes it: linked; the 30-day shadow trial starts", async () => {
    assert.equal((await admin.query("select trial_started_at from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0].trial_started_at, null);
    githubUser(h, { code: "flow-code", token: "gho_flow", login: "flow-owner", id: 6201, installations: [INSTALLATION_ID], adminOf: [ACCOUNT.login] });
    const r = await githubSetup(h, { installation_id: String(INSTALLATION_ID), setup_action: "install", state, code: "flow-code" });
    assert.equal(r.status, 303);
    const u = r.url;
    assert.equal(`${u.origin}${u.pathname}`, `${DASHBOARD}/projects/connect`);
    assert.deepEqual(Object.fromEntries(u.searchParams), { github: "confirm", installation: String(INSTALLATION_ID), account: ACCOUNT.login });
    // The dashboard completes the link with the person's own token (POST /v1/github/installations/complete).
    assert.deepEqual(await completeLink(h, r.completion!, org.userId), { workspace_id: org.workspaceId, installation_id: INSTALLATION_ID, account: ACCOUNT.login });
    const sub = (await admin.query("select extract(epoch from trial_ends_at - trial_started_at) / 86400 as days, trial_ends_at > now() as active from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0];
    assert.deepEqual({ days: Number(sub.days), active: sub.active }, { days: 30, active: true });
  });

  it("3. installation_repositories.added: the new repository is stored, pending", async () => {
    const added = hook("installation_repositories", "added", (p) => {
      const i = p.installation as Row;
      p.installation = { ...i, id: INSTALLATION_ID, app_id: APP_ID, account: { ...(i.account as Row), login: ACCOUNT.login, id: ACCOUNT.id, type: ACCOUNT.type }, repository_selection: "all", target_id: ACCOUNT.id, target_type: ACCOUNT.type };
      p.repository_selection = "all";
      p.repositories_added = [repoLite(REPOS.web)];
      p.repositories_removed = [];
    });
    assert.equal((await h.send("installation_repositories", added)).statusCode, 202);
    const r = (await admin.query("select onboarding_state, workspace_id from gh_repositories where repository_id = $1", [REPOS.web.id])).rows[0];
    assert.deepEqual(r, { onboarding_state: "pending", workspace_id: org.workspaceId });
  });

  it("4. the setup pull request, queued by repository id (as the API does): pr_open; the language and runner detected", async () => {
    const queue = new InProcessQueue(h.app.service);
    await queue.enqueue({ kind: "onboard", repositoryId: REPOS.shop.id });
    await queue.enqueue({ kind: "onboard", repositoryId: REPOS.web.id });
    await h.app.service.idle();
    const shop = rows.mapGitHubRepository(plain((await admin.query("select * from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0]));
    assert.deepEqual([shop.onboardingState, shop.onboardingDetail, shop.language, shop.testRunner], ["pr_open", "changed .github/workflows/ci.yml:test", "python", "pytest"]);
    const web = rows.mapGitHubRepository(plain((await admin.query("select * from gh_repositories where repository_id = $1", [REPOS.web.id])).rows[0]));
    assert.deepEqual([web.onboardingState, web.language, web.testRunner], ["pr_open", "node", "vitest"]);
    const projects = (await admin.query("select full_name, language, test_runner, setup_state from ci_projects order by full_name")).rows;
    assert.deepEqual(projects, [
      { full_name: "acme/shop", language: "python", test_runner: "pytest", setup_state: "pr_open" },
      { full_name: "acme/web", language: "node", test_runner: "vitest", setup_state: "pr_open" },
    ]);
  });

  it("5. pull_request opened, then merged: merged, with a detail", async () => {
    const pr = h.gh.repos.get("acme/shop")!.pulls[0]!;
    await h.send("pull_request", pullRequest("opened", { number: pr.number, headRef: "fenvix/runs-on", headSha: pr.headSha }));
    pr.state = "closed";
    await h.send("pull_request", pullRequest("closed", { number: pr.number, headRef: "fenvix/runs-on", headSha: pr.headSha, merged: true }));
    const r = (await admin.query("select onboarding_state, onboarding_detail from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0];
    assert.equal(r.onboarding_state, "merged");
    assert.match(r.onboarding_detail, /#1 was merged/);
    assert.equal((await admin.query("select setup_pr_state from ci_projects where full_name = 'acme/shop'")).rows[0].setup_pr_state, "merged");
  });

  it("6. a job queued: its machine in the organization's region (EU), in shadow mode", async () => {
    await h.send("push", push(MAIN_SHA, "refs/heads/main", 1795430000));
    h.gh.addRun("acme/shop", 31000, { event: "push", headSha: MAIN_SHA, headBranch: "main", message: "Merge pull request #1" });
    await h.send("workflow_job", workflowJob("queued", { id: 81000, runId: 31000, sha: MAIN_SHA, branch: "main" }));
    assert.deepEqual(launcher.launches.map((l) => [l.jobId, l.region, l.mode, l.runnerName]), [[81000, "eu", "shadow", "fenvix-j81000"]]);
    assert.equal((await admin.query("select region from gh_jobs where job_id = 81000")).rows[0].region, "eu");
    assert.equal((await admin.query("select count(*)::int as n from ci_runs")).rows[0].n, 0, "no run row before the job starts");
  });

  it("7. in_progress: a running run row (shadow, EU) the live view shows", async () => {
    await h.send("workflow_job", workflowJob("in_progress", { id: 81000, runId: 31000, sha: MAIN_SHA, branch: "main", runner: "fenvix-j81000", startedAt: "2026-11-18T09:40:05Z" }));
    const job = (await admin.query("select ci_run_id from gh_jobs where job_id = 81000")).rows[0];
    assert.ok(job.ci_run_id);
    run1 = job.ci_run_id;
    const row = await runRow(run1);
    assert.deepEqual([row.status, row.mode, row.region, row.number, row.trigger, row.branch, row.finished_at], ["running", "shadow", "eu", 1, "push", "main", null]);
    assert.equal(new Date(row.pushed_at as string).getTime(), 1795430000 * 1000);
    assert.equal(rows.mapRun(plain(row)).progress, null);
    // The same event again: still one row.
    await h.send("workflow_job", workflowJob("in_progress", { id: 81000, runId: 31000, sha: MAIN_SHA, branch: "main", runner: "fenvix-j81000", startedAt: "2026-11-18T09:40:05Z" }));
    assert.equal((await admin.query("select count(*)::int as n from ci_runs")).rows[0].n, 1);
  });

  it("8. progress: written at once; an older record (seq) is ignored; another job's or a malformed record is refused", async () => {
    const p = (seq: number, phase: string, done: number, extra: Row = {}) => ({ runId: 31000, runAttempt: 1, seq, phase, testsTotal: 56, testsDone: done, passed: done, failed: 0, skippedWithProof: 0, currentTest: null, elapsedMs: seq * 1000, ...extra });
    assert.equal((await runner("progress", "fenvix-j81000", 31000, p(1, "setup", 0, { testsTotal: null }))).statusCode, 202);
    assert.equal(rows.mapRun(plain(await runRow(run1))).progress!.phase, "setup");
    assert.equal((await runner("progress", "fenvix-j81000", 31000, p(3, "testing", 20, { currentTest: VAT, failed: 1, passed: 19 }))).statusCode, 202);
    assert.equal((await runner("progress", "fenvix-j81000", 31000, p(2, "collecting", 0))).statusCode, 202, "an older record is accepted and ignored");
    const live = rows.mapRun(plain(await runRow(run1))).progress!;
    assert.deepEqual({ ...live, updatedAt: "" }, { phase: "testing", testsTotal: 56, testsDone: 20, passed: 19, failed: 1, skippedWithProof: 0, currentTest: VAT, elapsedMs: 3000, updatedAt: "" });
    assert.equal(((await runRow(run1)).progress as Row).seq, 3);
    // Another runner, another run, a malformed record.
    assert.equal((await runner("progress", "fenvix-j81000", 31000, p(4, "testing", 21, { runnerName: "fenvix-j1" }))).statusCode, 403);
    assert.equal((await runner("progress", "fenvix-j81000", 31000, p(4, "testing", 21, { runId: 31001 }))).statusCode, 403);
    const bad = await runner("progress", "fenvix-j81000", 31000, p(4, "running", 21));
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.field, "phase");
    assert.equal((await h.app.fastify.inject({ method: "POST", url: "/v1/runner/progress", payload: p(4, "testing", 1) })).statusCode, 401);
    // A job not known yet: accepted, nothing stored.
    assert.equal((await runner("progress", "fenvix-j99", 39999, { ...p(1, "setup", 0), runId: 39999 })).statusCode, 202);
  });

  it("9. results chunks before the end: stored (sent again: replaced), not applied yet", async () => {
    const chunk0 = {
      runId: 31000, chunk: 0, chunks: 2, engineRunId: "20261118T094005-4412", seed: 3, mode: "shadow",
      tests: [
        { testId: VAT, outcome: "failed", durationMs: 12, failure: { kind: "real", phase: "call", exceptionType: "AssertionError", message: "assert 30 == 31", location: "tests/test_tax.py:40" } },
        { testId: EUR, outcome: "failed", durationMs: 3, failure: { kind: "flaky_defect", exceptionType: "AssertionError", message: "assert 'USD' == 'EUR'", defectFingerprint: H("a") } },
        { testId: TOTAL, outcome: "passed", durationMs: 8, wouldSkip: true },
        { testId: "tests/test_cart.py::test_empty", outcome: "passed", durationMs: 5, wouldSkip: true },
      ],
      defects: [defectA],
      missDetails: [{ kind: "code", detail: "shop/tax.py::vat", tests: 10 }, { kind: "new", detail: "(new test)", tests: 1 }],
    };
    const chunk1 = { runId: 31000, chunk: 1, tests: [{ testId: "tests/test_cart.py::test_other", outcome: "passed", durationMs: 7, wouldSkip: false }] };
    assert.equal((await runner("results", "fenvix-j81000", 31000, { ...chunk1, tests: [] })).statusCode, 202);
    assert.equal((await runner("results", "fenvix-j81000", 31000, chunk0)).statusCode, 202);
    assert.equal((await runner("results", "fenvix-j81000", 31000, chunk1)).statusCode, 202);
    const staged = (await admin.query("select chunk, applied_at, jsonb_array_length(payload->'tests') as tests from gh_run_results order by chunk")).rows;
    assert.deepEqual(staged, [{ chunk: 0, applied_at: null, tests: 4 }, { chunk: 1, applied_at: null, tests: 1 }]);
    assert.equal((await admin.query("select count(*)::int as n from ci_test_results")).rows[0].n, 0);
    // Limits and identity.
    const tooMany = await runner("results", "fenvix-j81000", 31000, { runId: 31000, chunk: 2, tests: Array.from({ length: 5001 }, (_, i) => ({ testId: `t${i}`, outcome: "passed", durationMs: 1 })) });
    assert.deepEqual([tooMany.statusCode, tooMany.json().error.field], [400, "tests"]);
    assert.equal((await runner("results", "fenvix-j81000", 31000, { ...chunk1, repositoryId: REPOS.web.id })).statusCode, 403);
  });

  it("10. completed + summary: the same row, finished; per-test results, the defect with the runner's replay command, shadow numbers", async () => {
    assert.equal((await h.summary({ runId: 31000, runner: "fenvix-j81000", summary: summary("job2-warm-real-failure", { mode: "shadow" }) })).statusCode, 202);
    await h.send("workflow_job", workflowJob("completed", { id: 81000, runId: 31000, sha: MAIN_SHA, branch: "main", runner: "fenvix-j81000", conclusion: "failure", startedAt: "2026-11-18T09:40:05Z", completedAt: "2026-11-18T09:41:50Z" }));
    assert.equal((await admin.query("select count(*)::int as n from ci_runs")).rows[0].n, 1, "the running row was finished, not a second one");
    const row = await runRow(run1);
    const run = rows.mapRun(plain(row));
    assert.deepEqual([run.status, run.mode, run.region, run.engineRunId, run.seed, run.progress], ["failed", "shadow", "eu", "20261118T094005-4412", 3, null]);
    assert.deepEqual([run.wouldSkipTests, run.wouldSaveMs], [2, 13]);
    assert.equal(run.missDetails.length, 2);
    assert.equal(run.tests.total, 56);
    assert.equal(new Date(row.finished_at as string).toISOString(), "2026-11-18T09:41:50.000Z");

    const tests = (await admin.query("select * from ci_test_results where run_id = $1 order by test_id", [run1])).rows.map((r) => ({ id: r.test_id as string, ...rows.mapTestResult(plain(r)) }));
    assert.equal(tests.length, 5);
    const defect = (await admin.query("select * from ci_defects")).rows[0];
    const flaky = tests.find((t) => t.id === EUR)!;
    assert.deepEqual([flaky.outcome, flaky.failure!.kind, flaky.failure!.defectId], ["failed", "flaky_defect", defect.id]);
    assert.deepEqual([tests.find((t) => t.id === VAT)!.failure!.kind, tests.find((t) => t.id === VAT)!.file], ["real", "tests/test_tax.py"]);
    const d = rows.mapDefect(plain(defect), { fullName: "acme/shop", testRunner: "pytest" });
    assert.deepEqual([d.cause, d.causeTests, d.familyKey, d.replayCommand, d.occurrences, d.firstRunId, d.lastRunId, d.state],
      ["polluter", [POLLUTER], POLLUTER, defectA.replayCommand, 1, run1, run1, "open"]);
    assert.deepEqual((await admin.query("select chunk, applied_at is not null as applied, apply_error from gh_run_results order by chunk")).rows,
      [{ chunk: 0, applied: true, apply_error: null }, { chunk: 1, applied: true, apply_error: null }]);
    const ev = (await admin.query("select billable, ci_run_id from ci_usage_events where github_job_id = 81000")).rows[0];
    assert.deepEqual(ev, { billable: true, ci_run_id: run1 });
    assert.equal(h.gh.repos.get("acme/shop")!.checkRuns.size, 1);
  });

  it("11. a chunk sent again after publish is applied again: nothing changes", async () => {
    const before = JSON.stringify([(await admin.query("select occurrences, last_seen_at from ci_defects")).rows, (await admin.query("select count(*) from ci_test_results")).rows,
      (await admin.query("select would_skip_tests, would_save_ms, audit_rerun from ci_runs")).rows]);
    const again = (await admin.query("select payload from gh_run_results where chunk = 0")).rows[0].payload;
    assert.equal((await runner("results", "fenvix-j81000", 31000, again)).statusCode, 202);
    assert.ok((await admin.query("select applied_at from gh_run_results where chunk = 0")).rows[0].applied_at);
    const now = JSON.stringify([(await admin.query("select occurrences, last_seen_at from ci_defects")).rows, (await admin.query("select count(*) from ci_test_results")).rows,
      (await admin.query("select would_skip_tests, would_save_ms, audit_rerun from ci_runs")).rows]);
    assert.equal(now, before);
  });

  it("12. after the trial (enforce): skipped with proof, receipts pointing at the reused run, audit reruns, the defect seen again", async () => {
    await admin.query("update ci_subscriptions set trial_ends_at = now() - interval '1 day', trial_started_at = now() - interval '31 days' where workspace_id = $1", [org.workspaceId]);
    h.gh.addRun("acme/shop", 31001, { event: "push", headSha: SHA2, headBranch: "main", message: "Next" });
    await h.send("workflow_job", workflowJob("queued", { id: 81001, runId: 31001, sha: SHA2, branch: "main" }));
    assert.deepEqual([launcher.launches.at(-1)!.region, launcher.launches.at(-1)!.mode], ["eu", "enforce"]);
    const t = { startedAt: "2026-11-18T10:10:05Z", completedAt: "2026-11-18T10:11:05Z" };
    await h.send("workflow_job", workflowJob("in_progress", { id: 81001, runId: 31001, sha: SHA2, branch: "main", runner: "fenvix-j81001", ...t }));
    run2 = (await admin.query("select ci_run_id from gh_jobs where job_id = 81001")).rows[0].ci_run_id;
    assert.equal((await runRow(run2)).mode, "enforce");
    const receipt = {
      testId: TOTAL, cacheKey: H("b"), reusedEngineRunId: "20261118T094005-4412", fingerprint: H("c"), reusedDurationMs: 8,
      code: [{ path: "shop/cart.py", qualname: "Cart.total", digest: H("d") }], modules: [{ path: "shop/cart.py", kind: "skeleton", digest: H("e") }],
      filesRead: [{ path: "data/rates.json", dep: `f:${H("f")}` }], envRead: [{ name: "TZ", digest: "-" }],
      runtime: { digest: H("1"), interpreter: "python 3.13.0", system: "Linux", machine: "x86_64", libc: "glibc 2.39", distributions: 41 },
      config: { digest: H("2"), runner: "pytest 8.3.3", engine: "detpy 0.1.0", inifile: "pyproject.toml", options: "-q" }, changedFilesProven: 2,
    };
    await runner("results", "fenvix-j81001", 31001, {
      // Three chunks in all: 1 and 2 come after the run is published (step 13).
      runId: 31001, chunk: 0, chunks: 3, engineRunId: "20261118T101005-5001", seed: null, mode: "enforce",
      tests: [
        { testId: TOTAL, outcome: "skipped_with_proof", durationMs: 8, cacheKey: H("b") },
        { testId: EUR, outcome: "failed", durationMs: 3, failure: { kind: "flaky_defect", defectFingerprint: H("a") } },
      ],
      receipts: [receipt], defects: [defectA],
      audit: [{ testId: TOTAL, cacheKey: H("b"), outcome: "confirmed" }, { testId: "tests/test_cart.py::test_tax", cacheKey: H("3"), outcome: "wrong_skip", untrusted: true, detail: "failed on rerun" }],
    });
    await h.summary({ runId: 31001, runner: "fenvix-j81001", summary: summary("job2-warm-real-failure") });
    await h.send("workflow_job", workflowJob("completed", { id: 81001, runId: 31001, sha: SHA2, branch: "main", runner: "fenvix-j81001", conclusion: "failure", ...t }));
    const run = rows.mapRun(plain(await runRow(run2)));
    assert.deepEqual([run.mode, run.audit, run.engineRunId, run.seed, run.wouldSkipTests], ["enforce", { rerun: 2, wrongSkips: 1 }, "20261118T101005-5001", null, 0]);
    const rc = (await admin.query("select * from ci_skip_receipts where run_id = $1", [run2])).rows[0];
    const mapped = rows.mapReceipt(plain(rc), 1);
    assert.deepEqual([mapped.reusedRunId, mapped.code.length, mapped.filesRead.length], [run1, 1, 1]);
    const skipped = rows.mapTestResult(plain((await admin.query("select * from ci_test_results where run_id = $1 and test_id = $2", [run2, TOTAL])).rows[0]));
    assert.deepEqual([skipped.outcome, skipped.receiptId], ["skipped_with_proof", rc.id]);
    const audits = (await admin.query("select * from ci_audit_reruns where run_id = $1 order by test_id", [run2])).rows.map((r) => rows.mapAuditRerun(plain({ ...r, run_number: 2 })));
    assert.deepEqual(audits.map((a) => [a.outcome, a.untrusted]), [["wrong_skip", true], ["confirmed", false]]);
    const d = rows.mapDefect(plain((await admin.query("select * from ci_defects")).rows[0]), { fullName: "acme/shop", testRunner: "pytest" });
    assert.deepEqual([d.occurrences, d.firstRunId, d.lastRunId], [2, run1, run2]);
  });

  it("13. chunks after publish are applied when they arrive; a skipped test waits for its receipt in a later chunk", async () => {
    const n = async () => (await admin.query("select count(*)::int as n from ci_test_results where run_id = $1", [run2])).rows[0].n as number;
    assert.equal(await n(), 2);
    await runner("results", "fenvix-j81001", 31001, { runId: 31001, chunk: 1, tests: [{ testId: "tests/test_late.py::test_a", outcome: "passed", durationMs: 4 }, { testId: "tests/test_late.py::test_b", outcome: "skipped_with_proof", durationMs: 6, cacheKey: H("4") }] });
    assert.equal(await n(), 3, "the skipped test waits for its receipt");
    const waiting = (await admin.query("select applied_at, apply_error from gh_run_results where run_id = 31001 and chunk = 1")).rows[0];
    assert.equal(waiting.applied_at, null);
    assert.match(waiting.apply_error, /1 test skipped with proof without a receipt yet/);
    await runner("results", "fenvix-j81001", 31001, { runId: 31001, chunk: 2, receipts: [{ testId: "tests/test_late.py::test_b", cacheKey: H("4"), reusedEngineRunId: "unknown-run", fingerprint: H("5"), reusedDurationMs: 6 }] });
    assert.equal(await n(), 4);
    assert.deepEqual((await admin.query("select chunk, applied_at is not null as applied from gh_run_results where run_id = 31001 order by chunk")).rows,
      [{ chunk: 0, applied: true }, { chunk: 1, applied: true }, { chunk: 2, applied: true }]);
    assert.equal((await admin.query("select reused_run_id from ci_skip_receipts where test_id = 'tests/test_late.py::test_b'")).rows[0].reused_run_id, null);
    assert.equal((await admin.query("select occurrences from ci_defects")).rows[0].occurrences, 2, "other chunks of the same run do not count the defect again");
    // A chunk past the count chunk 0 declared is not stored (review R-016 F7).
    assert.equal((await runner("results", "fenvix-j81001", 31001, { runId: 31001, chunk: 3, tests: [{ testId: "tests/test_late.py::test_c", outcome: "passed", durationMs: 1 }] })).statusCode, 202);
    assert.equal((await admin.query("select count(*)::int as n from gh_run_results where run_id = 31001")).rows[0].n, 3);
    assert.equal(await n(), 4);
  });

  it("14. a job that started on our machine and was cancelled without a summary: the row is marked cancelled; billed its held minutes", async () => {
    const sha = "e".repeat(40);
    h.gh.addRun("acme/shop", 31002, { event: "push", headSha: sha, headBranch: "main", message: "cancel me" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 81002, runId: 31002, sha, branch: "main", runner: "fenvix-j81002" }));
    const id = (await admin.query("select ci_run_id from gh_jobs where job_id = 81002")).rows[0].ci_run_id;
    assert.equal((await runRow(id)).status, "running");
    await h.send("workflow_job", workflowJob("completed", { id: 81002, runId: 31002, sha, branch: "main", runner: "fenvix-j81002", conclusion: "cancelled" }));
    assert.equal((await runRow(id)).status, "cancelled");
    assert.deepEqual((await admin.query("select billable, reason, ci_run_id from ci_usage_events where github_job_id = 81002")).rows[0], { billable: true, reason: "cancelled_after_start", ci_run_id: id });
    // A progress record for a finished run is ignored.
    await runner("progress", "fenvix-j81002", 31002, { runId: 31002, seq: 9, phase: "testing", testsDone: 1, passed: 1, failed: 0, skippedWithProof: 0, elapsedMs: 1 });
    assert.equal(rows.mapRun(plain(await runRow(id))).progress, null);
  });

  it("15. a nightly exploration: stored for the project, with the defects it found first", async () => {
    const defectB = { ...defectA, testId: "tests/test_cache.py::test_warm", fingerprint: H("9"), polluters: [], kind: "fails-alone", order: ["tests/test_cache.py::test_warm"] };
    const exploration = {
      startedAt: "2026-11-19T02:00:00Z", finishedAt: "2026-11-19T02:40:00Z", commitSha: SHA2, branch: "main", seeds: 20, runs: 20, collected: 56, seconds: 2400,
      flakyFailing: [EUR, defectB.testId], alwaysFailing: [VAT], notReproduced: [], familiesByPolluter: { [POLLUTER]: [EUR], "<none>": [defectB.testId] },
      seedsLog: [{ seed: 1, seconds: 120, failing: [EUR] }], defects: [defectA, defectB],
    };
    assert.equal((await runner("explorations", "fenvix-explore", undefined, exploration)).statusCode, 202);
    assert.equal((await runner("explorations", "fenvix-explore", undefined, exploration)).statusCode, 202, "sent again: the same exploration");
    const ex = (await admin.query("select * from ci_explorations")).rows;
    assert.equal(ex.length, 1);
    const b = (await admin.query("select id, cause, occurrences, first_run_id from ci_defects where test_id = $1", [defectB.testId])).rows[0];
    const mapped = rows.mapExploration(plain(ex[0]));
    assert.deepEqual([mapped.newDefectIds, mapped.seeds, mapped.familiesByPolluter.length], [[b.id], 20, 2]);
    // Found by an exploration only: no run saw it yet (occurrences counts runs), its sighting is in its history.
    assert.deepEqual([b.cause, b.occurrences, b.first_run_id], ["fails_alone", 0, null]);
    assert.equal((await admin.query("select count(*)::int as n from ci_defect_occurrences where defect_id = $1 and source = 'exploration'", [b.id])).rows[0].n, 1);
    assert.equal((await admin.query("select occurrences from ci_defects where test_id = $1", [EUR])).rows[0].occurrences, 2, "an exploration is not a run");
    const bad = await runner("explorations", "fenvix-explore", undefined, { ...exploration, commitSha: "nope" });
    assert.deepEqual([bad.statusCode, bad.json().error.field], [400, "commitSha"]);
  });

  it("15b. explorations are bounded (review R-016b G2): none from a CI job's credential, one new per project and day, 90 nights kept", async () => {
    const night = (day: number) => ({
      startedAt: new Date(Date.UTC(2026, 10, 1 + day, 2)).toISOString(), finishedAt: new Date(Date.UTC(2026, 10, 1 + day, 3)).toISOString(), commitSha: SHA2,
      branch: "main", seeds: 1, runs: 1, collected: 1, seconds: 1, flakyFailing: [], alwaysFailing: [], notReproduced: [], familiesByPolluter: {},
      seedsLog: [{ seed: 1, seconds: 1, failing: [] }], defects: [],
    });
    const count = async () => (await admin.query("select count(*)::int as n from ci_explorations")).rows[0].n as number;
    // A CI job's credential (it names the run) is refused.
    assert.equal((await runner("explorations", "fenvix-j81001", 31001, night(40))).statusCode, 403);
    // Step 15 stored one today: another one the same day is dropped (202, nothing stored).
    assert.equal((await runner("explorations", "fenvix-explore", undefined, night(41))).statusCode, 202);
    assert.equal(await count(), 1);
    // A project keeps the newest 90 nights (by when the App received them).
    await admin.query("update ci_explorations set received_at = now() - interval '1 day'");
    await admin.query(
      `insert into ci_explorations (workspace_id, project_id, started_at, finished_at, commit_sha, seeds, runs, received_at)
       select workspace_id, project_id, started_at - make_interval(days => g), finished_at - make_interval(days => g), commit_sha, 1, 1, now() - make_interval(days => 1 + g)
       from ci_explorations, generate_series(1, 89) g`);
    assert.equal(await count(), 90);
    const oldest = (await admin.query("select id from ci_explorations order by received_at limit 1")).rows[0].id;
    assert.equal((await runner("explorations", "fenvix-explore", undefined, night(42))).statusCode, 202);
    assert.equal(await count(), 90);
    assert.equal((await admin.query("select count(*)::int as n from ci_explorations where id = $1", [oldest])).rows[0].n, 0, "the oldest night went");
    assert.equal((await admin.query("select count(*)::int as n from ci_explorations where started_at = $1", [night(42).startedAt])).rows[0].n, 1);
  });

  it("16. every call the App made matches GitHub's REST description", () => {
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path} ${x.status}: ${JSON.stringify(x.problems)}`), []);
  });
});
