// The dashboard's pure logic (src/data/ci.ts, shared by the mock and the API server) and the row mapping from the
// database (src/data/ci-rows.ts, used by the API server).
import test from "node:test";
import assert from "node:assert/strict";
import {
  MINUTES_PER_UNIT, TRIAL_GATE, auditFrom, billedUnits, billingFrom, daysBetween, minuteBreakdown, roundToSum, runMinutes, familiesOf, familyKeyOf, median, medianTimeToGreen, overviewFrom, projectRow,
  replayCommand, setupChange, setupSnippet, suggestPlan, trialFrom, usageCsv, usageFrom, type UsageEvent,
} from "../../src/data/ci.ts";
import { fileOfTest, friendlyError, mapAuditRerun, mapDefect, mapGitHubRepository, mapInstallation, mapPlan, mapProgress, mapProject, mapReceipt, mapRun, mapTestResult, mapUsageEvent } from "../../src/data/ci-rows.ts";
import type { AuditRerun, Defect, GitHubRate, Plan, Project, Run } from "../../src/data/types.ts";

const RATE: GitHubRate = { usdPerMinute: 0.008, runner: "GitHub-hosted Linux, 2 cores", source: "test", checkedOn: "2026-11-16" };
const NOW = new Date("2026-11-17T12:00:00Z");

const project = (id: string, ttg: number | null = 400, jobMinutes = 8): Project => ({
  id, fullName: `acme/${id}`, language: "python", testRunner: "pytest", defaultBranch: "main", installationId: 1, repositoryId: null, setupState: "active", setupPullRequest: null,
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
    otherStepMinutes: 2, githubEquivalentMinutes: ran / 60000 + skipped / 60000 + 2, engineVersion: "detpy 0.1.0", seed: 3, skipMisses: {}, missDetails: [],
    mode: "enforce", wouldSkipTests: 0, wouldSaveMs: 0, audit: { rerun: 0, wrongSkips: 0 }, region: "us", progress: null, ...o,
  };
}

const defect = (o: Partial<Defect>): Defect => ({
  id: "d1", projectId: "p1", projectName: "acme/p1", testId: "tests/test_b.py::test_b", status: "reproduced", state: "open", cause: "polluter",
  causeTests: ["tests/test_a.py::test_a"], minimalOrder: ["tests/test_a.py::test_a", "tests/test_b.py::test_b"], prefixLength: 31, seed: 3, fingerprint: "6fc828330e79296ba4e94163743199dd",
  replays: { runs: 10, fails: 10, identicalFingerprint: true }, outcome: "failed", exception: { type: "TypeError", phase: "setup", message: "x", location: "a.py:1" }, divergence: null,
  familyKey: "tests/test_a.py::test_a", firstSeenAt: "2026-11-01T00:00:00Z", lastSeenAt: "2026-11-10T00:00:00Z", firstRunId: null, lastRunId: null, occurrences: 2, engineVersion: "detpy 0.1.0",
  language: "python", testRunner: "pytest", replayCommand: null, ...o,
});

const plan = (id: string, unitsIncluded: number | null, maxProjects: number | null, priceUsdMonth: number | null, current = false, kind: Plan["kind"] = "plan"): Plan => ({ id, name: id, description: "", kind, unitsIncluded, maxProjects, priceUsdMonth, features: [], current });
/** The four plans with their prices; the units each includes are not set yet. */
const unsetPlans: Plan[] = [plan("starter", null, 1, 129), plan("team", null, 5, 479, true), plan("scale", null, 25, 1350), plan("monorepo", null, null, 4200), plan("nightly", null, null, null, false, "addon")];
/** The same plans with units set, for sizing. */
const plans: Plan[] = [plan("starter", 500, 1, 129), plan("team", 2000, 5, 479, true), plan("scale", 10000, 25, 1350), plan("monorepo", null, null, 4200)];
const event = (projectId: string | null, occurredAt: string, baselineMinutes: number, billable = true): UsageEvent => ({ projectId, occurredAt, baselineMinutes, billable });

test("rounded parts always add up to the rounded total", () => {
  assert.deepEqual(roundToSum([0.4, 0.4, 0.4]), [1, 0, 0]);
  assert.deepEqual(roundToSum([1.25, 2.25, 3.5], 1), [1.3, 2.2, 3.5]);
  for (let i = 0; i < 500; i++) {
    const parts = [Math.random() * 900, Math.random() * 2000, Math.random() * 1300] as [number, number, number];
    for (const d of [0, 1]) {
      const m = minuteBreakdown(parts, d);
      assert.equal(Math.round((m.ran + m.skipped + m.other) * 10 ** d), Math.round(m.total * 10 ** d));
      assert.equal(m.total, Math.round(parts.reduce((a, b) => a + b, 0) * 10 ** d) / 10 ** d);
    }
  }
  const r = runMinutes(run("p1", "2026-11-03T10:00:00Z"));
  assert.equal(r.total, 7);
  assert.equal(Math.round((r.ran + r.skipped + r.other) * 10), 70);
});

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

test("the overview: runs, minutes saved, GitHub cost, run units, the same days of last month", () => {
  const runs = [run("p1", "2026-11-03T10:00:00Z"), run("p1", "2026-11-16T10:00:00Z"), run("p1", "2026-10-10T10:00:00Z"), run("p1", "2026-10-20T10:00:00Z")];
  const events = runs.map((r) => event(r.projectId, r.finishedAt!, r.githubEquivalentMinutes));
  const o = overviewFrom([project("p1", 400)], runs, [defect({})], plans[1], RATE, NOW, events, null);
  assert.equal(o.month, "2026-11");
  assert.equal(o.runs.thisMonth, 2);
  assert.equal(o.runs.lastMonthSameDays, 1, "October 20 is after the same point of the month");
  // Two runs: 2 × (0.167 run + 4.833 skipped + 2 other) = 0.33 + 9.67 + 4 = 14 min, in whole minutes 0 + 10 + 4 = 14.
  assert.deepEqual(o.minutes, { ran: 0, skipped: 10, other: 4, total: 14 });
  assert.equal(o.minutesSaved.thisMonth, 10);
  assert.equal(o.cost.githubEquivalentMinutes, 14);
  assert.equal(o.cost.githubEquivalentUsd, 0.11);
  assert.equal(o.timeToGreen.beforeMedianS, 400);
  assert.equal(o.runs.perDay.length, 30);
  assert.equal(o.openDefects, 1);
  assert.deepEqual(o.units, { used: 2, included: 2000 }, "two runs of 7 baseline minutes: 1.4 units, billed as 2");
  assert.equal(o.trial, null);
});

test("usage: per project, totals that add up, a CSV with one row per project", () => {
  const runs = [run("p1", "2026-11-03T10:00:00Z"), run("p1", "2026-11-04T10:00:00Z"), run("p2", "2026-11-04T10:00:00Z"), run("p2", "2026-10-04T10:00:00Z")];
  const events = runs.map((r) => event(r.projectId, r.finishedAt!, r.githubEquivalentMinutes));
  const u = usageFrom("2026-11", [project("p1"), project("p2")], runs, plans[1], RATE, events);
  assert.equal(u.runsUsed, 3);
  assert.equal(u.unitsIncluded, 2000);
  assert.deepEqual(u.rows.map((r) => r.runs), [2, 1]);
  assert.equal(u.totals.runs, 3);
  assert.equal(u.daily.series.length, 2);
  assert.equal(u.daily.series[0].values.reduce((a, b) => a + b, 0), 2);
  const csv = usageCsv(u).trim().split("\n");
  assert.equal(csv[0], "project,runs,units,test_minutes_ran,minutes_saved,other_step_minutes,github_equivalent_minutes,github_equivalent_usd");
  assert.equal(csv.length, 3);
  assert.equal(csv[1], "acme/p1,2,1.4,0,10,4,14,0.11");
  for (const r of [...u.rows, u.totals]) assert.equal(r.testMinutesRan + r.minutesSaved + r.otherStepMinutes, r.githubEquivalentMinutes);
  assert.equal(u.rows.reduce((a, r) => a + r.githubEquivalentUsd, 0).toFixed(2), u.totals.githubEquivalentUsd.toFixed(2));
});

test("run units: 10 baseline minutes each, the month rounded up to a whole unit", () => {
  assert.equal(MINUTES_PER_UNIT, 10);
  assert.equal(billedUnits([]), 0);
  assert.equal(billedUnits([event("p1", "2026-11-03T10:00:00Z", 10)]), 1);
  assert.equal(billedUnits([event("p1", "2026-11-03T10:00:00Z", 10.01)]), 2, "a part of a unit is billed as a whole unit");
  assert.equal(billedUnits([event("p1", "2026-11-03T10:00:00Z", 3), event("p1", "2026-11-04T10:00:00Z", 4)]), 1, "0.7 units round up to 1");
  // Floating point: 0.1 + 0.2 minutes-units must not become 0.30000000000000004 and bill a unit too many.
  assert.equal(billedUnits([event("p1", "2026-11-03T10:00:00Z", 1), event("p1", "2026-11-04T10:00:00Z", 2), event("p1", "2026-11-05T10:00:00Z", 27)]), 3);
  // Only billable events count.
  const u = usageFrom("2026-11", [project("p1")], [], plans[1], RATE, [event("p1", "2026-11-03T10:00:00Z", 15), event("p1", "2026-11-04T10:00:00Z", 500, false)]);
  assert.equal(u.unitsUsed, 2);
  assert.equal(u.runsUsed, 1);
});

test("usage rows add up, with a row for the jobs of repositories that are not set up as projects", () => {
  const runs = [run("p1", "2026-11-03T10:00:00Z"), run("p2", "2026-11-04T10:00:00Z")];
  const events = [event("p1", "2026-11-03T10:01:00Z", 7.33), event("p1", "2026-11-05T10:01:00Z", 6.66), event("p2", "2026-11-04T10:01:00Z", 9.99), event(null, "2026-11-06T10:00:00Z", 4.4), event("gone", "2026-11-07T10:00:00Z", 5.6)];
  const u = usageFrom("2026-11", [project("p1"), project("p2")], runs, null, RATE, events);
  const stray = u.rows.find((r) => r.projectId === "");
  assert.ok(stray, "no row for repositories that are not projects");
  assert.equal(stray.fullName, "Repositories not set up as projects");
  assert.equal(stray.runs, 2);
  assert.equal(stray.githubEquivalentMinutes, 10);
  assert.equal(stray.testMinutesRan + stray.minutesSaved + stray.otherStepMinutes, stray.githubEquivalentMinutes);
  // Every column adds up to its total, units included (rounded to one decimal with the largest-remainder rule).
  for (const k of ["runs", "units", "testMinutesRan", "minutesSaved", "otherStepMinutes", "githubEquivalentMinutes"] as const) {
    assert.equal(Math.round(u.rows.reduce((a, r) => a + r[k], 0) * 100), Math.round(u.totals[k] * 100), `the ${k} column does not add up`);
  }
  assert.equal(u.totals.units, 3.4);
  assert.equal(u.unitsUsed, 4, "3.398 units are billed as 4");
  assert.equal(u.unitsIncluded, null);
  assert.equal(u.plan, null);
});

test("plans: the cheapest that holds the projects and the units; none while the units are not set", () => {
  assert.equal(suggestPlan(plans, 1, 400)?.id, "starter");
  assert.equal(suggestPlan(plans, 2, 400)?.id, "team");
  assert.equal(suggestPlan(plans, 3, 5000)?.id, "scale");
  assert.equal(suggestPlan(plans, 30, 50000), null, "a plan whose units are not set is never suggested");
  assert.equal(suggestPlan(unsetPlans, 1, 1), null);
  const b = billingFrom(plans, [project("p1")], [event("p1", "2026-10-03T10:00:00Z", 100), event("p1", "2026-11-03T10:00:00Z", 25)], null, NOW);
  assert.equal(b.plan?.id, "team");
  assert.equal(b.runsUsed, 1);
  assert.equal(b.unitsUsed, 3);
  assert.equal(b.unitsIncluded, 2000);
  assert.equal(b.averageMonthlyUnits, 10);
  assert.equal(b.suggestedPlanId, "starter");
  assert.equal(b.trial, null);
  const unset = billingFrom(unsetPlans, [project("p1")], [event("p1", "2026-11-03T10:00:00Z", 25)], null, NOW);
  assert.equal(unset.suggestedPlanId, null, "no suggestion while the units are not set");
  assert.equal(unset.unitsIncluded, null);
  assert.equal(unset.plan?.priceUsdMonth, 479);
  assert.deepEqual(unset.addons.map((a) => a.id), ["nightly"]);
  assert.equal(unset.addons[0].priceUsdMonth, null);
});

test("the shadow trial: the would-have-skipped share against the 35% gate, days left, ended", () => {
  assert.equal(TRIAL_GATE, 0.35);
  const dates = { startedAt: "2026-10-30T00:00:00Z", endsAt: "2026-11-29T00:00:00Z" };
  assert.equal(trialFrom(null, [], [], NOW), null);
  const shadow = (at: string, wouldSaveMs: number, o: Partial<Run> = {}) => run("p1", at, { mode: "shadow", testTimeMs: { ran: 100_000, skipped: 0 }, wouldSaveMs, ...o });
  const empty = trialFrom(dates, [], [], NOW)!;
  assert.equal(empty.status, "active");
  assert.equal(empty.daysLeft, 12, "11.5 days left read as 12");
  assert.equal(empty.wouldSkipShare, null);
  assert.equal(empty.gate.met, false);
  // Time-weighted: (60 + 20) of 200 seconds = 40%, over the trial's finished shadow runs only.
  const runs = [
    shadow("2026-11-01T10:00:00Z", 60_000),
    shadow("2026-11-02T10:00:00Z", 20_000),
    shadow("2026-11-03T10:00:00Z", 90_000, { status: "running" }),
    shadow("2026-10-20T10:00:00Z", 90_000),
    run("p1", "2026-11-04T10:00:00Z"),
  ];
  const events = [event("p1", "2026-11-01T10:05:00Z", 12), event("p1", "2026-11-02T10:05:00Z", 13), event("p1", "2026-10-20T10:05:00Z", 99), event("p1", "2026-11-02T11:00:00Z", 50, false)];
  const met = trialFrom(dates, runs, events, NOW)!;
  assert.equal(met.runs, 2);
  assert.equal(met.wouldSkipShare, 0.4);
  assert.equal(met.wouldSaveMinutes, 1.3);
  assert.equal(met.units, 2.5);
  assert.deepEqual(met.gate, { threshold: 0.35, met: true });
  const below = trialFrom(dates, [shadow("2026-11-01T10:00:00Z", 30_000)], [], NOW)!;
  assert.equal(below.wouldSkipShare, 0.3);
  assert.equal(below.gate.met, false);
  const ended = trialFrom({ startedAt: "2026-09-01T00:00:00Z", endsAt: "2026-10-01T00:00:00Z" }, [shadow("2026-09-10T10:00:00Z", 50_000)], [], NOW)!;
  assert.equal(ended.status, "ended");
  assert.equal(ended.daysLeft, 0);
  assert.equal(ended.gate.met, true);
  // A run that reports more would-have-saved time than its own test time counts its test time at most: the share
  // stays within 0 to 1 (review R-016 F4).
  const inflated = trialFrom(dates, [shadow("2026-11-01T10:00:00Z", 1_000_000_000), shadow("2026-11-02T10:00:00Z", 0)], [], NOW)!;
  assert.equal(inflated.wouldSkipShare, 0.5);
  assert.equal(inflated.wouldSaveMinutes, round1(100_000 / 60_000));
  assert.ok(trialFrom(dates, [shadow("2026-11-01T10:00:00Z", 1e12)], [], NOW)!.wouldSkipShare! <= 1);
});
const round1 = (n: number) => Math.round(n * 10) / 10;

test("audit reruns: totals from the runs, the rule-of-three bound, no bound once a skip was wrong", () => {
  const from = new Date("2026-10-18T12:00:00Z");
  const rerun = (runId: string, at: string, o: Partial<AuditRerun> = {}): AuditRerun => ({ runId, runNumber: 1, testId: `t-${at}`, cacheKey: "k".repeat(32), outcome: "confirmed", untrusted: false, detail: "", at, ...o });
  const runs = [run("p1", "2026-11-01T10:00:00Z", { audit: { rerun: 1000, wrongSkips: 0 } }), run("p1", "2026-11-02T10:00:00Z", { audit: { rerun: 500, wrongSkips: 0 } }), run("p1", "2026-11-03T10:00:00Z"), run("p1", "2026-10-01T10:00:00Z", { audit: { rerun: 9, wrongSkips: 1 } })];
  const reruns = [
    rerun("r1", "2026-11-01T10:01:00Z", { untrusted: true, cacheKey: "a".repeat(32) }),
    rerun("r1", "2026-11-02T10:01:00Z", { untrusted: true, cacheKey: "a".repeat(32) }),
    rerun("r2", "2026-11-02T10:02:00Z", { untrusted: true, cacheKey: "b".repeat(32) }),
    rerun("r2", "2026-11-02T10:03:00Z"),
    rerun("old", "2026-10-01T10:01:00Z", { untrusted: true, cacheKey: "c".repeat(32) }),
  ];
  const a = auditFrom(runs, reruns, from, NOW);
  assert.equal(a.runs, 2);
  assert.equal(a.testsRerun, 1500);
  assert.equal(a.wrongSkips, 0);
  assert.equal(a.expectedWrongSkips, 0);
  assert.equal(a.ruleOfThreeBound, 0.002, "3 / 1,500: fewer than 1 in 500 skips is wrong, with 95% confidence");
  assert.deepEqual(a.untrustedKeys.map((k) => k.cacheKey), ["b".repeat(32), "a".repeat(32)], "each key once, newest first, within the window");
  assert.equal(a.recent.length, 4);
  assert.equal(a.recent[0].at, "2026-11-02T10:03:00Z");
  const wrong = auditFrom([...runs, run("p1", "2026-11-05T10:00:00Z", { audit: { rerun: 10, wrongSkips: 1 } })], [], from, NOW);
  assert.equal(wrong.wrongSkips, 1);
  assert.equal(wrong.ruleOfThreeBound, null, "a wrong skip: no bound");
  assert.equal(auditFrom([], [], from, NOW).ruleOfThreeBound, null, "nothing audited: no bound");
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
  // The runner's own command, when it sent one, with <bundle> pointing at where `fenvix defects pull` writes it.
  assert.equal(replayCommand(defect({ id: "dfx_9", replayCommand: "pytest --det --det-seed=3 --det-order=<bundle>/order.txt -n 0" })), "pytest --det --det-seed=3 --det-order=.fenvix/defects/dfx_9/order.txt -n 0");
  assert.equal(replayCommand(defect({ language: "node", testRunner: "vitest", replayCommand: "detjs vitest run --det --det-seed=5" })), "detjs vitest run --det --det-seed=5");
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
  assert.equal(r.mode, "enforce");
  assert.equal(r.progress, null, "a finished run has no progress");
  const live = mapRun({ id: "r", status: "running", mode: "shadow", region: "eu", would_skip_tests: "40", would_save_ms: "9000", audit_rerun: 3, progress: { phase: "testing", testsTotal: 100, testsDone: 40, passed: 39, failed: 1, skippedWithProof: 0, currentTest: "t", elapsedMs: 5000 }, progress_at: new Date("2026-11-17T12:00:00Z") });
  assert.equal(live.mode, "shadow");
  assert.equal(live.region, "eu");
  assert.equal(live.wouldSkipTests, 40);
  assert.equal(live.audit.rerun, 3);
  assert.deepEqual(live.progress, { phase: "testing", testsTotal: 100, testsDone: 40, passed: 39, failed: 1, skippedWithProof: 0, currentTest: "t", elapsedMs: 5000, updatedAt: "2026-11-17T12:00:00.000Z", workers: [] });
  assert.equal(mapProgress({ phase: "weird", testsTotal: null }, "2026-11-17T12:00:00Z").phase, "setup");
  const t = mapTestResult({ run_id: "r", test_id: "tests/a.py::test_x", outcome: "failed", failure_kind: "flaky_defect", defect_id: "d", failure_message: "boom" });
  assert.equal(t.file, "tests/a.py");
  assert.equal(t.failure?.kind, "flaky_defect");
  assert.equal(mapTestResult({ test_id: "x", outcome: "passed" }).failure, null);
  assert.equal(fileOfTest("packages/a/src/x.test.ts > suite > case"), "packages/a/src/x.test.ts");
  const d = mapDefect({ id: "d", project_id: "x", test_id: "t", status: "reproduced", cause: "state_setter", cause_tests: ["s"], minimal_order: ["t"], seed: "16", fingerprint: "f".repeat(32), replay_runs: 10, replay_fails: 10, exception: { type: "KeyError", phase: "call", message: "m", location: "l" }, language: "python" }, { fullName: "acme/api", testRunner: "pytest" });
  assert.equal(d.seed, 16);
  assert.equal(d.familyKey, "s");
  assert.equal(d.projectName, "acme/api");
  const pl = mapPlan({ id: "team", name: "Team", kind: "plan", units_included: null, max_projects: 5, price_usd_month: "479" }, "team");
  assert.equal(pl.priceUsdMonth, 479);
  assert.equal(pl.unitsIncluded, null);
  assert.equal(pl.current, true);
  assert.equal(mapPlan({ id: "nightly", kind: "addon" }, "team").kind, "addon");
  const rc = mapReceipt({ id: "c", run_id: "r", test_id: "t", cache_key: "k", reused_engine_run_id: "20261117T101502-4412", reused_duration_ms: 840, env_read: [{ name: "TZ", digest: "-" }], runtime: { interpreter: "python 3.12.7" } }, 12);
  assert.equal(rc.reusedRunNumber, 12);
  assert.deepEqual(rc.envRead, [{ name: "TZ", digest: "-" }]);
  assert.equal(rc.runtime.interpreter, "python 3.12.7");
  assert.deepEqual(rc.code, []);
  const ar = mapAuditRerun({ run_id: "r", run_number: "4", test_id: "t", cache_key: "k", outcome: "wrong_skip", untrusted: true, detail: "d", at: new Date("2026-11-01T00:00:00Z") });
  assert.deepEqual(ar, { runId: "r", runNumber: 4, testId: "t", cacheKey: "k", outcome: "wrong_skip", untrusted: true, detail: "d", at: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(mapUsageEvent({ project_id: null, occurred_at: "2026-11-01T00:00:00Z", billable: true, baseline_minutes: "6.5" }), { projectId: null, occurredAt: "2026-11-01T00:00:00Z", billable: true, baselineMinutes: 6.5 });
  assert.equal(mapInstallation({ installation_id: "7", account_login: "acme", account_type: "Organization", suspended_at: "2026-11-01", repositories: 3 }).status, "suspended");
  assert.equal(mapInstallation({ installation_id: "7", deleted_at: "2026-11-01", suspended_at: "2026-11-01" }).status, "deleted");
  const gr = mapGitHubRepository({ repository_id: "9", installation_id: "7", full_name: "acme/api", onboarding_state: "closed", setup_pr_number: 3, setup_pr_url: "u", detected_language: "ruby", detected_test_runner: "rspec" });
  assert.equal(gr.onboardingState, "closed");
  assert.equal(gr.setupPullRequest?.state, "closed");
  assert.equal(gr.language, null, "a language fenvix does not know is not detected");
  assert.equal(gr.testRunner, null);
  assert.equal(mapGitHubRepository({ onboarding_state: "nonsense" }).onboardingState, "pending");
});

test("errors read as sentences", () => {
  assert.match(friendlyError({ message: "TypeError: Failed to fetch" }), /Could not reach the server/);
  assert.match(friendlyError({ message: "JWT expired" }), /session has ended/);
  assert.match(friendlyError({ code: "42501", message: "permission denied for table ci_runs" }), /read only/);
});
