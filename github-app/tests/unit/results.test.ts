import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CHECK_NAME, COMMENT_MARKER, checkRunOutput, conclusionOf, minutes, prComment, type RenderContext } from "../../src/results/render.ts";
import { parseSummary, SummaryError, trimSummary } from "../../src/results/summary.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

const ctx: RenderContext = {
  repository: "acme/shop", headSha: "4bec63ba31437dbe83826d4643ae63b6ad03fead", workflowName: "CI", jobName: "test",
  jobUrl: "https://github.com/acme/shop/actions/runs/1/job/2", receiptsUrl: "https://app.fenvix.test/projects/p/runs/r",
  dashboardRunUrl: "https://app.fenvix.test/projects/p/runs/r", jobConclusion: "failure",
};

describe("the runner's summary", () => {
  it("reads the three real summaries", () => {
    const cold = parseSummary(fixture("job1-cold-flaky"));
    assert.equal(cold.tests, 56);
    assert.equal(cold.reusedWithProof, 0);
    assert.equal(cold.flaky.length, 1);
    assert.equal(cold.flaky[0]!.nodeid, "tests/test_cart.py::test_default_currency_is_eur");
    assert.match(cold.flaky[0]!.replay, /pytest --det/);
    assert.equal(cold.engineVersion, "0.1.0");
    const warm = parseSummary(fixture("job2-warm-real-failure"));
    assert.equal(warm.reusedWithProof, 45);
    assert.equal(warm.ran, 11);
    assert.deepEqual(warm.failed, ["tests/test_tax.py::test_vat[3]"]);
    assert.ok(warm.shareOfTestTimeSaved > 0.5);
    const pass = parseSummary(fixture("job3-warm-pass"));
    assert.equal(pass.failed.length + pass.flaky.length, 0);
    assert.equal(pass.exit, 0);
  });

  it("drops the per-test maps before storing", () => {
    const raw = fixture("job2-warm-real-failure");
    const t = trimSummary(raw);
    assert.equal("outcomes" in t, false);
    assert.equal("reused_outcomes" in t, false);
    assert.equal("dist_list" in (t.runtime as object), false);
    assert.equal(t.engine_version, "0.1.0");
    assert.deepEqual(parseSummary(t), parseSummary(raw));
  });

  it("refuses summaries that do not add up or are not the runner's", () => {
    assert.throws(() => parseSummary(null), SummaryError);
    assert.throws(() => parseSummary({ tests: 3, reused_with_proof: 1, ran: 1 }), /must equal/);
    assert.throws(() => parseSummary({ tests: -1, reused_with_proof: 0 }), /tests/);
    assert.throws(() => parseSummary({ tests: 1, reused_with_proof: 0, failed: [1] }), /failed/);
    assert.throws(() => parseSummary({ tests: 1, reused_with_proof: 0, flaky: [{ nodeid: "a" }] }), /replay/);
  });
});

describe("check run and comment", () => {
  it("says tests run, skipped with proof (with receipts), minutes saved, failures", () => {
    const s = parseSummary(fixture("job2-warm-real-failure"));
    const out = checkRunOutput(s, ctx);
    assert.equal(out.title, "45 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · 1 failed");
    assert.match(out.summary, /\| Tests run \| 11 \|/);
    assert.match(out.summary, /\| Skipped with proof \| \*\*45\*\* \(\[receipts\]\(https:\/\/app\.fenvix\.test\/projects\/p\/runs\/r\)\) \|/);
    assert.match(out.summary, /\| Minutes saved \|/);
    assert.match(out.summary, /### Failures\n\n- `tests\/test_tax.py::test_vat\[3\]`/);
    assert.match(out.text, /Why the other tests ran.*code 10/);
    assert.equal(conclusionOf(s, "failure"), "failure");
  });

  it("explains flaky tests with their replay command", () => {
    const s = parseSummary(fixture("job1-cold-flaky"));
    const out = checkRunOutput(s, ctx);
    assert.match(out.title, /1 failed \(1 flaky, reproducible\)/);
    assert.match(out.summary, /### Flaky tests, explained/);
    assert.match(out.summary, /replay: `python -m pytest --det/);
    assert.match(out.summary, /find the test that breaks it: `detpy repro tests\/test_cart.py::test_default_currency_is_eur --seed fixed`/);
  });

  it("passes when nothing failed", () => {
    const s = parseSummary(fixture("job3-warm-pass"));
    assert.equal(conclusionOf(s, "success"), "success");
    assert.match(checkRunOutput(s, { ...ctx, jobConclusion: "success" }).title, /no failures$/);
  });

  it("without a summary: neutral on success, failure otherwise, cancelled when cancelled", () => {
    assert.equal(conclusionOf(null, "success"), "neutral");
    assert.equal(conclusionOf(null, "failure"), "failure");
    assert.equal(conclusionOf(null, "cancelled"), "cancelled");
    assert.match(checkRunOutput(null, ctx).title, /No fenvix summary/);
  });

  it("the comment is short, marked, and links the check run", () => {
    const s = parseSummary(fixture("job1-cold-flaky"));
    const c = prComment(s, { ...ctx, checkRunUrl: "https://github.com/acme/shop/runs/9" });
    assert.ok(c.startsWith(COMMENT_MARKER));
    assert.match(c, /\[Check run\]\(https:\/\/github\.com\/acme\/shop\/runs\/9\)/);
    assert.ok(c.length < 3000, `comment is ${c.length} characters`);
    assert.equal(CHECK_NAME, "fenvix");
  });

  it("keeps long lists within GitHub's limits", () => {
    const failed = Array.from({ length: 5000 }, (_, i) => `tests/test_${i}.py::test_${"x".repeat(200)}`);
    const s = parseSummary({ tests: 5000, reused_with_proof: 0, ran: 5000, failed });
    const out = checkRunOutput(s, ctx);
    assert.ok(out.summary.length <= 65535);
    assert.match(out.summary, /and 4,950 more/);
  });

  it("formats minutes", () => {
    assert.equal(minutes(13.9), "0.2 min (13.9 s)");
    assert.equal(minutes(744), "12.4 min");
    assert.equal(minutes(0.2), "under 0.1 min (0.2 s)");
  });
});
