import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { projectStack, stackFromSummary } from "../../src/results/detect.ts";
import { parseSummary, trimSummary } from "../../src/results/summary.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("language and test runner, detected (never assumed)", () => {
  it("the summary's own fields first", () => {
    assert.deepEqual(stackFromSummary({ language: "node", test_runner: "vitest" }), { language: "node", testRunner: "vitest" });
    assert.deepEqual(stackFromSummary({ test_runner: "jest" }), { language: "node", testRunner: "jest" });
    assert.deepEqual(stackFromSummary({ language: "python" }), { language: "python", testRunner: null });
    // A runner of another language is not taken; an unknown value is ignored.
    assert.deepEqual(stackFromSummary({ language: "python", test_runner: "vitest" }), { language: "python", testRunner: null });
    assert.equal(stackFromSummary({ language: "ruby", test_runner: "rspec" }), null);
  });

  it("else the runtime: a detpy distribution is Python and pytest", () => {
    const raw = fixture("job1-cold-flaky");
    assert.deepEqual(stackFromSummary(raw), { language: "python", testRunner: "pytest" });
    assert.deepEqual(parseSummary(raw).stack, { language: "python", testRunner: "pytest" });
  });

  it("detjs is Node; vitest or jest from the runner or config fields when present, else unknown", () => {
    const rt = { runtime: { dist_list: ["detjs@0.2.0", "vitest@2.1.4"] } };
    assert.deepEqual(stackFromSummary(rt), { language: "node", testRunner: null });
    assert.deepEqual(stackFromSummary({ ...rt, runner: "vitest 2.1.4" }), { language: "node", testRunner: "vitest" });
    assert.deepEqual(stackFromSummary({ ...rt, config: { runner: "jest 29.7.0" } }), { language: "node", testRunner: "jest" });
    assert.deepEqual(stackFromSummary({ engine: "detjs 0.2.0", command: "detjs jest --det" }), { language: "node", testRunner: "jest" });
    assert.equal(stackFromSummary({ runtime: { dist_list: ["requests==2.32.0"] } }), null);
    assert.equal(stackFromSummary(null), null);
  });

  it("the stored (trimmed) summary keeps what the dropped distribution list told", () => {
    const stored = trimSummary(fixture("job1-cold-flaky"));
    assert.equal((stored.runtime as Record<string, unknown>).dist_list, undefined);
    assert.equal(stored.language, "python");
    assert.equal(stored.test_runner, "pytest");
    assert.equal(stored.engine_version, "0.1.0");
    assert.deepEqual(parseSummary(stored).stack, { language: "python", testRunner: "pytest" });
    const node = trimSummary({ tests: 1, reused_with_proof: 0, runtime: { dist_list: ["detjs==0.2.0"] }, runner: "vitest" });
    assert.deepEqual([node.language, node.test_runner, node.engine_version], ["node", "vitest", "0.2.0"]);
  });

  it("the summary's mode: shadow or enforce, else not sent", () => {
    const base = { tests: 2, reused_with_proof: 0 };
    assert.equal(parseSummary({ ...base, mode: "shadow" }).mode, "shadow");
    assert.equal(parseSummary({ ...base, mode: "enforce" }).mode, "enforce");
    assert.equal(parseSummary({ ...base, mode: "loud" }).mode, null);
  });

  it("the project: the workflow analysis first, else the run; a Node repository is never labelled pytest", () => {
    const none = { language: null, testRunner: null };
    assert.deepEqual(projectStack({ language: "python", testRunner: "pytest" }, null), { language: "python", testRunner: "pytest" });
    // Python's and Go's only runner when the workflow did not name one.
    assert.deepEqual(projectStack({ language: "python", testRunner: null }, null), { language: "python", testRunner: "pytest" });
    assert.deepEqual(projectStack({ language: "go", testRunner: null }, null), { language: "go", testRunner: "go test" });
    // Node without a known runner: no project yet; the run names it.
    assert.equal(projectStack({ language: "node", testRunner: null }, null), null);
    assert.deepEqual(projectStack({ language: "node", testRunner: null }, { language: "node", testRunner: "vitest" }), { language: "node", testRunner: "vitest" });
    // A run of another language does not relabel the repository (the workflow analysis wins).
    assert.equal(projectStack({ language: "node", testRunner: null }, { language: "python", testRunner: "pytest" }), null);
    assert.deepEqual(projectStack({ language: "python", testRunner: "pytest" }, { language: "node", testRunner: "jest" }), { language: "python", testRunner: "pytest" });
    // Nothing from the workflow: the run decides.
    assert.deepEqual(projectStack(none, { language: "python", testRunner: "pytest" }), { language: "python", testRunner: "pytest" });
    assert.deepEqual(projectStack(none, { language: "node", testRunner: "jest" }), { language: "node", testRunner: "jest" });
    assert.equal(projectStack(none, { language: "node", testRunner: null }), null);
    assert.equal(projectStack(none, null), null);
  });
});
