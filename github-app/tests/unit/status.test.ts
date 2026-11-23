import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { testRow } from "../../src/results/apply.ts";
import { checkRunOutput, conclusionOf, prComment, title, type RenderContext } from "../../src/results/render.ts";
import { parseResults } from "../../src/results/runner-records.ts";
import { runStatus } from "../../src/results/status.ts";
import { parseSummary, proofRecord } from "../../src/results/summary.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

const ctx: RenderContext = {
  repository: "acme/shop", headSha: "4bec63ba31437dbe83826d4643ae63b6ad03fead", workflowName: "CI", jobName: "test",
  jobUrl: "https://github.com/acme/shop/actions/runs/1/job/2", receiptsUrl: null, dashboardRunUrl: "https://app.fenvix.test/projects/p/runs/r", jobConclusion: "success",
};

/** A passing parallel run: 374 tests ran in 4 lanes, every one proven unless `notProven` says otherwise. */
function parallel(notProven: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tests: 374, reused_with_proof: 0, ran: 374, exit: 0, failed: [], flaky: [], outcome_counts: { passed: 374 }, test_seconds_run: 39.2,
    proof: {
      workers: 4, proven: 374 - notProven, not_proven: notProven, rerun_one_lane: notProven, parallel_seconds: 39.2, serial_seconds_estimate: 151.0,
      order_digest: "7c1e0000000000000000000000009a04", not_proven_causes: notProven ? [{ cause: "file read outside the project", tests: notProven }] : [],
    },
    ...extra,
  };
}

const s = (raw: Record<string, unknown>) => parseSummary(raw);

describe("runStatus: the run's status, first match wins (github-app/src/results/status.ts)", () => {
  it("a cancelled job is cancelled, whatever the summary", () => {
    assert.equal(runStatus("cancelled", s(parallel(14))), "cancelled");
    assert.equal(runStatus("cancelled", null), "cancelled");
  });
  it("no summary: passed if the job succeeded", () => assert.equal(runStatus("success", null), "passed"));
  it("no summary: failed if the job did not succeed", () => assert.equal(runStatus("failure", null), "failed"));
  it("failures and tests not proven: failed (a failure is never hidden behind not proven)", () => {
    assert.equal(runStatus("failure", s(parallel(14, { failed: ["tests/test_a.py::test_x"], exit: 1 }))), "failed");
    assert.equal(runStatus("failure", s(parallel(2, { flaky: [{ nodeid: "t", replay: "pytest --det t" }] }))), "failed");
  });
  it("only tests not proven: not_proven", () => assert.equal(runStatus("success", s(parallel(14))), "not_proven"));
  it("every test proven, no failure: passed", () => assert.equal(runStatus("success", s(parallel(0))), "passed"));
  it("a non-zero exit with every test proven and no failure: failed", () => assert.equal(runStatus("failure", s(parallel(0, { exit: 2 }))), "failed"));
  it("tests not proven with exit 1 (the engine exits 1 then): not_proven, not failed; also without a proof", () => {
    assert.equal(runStatus("failure", s(parallel(14, { exit: 1 }))), "not_proven");
    assert.equal(runStatus("failure", s({ tests: 10, reused_with_proof: 0, ran: 10, exit: 1, not_proven: 2 })), "not_proven");
  });
});

describe("N, the not-proven count of a summary", () => {
  it("node-mocha-verify-failed (exit 0, verify_status diverged, 1 diverged test): N = 1, not_proven, check run failure", () => {
    const sum = parseSummary(fixture("node-mocha-verify-failed"));
    assert.equal(sum.exit, 0);
    assert.equal(sum.proof, null);
    assert.equal(sum.notProven, 1);
    assert.equal(runStatus("success", sum), "not_proven");
    assert.equal(conclusionOf(sum, "success"), "failure");
    assert.match(title(sum, "failure"), /1 not proven/);
    assert.doesNotMatch(title(sum, "failure"), /no failures/);
    assert.match(prComment(sum, ctx), /❌/);
    assert.match(checkRunOutput(sum, ctx).summary, /Not proven identical to the serial run \| 1/);
  });
  it("with a proof: the largest of proof.not_proven, the top-level not_proven and the verify count (a proof never hides tests)", () => {
    assert.equal(s(parallel(3)).notProven, 3);
    assert.equal(s(parallel(3, { not_proven: 9 })).notProven, 9);
    assert.equal(s(parallel(3, { verify_status: "diverged", verify_counts: { not_proven: 5, diverged: 5, missing: 5 } })).notProven, 15);
  });
  it("with a proof that does not cover the tests that ran: N is at least ran - proven", () => {
    // 374 ran, the proof accounts for 300 proven + 0 not proven: 74 tests were never proven.
    const sum = s(parallel(0, { proof: { workers: 4, proven: 300, not_proven: 0, parallel_seconds: 10 } }));
    assert.equal(sum.notProven, 74);
    assert.equal(runStatus("success", sum), "not_proven");
  });
  it("verify fails closed: not_proven, a crashed verify (null with a non-zero exit), wrong_reuse, an unknown status; identical stays 0", () => {
    const base = { tests: 10, reused_with_proof: 0, ran: 10, exit: 0 };
    const zero = { not_proven: 0, diverged: 0, missing: 0, wrong_reuse: 0 };
    assert.equal(s({ ...base, verify_status: "not_proven", verify_counts: { ...zero, not_proven: 2 } }).notProven, 2);
    assert.equal(s({ ...base, verify_status: "not_proven", verify_counts: zero }).notProven, 1);
    assert.equal(s({ ...base, verify_status: null, verify_exit: 2 }).notProven, 1);
    assert.equal(s({ ...base, verify_exit: 2 }).notProven, 1);
    assert.equal(s({ ...base, verify_status: null, verify_exit: 0 }).notProven, 0);
    assert.equal(s({ ...base, verify_status: "diverged", verify_counts: { ...zero, wrong_reuse: 3 } }).notProven, 3);
    assert.equal(s({ ...base, verify_status: "something new", verify_counts: zero }).notProven, 1);
    assert.equal(s({ ...base, verify_status: "identical", verify_exit: 0, verify_counts: { ...zero, wrong_reuse: 3 } }).notProven, 0);
    for (const v of ["not_proven", null, "something new"]) assert.equal(runStatus("success", s({ ...base, verify_status: v, verify_exit: 2 })), "not_proven", String(v));
  });
  it("without proof: the larger of the top-level not_proven and the diverged verify counts; status.not_proven is not used", () => {
    const base = { tests: 10, reused_with_proof: 0, ran: 10, exit: 0 };
    assert.equal(s({ ...base, not_proven: 2 }).notProven, 2);
    assert.equal(s({ ...base, not_proven: 2, verify_status: "diverged", verify_counts: { not_proven: 1, diverged: 1, missing: 1 } }).notProven, 3);
    assert.equal(s({ ...base, not_proven: 0, verify_status: "identical", verify_counts: { not_proven: 4, diverged: 0, missing: 0 } }).notProven, 0);
    assert.equal(s({ ...base, status: { not_proven: 7 } }).notProven, 0);
    assert.equal(s(base).notProven, 0);
  });
  it("the real Node summaries without a divergence stay N = 0 (vitest, jest, node:test)", () => {
    for (const f of ["node-vitest-warm", "node-jest-cold-0-reused", "node-node-test-failed"]) assert.equal(parseSummary(fixture(f)).notProven, 0, f);
  });
});

describe("the summary's proof", () => {
  it("with proof: read and stored as the contract's RunProof (camelCase, milliseconds)", () => {
    const sum = s(parallel(14));
    assert.deepEqual(sum.proof, {
      workers: 4, proven: 360, notProven: 14, rerunOneLane: 14, parallelSeconds: 39.2, serialSecondsEstimate: 151, orderDigest: "7c1e0000000000000000000000009a04",
      notProvenCauses: [{ cause: "file read outside the project", tests: 14 }],
    });
    assert.deepEqual(proofRecord(sum.proof!), {
      workers: 4, proven: 360, notProven: 14, rerunOneLane: 14, parallelMs: 39200, serialMsEstimate: 151000, orderDigest: "7c1e0000000000000000000000009a04",
      notProvenCauses: [{ cause: "file read outside the project", tests: 14 }],
    });
    assert.equal(conclusionOf(sum, "success"), "failure");
    assert.match(title(sum, "failure"), /14 not proven/);
  });
  it("every test proven: a green check that says no failures", () => {
    const sum = s(parallel(0));
    assert.equal(conclusionOf(sum, "success"), "success");
    assert.match(title(sum, "success"), /no failures/);
  });
  it("without proof (a serial run): null; serial estimate and order digest may be null", () => {
    assert.equal(parseSummary(fixture("job3-warm-pass")).proof, null);
    const p = s(parallel(0, { proof: { workers: 2, proven: 374, not_proven: 0, parallel_seconds: 20, serial_seconds_estimate: null, order_digest: null } })).proof!;
    assert.equal(p.serialSecondsEstimate, null);
    assert.equal(p.orderDigest, null);
    assert.equal(proofRecord(p).serialMsEstimate, null);
  });
  it("a malformed proof never discards the summary: proof null, the rest kept, N from the other sources, never green for it", () => {
    const good = { workers: 4, proven: 370, not_proven: 4, rerun_one_lane: 4, parallel_seconds: 10, serial_seconds_estimate: null, order_digest: "ab", not_proven_causes: [{ cause: "c", tests: 4 }] };
    const bad = [
      ["a list", []], ["rerun_one_lane null", { ...good, rerun_one_lane: null }], ["order_digest empty", { ...good, order_digest: "" }],
      ["a cause over 500 characters", { ...good, not_proven_causes: [{ cause: "x".repeat(501), tests: 4 }] }], ["parallel_seconds null", { ...good, parallel_seconds: null }],
      ["workers -1", { ...good, workers: -1 }], ["an empty cause", { ...good, not_proven_causes: [{ cause: "", tests: 4 }] }],
    ] as const;
    for (const [what, proof] of bad) {
      const sum = s(parallel(0, { proof, not_proven: 4 }));
      assert.equal(sum.proof, null, what);
      assert.equal(sum.tests, 374, `${what}: the summary is kept`);
      assert.equal(sum.notProven, 4, `${what}: N from the top-level not_proven`);
      assert.equal(runStatus("success", sum), "not_proven", what);
    }
    assert.notEqual(s(parallel(0, { proof: good })).proof, null);
  });
});

describe("a results chunk with a not_proven test and its cause", () => {
  it("is accepted and stored with its cause; the cause is kept for not_proven only", () => {
    const r = parseResults({
      runId: 1, runAttempt: 1, chunk: 0,
      tests: [
        { testId: "tests/test_io.py::test_reads_home", outcome: "not_proven", durationMs: 7, notProvenCause: "file read outside the project" },
        { testId: "tests/test_io.py::test_env", outcome: "not_proven", durationMs: 3, notProvenCause: null },
        { testId: "tests/test_io.py::test_ok", outcome: "passed", durationMs: 2, notProvenCause: "ignored" },
      ],
    });
    const [a, b, c] = r.tests!.map(testRow);
    assert.equal(a!.outcome, "not_proven");
    assert.equal(a!.not_proven_cause, "file read outside the project");
    assert.equal(a!.failure_kind, null);
    assert.equal(b!.not_proven_cause, null);
    assert.equal("not_proven_cause" in c!, false);
  });
  it("a cause longer than 500 characters is refused", () => {
    assert.throws(() => parseResults({ runId: 1, runAttempt: 1, chunk: 0, tests: [{ testId: "t", outcome: "not_proven", durationMs: 1, notProvenCause: "x".repeat(501) }] }));
  });
});
