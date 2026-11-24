import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { auditRow, defectRow, receiptRow, testRow } from "../../src/results/apply.ts";
import {
  causeOf, familyKeyOf, isNewerProgress, parseExploration, parseProgress, parseResults, progressRecord, RecordError,
} from "../../src/results/runner-records.ts";
import { parseWork } from "../../src/work.ts";

// The OpenAPI description is the contract: the server's checks must accept and refuse exactly what its schemas do.
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (o: object) => { addSchema(s: object, k: string): void; compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
const addFormats = addFormatsModule as unknown as (a: unknown) => void;
const spec = parseYaml(readFileSync(new URL("../../../openapi/fenvix-api.yaml", import.meta.url), "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: "https://fenvix.dev/openapi" }, "openapi");
const schema = (name: string) => ajv.compile({ $ref: `https://fenvix.dev/openapi#/components/schemas/${name}` });

const H = (c: string) => c.repeat(32);
const progress = { runId: 31000, runAttempt: 1, seq: 4, phase: "testing", testsTotal: 56, testsDone: 20, passed: 19, failed: 1, skippedWithProof: 0, currentTest: "tests/test_tax.py::test_vat[3]", elapsedMs: 4200, mode: "shadow" };
const defect = {
  testId: "tests/test_money.py::test_default_currency_is_eur", status: "reproduced", kind: "order",
  polluters: ["tests/test_config.py::test_set_currency"], setters: [], order: ["tests/test_config.py::test_set_currency", "tests/test_money.py::test_default_currency_is_eur"],
  prefixLength: 31, seed: 3, fingerprint: H("a"), replay: { runs: 10, fails: 10, identicalFingerprint: true }, outcome: "failed",
  exception: { type: "AssertionError", phase: "call", message: "assert 'USD' == 'EUR'", location: "tests/test_money.py:12" },
  divergence: { index: 1, reason: "outcome-only", description: "the outcome differs" }, engineVersion: "0.1.0", language: "python",
  replayCommand: "pytest --det --det-seed=3 --det-order=<bundle>/order.txt -n 0",
};
const results = {
  runId: 31000, runAttempt: 1, repositoryId: 70001, runnerName: "fenvix-j81000", chunk: 0, chunks: 2, engineRunId: "20261118T094005-4412", seed: 3, mode: "shadow",
  tests: [
    { testId: "tests/test_tax.py::test_vat[3]", outcome: "failed", durationMs: 12, failure: { kind: "real", phase: "call", exceptionType: "AssertionError", message: "assert 30 == 31", location: "tests/test_tax.py:40" },
      failSeq: 0, rerunAlone: { ran: true, outcome: "failed", failure: { kind: "real", phase: "call", exceptionType: "AssertionError", message: "assert 30 == 31" } } },
    { testId: defect.testId, outcome: "failed", durationMs: 3, failure: { kind: "flaky_defect", defectFingerprint: H("a") } },
    { testId: "tests/test_cart.py::test_total", outcome: "skipped_with_proof", durationMs: 8, cacheKey: H("b") },
    { testId: "tests/test_cart.py::test_empty", outcome: "passed", durationMs: 5, failure: null, cacheKey: null, wouldSkip: true },
  ],
  receipts: [{
    testId: "tests/test_cart.py::test_total", cacheKey: H("b"), reusedEngineRunId: "20261117T101502-4412", fingerprint: H("c"), reusedDurationMs: 8,
    code: [{ path: "shop/cart.py", qualname: "Cart.total", digest: H("d") }], modules: [{ path: "shop/cart.py", kind: "skeleton", digest: H("e") }],
    filesRead: [{ path: "data/rates.json", dep: `f:${H("f")}` }], envRead: [{ name: "TZ", digest: "-" }],
    runtime: { digest: H("1"), interpreter: "python 3.13.0" }, config: { digest: H("2"), runner: "pytest 8.3.3" }, changedFilesProven: 2,
  }],
  defects: [defect],
  audit: [{ testId: "tests/test_cart.py::test_total", cacheKey: H("b"), outcome: "confirmed" }, { testId: "tests/test_cart.py::test_tax", cacheKey: H("3"), outcome: "wrong_skip", untrusted: true, detail: "failed on rerun" }],
  missDetails: [{ kind: "code", detail: "shop/tax.py::vat", tests: 10 }],
};
const exploration = {
  startedAt: "2026-11-18T02:00:00Z", finishedAt: "2026-11-18T02:40:00Z", commitSha: "c".repeat(40), branch: "main", seeds: 20, runs: 20, collected: 56, seconds: 2400.5,
  flakyFailing: [defect.testId], alwaysFailing: [], notReproduced: [], familiesByPolluter: { "tests/test_config.py::test_set_currency": [defect.testId] },
  seedsLog: [{ seed: 1, seconds: 120.2, failing: [] }], defects: [defect],
};

type Json = Record<string, unknown>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
function setPath(o: Json, path: (string | number)[], v: unknown): Json {
  const c = clone(o);
  let cur: Record<string | number, unknown> = c;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  if (v === undefined) delete cur[last]; else cur[last] = v;
  return c;
}

/** Each change: whether the schema and our check agree (both accept or both refuse). */
function agree(name: string, parse: (b: unknown) => unknown, base: Json, changes: [(string | number)[], unknown, boolean][]) {
  const check = schema(name);
  assert.equal(check(base), true, `${name}: the sample is valid: ${JSON.stringify(check.errors)}`);
  assert.doesNotThrow(() => parse(base));
  for (const [path, v, valid] of changes) {
    const body = setPath(base, path, v);
    const ours = (() => { try { parse(body); return true; } catch (e) { assert.ok(e instanceof RecordError, String(e)); return false; } })();
    assert.equal(check(body), valid, `${name} ${path.join(".")}=${JSON.stringify(v)?.slice(0, 40)}: the schema says ${!valid ? "valid" : "invalid"}`);
    assert.equal(ours, valid, `${name} ${path.join(".")}=${JSON.stringify(v)?.slice(0, 40)}: our check disagrees with the schema`);
  }
}

describe("runner records: the request schemas of openapi/fenvix-api.yaml, checked exactly", () => {
  it("RunnerProgress", () => {
    agree("RunnerProgress", parseProgress, progress, [
      [["runId"], undefined, false], [["runId"], 0, false], [["runId"], "31000", false], [["runAttempt"], 0, false], [["runAttempt"], undefined, true],
      [["seq"], -1, false], [["seq"], 1.5, false], [["seq"], undefined, false], [["phase"], "running", false], [["phase"], "reporting", true],
      [["testsTotal"], null, true], [["testsTotal"], undefined, true], [["testsTotal"], -1, false], [["testsDone"], undefined, false],
      [["passed"], "1", false], [["currentTest"], null, true], [["currentTest"], "x".repeat(2001), false], [["elapsedMs"], undefined, false],
      [["mode"], "enforce", true], [["mode"], "trial", false], [["extra"], "kept out", true], [["repositoryId"], 70001, true], [["runnerName"], 5, false],
    ]);
  });

  it("RunnerResults (tests, receipts, defects, audit reruns, miss details) and its limits", () => {
    agree("RunnerResults", parseResults, results, [
      [["chunk"], undefined, false], [["chunk"], 10000, false], [["chunk"], 9999, true], [["chunks"], 0, false], [["chunks"], 10001, false],
      [["engineRunId"], "x".repeat(101), false], [["seed"], null, true], [["seed"], 1.5, false], [["mode"], "both", false],
      [["tests", 0, "outcome"], "skipped", false], [["tests", 0, "durationMs"], -1, false], [["tests", 0, "testId"], "x".repeat(2001), false],
      [["tests", 0, "failure", "kind"], "flaky", false], [["tests", 0, "failure", "message"], "m".repeat(4001), false], [["tests", 0, "failure"], null, true],
      [["tests", 1, "failure", "defectFingerprint"], "ABC", false],
      [["tests", 0, "failSeq"], -1, false], [["tests", 0, "failSeq"], 1.5, false], [["tests", 0, "failSeq"], "0", false], [["tests", 0, "failSeq"], undefined, true], [["tests", 0, "failSeq"], 2147483647, true], [["tests", 0, "failSeq"], 2147483648, false],
      [["tests", 0, "rerunAlone"], undefined, true], [["tests", 0, "rerunAlone"], { ran: false }, true], [["tests", 0, "rerunAlone"], {}, false],
      [["tests", 0, "rerunAlone", "ran"], "yes", false], [["tests", 0, "rerunAlone", "outcome"], "skipped", false],
      [["tests", 0, "rerunAlone", "outcome"], "not_proven", true], [["tests", 0, "rerunAlone", "failure"], { phase: "call" }, false],
      [["tests", 0, "rerunAlone", "failure", "message"], "m".repeat(4001), false], [["tests", 0, "rerunAlone", "extra"], 1, true], [["tests", 2, "cacheKey"], "b".repeat(31), false], [["tests", 3, "wouldSkip"], "yes", false],
      [["tests"], Array.from({ length: 5001 }, (_, i) => ({ testId: `t${i}`, outcome: "passed", durationMs: 1 })), false],
      [["tests"], Array.from({ length: 5000 }, (_, i) => ({ testId: `t${i}`, outcome: "passed", durationMs: 1 })), true],
      [["receipts", 0, "cacheKey"], undefined, false], [["receipts", 0, "reusedEngineRunId"], "x".repeat(101), false],
      [["receipts", 0, "modules", 0, "kind"], "file", false], [["receipts", 0, "code", 0, "digest"], undefined, false],
      [["receipts", 0, "filesRead", 0, "dep"], 3, false], [["receipts", 0, "envRead", 0, "name"], undefined, false], [["receipts", 0, "runtime"], [], false],
      [["receipts", 0, "changedFilesProven"], -1, false],
      [["receipts"], Array.from({ length: 2001 }, () => results.receipts[0]), false],
      [["defects", 0, "kind"], "fails-alone", true], [["defects", 0, "kind"], "fails_alone", false], [["defects", 0, "status"], "flaky", false],
      [["defects", 0, "order"], [], false], [["defects", 0, "replay"], { runs: 10, fails: 10 }, false], [["defects", 0, "exception", "location"], undefined, false],
      [["defects", 0, "divergence"], null, true], [["defects", 0, "divergence"], { index: 1 }, false], [["defects", 0, "language"], "go", false],
      [["defects", 0, "replayCommand"], "x".repeat(4001), false], [["defects", 0, "seed"], null, true], [["defects", 0, "polluters"], [1], false],
      [["audit", 1, "outcome"], "wrong", false], [["audit", 1, "untrusted"], "true", false], [["audit", 1, "detail"], "d".repeat(2001), false],
      [["missDetails", 0, "kind"], "network", false], [["missDetails"], Array.from({ length: 6 }, () => results.missDetails[0]), false],
    ]);
  });

  it("RunnerExploration", () => {
    agree("RunnerExploration", parseExploration, exploration, [
      [["startedAt"], "yesterday", false], [["startedAt"], "2026-11-18T02:00:00.123+01:00", true], [["commitSha"], "C".repeat(40), false],
      [["seeds"], -1, false], [["seconds"], -0.5, false], [["seconds"], undefined, false], [["familiesByPolluter"], { a: "b" }, false],
      [["seedsLog", 0, "failing"], undefined, false], [["defects", 0, "fingerprint"], "z", false], [["flakyFailing"], [3], false],
    ]);
  });

  it("an error names the field", () => {
    assert.throws(() => parseResults({ ...results, tests: [{ ...results.tests[0], durationMs: -1 }] }), (e: unknown) => e instanceof RecordError && e.field === "tests[0].durationMs");
    assert.throws(() => parseProgress([]), (e: unknown) => e instanceof RecordError && e.field === "body");
  });
});

describe("progress: stored in the dashboard's shape, newer records only", () => {
  it("ci_runs.progress has the keys mapProgress (src/data/ci-rows.ts) reads, plus seq; nothing else", () => {
    const rec = progressRecord(parseProgress(progress));
    assert.deepEqual(Object.keys(rec).sort(), ["currentTest", "elapsedMs", "failed", "passed", "phase", "seq", "skippedWithProof", "testsDone", "testsTotal"]);
    assert.equal(rec.seq, 4);
  });

  it("only a higher seq replaces the stored record (records can overtake each other)", () => {
    assert.equal(isNewerProgress(null, 0), true);
    assert.equal(isNewerProgress({ seq: 4 }, 5), true);
    assert.equal(isNewerProgress({ seq: 4 }, 4), false);
    assert.equal(isNewerProgress({ seq: 4 }, 3), false);
    assert.equal(isNewerProgress({}, 0), true);
  });
});

describe("results mapping to the dashboard's rows", () => {
  it("a defect bundle: cause from its kind, cause tests, family key, the runner's replay command", () => {
    assert.equal(causeOf("order"), "polluter");
    assert.equal(causeOf("brittle"), "state_setter");
    assert.equal(causeOf("fails-alone"), "fails_alone");
    const d = parseResults(results).defects![0]!;
    const row = defectRow(d, "python");
    assert.deepEqual([row.cause, row.cause_tests, row.family_key, row.replay_command, row.language, row.minimal_order.length], ["polluter", ["tests/test_config.py::test_set_currency"], "tests/test_config.py::test_set_currency", defect.replayCommand, "python", 2]);
    const brittle = defectRow({ ...d, kind: "brittle", setters: ["a", "b"], language: undefined, replayCommand: undefined }, "node");
    assert.deepEqual([brittle.cause, brittle.cause_tests, brittle.family_key, brittle.replay_command, brittle.language], ["state_setter", ["a", "b"], "a + b", null, "node"]);
    const alone = defectRow({ ...d, kind: "fails-alone" }, "python");
    assert.deepEqual([alone.cause, alone.cause_tests, alone.family_key], ["fails_alone", [], "<none>"]);
    assert.equal(familyKeyOf([]), "<none>");
  });

  it("a test outcome: failure fields only when it failed (a failure always has a kind); the defect's fingerprint for a flaky one", () => {
    const [real, flaky, skipped, passed] = parseResults(results).tests!;
    assert.deepEqual(testRow(real!), { test_id: real!.testId, outcome: "failed", duration_ms: 12, failure_kind: "real", failure_phase: "call", exception_type: "AssertionError", failure_message: "assert 30 == 31", failure_location: "tests/test_tax.py:40", defect_fingerprint: null,
      fail_seq: 0, rerun_alone_ran: true, rerun_alone_outcome: "failed", rerun_alone_failure: { kind: "real", phase: "call", exceptionType: "AssertionError", message: "assert 30 == 31" } });
    assert.equal(testRow(flaky!).defect_fingerprint, H("a"));
    assert.equal(testRow(flaky!).failure_phase, "call");
    assert.equal(testRow(skipped!).failure_kind, null);
    assert.equal(testRow({ ...passed!, failure: { kind: "real" } }).failure_kind, null);
    assert.equal(testRow({ testId: "x", outcome: "failed", durationMs: 1 }).failure_kind, "real");
  });

  it("receipts keep the proof-cache lists; audit reruns default to trusted", () => {
    const r = receiptRow(parseResults(results).receipts![0]!);
    assert.deepEqual([r.code.length, r.modules.length, r.files_read.length, r.env_read.length, r.changed_files_proven], [1, 1, 1, 1, 2]);
    assert.deepEqual(auditRow(parseResults(results).audit![0]!), { test_id: "tests/test_cart.py::test_total", cache_key: H("b"), outcome: "confirmed", untrusted: false, detail: "" });
  });
});

describe("work read back from the queue", () => {
  it("results, explorations and onboarding by repository id cross the queue intact; a bad one is refused", () => {
    const r = parseWork(clone({ kind: "results", repositoryId: 70001, runId: 31000, runAttempt: 1, runnerName: "fenvix-j81000", results }));
    assert.equal(r.kind === "results" && r.results.tests!.length, 4);
    const e = parseWork(clone({ kind: "exploration", repositoryId: 70001, runnerName: "fenvix-explore", exploration }));
    assert.equal(e.kind === "exploration" && e.exploration.seeds, 20);
    assert.deepEqual(parseWork({ kind: "onboard", repositoryId: 70001 }), { kind: "onboard", repositoryId: 70001 });
    assert.throws(() => parseWork({ kind: "onboard", repositoryId: "70001" }), /not a work message/);
    assert.throws(() => parseWork({ kind: "results", repositoryId: 1, runId: 1, runAttempt: 1, runnerName: "x", results: { chunk: -1, runId: 1 } }), RecordError);
  });
});
