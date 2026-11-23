import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
type Row = Record<string, unknown>;
interface DashRun {
  id: string; number: number; commitSha: string; branch: string; trigger: string; status: string; pullRequest: number | null; durationMs: number;
  startedAt: string; finishedAt: string | null; skipShare: number; minutesSaved: number; otherStepMinutes: number; githubEquivalentMinutes: number;
  tests: { total: number; ran: number; passed: number; failed: number; skippedWithProof: number; flakyDefects: number; notProven: number };
  testTimeMs: { ran: number; skipped: number }; skipMisses: Record<string, number>; proof: unknown; exitCode: number | null;
}
interface DashProject { id: string; fullName: string; language: string; testRunner: string; setupState: string; installationId: number }
// The customer dashboard's own row mappers (src/data/ci-rows.ts): what it shows is what it reads.
// Loaded at run time (that file is type-checked by the dashboard's own tsconfig, not this one).
const { mapProject, mapRun } = (await import(new URL("../../../src/data/ci-rows.ts", import.meta.url).href)) as {
  mapRun: (r: Row) => DashRun; mapProject: (r: Row) => DashProject;
};
import { ACCOUNT, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, workflowJob } from "../helpers/harness.ts";

const summary = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Record<string, unknown>;

const NODE_YAML = `name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`;
const PY_YAML = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: python -m pytest -q
`;

describe("the rows the App writes, read by the dashboard (src/data/ci-rows.ts)", () => {
  const h = new Harness();
  let admin: pg.Client;

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "contract-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id, REPOS.web.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": PY_YAML } });
    h.gh.addRepo({ id: REPOS.web.id, fullName: REPOS.web.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/test.yml": NODE_YAML } });
    await h.send("installation", installationCreated([REPOS.shop, REPOS.web]));
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("a published run maps to the dashboard's Run with every field it shows", async () => {
    const sha = "8".repeat(40);
    h.gh.addRun("acme/shop", 9201, { event: "push", headSha: sha, headBranch: "main", message: "Contract run\n\nbody" });
    await h.summary({ runId: 9201, summary: summary("job2-warm-real-failure") });
    await h.send("workflow_job", workflowJob("in_progress", { id: 801, runId: 9201, sha, branch: "main", startedAt: "2026-11-18T10:00:00Z" }));
    await h.send("workflow_job", workflowJob("completed", { id: 801, runId: 9201, sha, branch: "main", conclusion: "failure", startedAt: "2026-11-18T10:00:00Z", completedAt: "2026-11-18T10:03:00Z" }));
    // Read as the dashboard does (select *), then through its mapper.
    const row = (await admin.query("select * from ci_runs where commit_sha = $1", [sha])).rows[0];
    const run = mapRun(JSON.parse(JSON.stringify(row)));
    const project = mapProject(JSON.parse(JSON.stringify((await admin.query("select * from ci_projects where id = $1", [row.project_id])).rows[0])));
    assert.equal(project.fullName, "acme/shop");
    assert.equal(project.language, "python");
    assert.equal(project.testRunner, "pytest");
    assert.equal(project.setupState, "active");
    assert.equal(project.installationId, INSTALLATION_ID);
    assert.equal(run.number, 1);
    assert.equal(run.commitSha, sha);
    assert.equal(run.branch, "main");
    assert.equal(run.trigger, "push");
    assert.equal(run.status, "failed");
    assert.equal(run.pullRequest, null);
    assert.equal(run.durationMs, 180_000);
    assert.equal(new Date(run.startedAt).toISOString(), "2026-11-18T10:00:00.000Z");
    assert.equal(new Date(run.finishedAt!).toISOString(), "2026-11-18T10:03:00.000Z");
    // Counts as the run page shows them: passed + failed + skipped with proof = total; ran + skipped = total.
    assert.deepEqual(run.tests, { total: 56, ran: 11, passed: 10, failed: 1, skippedWithProof: 45, flakyDefects: 0, notProven: 0 });
    // A serial run (no proof block in its summary): no proof.
    assert.equal(run.proof, null);
    assert.equal(run.exitCode, 1);
    assert.equal(run.tests.passed + run.tests.failed + run.tests.skippedWithProof, run.tests.total);
    assert.ok(run.testTimeMs.ran > 0 && run.testTimeMs.skipped > 0);
    assert.ok(run.skipShare > 0 && run.skipShare < 1);
    // Generated columns agree with what the App wrote.
    assert.equal(run.minutesSaved, Math.round(run.testTimeMs.skipped / 600) / 100);
    assert.ok(Math.abs(run.githubEquivalentMinutes - ((run.testTimeMs.ran + run.testTimeMs.skipped) / 60000 + run.otherStepMinutes)) < 0.011);
    // "Why tests ran": the kinds the dashboard knows (MissKind).
    assert.deepEqual(run.skipMisses, { new: 1, code: 10 });
    for (const k of Object.keys(run.skipMisses)) assert.ok(["new", "failed-before", "config", "runtime", "clock", "env", "data", "code"].includes(k));
    // The usage event of the same job points at this run, same month.
    const ev = (await admin.query("select ci_run_id, project_id, billable, to_char(month, 'YYYY-MM') as month from ci_usage_events where github_job_id = 801")).rows[0];
    assert.deepEqual(ev, { ci_run_id: run.id, project_id: project.id, billable: true, month: "2026-11" });
  });

  it("a Node repository whose runner was not detected is never labelled pytest", async () => {
    const r = (await admin.query("select detected_language, detected_test_runner, project_id from gh_repositories where repository_id = $1", [REPOS.web.id])).rows[0];
    assert.equal(r.detected_language, "node");
    assert.equal(r.detected_test_runner, null);
    assert.equal(r.project_id, null, "no project until its test runner is known");
    const sha = "9".repeat(40);
    h.gh.addRun("acme/web", 9202, { event: "push", headSha: sha, headBranch: "main", message: "node" });
    await h.summary({ repositoryId: REPOS.web.id, runId: 9202, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", workflowJob("in_progress", { id: 802, runId: 9202, sha, branch: "main", repo: REPOS.web }));
    await h.send("workflow_job", workflowJob("completed", { id: 802, runId: 9202, sha, branch: "main", repo: REPOS.web }));
    assert.equal((await admin.query("select count(*)::int as n from ci_projects where full_name = 'acme/web' and test_runner = 'pytest'")).rows[0].n, 0);
    // Billed all the same (it ran on our machine); the dashboard shows it once the project exists.
    assert.equal((await admin.query("select billable from ci_usage_events where github_job_id = 802")).rows[0].billable, true);
  });

  it("the run's summary names the Node runner (detjs, vitest): the project is created as node / vitest, with its run", async () => {
    const sha = "7".repeat(40);
    h.gh.addRun("acme/web", 9203, { event: "push", headSha: sha, headBranch: "main", message: "node with detjs" });
    const node = { ...summary("job3-warm-pass"), runtime: { digest: "x", node: "22.11.0", dist_list: ["detjs@0.2.0", "vitest@2.1.4"] }, runner: "vitest 2.1.4" };
    await h.summary({ repositoryId: REPOS.web.id, runId: 9203, summary: node });
    await h.send("workflow_job", workflowJob("in_progress", { id: 803, runId: 9203, sha, branch: "main", repo: REPOS.web }));
    await h.send("workflow_job", workflowJob("completed", { id: 803, runId: 9203, sha, branch: "main", repo: REPOS.web }));
    const p = mapProject(JSON.parse(JSON.stringify((await admin.query("select * from ci_projects where full_name = 'acme/web'")).rows[0])));
    assert.deepEqual([p.language, p.testRunner, p.setupState], ["node", "vitest", "active"]);
    const run = (await admin.query("select engine_version, status from ci_runs where project_id = $1", [p.id])).rows[0];
    assert.deepEqual(run, { engine_version: "0.2.0", status: "passed" });
  });
});
