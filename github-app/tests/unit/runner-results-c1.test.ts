import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { testRow } from "../../src/results/apply.ts";
import { parseResults, type RunnerTestOutcome } from "../../src/results/runner-records.ts";

// Spec C1 (idea 3, "is this red real?"): the per-test results every `runs-on: fenvix` job now sends. The fixtures in
// tests/fixtures/runner/c1/ are chunks written by the engine's runner (fenvix-engine-cli runner/fenvix-run, its test
// tests/test_runner_results_c1_e2e.py with FENVIX_C1_CHUNKS_OUT) for vitest, jest, node:test (serial and parallel),
// mocha (serial) and pytest (serial and parallel): 22 failed tests (one flaky), 2 skipped (and an xfail) left out, one
// reused with its receipt.
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (o: object) => { addSchema(s: object, k: string): void; compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
const spec = parseYaml(readFileSync(new URL("../../../openapi/fenvix-api.yaml", import.meta.url), "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
require("ajv-formats")(ajv);
ajv.addSchema({ ...spec, $id: "https://fenvix.dev/openapi" }, "openapi");
const schema = ajv.compile({ $ref: "https://fenvix.dev/openapi#/components/schemas/RunnerResults" });

const DIR = new URL("../fixtures/runner/c1/", import.meta.url);
const CASES = readdirSync(DIR).filter((f) => f.endsWith(".chunk-0.json")).sort();
/** What the machine's poster adds around a chunk (infra/github-app/lib/runner/files/fenvix-summary-poster). */
const envelope = (chunk: object) => ({ repositoryId: 70001, runId: 31000, runAttempt: 1, runnerName: "fenvix-j81000", ...chunk });

describe("C1: the engine's per-test result chunks are accepted as sent", () => {
  it("there is a chunk for every runner case", () => {
    assert.deepEqual(CASES.map((f) => f.replace(".chunk-0.json", "")), [
      "jest-parallel", "jest-serial", "mocha-serial", "node-test-parallel", "node-test-serial", "pytest-parallel", "pytest-serial",
      "vitest-parallel", "vitest-serial",
    ]);
  });

  for (const file of CASES) {
    // protects=spec C1 criterion 1 (chunks parseResults accepts) and 4.1 (the parser keeps failSeq and rerunAlone);
    // fails_when=a field the runner writes is refused (the whole chunk would be lost) or dropped by the parser, or the
    // schema and the parser disagree on it; no_claim=the runner's own correctness (engine tests).
    it(`${file}: valid for the schema and the parser; failSeq and rerunAlone kept; stored in the four columns`, () => {
      const body = envelope(JSON.parse(readFileSync(new URL(file, DIR), "utf8")));
      assert.equal(schema(body), true, JSON.stringify(schema.errors));
      const r = parseResults(body);
      const tests = r.tests!;
      const failed = tests.filter((t) => t.outcome === "failed").sort((a, b) => a.failSeq! - b.failSeq!);
      assert.equal(failed.length, 22);
      assert.deepEqual(failed.map((t) => t.failSeq), Array.from({ length: 22 }, (_, i) => i));
      assert.deepEqual(failed.map((t) => t.rerunAlone!.ran), [...Array(20).fill(true), false, false]);
      assert.equal(failed.filter((t) => t.rerunAlone!.outcome === "passed").length, 1, "one flaky test passes alone");
      const reused = tests.filter((t) => t.outcome === "skipped_with_proof");
      assert.equal(reused.length, 1);
      assert.equal(r.receipts!.length, 1);
      assert.equal(r.receipts![0]!.testId, reused[0]!.testId);
      assert.equal(reused[0]!.durationMs, r.receipts![0]!.reusedDurationMs);
      for (const t of tests) {
        const row = testRow(t);
        if (t.outcome === "failed") {
          assert.equal(row.fail_seq, t.failSeq);
          assert.equal(row.rerun_alone_ran, t.rerunAlone!.ran);
          assert.equal(row.rerun_alone_outcome, t.rerunAlone!.ran ? t.rerunAlone!.outcome : null);
          assert.equal(row.rerun_alone_failure === null, row.rerun_alone_outcome !== "failed" || !t.rerunAlone!.failure);
        } else {
          assert.deepEqual([row.fail_seq, row.rerun_alone_ran, row.rerun_alone_outcome, row.rerun_alone_failure], [null, null, null, null]);
        }
      }
    });
  }
});

describe("C1: testRow's four columns (migration 0021)", () => {
  const fail = { kind: "real" as const, phase: "call", message: "m" };
  const row = (t: Partial<RunnerTestOutcome>) => testRow({ testId: "t", outcome: "failed", durationMs: 1, ...t } as RunnerTestOutcome);
  const cols = (r: ReturnType<typeof testRow>) => [r.fail_seq, r.rerun_alone_ran, r.rerun_alone_outcome, r.rerun_alone_failure];

  // protects=4.3 (the four columns only for failed tests; the re-run's failure only when it failed); fails_when=a
  // passed, reused or not proven test gets a value, or a test that was not re-run gets an outcome; no_claim=storage
  // itself (tests/integration/results.test.ts "C1: ...").
  it("failed: written as sent; the re-run's outcome only when it ran, its failure only when it failed", () => {
    assert.deepEqual(cols(row({ failSeq: 3, rerunAlone: { ran: true, outcome: "failed", failure: fail } })), [3, true, "failed", fail]);
    assert.deepEqual(cols(row({ failSeq: 0, rerunAlone: { ran: true, outcome: "passed", failure: fail } })), [0, true, "passed", null]);
    assert.deepEqual(cols(row({ failSeq: 1, rerunAlone: { ran: true, outcome: "not_proven" } })), [1, true, "not_proven", null]);
    assert.deepEqual(cols(row({ failSeq: 20, rerunAlone: { ran: false, outcome: "passed" } })), [20, false, null, null]);
    assert.deepEqual(cols(row({ failSeq: 2, rerunAlone: { ran: true, outcome: "failed" } })), [2, true, "failed", null]);
  });
  it("a runner without the fields (older machines): null columns, chunk accepted", () => {
    assert.deepEqual(cols(row({})), [null, null, null, null]);
    const r = parseResults({ runId: 1, chunk: 0, tests: [{ testId: "t", outcome: "failed", durationMs: 1, failure: fail }] });
    assert.equal(r.tests![0]!.failSeq, undefined);
    assert.equal(r.tests![0]!.rerunAlone, undefined);
  });
  it("other outcomes: null, whatever was sent", () => {
    for (const outcome of ["passed", "skipped_with_proof", "not_proven"] as const) {
      assert.deepEqual(cols(row({ outcome, failSeq: 4, rerunAlone: { ran: true, outcome: "failed", failure: fail } })), [null, null, null, null]);
    }
  });
});
