// Parallel with proof and NOT PROVEN in the dashboard's pure logic (src/data/ci.ts, src/data/ci-rows.ts): a run not
// proven is finished, never green, never "failed"; the Overview's proof block; the search; time to green per day.
import test from "node:test";
import assert from "node:assert/strict";
import { activityFrom, finished, isNotProven, medianTimeToGreen, NO_CAUSE_LABEL, notProvenCausesOf, notProvenSentence, overviewFrom, parallelProofFrom, projectRow, searchFrom, timeToGreenPerDay } from "../../src/data/ci.ts";
import { compatOverview, compatRun, compatTests, withCompat } from "../../src/data/compat.ts";
import { ApiError } from "../../src/data/api-errors.ts";
import type { DataClient } from "../../src/data/client.ts";
import { mapRun, mapTestResult } from "../../src/data/ci-rows.ts";
import type { Defect, GitHubRate, Overview, Project, Run, RunProof, TestPage } from "../../src/data/types.ts";

const RATE: GitHubRate = { usdPerMinute: 0.008, runner: "x", source: "test", checkedOn: "2026-11-16" };
const NOW = new Date("2026-11-17T12:00:00Z");
const project: Project = {
  id: "p1", fullName: "acme/homehub", language: "python", testRunner: "pytest", defaultBranch: "main", installationId: 1, repositoryId: null, setupState: "active", setupPullRequest: null,
  connectedAt: "2026-09-01T00:00:00Z", baseline: null, settings: { skipWithProof: true, commentOnPullRequests: true, nightlyExploration: false, testCommand: "" },
  warmCache: { state: "cold", commitSha: null, warmAt: null, source: null, warmup: null },
};

let n = 4290;
function run(startedAt: string, o: Partial<Run> = {}, tests: Partial<Run["tests"]> = {}): Run {
  n++;
  return {
    id: `r${n}`, projectId: "p1", number: n, engineRunId: null, commitSha: String(n).padEnd(40, "a"), commitMessage: "", branch: "main", pullRequest: null, trigger: "push",
    status: "passed", pushedAt: new Date(new Date(startedAt).getTime() - 10_000).toISOString(), startedAt, finishedAt: new Date(new Date(startedAt).getTime() + 60_000).toISOString(), durationMs: 60_000,
    tests: { total: 400, ran: 374, passed: 374, failed: 0, skippedWithProof: 26, flakyDefects: 0, notProven: 0, ...tests }, testTimeMs: { ran: 50_000, skipped: 5_000 }, skipShare: 0.09, minutesSaved: 0.08,
    otherStepMinutes: 1, githubEquivalentMinutes: 2, engineVersion: "0.1.0", seed: null, skipMisses: {}, missDetails: [], mode: "enforce", wouldSkipTests: 0, wouldSaveMs: 0,
    audit: { rerun: 0, wrongSkips: 0 }, region: "us", progress: null, proof: null, exitCode: 0, ...o,
  };
}
const proof = (notProven: number, causes: RunProof["notProvenCauses"] = [], o: Partial<RunProof> = {}): RunProof => ({
  workers: 4, proven: 374 - notProven, notProven, rerunOneLane: notProven, parallelMs: 39_200, serialMsEstimate: 151_000, orderDigest: "7c1e", notProvenCauses: causes, ...o,
});

// Skip shares 0.1 (proven), 0.9 and 0.8 (the two not proven), 0.2 (serial), 0.3 (failed): the median of the five is
// 0.3; without the not-proven runs it would be 0.2.
const proven = run("2026-11-10T10:00:00Z", { proof: proof(0), skipShare: 0.1 });
const notProvenWithCause = run("2026-11-12T10:00:00Z", { status: "not_proven", exitCode: 1, skipShare: 0.9, proof: proof(14, [{ cause: "file read outside the project", tests: 14 }]) }, { notProven: 14, passed: 360 });
const notProvenNoProof = run("2026-11-14T10:00:00Z", { status: "not_proven", exitCode: 1, skipShare: 0.8 }, { notProven: 2, passed: 372 });
const serial = run("2026-11-15T10:00:00Z", { skipShare: 0.2 });
const failed = run("2026-11-16T10:00:00Z", { status: "failed", exitCode: 1, skipShare: 0.3 }, { failed: 1, passed: 373 });
const all = [failed, serial, notProvenNoProof, notProvenWithCause, proven];

test("a run not proven is finished, never green: not counted by time to green, counted per day, its own activity kind", () => {
  assert.equal(finished(notProvenWithCause), true);
  assert.equal(finished(run("2026-11-17T11:00:00Z", { status: "running" })), false);
  // Time to green: only passed runs (2 of the 5: proven and serial).
  assert.equal(medianTimeToGreen(all, new Date("2026-11-01T00:00:00Z"), NOW).commits, 2);
  const o = overviewFrom([project], all, [], null, RATE, NOW);
  assert.equal(o.runs.thisMonth, 5);
  assert.equal(o.runs.perDay.reduce((a, p) => a + p.value, 0), 5, "not proven runs are in the runs per day");
  // The median share skipped counts finished runs, the not-proven ones included (0.2 without them).
  assert.equal(o.skipShare.median, 0.3);
  assert.equal(o.skipShare.perDay.find((p) => p.at.startsWith("2026-11-12"))!.value, 0.9);
  const act = activityFrom([project], all, [], [], 10);
  const np = act.filter((a) => a.kind === "run_not_proven");
  assert.deepEqual(np.map((a) => a.title).sort(), [`Run #${notProvenNoProof.number} not proven`, `Run #${notProvenWithCause.number} not proven`].sort());
  assert.ok(np.every((a) => !/failed|green/.test(a.title)));
  assert.match(np.find((a) => a.title.includes(String(notProvenNoProof.number)))!.detail, /^2 not proven/);
});

test("the Overview's proof block: runs with lanes, those all proven, every run not proven this month", () => {
  assert.deepEqual(overviewFrom([project], all, [], null, RATE, NOW).proof, { runsWithProof: 2, provenIdentical: 1, notProven: 2 });
  assert.deepEqual(overviewFrom([project], [serial], [], null, RATE, NOW).proof, { runsWithProof: 0, provenIdentical: 0, notProven: 0 });
  // A cancelled run with a proof block is not finished: not counted.
  const cancelled = run("2026-11-13T10:00:00Z", { status: "cancelled", proof: proof(0) });
  assert.deepEqual(overviewFrom([project], [...all, cancelled], [], null, RATE, NOW).proof, { runsWithProof: 2, provenIdentical: 1, notProven: 2 });
});

test("a project row carries the last run's not-proven count for its pill", () => {
  const row = projectRow(project, [notProvenNoProof, serial], [], NOW);
  assert.equal(row.lastRunStatus, "passed");
  assert.equal(projectRow(project, [notProvenNoProof], [], NOW).lastRunNotProven, 2);
});

test("causes: the runner's, and what it did not explain as 'The runner did not report why'", () => {
  assert.deepEqual(notProvenCausesOf(notProvenWithCause), [{ cause: "file read outside the project", tests: 14 }]);
  assert.deepEqual(notProvenCausesOf(notProvenNoProof), [{ cause: NO_CAUSE_LABEL, tests: 2 }]);
  assert.deepEqual(notProvenCausesOf(proven), []);
  const p = parallelProofFrom(all, NOW);
  assert.equal(p.withProof.length, 2);
  assert.deepEqual(p.notProven.map((r) => r.id), [notProvenNoProof.id, notProvenWithCause.id]);
  assert.deepEqual(p.causes, [{ cause: "file read outside the project", tests: 14, runs: 1 }, { cause: NO_CAUSE_LABEL, tests: 2, runs: 1 }]);
  assert.deepEqual(p.proven.map((x) => Math.round(x.value * 1000) / 1000), [1, Math.round((360 / 374) * 1000) / 1000]);
  assert.deepEqual(p.speed[0], { at: "2026-11-10T00:00:00.000Z", parallelMs: 39_200, serialMs: 151_000 });
});

test("time to green per day: one median per day, at most 30 points", () => {
  const many: Run[] = [];
  for (let d = 0; d < 45; d++) for (let k = 0; k < 9; k++) many.push(run(new Date(NOW.getTime() - d * 86_400_000 - k * 600_000 - 3_600_000).toISOString()));
  const per = timeToGreenPerDay(many);
  assert.equal(per.length, 30);
  assert.ok(per.every((p) => p.commits === 9 && p.value === 70));
  assert.ok(per[0].at < per[29].at);
});

test("search: runs by number (with #) or commit prefix, open defects by test name; each names its project", () => {
  const other: Project = { ...project, id: "p2", fullName: "acme/docs" };
  const twin = { ...notProvenWithCause, id: "twin", projectId: "p2", branch: "feat/x" };
  const d = { id: "d1", projectId: "p1", testId: "tests/test_mqtt.py::test_discovery_update", state: "open", lastSeenAt: "2026-11-10T00:00:00Z" } as Defect;
  const fixed = { ...d, id: "d2", state: "fixed" } as Defect;
  const byNumber = searchFrom([project, other], all.concat(twin), [d, fixed], `#${notProvenWithCause.number}`);
  assert.deepEqual(byNumber.map((r) => [r.kind, r.label, r.sublabel]).sort(), [["run", `Run #${notProvenWithCause.number}`, "docs · feat/x"], ["run", `Run #${notProvenWithCause.number}`, "homehub · main"]]);
  assert.deepEqual(searchFrom([project], all, [], serial.commitSha.slice(0, 8)).map((r) => r.id), [serial.id]);
  assert.deepEqual(searchFrom([project], all, [d, fixed], "DISCOVERY").map((r) => [r.kind, r.id, r.label, r.sublabel]), [["defect", "d1", "test_discovery_update", "homehub"]]);
  assert.deepEqual(searchFrom([project], all, [d], "nothing like this"), []);
  const many = Array.from({ length: 30 }, (_, i) => run(new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString(), { number: 77 }));
  const capped = searchFrom([project], many, [], "77");
  assert.equal(capped.length, 20);
  assert.deepEqual(capped.map((r) => r.id), [...many].reverse().slice(0, 20).map((r) => r.id), "newest first");
  assert.deepEqual(searchFrom([project], all, [d], "d"), [], "one character finds nothing");
  // A run number of one digit is still a search.
  const six = run("2026-11-11T09:00:00Z", { number: 6 });
  assert.deepEqual(searchFrom([project], [six], [], "6").map((r) => r.id), [six.id]);
  assert.deepEqual(searchFrom([project], [six], [], "#6").map((r) => r.id), [six.id]);
});

test("rows: proof and exit code only once finished; a test's cause only when it is not proven", () => {
  const row = { id: "x", project_id: "p1", status: "not_proven", tests_not_proven: 3, exit_code: 1, proof: { workers: 4, proven: 10, notProven: 3, rerunOneLane: 3, parallelMs: 900, serialMsEstimate: null, orderDigest: "ab", notProvenCauses: [{ cause: "c", tests: 3 }] } };
  const r = mapRun(row);
  assert.equal(r.tests.notProven, 3);
  assert.equal(r.exitCode, 1);
  // A row stored before ranExecuted existed: null (the card then uses the run's ran).
  assert.deepEqual(r.proof, { workers: 4, proven: 10, notProven: 3, ranExecuted: null, rerunOneLane: 3, parallelMs: 900, serialMsEstimate: null, orderDigest: "ab", notProvenCauses: [{ cause: "c", tests: 3 }] });
  const running = mapRun({ ...row, status: "running" });
  assert.equal(running.proof, null);
  assert.equal(running.exitCode, null);
  assert.equal(mapRun({ id: "y", status: "passed" }).proof, null);
  assert.equal(mapTestResult({ run_id: "x", test_id: "t", outcome: "not_proven", not_proven_cause: "file read outside the project" }).notProvenCause, "file read outside the project");
  assert.equal(mapTestResult({ run_id: "x", test_id: "t", outcome: "passed", not_proven_cause: "x" }).notProvenCause, null);
});

test("the sentence about tests not proven: both causes, an unknown one, none, one test, exit 0 and 1", () => {
  const r = (n: number, exitCode: number | null) => ({ exitCode, tests: { ...notProvenNoProof.tests, notProven: n } });
  assert.equal(notProvenSentence(r(14, 1), { notProvenCauses: [{ cause: "file read outside the project", tests: 14 }] }),
    "14 tests read a file outside the project, so the parallel result could not be proven equal to the serial one. Their serial result is reported; the run exits 1.");
  assert.equal(notProvenSentence(r(3, 0), { notProvenCauses: [{ cause: "environment variable read outside any test", tests: 3 }] }),
    "3 tests read an environment variable outside any test, so the parallel result could not be proven equal to the serial one. Their serial result is reported; the check on GitHub is marked failed.");
  assert.equal(notProvenSentence(r(5, 0), { notProvenCauses: [{ cause: "a socket", tests: 1 }, { cause: "file read outside the project", tests: 4 }] }),
    "4 tests read a file outside the project, so the parallel result could not be proven equal to the serial one. Their serial result is reported; the check on GitHub is marked failed.", "the largest cause");
  assert.equal(notProvenSentence(r(1, 2), { notProvenCauses: [{ cause: "a socket", tests: 1 }] }),
    "1 test was not proven (a socket), so the parallel result could not be proven equal to the serial one. Their serial result is reported; the run exits 2.");
  assert.equal(notProvenSentence(r(2, 1), null), "2 tests were not proven identical. The runner did not report why. Their serial result is reported; the run exits 1.");
  assert.equal(notProvenSentence(r(1, null), { notProvenCauses: [] }), "1 test was not proven identical. The runner did not report why. Their serial result is reported; the check on GitHub is marked failed.");
});

test("an API one release older: the missing fields read as nothing to show, never green, never an error", async () => {
  const { proof: _p, exitCode: _e, ...bare } = proven;
  const { notProven: _n, ...tests } = proven.tests;
  const old = { ...bare, tests } as unknown as Run;
  const r = compatRun(old);
  assert.deepEqual([r.proof, r.exitCode, r.tests.notProven], [null, null, 0]);
  const o = compatOverview({ ...overviewFrom([project], all, [], null, RATE, NOW), proof: undefined } as unknown as Overview);
  assert.deepEqual(o.proof, { runsWithProof: 0, provenIdentical: 0, notProven: 0 });
  const t = compatTests({ items: [{ runId: "x", testId: "t", file: "t", outcome: "passed", durationMs: 1, failure: null, receiptId: null }], total: 1, page: 1, pageSize: 50, counts: { passed: 1, failed: 0, skipped_with_proof: 0 } } as unknown as TestPage);
  assert.equal(t.counts.not_proven, 0);
  // A search on an API without GET /search: no results.
  const c = withCompat({ search: () => Promise.reject(new ApiError("not_found", "Not found", 404)) } as unknown as DataClient);
  assert.deepEqual(await c.search("4299"), []);
  const broken = withCompat({ search: () => Promise.reject(new ApiError("internal", "boom", 500)) } as unknown as DataClient);
  await assert.rejects(broken.search("4299"));
});

test("Proven over time: (ran − N) / ran per run, N never less than the proof's; 0 when nothing is proven; runs that ran nothing left out", () => {
  const day = "2026-11-11T10:00:00Z";
  const a = run(day, { proof: proof(0, [], { proven: 100, ranExecuted: 100 }) }, { ran: 100, notProven: 5 });
  assert.deepEqual(parallelProofFrom([a], NOW).proven.map((p) => p.value), [0.95]);
  const none = run(day, { proof: proof(0, [], { proven: 0, notProven: 10, ranExecuted: 10 }) }, { ran: 10, notProven: 10 });
  assert.deepEqual(parallelProofFrom([none], NOW).proven.map((p) => p.value), [0]);
  const empty = run(day, { proof: proof(0, [], { proven: 0, notProven: 0, ranExecuted: 0 }) }, { ran: 0 });
  assert.deepEqual(parallelProofFrom([empty], NOW).proven, []);
});

test("one predicate for a not-proven run: its status, or tests not proven (the Overview and Parallel with proof agree)", () => {
  const flagged = run("2026-11-12T11:00:00Z", { status: "failed", exitCode: 1 }, { failed: 1, notProven: 3 });
  assert.equal(isNotProven(flagged), true);
  assert.equal(isNotProven(notProvenNoProof), true);
  assert.equal(isNotProven(serial), false);
  const runs = [...all, flagged];
  assert.equal(overviewFrom([project], runs, [], null, RATE, NOW).proof.notProven, 3);
  assert.equal(parallelProofFrom(runs, NOW).notProven.length, 3);
});

test("the sentence for a run's own reason, and for inputs that differ (no count of tests)", () => {
  const r = (n: number, notProvenReason: string | null, exitCode: number | null = 1) => ({ exitCode, notProvenReason, tests: { ...notProvenNoProof.tests, notProven: n } });
  assert.equal(notProvenSentence(r(1, "the runner's summary could not be read", null), null),
    "1 test was not proven identical: the runner's summary could not be read. Their serial result is reported; the check on GitHub is marked failed.");
  assert.equal(notProvenSentence(r(1, "exit code missing", null), null), "1 test was not proven identical: exit code missing. Their serial result is reported; the check on GitHub is marked failed.");
  const inputs = notProvenSentence(r(1, "inputs differ"), null);
  assert.equal(inputs, "The parallel and serial runs could not be compared: their inputs differ. The run is not proven; the check on GitHub is marked failed.");
  assert.doesNotMatch(inputs, /1 test/);
  // A run's reason names the part of N no proof cause explains.
  assert.deepEqual(notProvenCausesOf({ ...notProvenNoProof, notProvenReason: "exit code missing" }), [{ cause: "exit code missing", tests: 2 }]);
});

test("an older API refuses the not_proven filters (400): an empty page, never an error; other errors still throw", async () => {
  const refuse = () => Promise.reject(new ApiError("validation_failed", "status must be one of all, passed, failed", 400, "status"));
  const c = withCompat({ listRuns: refuse, listTestResults: refuse } as unknown as DataClient);
  assert.deepEqual(await c.listRuns("p1", { status: "not_proven" }), { items: [], total: 0, page: 1, pageSize: 25 });
  const t = await c.listTestResults("r1", { outcome: "not_proven" });
  assert.deepEqual([t.items, t.total, t.counts.not_proven], [[], 0, 0]);
  await assert.rejects(c.listRuns("p1", { status: "failed" }), "a 400 on another filter is still an error");
});
