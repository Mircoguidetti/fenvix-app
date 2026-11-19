import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapWarmCache } from "../../src/data/ci-rows.ts";
import { warmCacheText } from "../../src/lib/warm.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("warm cache: the row (gh_repositories + its latest warm-up) to the contract's WarmCache", () => {
  it("never warmed, no warm-up: cold", () => {
    assert.deepEqual(mapWarmCache({}), { state: "cold", commitSha: null, warmAt: null, source: null, warmup: null });
  });

  it("warm since a commit (a Date from node-postgres becomes ISO 8601)", () => {
    const at = new Date("2026-11-18T10:00:00Z");
    assert.deepEqual(mapWarmCache({ cache_warm_sha: A, cache_warm_at: at, cache_warm_source: "warmup", warmup_status: "succeeded", warmup_sha: A, warmup_detail: "ok", warmup_updated_at: at }), {
      state: "warm", commitSha: A, warmAt: "2026-11-18T10:00:00.000Z", source: "warmup", warmup: { status: "succeeded", commitSha: A, detail: "ok", updatedAt: "2026-11-18T10:00:00.000Z" },
    });
  });

  it("a warm-up pending or running: warming, even when the cache is warm at an older commit", () => {
    for (const status of ["pending", "dispatched", "running"]) {
      assert.equal(mapWarmCache({ cache_warm_sha: A, cache_warm_source: "run", warmup_status: status, warmup_sha: B }).state, "warming", status);
    }
    assert.equal(mapWarmCache({ warmup_status: "running", warmup_sha: B }).state, "warming");
  });

  it("garbage stays out: an unknown status or a malformed SHA is no warm-up; an unknown source is none", () => {
    assert.equal(mapWarmCache({ warmup_status: "queued", warmup_sha: B }).warmup, null);
    assert.equal(mapWarmCache({ warmup_status: "running", warmup_sha: "main" }).warmup, null);
    assert.equal(mapWarmCache({ cache_warm_sha: "abc" }).commitSha, null);
    assert.equal(mapWarmCache({ cache_warm_sha: A, cache_warm_source: "magic" }).source, null);
  });
});

describe("warm cache in words (Projects and Connect)", () => {
  const warm = (o: Partial<ReturnType<typeof mapWarmCache>> = {}) => ({ state: "warm" as const, commitSha: A, warmAt: "2026-11-18T10:00:00Z", source: "warmup" as const, warmup: null, ...o });

  it("warm since <commit>, and by whom", () => {
    assert.deepEqual(warmCacheText(warm()), { lead: "Cache warm since aaaaaaa", sub: "by a fenvix warm-up", detail: null, sha: A });
    assert.equal(warmCacheText(warm({ source: "run" })).sub, "by your run on the default branch");
  });

  it("warming: the commit it is warm since, and the one being warmed", () => {
    const w = { status: "running" as const, commitSha: B, detail: "running the test job", updatedAt: "2026-11-18T10:00:00Z" };
    assert.deepEqual(warmCacheText(warm({ state: "warming", warmup: w })), { lead: "Cache warm since aaaaaaa", sub: "Warming up bbbbbbb", detail: "running the test job", sha: A });
    const q = warmCacheText({ state: "warming", commitSha: null, warmAt: null, source: null, warmup: { ...w, status: "pending", detail: "waiting for a free machine in us" } });
    assert.deepEqual([q.lead, q.sub, q.detail], ["Cache cold", "Warm-up queued for bbbbbbb", "waiting for a free machine in us"]);
  });

  it("cold, with why the last warm-up did not fill it", () => {
    const c = { state: "cold" as const, commitSha: null, warmAt: null, source: null };
    assert.deepEqual(warmCacheText({ ...c, warmup: null }), { lead: "Cache cold: the first run fills it", sub: null, detail: null, sha: null });
    const u = warmCacheText({ ...c, warmup: { status: "unsupported", commitSha: B, detail: "the job needs the outputs of job build", updatedAt: "2026-11-18T10:00:00Z" } });
    assert.deepEqual([u.sub, u.detail], ["Warm-up not possible (bbbbbbb)", "the job needs the outputs of job build"]);
    assert.equal(warmCacheText({ ...c, warmup: { status: "failed", commitSha: B, detail: "2 tests failed", updatedAt: "2026-11-18T10:00:00Z" } }).sub, "Warm-up failed (bbbbbbb)");
  });
});
