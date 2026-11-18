/**
 * The nine onboarding states of a repository (gh_repositories.onboarding_state), each reached through the App's own
 * paths and stored with a detail a person can read: pending (stored, not tried), pr_open, merged, closed (the setup
 * pull request), no_workflow, no_test_job, already_fenvix, unsupported, failed (why no pull request was opened).
 * Onboarding is asked for by GitHub's repository id through the queue (work kind "onboard"), as the dashboard API does.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { InProcessQueue } from "../../src/work.ts";
import { ACCOUNT, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, pullRequest, resetDb } from "../helpers/harness.ts";

const repo = (id: number, name: string) => ({ id, name, full_name: `acme/${name}` });
const R = {
  waiting: repo(70100, "waiting"), open: repo(70101, "open"), merged: repo(70102, "merged"), closed: repo(70103, "closed"), none: repo(70104, "none"),
  lint: repo(70105, "lint"), fenvix: repo(70106, "fenvix"), windows: repo(70107, "windows"), broken: repo(70108, "broken"),
};
const LINT_ONLY = "name: lint\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ruff check .\n";
const ON_FENVIX = "name: CI\non: [push]\njobs:\n  test:\n    runs-on: fenvix\n    steps:\n      - run: python -m pytest -q\n";
const WINDOWS = "name: CI\non: [push]\njobs:\n  test:\n    runs-on: windows-latest\n    steps:\n      - run: python -m pytest -q\n";

describe("the nine onboarding states, each stored with a detail", () => {
  const h = new Harness();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "states-owner");
    const all = Object.values(R);
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: all.map((r) => r.id), selection: "all" });
    for (const r of [R.waiting, R.open, R.merged, R.closed, R.broken]) h.gh.addRepo({ id: r.id, fullName: r.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addRepo({ id: R.none.id, fullName: R.none.full_name, ownerId: ACCOUNT.id, files: { "README.md": "no workflows" } });
    h.gh.addRepo({ id: R.lint.id, fullName: R.lint.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/lint.yml": LINT_ONLY } });
    h.gh.addRepo({ id: R.fenvix.id, fullName: R.fenvix.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": ON_FENVIX } });
    h.gh.addRepo({ id: R.windows.id, fullName: R.windows.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": WINDOWS } });
    // All repositories: stored, nothing opened by itself.
    await h.send("installation", installationCreated(all, "all"));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("each state is reached and stored with a detail", async () => {
    const queue = new InProcessQueue(h.app.service);
    h.gh.failNext.set(`GET /repos/${R.broken.full_name}`, 500);
    for (const r of [R.open, R.merged, R.closed, R.none, R.lint, R.fenvix, R.windows, R.broken]) await queue.enqueue({ kind: "onboard", repositoryId: r.id });
    await h.app.service.idle();
    for (const [r, merged] of [[R.merged, true], [R.closed, false]] as const) {
      const pr = h.gh.repos.get(r.full_name)!.pulls[0]!;
      await h.send("pull_request", pullRequest("closed", { number: pr.number, headRef: "fenvix/runs-on", headSha: pr.headSha, merged, repo: r }));
    }
    const got: Record<string, [string, string]> = Object.fromEntries((await admin.query<{ full_name: string; onboarding_state: string; onboarding_detail: string }>(
      "select full_name, onboarding_state, onboarding_detail from gh_repositories order by repository_id")).rows
      .map((x) => [x.full_name.split("/")[1]!, [x.onboarding_state, x.onboarding_detail] as [string, string]]));
    const states = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v[0]]));
    assert.deepEqual(states, {
      waiting: "pending", open: "pr_open", merged: "merged", closed: "closed", none: "no_workflow", lint: "no_test_job",
      fenvix: "already_fenvix", windows: "unsupported", broken: "failed",
    });
    for (const [k, [, detail]] of Object.entries(got)) assert.ok(String(detail).length > 0, `${k} has a detail`);
    assert.match(got.merged![1], /was merged/);
    assert.match(got.closed![1], /closed without merging/);
    assert.match(got.windows![1], /Linux/);
    assert.match(got.broken![1], /500/);
  });

  it("asking again keeps an open pull request (no second one)", async () => {
    await new InProcessQueue(h.app.service).enqueue({ kind: "onboard", repositoryId: R.open.id });
    await h.app.service.idle();
    assert.equal(h.gh.repos.get(R.open.full_name)!.pulls.length, 1);
    assert.equal((await admin.query("select onboarding_state from gh_repositories where repository_id = $1", [R.open.id])).rows[0].onboarding_state, "pr_open");
  });
});
