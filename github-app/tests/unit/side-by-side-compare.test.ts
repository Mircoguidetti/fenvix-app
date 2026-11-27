/*
 * Side-by-side runs: the comparison rule (spec section 5, AC 8), the pairing (AC 7) and the prices (AC 9). Each test
 * states its card: protects=...; fails_when=...; no_claim=...
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billedMinutes, compare, ourCost, type HisJob, jobCost, type OurJob, pairJobs, priceOf, priceText, type Rate } from "../../src/sidebyside/compare.ts";

const SHA = "a".repeat(40);
const T0 = new Date("2026-11-26T10:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const TEST_STEP = "Run npm test";
const his = (o: Partial<HisJob> = {}): HisJob => ({
  jobId: 1, runAttempt: 1, headSha: SHA, event: "push", prNumber: null, matrixSuffix: null, conclusion: "success", startedAt: T0, completedAt: min(15),
  labels: ["ubuntu-latest"], steps: [{ name: "Set up job", conclusion: "success" }, { name: TEST_STEP, conclusion: "success" }], ...o,
});
const failedAt = (step: string): Partial<HisJob> => ({ conclusion: "failure", steps: [{ name: "Set up job", conclusion: "success" }, { name: step, conclusion: "failure" }] });
const ours = (o: Partial<OurJob> = {}): OurJob => ({
  jobId: 2, runAttempt: 1, headSha: SHA, event: "push", prNumber: null, status: "completed", conclusion: "success", startedAt: T0, completedAt: min(6),
  skipMachine: false, hasSummary: true, runStatus: "passed", testsRan: 120, wouldSkipTests: 80, wouldSaveMs: 300_000, ...o,
});

describe("the comparison rule: one fixture per row, first matching row wins (AC 8)", () => {
  // protects=each row of section 5 gives its result; fails_when=a row is skipped or two rows swap order (e.g. a
  // cancelled job of his compared as different); no_claim=why the results differ (the notes say what can cause it).
  const rows: [string, HisJob | null, OurJob | null, string, RegExp][] = [
    ["1 his cancelled", his({ conclusion: "cancelled" }), ours(), "not_comparable", /your job: cancelled/],
    ["2 ours on a skip machine", his(), ours({ skipMachine: true, hasSummary: false, runStatus: "not_proven" }), "not_comparable", /skip machine/],
    ["2b ours stopped for a customer job", his(), ours({ stoppedForCustomer: true, hasSummary: false, conclusion: "failure" }), "not_comparable", /stopped for a customer job/],
    ["3 engine NOT PROVEN", his(), ours({ runStatus: "not_proven" }), "not_proven", /NOT PROVEN/],
    ["4 his failure at another step", his(failedAt("Install dependencies")), ours({ runStatus: "failed" }), "not_comparable", /failed at step Install dependencies/],
    ["5 success / all passed", his(), ours(), "same", /both passed/],
    ["6 failure at the test step / one failed", his(failedAt(TEST_STEP)), ours({ runStatus: "failed" }), "same", /both failed/],
    ["7 success / one failed", his(), ours({ runStatus: "failed" }), "different", /ours failed/],
    ["8 failure at the test step / all passed", his(failedAt(TEST_STEP)), ours(), "different", /ours all passed/],
  ];
  for (const [name, h, u, result, detail] of rows) {
    it(`row ${name}`, () => {
      const r = compare(h, u, TEST_STEP);
      assert.equal(r.result, result);
      assert.match(r.detail, detail);
    });
  }
  // protects=first matching row wins: NOT PROVEN (row 3) comes before his failure at another step (row 4);
  // fails_when=the rows are applied in another order; no_claim=-.
  it("rows 3 and 4 both match: not proven wins", () => {
    assert.equal(compare(his(failedAt("Install dependencies")), ours({ runStatus: "not_proven" }), TEST_STEP).result, "not_proven");
  });
  // protects=a missing summary is never compared (row 2), even when GitHub says success; fails_when=compared as same.
  // no_claim=-.
  it("no summary from the runner: not comparable, whatever GitHub's conclusion of our job", () => {
    assert.deepEqual(compare(his(), ours({ hasSummary: false, runStatus: "not_proven" }), TEST_STEP), { result: "not_comparable", detail: "no summary from the runner" });
  });
});

describe("the pairing (AC 7)", () => {
  const now = min(60);
  const pair = (h: HisJob[], u: OurJob[], o: { suffix?: string | null; at?: Date } = {}) => pairJobs(h, u, { matrixSuffix: o.suffix ?? null, testStep: TEST_STEP, now: o.at ?? now });

  // protects=a push pairs by (sha, event); fails_when=no pair, or two; no_claim=-.
  it("push: one pair", () => {
    const p = pair([his()], [ours()]);
    assert.equal(p.length, 1);
    assert.deepEqual({ r: p[0]!.result, his: p[0]!.his?.jobId, ours: p[0]!.ours?.jobId }, { r: "same", his: 1, ours: 2 });
  });

  // protects=a pull request pairs by its number too (a push of the same sha is another pair); fails_when=the PR job
  // pairs with the push job; no_claim=-.
  it("pull_request: the PR number is part of the key", () => {
    const p = pair([his({ event: "pull_request", prNumber: 7 }), his({ jobId: 3, event: "push" })], [ours({ event: "pull_request", prNumber: 7 })]);
    const pr = p.find((x) => x.key.prNumber === 7)!;
    assert.deepEqual({ his: pr.his?.jobId, ours: pr.ours?.jobId, r: pr.result }, { his: 1, ours: 2, r: "same" });
    assert.equal(p.find((x) => x.key.event === "push")!.ours, null);
  });

  // protects=only his job of the combination we run is paired; fails_when=another combination is paired; no_claim=-.
  it("matrix suffix: only his job with the stored suffix", () => {
    const p = pair([his({ jobId: 10, matrixSuffix: " (18)", conclusion: "failure", steps: [{ name: TEST_STEP, conclusion: "failure" }] }), his({ jobId: 11, matrixSuffix: " (20)" })], [ours()], { suffix: " (20)" });
    assert.equal(p.length, 1);
    assert.equal(p[0]!.his?.jobId, 11);
  });

  // protects=the latest completed attempt of each side pairs (his re-run with our first); fails_when=his attempt 1 is
  // used; no_claim=-.
  it("his re-run (attempt 2) pairs with our attempt 1", () => {
    const p = pair([his({ jobId: 20, runAttempt: 1, conclusion: "failure", steps: [{ name: TEST_STEP, conclusion: "failure" }] }), his({ jobId: 21, runAttempt: 2, completedAt: min(40) })], [ours()]);
    assert.deepEqual({ his: p[0]!.his?.jobId, r: p[0]!.result }, { his: 21, r: "same" });
  });

  // protects=the order of arrival does not matter; fails_when=his earlier job is missed; no_claim=-.
  it("his event before ours: the same pair", () => {
    assert.equal(pair([his({ completedAt: min(5) })], [ours({ completedAt: min(30) })])[0]!.result, "same");
  });

  // protects=his job missing: waiting for 6 hours after ours, then "your job not seen"; fails_when=not seen at once, or
  // never; no_claim=why it is missing.
  it("his missing: waiting, then your job not seen after 6 hours", () => {
    assert.equal(pair([], [ours()])[0]!.result, "waiting");
    const late = pair([], [ours()], { at: new Date(min(6).getTime() + 6 * 3_600_000 + 1) })[0]!;
    assert.deepEqual({ r: late.result, d: late.detail }, { r: "not_comparable", d: "your job not seen" });
  });

  // protects=ours missing (cap, filters, no machine, still queued): "our job not seen" after 6 hours; fails_when=a
  // queued job of ours counts as seen; no_claim=-.
  it("ours missing (queued, never ran): our job not seen after 6 hours", () => {
    const later = new Date(min(15).getTime() + 6 * 3_600_000 + 1);
    const p = pair([his()], [ours({ status: "queued", completedAt: null })], { at: later })[0]!;
    assert.equal(p.result, "not_comparable");
    assert.match(p.detail, /our job not seen/);
  });
});

describe("prices of his runner (AC 9)", () => {
  const rates = new Map<string, Rate>([
    ["ubuntu-latest", { key: "github-linux-2core", usdPerMinute: 0.006, usdPerMinuteMax: null, runner: "GitHub-hosted Linux, 2 cores" }],
    ["ubicloud-standard-2", { key: "ubicloud-x64-2", usdPerMinute: 0.00125, usdPerMinuteMax: 0.002, runner: "Ubicloud x64, 2 vCPU" }],
    ["blacksmith-4vcpu-ubuntu-2404", { key: "blacksmith-4vcpu-ubuntu-2404", usdPerMinute: 0.008, usdPerMinuteMax: null, runner: "Blacksmith 4 vCPU" }],
  ]);
  // protects=each label's price as the spec's table; fails_when=a wrong rate, a missing range, a public GitHub-hosted
  // job priced, an unknown label priced, or minutes not rounded up; no_claim=the rates themselves (research dates).
  it("ubicloud-standard-2: 0.00125 to 0.002 a minute", () => {
    const p = priceOf(["ubicloud-standard-2"], true, rates);
    assert.deepEqual(jobCost(60, p), { min: 0.00125, max: 0.002 });
    assert.equal(priceText(p), "$0.00125-0.002 per minute (Ubicloud x64, 2 vCPU)");
  });
  it("ubuntu-latest, private: 0.006 a minute", () => assert.deepEqual(jobCost(60, priceOf(["ubuntu-latest"], true, rates)), { min: 0.006, max: 0.006 }));
  it("ubuntu-latest, public: $0", () => {
    const p = priceOf(["ubuntu-latest"], false, rates);
    assert.equal(p.kind, "free");
    assert.deepEqual(jobCost(900, p), { min: 0, max: 0 });
  });
  it("blacksmith-4vcpu-ubuntu-2404: 0.008 a minute", () => assert.deepEqual(jobCost(60, priceOf(["blacksmith-4vcpu-ubuntu-2404"], true, rates)), { min: 0.008, max: 0.008 }));
  it("my-runner: price unknown for my-runner", () => {
    const p = priceOf(["self-hosted", "my-runner"], true, rates);
    assert.equal(priceText(p), "price unknown for my-runner");
    assert.equal(jobCost(60, p), null);
  });
  it("61 seconds bill 2 minutes", () => {
    assert.equal(billedMinutes(61), 2);
    assert.equal(billedMinutes(60), 1);
    assert.deepEqual(jobCost(61, priceOf(["ubuntu-latest"], true, rates)), { min: 0.012, max: 0.012 });
  });
});

// protects=our job's machine cost: a full machine at SIDE_BY_SIDE_USD_PER_HOUR and its vCPUs, a skip machine as a
// c6i.large (2 vCPU, the same price per vCPU); fails_when=a skip machine is priced as the full one; no_claim=AWS's bill.
it("our cost: a full machine, or a skip machine priced as a c6i.large", () => {
  const full = { instanceType: "c6i.2xlarge", vcpus: 8, usdPerHour: 0.3648 };
  assert.deepEqual(ourCost(10, false, full), { vcpuMinutes: 80, machineCost: 0.0608 });
  assert.deepEqual(ourCost(10, true, full), { vcpuMinutes: 20, machineCost: 0.0152 });
});
