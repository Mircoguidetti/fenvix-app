// Console proof follow-ups (docs/REPORT-proof-to-customer.md): A1.1 no summary with per-test rows, A1.3 ranExecuted on
// warm runs, A1.5 malformed counts, A2 the honest words, the not-proven causes list and the two engine signals.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkRunOutput, conclusionOf, prComment, title, type RenderContext } from "../../src/results/render.ts";
import { runStatus } from "../../src/results/status.ts";
import { NOT_PROVEN_REASONS as R, parseSummary, skippedRanOf, trimSummary } from "../../src/results/summary.ts";
import { describeWork, parseWork } from "../../src/work.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

const ctx: RenderContext = {
  repository: "acme/shop", headSha: "4bec63ba31437dbe83826d4643ae63b6ad03fead", workflowName: "CI", jobName: "test",
  jobUrl: "https://github.com/acme/shop/actions/runs/1/job/2", receiptsUrl: null, dashboardRunUrl: null, jobConclusion: "success",
};
const base = { tests: 10, reused_with_proof: 0, ran: 10, exit: 0, failed: [], flaky: [], outcome_counts: { passed: 10 } };
const proof = (proven: number, notProven: number, causes: { cause: string; tests: number }[] = []) => ({
  workers: 2, proven, not_proven: notProven, rerun_one_lane: 0, parallel_seconds: 1, serial_seconds_estimate: 2, order_digest: null, not_proven_causes: causes,
});

describe("A1.1 no summary with per-test not_proven rows", () => {
  // protects=a job without a summary but with not_proven rows is never green (status and check run); fails_when=passed
  // or neutral; no_claim=the run row in Postgres (tests/integration/results.test.ts A1.1).
  it("runStatus and conclusionOf count the rows when the summary is null; a cancelled or failed job keeps its status", () => {
    assert.equal(runStatus("success", null, { notProvenRows: 2 }), "not_proven");
    assert.equal(runStatus("success", null, { notProvenRows: 0 }), "passed");
    assert.equal(runStatus("failure", null, { notProvenRows: 2 }), "failed");
    assert.equal(runStatus("cancelled", null, { notProvenRows: 2 }), "cancelled");
    assert.equal(conclusionOf(null, "success", false, 2), "failure");
    assert.equal(conclusionOf(null, "success", false, 0), "neutral");
    assert.equal(conclusionOf(null, "cancelled", false, 2), "cancelled");
    assert.equal(title(null, "failure", false, 2), "Not proven: 2 not proven, no fenvix summary");
    assert.match(checkRunOutput(null, { ...ctx, notProvenRows: 2 }).summary, /2 test\(s\) not proven: the run is not proven/);
    assert.match(prComment(null, { ...ctx, notProvenRows: 2 }), /❌/);
  });
});

describe("A1.2 the summary_rejected work item", () => {
  // protects=a rejection crosses the queue intact, its reason bounded to 500 characters; fails_when=parseWork refuses it
  // or keeps a longer reason; no_claim=the upsert rules (integration A1.2).
  it("parseWork reads it back and cuts the reason to 500 characters", () => {
    const w = parseWork({ kind: "summary_rejected", repositoryId: 1, runId: 2, runAttempt: 1, runnerName: "m", reason: "x".repeat(600) });
    assert.equal(w.kind, "summary_rejected");
    assert.equal((w as { reason: string }).reason.length, 500);
    assert.equal(describeWork(w), "summary_rejected 1/2/1");
    assert.throws(() => parseWork({ kind: "summary_rejected", repositoryId: 1, runId: 2, runAttempt: 1, runnerName: "m" }), /not a work message/);
  });
});

describe("A1.3 ranExecuted on warm runs (skipped_ran)", () => {
  // A warm run: 3 tests reused (one skipped), 2 ran (one skipped). outcome_counts counts both skipped tests.
  const warm = {
    tests: 5, reused_with_proof: 3, ran: 2, exit: 0, failed: [], flaky: [], outcome_counts: { passed: 3, skipped: 2 },
    outcomes: { "a::1": "passed", "a::2": "passed", "a::3": "skipped", "b::1": "passed", "b::2": "skipped" },
    reused_outcomes: { "a::1": "passed", "a::2": "passed", "a::3": "skipped" },
    proof: proof(1, 0),
  };
  // protects=reused skipped tests are not subtracted from the tests that ran; fails_when=a warm run whose proof covers
  // exactly the executed tests is reported not proven; no_claim=the runner's own proven count (Part B).
  it("trimSummary writes skipped_ran (skipped or todo in outcomes minus in reused_outcomes); parseSummary uses it", () => {
    const stored = trimSummary(warm);
    assert.equal(stored.skipped_ran, 1);
    assert.equal(stored.outcomes, undefined, "the per-test maps are still dropped");
    const sum = parseSummary(stored);
    assert.equal(sum.ranExecuted, 1);
    assert.deepEqual([sum.notProven, runStatus("success", sum)], [0, "passed"]);
    // Without skipped_ran (a row stored before this change): the older rule, 2 − 2 = 0, and the proof of 1 is above it.
    const old = parseSummary(warm);
    assert.equal(old.ranExecuted, 0);
    assert.deepEqual([old.notProven, old.notProvenReason], [1, R.proofShort]);
  });
  it("todo counts like skipped; outcomes not a map: null (older rule); a malformed skipped_ran falls back to the older rule", () => {
    assert.equal(skippedRanOf({ outcomes: { a: "todo", b: "skipped", c: "passed" }, reused_outcomes: { b: "skipped" } }), 1);
    assert.equal(skippedRanOf({ outcomes: [] }), null);
    assert.equal(skippedRanOf({}), null);
    for (const bad of [-1, 1.5, "1"]) assert.equal(parseSummary({ ...warm, skipped_ran: bad }).ranExecuted, 0, String(bad));
  });
  // protects=a proof claiming more tests than ran is not proven with its own reason; fails_when=N is 0 (the old
  // raise(ranExecuted − proven) is negative there); no_claim=which tests are wrong.
  it("a proof with proven + not_proven above ranExecuted: N = max(1, the other sources), reason 'the proof does not match the tests that ran'", () => {
    const over = parseSummary({ ...base, proof: proof(12, 0) });
    assert.deepEqual([over.notProven, over.notProvenReason], [1, "the proof does not match the tests that ran"]);
    assert.equal(runStatus("success", over), "not_proven");
    const overWithOthers = parseSummary({ ...base, not_proven: 3, proof: proof(9, 3, [{ cause: "c", tests: 3 }]) });
    assert.deepEqual([overWithOthers.notProven, overWithOthers.notProvenReason], [3, R.proofShort]);
    assert.equal(parseSummary({ ...base, proof: proof(10, 0) }).notProven, 0);
  });
});

describe("A1.5 malformed counts", () => {
  // protects=a count that is present but not a whole number of 0 or more is never read as 0; fails_when=such a summary
  // is green or N is not exactly 1; no_claim=which value the runner meant.
  it("top-level not_proven and each verify_counts value: absent or null = 0; malformed = exactly N 1, countsUnreadable", () => {
    for (const ok of [undefined, null, 0]) {
      assert.equal(parseSummary({ ...base, not_proven: ok }).notProven, 0, String(ok));
      assert.equal(parseSummary({ ...base, verify_counts: { not_proven: ok, diverged: ok } }).notProven, 0, String(ok));
    }
    for (const bad of [-1, 1.5, "2", true, {}]) {
      const top = parseSummary({ ...base, not_proven: bad });
      assert.deepEqual([top.notProven, top.notProvenReason], [1, R.countsUnreadable], `not_proven ${JSON.stringify(bad)}`);
      for (const k of ["tests", "identical", "not_proven", "diverged", "missing", "input_differs", "wrong_reuse"]) {
        const v = parseSummary({ ...base, verify_counts: { [k]: bad } });
        assert.deepEqual([v.notProven, v.notProvenReason], [1, R.countsUnreadable], `verify_counts.${k} ${JSON.stringify(bad)}`);
        assert.equal(runStatus("success", v), "not_proven");
      }
    }
    for (const bad of ["x", [], 3]) assert.deepEqual([parseSummary({ ...base, verify_counts: bad }).notProven], [1], `verify_counts ${JSON.stringify(bad)}`);
    // With another source: the larger one, exactly (2 diverged, a malformed missing).
    assert.equal(parseSummary({ ...base, verify_counts: { diverged: 2, missing: "x" } }).notProven, 2);
  });
  // protects=a verify_exit that is not a number fails closed; fails_when=it is read as success; no_claim=verify's own run.
  it("a non-numeric verify_exit: N 1, 'the comparison of two runs failed'", () => {
    const sum = parseSummary({ ...base, verify_status: "identical", verify_exit: "1" });
    assert.deepEqual([sum.notProven, sum.notProvenReason], [1, "the comparison of two runs failed"]);
  });
});

describe("A2 the two engine signals (provable_absent, not_proven_outside)", () => {
  // protects=a run the engine itself calls uncertain is never green, parallel or serial; fails_when=N 0 or another
  // reason when no other source fires; no_claim=which uncontrolled read happened (the runner logs it).
  it("provable_absent non-empty (other sources 0): N = 1, 'the run could not watch what tests touched'", () => {
    for (const raw of [{ ...base, provable_absent: "no fs hooks" }, { ...base, provable_absent: "no fs hooks", proof: proof(10, 0) }]) {
      const sum = parseSummary(raw);
      assert.deepEqual([sum.notProven, sum.notProvenReason], [1, "the run could not watch what tests touched"]);
      assert.equal(runStatus("success", sum), "not_proven");
      assert.equal(conclusionOf(sum, "success"), "failure");
    }
  });
  it("not_proven_outside 3 (other sources 0): N = 1 (it counts reads, not tests), 'something not controlled ran outside the tests'", () => {
    const sum = parseSummary({ ...base, not_proven_outside: 3 });
    assert.deepEqual([sum.notProven, sum.notProvenReason], [1, "something not controlled ran outside the tests"]);
  });
  it("absent, null, an empty provable_absent and not_proven_outside 0: no signal (Python summaries send neither)", () => {
    for (const extra of [{}, { provable_absent: null, not_proven_outside: null }, { provable_absent: "", not_proven_outside: 0 }]) {
      assert.equal(parseSummary({ ...base, ...extra }).notProven, 0, JSON.stringify(extra));
    }
  });
  it("malformed: not_proven_outside not a whole number of 0 or more, provable_absent neither a string nor null: N 1, countsUnreadable", () => {
    for (const extra of [{ not_proven_outside: -1 }, { not_proven_outside: 1.5 }, { not_proven_outside: "3" }, { provable_absent: 5 }, { provable_absent: {} }]) {
      const sum = parseSummary({ ...base, ...extra });
      assert.deepEqual([sum.notProven, sum.notProvenReason], [1, R.countsUnreadable], JSON.stringify(extra));
    }
  });
  it("a signal's reason is kept even when the proof's causes cover N (no test cause explains it)", () => {
    const sum = parseSummary({ ...base, not_proven_outside: 1, proof: proof(8, 2, [{ cause: "b.test.js: the one-lane re-run ran 0 of its 2 test(s)", tests: 2 }]) });
    assert.deepEqual([sum.notProven, sum.notProvenReason], [2, R.notProvenOutside]);
  });
});

describe("A2 the check run's proof rows and causes list", () => {
  const causes = Array.from({ length: 12 }, (_, i) => ({ cause: `f${i}.test.js: the one-lane re-run ran 0 of its 1 test(s)`, tests: 1 }));
  // protects=the customer reads what the engine proves, and why tests are not proven; fails_when=the old "identical to
  // the serial run" words, a missing row, more than 10 causes listed; no_claim=the console's own card.
  it("with a proof: 'Proven: no conflict between lanes | proven of ranExecuted' and 'Not proven | N'; causes listed, at most 10, then 'and K more'", () => {
    const sum = parseSummary({ ...base, ran: 20, tests: 20, outcome_counts: { passed: 20 }, proof: proof(8, 12, causes) });
    for (const out of [checkRunOutput(sum, ctx).summary, prComment(sum, ctx)]) {
      assert.match(out, /\| Proven: no conflict between lanes \| 8 of 20 \|/);
      assert.match(out, /\| Not proven \| 12 \|/);
      assert.match(out, /### Not proven\n\n- f0\.test\.js: the one-lane re-run ran 0 of its 1 test\(s\): 1 test\(s\)\n/);
      assert.match(out, /- f9\.test\.js[^\n]*\n- and 2 more/);
      assert.doesNotMatch(out, /f10\.test\.js/);
      assert.doesNotMatch(out, /serial run|identical/);
    }
  });
  it("every test proven: both rows, Not proven 0, no causes heading", () => {
    const out = checkRunOutput(parseSummary({ ...base, proof: proof(10, 0) }), ctx).summary;
    assert.match(out, /\| Proven: no conflict between lanes \| 10 of 10 \|/);
    assert.match(out, /\| Not proven \| 0 \|/);
    assert.doesNotMatch(out, /### Not proven/);
  });
  it("no proof (serial) with N > 0: the Not proven row only, no Proven row, no heading; a proof without causes: no heading", () => {
    const serial = checkRunOutput(parseSummary({ ...base, not_proven: 2 }), ctx).summary;
    assert.match(serial, /\| Not proven \| 2 \|/);
    assert.doesNotMatch(serial, /Proven: no conflict|### Not proven/);
    const noCause = checkRunOutput(parseSummary({ ...base, proof: proof(8, 2) }), ctx).summary;
    assert.match(noCause, /\| Not proven \| 2 \|/);
    assert.doesNotMatch(noCause, /### Not proven/);
    assert.doesNotMatch(checkRunOutput(parseSummary(base), ctx).summary, /Not proven|Proven:/);
  });
  it("the real Node vitest fixture (warm, serial) keeps N 0 after trimSummary (skipped_ran 0)", () => {
    const stored = trimSummary(fixture("node-vitest-warm"));
    assert.equal(stored.skipped_ran, 0);
    assert.equal(parseSummary(stored).notProven, 0);
  });
});

describe("the runner's real proof summaries (tests/fixtures/runner/node-vitest-parallel-*)", () => {
  // protects=the App reads what the patched runner really sends: proof not null, the warm run passed (A1.3's
  // skipped_ran), the hazard run passed with its one-lane re-run, the edited one not proven with exact N;
  // fails_when=a real summary is refused, loses its proof, or is not proven for a field mismatch; no_claim=other
  // runners or versions.
  it("parseSummary accepts them with proof; proof, warm and hazard parse to passed; the edited one to not_proven, N 2", () => {
    const read = (f: string) => parseSummary(trimSummary(fixture(f)));
    for (const f of ["node-vitest-parallel-proof", "node-vitest-parallel-warm", "node-vitest-parallel-hazard"]) {
      const sum = read(f);
      assert.notEqual(sum.proof, null, f);
      assert.equal(sum.proof!.workers, 2, f);
      assert.deepEqual([sum.notProven, runStatus("success", sum)], [0, "passed"], f);
      assert.equal(sum.proof!.proven + sum.proof!.notProven, sum.ranExecuted, f);
    }
    const warm = read("node-vitest-parallel-warm");
    assert.ok(warm.reusedWithProof > 0 && warm.ranExecuted === 1, `warm: reused ${warm.reusedWithProof}, ranExecuted ${warm.ranExecuted}`);
    assert.ok(read("node-vitest-parallel-hazard").proof!.rerunOneLane > 0);
    const np = read("node-vitest-parallel-notproven");
    assert.deepEqual([np.notProven, np.notProvenReason, runStatus("failure", np), conclusionOf(np, "failure")], [2, null, "not_proven", "failure"]);
  });
});
