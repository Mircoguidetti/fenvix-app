// The CI dashboard's pure logic (src/data/ci.ts) and the row mapping from the Supabase tables (src/data/ci-rows.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { billingFrom, daysBetween, familiesOf, familyKeyOf, median, medianTimeToGreen, overviewFrom, projectRow, replayCommand, setupChange, setupSnippet, suggestPlan, usageCsv, usageFrom } from "../../src/data/ci.ts";
import { fileOfTest, friendlyError, mapDefect, mapPlan, mapProject, mapReceipt, mapRun, mapTestResult } from "../../src/data/ci-rows.ts";
import type { Defect, GitHubRate, Plan, Project, Run } from "../../src/data/types.ts";

const RATE: GitHubRate = { usdPerMinute: 0.008, runner: "GitHub-hosted Linux, 2 cores", source: "test", checkedOn: "2026-11-16" };
const NOW = new Date("2026-11-17T12:00:00Z");

const project = (id: string, ttg: number | null = 400, jobMinutes = 8): Project => ({
  id, fullName: `acme/${id}`, language: "python", testRunner: "pytest", defaultBranch: "main", installationId: 1, setupState: "active", setupPullRequest: null,
  connectedAt: "2026-09-01T00:00:00Z", baseline: ttg === null ? null : { medianTimeToGreenS: ttg, medianJobMinutes: jobMinutes, runsSampled: 10, from: "2026-08-01", to: "2026-08-31" },
  settings: { skipWithProof: true, commentOnPullRequests: true, nightlyExploration: false, testCommand: "" },
});

let n = 0;
function run(p: string, startedAt: string, o: Partial<Run> = {}): Run {
  n++;
  const ran = o.testTimeMs?.ran ?? 10_000;
  const skipped = o.testTimeMs?.skipped ?? 290_000;
  return {
    id: `r${n}`, projectId: p, number: n, engineRunId: null, commitSha: (o.commitSha ?? String(n)).padEnd(40, "0"), commitMessage: "", branch: "main", pullRequest: null, trigger: "push",
    status: "passed", pushedAt: new Date(new Date(startedAt).getTime() - 10_000).toISOString(), startedAt, finishedAt: new Date(new Date(startedAt).getTime() + 30_000).toISOString(), durationMs: 30_000,
    tests: { total: 100, ran: 3, passed: 3, failed: 0, skippedWithProof: 97, flakyDefects: 0 }, testTimeMs: { ran, skipped }, skipShare: skipped / (ran + skipped), minutesSaved: skipped / 60000,
    githubEquivalentMinutes: 8, engineVersion: "detpy 0.1.0", seed: 3, ...o,
  };
}

const defect = (o: Partial<Defect>): Defect => ({
  id: "d1", projectId: "p1", projectName: "acme/p1", testId: "tests/test_b.py::test_b", status: "reproduced", state: "open", cause: "polluter",
  causeTests: ["tests/test_a.py::test_a"], minimalOrder: ["tests/test_a.py::test_a", "tests/test_b.py::test_b"], prefixLength: 31, seed: 3, fingerprint: "6fc828330e79296ba4e94163743199dd",
  replays: { runs: 10, fails: 10, identicalFingerprint: true }, outcome: "failed", exception: { type: "TypeError", phase: "setup", message: "x", location: "a.py:1" }, divergence: null,
  familyKey: "tests/test_a.py::test_a", firstSeenAt: "2026-11-01T00:00:00Z", lastSeenAt: "2026-11-10T00:00:00Z", firstRunId: null, lastRunId: null, occurrences: 2, engineVersion: "detpy 0.1.0",
  language: "python", testRunner: "pytest", ...o,
});

const plans: Plan[] = [
  { id: "starter", name: "Starter", description: "", runsPerMonth: 500, maxProjects: 1, priceUsdMonth: null, features: [], current: false },
  { id: "team", name: "Team", description: "", runsPerMonth: 2000, maxProjects: 5, priceUsdMonth: null, features: [], current: true },
  { id: "enterprise", name: "Enterprise", description: "", runsPerMonth: null, maxProjects: null, priceUsdMonth: null, features: [], current: false },
];

test("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("time to green: the first passing run of each commit, from the push", () => {
  const runs = [
    run("p1", "2026-11-05T10:00:00Z", { commitSha: "a", status: "failed" }),
    run("p1", "2026-11-05T10:05:00Z", { commitSha: "a" }), // green 5 min after the failure: pushed 10 s before its own start
    run("p1", "2026-11-05T11:00:00Z", { commitSha: "b" }),
    run("p1", "2026-11-05T11:10:00Z", { commitSha: "b" }), // a second green run of the same commit does not count
  ];
  const t = medianTimeToGreen(runs, new Date("2026-11-01T00:00:00Z"), NOW);
  assert.equal(t.commits, 2);
  assert.equal(t.medianS, 40);
});

test("a project row: this month's runs, median skip share, open defects", () => {
  const runs = [run("p1", "2026-11-03T10:00:00Z"), run("p1", "2026-11-04T10:00:00Z", { testTimeMs: { ran: 300_000, skipped: 0 }, skipShare: 0 }), run("p1", "2026-10-30T10:00:00Z"), run("p2", "2026-11-04T10:00:00Z")];
  const row = projectRow(project("p1"), runs, [defect({}), defect({ id: "d2", state: "fixed" })], NOW);
  assert.equal(row.runsThisMonth, 2);
  assert.equal(row.medianSkipShare, median([runs[0].skipShare, 0]));
  assert.equal(row.openDefects, 1);
  assert.equal(row.lastRunAt, "2026-11-04T10:00:00Z");
});

test("the overview: runs, minutes saved, GitHub cost, the same days of last month", () => {
  const runs = [run("p1", "2026-11-03T10:00:00Z"), run("p1", "2026-11-16T10:00:00Z"), run("p1", "2026-10-10T10:00:00Z"), run("p1", "2026-10-20T10:00:00Z")];
  const o = overviewFrom([project("p1", 400)], runs, [defect({})], plans[1], RATE, NOW);
  assert.equal(o.month, "2026-11");
  assert.equal(o.runs.thisMonth, 2);
  assert.equal(o.runs.lastMonthSameDays, 1, "October 20 is after the same point of the month");
  assert.equal(o.minutesSaved.thisMonth, 9.7);
  assert.equal(o.cost.githubEquivalentMinutes, 16);
  assert.equal(o.cost.githubEquivalentUsd, 0.13);
  assert.equal(o.timeToGreen.beforeMedianS, 400);
  assert.equal(o.runs.perDay.length, 30);
  assert.equal(o.openDefects, 1);
});

test("usage: per project, totals that add up, a CSV with one row per project", () => {
  const runs = [run("p1", "2026-11-03T10:00:00Z"), run("p1", "2026-11-04T10:00:00Z"), run("p2", "2026-11-04T10:00:00Z"), run("p2", "2026-10-04T10:00:00Z")];
  const u = usageFrom("2026-11", [project("p1"), project("p2")], runs, plans[1], RATE);
  assert.equal(u.runsUsed, 3);
  assert.equal(u.runsIncluded, 2000);
  assert.deepEqual(u.rows.map((r) => r.runs), [2, 1]);
  assert.equal(u.totals.runs, 3);
  assert.equal(u.daily.series.length, 2);
  assert.equal(u.daily.series[0].values.reduce((a, b) => a + b, 0), 2);
  const csv = usageCsv(u).trim().split("\n");
  assert.equal(csv[0], "project,runs,minutes_saved,test_minutes_ran,github_equivalent_minutes,github_equivalent_usd");
  assert.equal(csv.length, 3);
  assert.equal(csv[1], "acme/p1,2,9.7,0.3,16,0.13");
});

test("plans: the smallest that holds the projects and the runs; prices stay unset", () => {
  assert.equal(suggestPlan(plans, 1, 400)?.id, "starter");
  assert.equal(suggestPlan(plans, 2, 400)?.id, "team");
  assert.equal(suggestPlan(plans, 3, 5000)?.id, "enterprise");
  const b = billingFrom(plans, [project("p1")], [run("p1", "2026-10-03T10:00:00Z"), run("p1", "2026-11-03T10:00:00Z")], NOW);
  assert.equal(b.plan?.id, "team");
  assert.equal(b.runsUsed, 1);
  assert.equal(b.averageMonthlyRuns, 1);
  assert.equal(b.suggestedPlanId, "starter");
  assert.equal(b.plan?.priceUsdMonth, null);
});

test("defects: families by cause, the engine's family key, replay commands", () => {
  assert.equal(familyKeyOf([]), "<none>");
  assert.equal(familyKeyOf(["a", "b"]), "a + b");
  const fams = familiesOf([defect({}), defect({ id: "d2", testId: "tests/test_c.py::test_c" }), defect({ id: "d3", cause: "fails_alone", causeTests: [], familyKey: "<none>" })]);
  assert.equal(fams.length, 2);
  assert.equal(fams[0].defects.length, 2);
  assert.equal(replayCommand(defect({ id: "dfx_1", seed: 3 })), "pytest --det --det-seed=3 --det-order=.fenvix/defects/dfx_1/order.txt");
  assert.equal(replayCommand(defect({ id: "dfx_1", seed: null })), "pytest --det --det-order=.fenvix/defects/dfx_1/order.txt", "collection order: no --det-seed, as in the bundle's command");
  assert.equal(replayCommand(defect({ language: "node", testRunner: "vitest", seed: 32 })), "detjs vitest run --det --det-seed=32");
  assert.equal(replayCommand(defect({ language: "node", testRunner: "jest", seed: 7 })), "detjs jest --det --det-seed=7");
});

test("setup: one line in the test job", () => {
  const c = setupChange(project("p1"));
  assert.equal(c.before, "runs-on: ubuntu-latest");
  assert.equal(c.after, "runs-on: fenvix");
  assert.match(setupSnippet(project("p1")), /^ {4}runs-on: fenvix$/m);
});

test("days between two times, inclusive, in UTC", () => {
  assert.deepEqual(daysBetween(new Date("2026-11-01T23:00:00Z"), new Date("2026-11-03T01:00:00Z")), ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"]);
});

test("rows from Postgres become the contract's records", () => {
  const p = mapProject({ id: "x", full_name: "acme/api", language: "python", test_runner: "pytest", installation_id: "42", setup_state: "pr_open", setup_pr_number: 7, setup_pr_url: "https://github.com/acme/api/pull/7", baseline_median_ttg_s: "417.0", baseline_median_job_minutes: "8.80", nightly_exploration: true });
  assert.equal(p.installationId, 42);
  assert.deepEqual(p.setupPullRequest, { number: 7, url: "https://github.com/acme/api/pull/7", state: "open" });
  assert.equal(p.baseline?.medianTimeToGreenS, 417);
  assert.equal(p.settings.nightlyExploration, true);
  assert.equal(p.settings.skipWithProof, true);
  const r = mapRun({ id: "r", project_id: "x", number: 3, commit_sha: "a".repeat(40), trigger: "pull_request", status: "failed", pull_request: 12, tests_total: 10, tests_ran: 4, tests_skipped: 6, tests_failed: 1, tests_flaky_defects: 1, test_time_ran_ms: "1000", test_time_skipped_ms: "9000", skip_share: "0.9000", minutes_saved: "0.15", seed: null });
  assert.equal(r.tests.skippedWithProof, 6);
  assert.equal(r.skipShare, 0.9);
  assert.equal(r.seed, null);
  assert.equal(r.pullRequest, 12);
  const t = mapTestResult({ run_id: "r", test_id: "tests/a.py::test_x", outcome: "failed", failure_kind: "flaky_defect", defect_id: "d", failure_message: "boom" });
  assert.equal(t.file, "tests/a.py");
  assert.equal(t.failure?.kind, "flaky_defect");
  assert.equal(mapTestResult({ test_id: "x", outcome: "passed" }).failure, null);
  assert.equal(fileOfTest("packages/a/src/x.test.ts > suite > case"), "packages/a/src/x.test.ts");
  const d = mapDefect({ id: "d", project_id: "x", test_id: "t", status: "reproduced", cause: "state_setter", cause_tests: ["s"], minimal_order: ["t"], seed: "16", fingerprint: "f".repeat(32), replay_runs: 10, replay_fails: 10, exception: { type: "KeyError", phase: "call", message: "m", location: "l" }, language: "python" }, { fullName: "acme/api", testRunner: "pytest" });
  assert.equal(d.seed, 16);
  assert.equal(d.familyKey, "s");
  assert.equal(d.projectName, "acme/api");
  assert.equal(mapPlan({ id: "team", name: "Team", runs_per_month: 2000, max_projects: 5, price_usd_month: null }, "team").priceUsdMonth, null);
  const rc = mapReceipt({ id: "c", run_id: "r", test_id: "t", cache_key: "k", reused_engine_run_id: "20261117T101502-4412", reused_duration_ms: 840, env_read: [{ name: "TZ", digest: "-" }], runtime: { interpreter: "python 3.12.7" } }, 12);
  assert.equal(rc.reusedRunNumber, 12);
  assert.deepEqual(rc.envRead, [{ name: "TZ", digest: "-" }]);
  assert.equal(rc.runtime.interpreter, "python 3.12.7");
  assert.deepEqual(rc.code, []);
});

test("errors read as sentences", () => {
  assert.match(friendlyError({ message: "TypeError: Failed to fetch" }), /Could not reach the server/);
  assert.match(friendlyError({ message: "JWT expired" }), /session has ended/);
  assert.match(friendlyError({ code: "42501", message: "permission denied for table ci_runs" }), /read only/);
});
