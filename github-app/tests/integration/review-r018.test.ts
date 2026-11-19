// Review R-018 (docs/REVIEW-R-018.md): warm cache at install (branch claude/warm-cache-install).
// Each test asserts the behaviour the branch should have; each FAILS on claude/warm-cache-install at b6e7744.
//
//   cd github-app && node --test --test-reporter=spec --test-concurrency=1 tests/integration/review-r018.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { type Region, RetryLater, type RunnerLaunch, type RunnerLauncher, type WarmupLaunch } from "../../src/runners/launcher.ts";
import {
  ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, push, REPOS, resetDb, workflowJob,
} from "../helpers/harness.ts";

const SUMMARY = JSON.parse(readFileSync(new URL("../fixtures/runner/job3-warm-pass.summary.json", import.meta.url), "utf8")) as Record<string, unknown>;

/** The fleet in memory (as in warmup.test.ts). */
class FakeFleet implements RunnerLauncher {
  jobs: RunnerLaunch[] = [];
  warmups: WarmupLaunch[] = [];
  live = new Map<number, Region>();
  max = 10;
  canPlace(region: Region) { return region === "us"; }
  async hasCapacity() { return this.jobs.length + this.live.size < this.max; }
  async launch(l: RunnerLaunch) { this.jobs.push(l); return { instanceId: `i-j${l.jobId}`, already: false }; }
  async slots() { return { running: this.live.size, warmups: this.live.size, max: this.max }; }
  async launchWarmup(w: WarmupLaunch) {
    if (this.live.size >= this.max) throw new RetryLater("full");
    this.warmups.push(w); this.live.set(w.warmupId, w.region);
    return { instanceId: `i-w${w.warmupId}-${w.attempt}`, already: false };
  }
  async terminateWarmup(_r: Region, id: number) { return this.live.delete(id) ? [`i-w${id}`] : []; }
}

type Row = Record<string, unknown>;

describe("review R-018: warm-up runs", () => {
  const h = new Harness();
  const fleet = new FakeFleet();
  let admin: pg.Client;
  const sha = (c: string) => c.repeat(40);
  const one = async (s: string): Promise<Row | undefined> =>
    (await admin.query("select * from gh_warmups where repository_id = $1 and commit_sha = $2", [REPOS.shop.id, s])).rows[0];
  const due = () => admin.query("update gh_warmups set not_before = now() - interval '1 second' where status = 'pending'");
  const report = (cred: string, body: Row) => h.app.fastify.inject({ method: "POST", url: "/v1/runner/warmups", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, payload: body });
  const pushTo = (s: string, at: number) => h.send("push", push(s, "refs/heads/main", at));
  let head = "";

  before(async () => {
    admin = await resetDb();
    await h.start({ WARMUP_GRACE_SECONDS: "180", WARMUP_DAILY_CAP: "50" }, { launcher: fleet });
    const org = await makeOrg(admin, "r018-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    const pr = (await admin.query("select setup_pr_number from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].setup_pr_number as number;
    await h.send("pull_request", pullRequest("closed", { number: pr, headRef: "fenvix/runs-on", headSha: "1".repeat(40), merged: true, mergeSha: sha("a") }));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
    // The default branch's head at the link is warmed: the cache is warm since `head`.
    head = h.gh.repos.get("acme/shop")!.branches.get("main")!.sha;
    assert.equal((await h.app.service.warmups.tick()).dispatched, 1);
    const l = fleet.warmups.at(-1)!;
    assert.equal(l.commitSha, head);
    assert.equal((await report(l.summaryToken, { warmupId: l.warmupId, event: "finished", outcome: "succeeded", summary: SUMMARY })).statusCode, 202);
    fleet.live.delete(l.warmupId);
    assert.equal((await admin.query("select cache_warm_sha from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0].cache_warm_sha, head);
  });
  after(async () => { await h.stop(); await admin.end(); });
  beforeEach(() => { fleet.live.clear(); });

  // F1 (Medium): a commit taken off the default branch (reset to the last warm commit) keeps its warm-up, which later
  // runs that commit's code with WRITE access to the shared cache. The reset's push returns "exists" before it
  // supersedes anything, and the dispatch never checks that the commit is still on the default branch.
  it("F1: resetting the default branch to the warm commit cancels the warm-up of the commit that was taken off it", async () => {
    const bad = sha("b");
    await pushTo(bad, 1_795_600_000);
    assert.equal((await one(bad))?.status, "pending");
    // The maintainers reset main back to the last good (already warm) commit: a push with after = head.
    await pushTo(head, 1_795_600_060);
    await due();
    const before = fleet.warmups.length;
    await h.app.service.warmups.tick();
    const dispatchedBad = fleet.warmups.slice(before).some((w) => w.commitSha === bad);
    assert.equal(dispatchedBad, false, "no machine runs a commit that is no longer on the default branch with a write cache token");
    assert.notEqual((await one(bad))?.status, "pending", "its warm-up is superseded by the reset");
  });

  // F2 (Medium): "if the covering run ends without results, the warm-up is re-armed" (report, section 1) holds only
  // for a cancelled run. A trusted push run that FAILS before its tests (no summary) re-arms it, and the very next tick
  // marks it covered again by that same job (step 4 excludes only cancelled/skipped). Nobody re-arms it after that: the
  // commit is never warmed.
  it("F2: a warm-up re-armed after its covering run failed without results gets a machine on the next tick", async () => {
    // A clean state: whatever F1 left in flight ends.
    await admin.query("update gh_warmups set status = 'cancelled', finished_at = now() where status in ('pending', 'dispatched', 'running')");
    const c = sha("d");
    await pushTo(c, 1_795_700_000);
    h.gh.addRun("acme/shop", 9101, { event: "push", headSha: c, headBranch: "main", message: "main" });
    await h.send("workflow_job", workflowJob("queued", { id: 9101, runId: 9101, sha: c, branch: "main" }));
    assert.equal((await one(c))?.status, "covered");
    await h.send("workflow_job", workflowJob("in_progress", { id: 9101, runId: 9101, sha: c, branch: "main", runner: "fenvix-j9101" }));
    // `npm ci` failed: the job fails before its test step, so the runner sends no summary. The sweep publishes it.
    await h.send("workflow_job", workflowJob("completed", { id: 9101, runId: 9101, sha: c, branch: "main", runner: "fenvix-j9101", conclusion: "failure" }));
    assert.equal(await h.app.service.tryPublish(9101, true), "published");
    assert.equal((await one(c))?.status, "pending", "re-armed (this part works)");
    await due();
    await h.app.service.warmups.tick();
    const w = await one(c);
    assert.ok(["dispatched", "running"].includes(String(w?.status)), `the re-armed warm-up must get its machine; it is ${w?.status} (${w?.detail})`);
  });
});
