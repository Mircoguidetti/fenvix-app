/**
 * Several GitHub installations linked to one organization (e.g. the company's GitHub organization and a second one for
 * its labs): each repository gets its project under its own installation, runs and usage events land in the one
 * organization, the trial starts once, and a repository that moves between the two keeps its project and its runs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import {
  ACCOUNT, APP_ID, CI_YAML, Harness, hook, INSTALLATION_ID, installationCreated, makeOrg, repoLite, REPOS, resetDb, workflowJob,
} from "../helpers/harness.ts";

type Json = Record<string, unknown>;
const summary = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/runner/${name}.summary.json`, import.meta.url), "utf8")) as Json;

const LABS = { login: "acme-labs", id: 9002, type: "Organization" as const };
const LABS_ID = 4343;
const API = { id: 70010, name: "api", full_name: "acme-labs/api" };
const MOVED = { id: REPOS.shop.id, name: "shop", full_name: "acme-labs/shop" };

/** installation.created for the second installation (GitHub's recorded payload with its values put in). */
function labsCreated(repos: { id: number; name: string; full_name: string }[]): Json {
  const p = installationCreated(repos);
  const i = p.installation as Json;
  p.installation = { ...i, id: LABS_ID, account: { ...(i.account as Json), login: LABS.login, id: LABS.id }, target_id: LABS.id };
  return p;
}

function repositoriesChanged(installation: number, account: typeof ACCOUNT | typeof LABS, action: "added" | "removed", repos: { id: number; name: string; full_name: string }[]): Json {
  return hook("installation_repositories", action, (p) => {
    const i = p.installation as Json;
    p.installation = { ...i, id: installation, app_id: APP_ID, account: { ...(i.account as Json), login: account.login, id: account.id, type: account.type }, repository_selection: "all", target_id: account.id, target_type: account.type };
    p.repository_selection = "all";
    p.repositories_added = action === "added" ? repos.map(repoLite) : [];
    p.repositories_removed = action === "removed" ? repos.map(repoLite) : [];
  });
}

/** workflow_job of a repository of the second installation. */
function labsJob(action: "in_progress" | "completed", j: Parameters<typeof workflowJob>[1]): Json {
  const p = workflowJob(action, j);
  (p.installation as Json).id = LABS_ID;
  return p;
}

describe("several installations linked to one organization", () => {
  const h = new Harness();
  let admin: pg.Client;
  let org: { userId: string; workspaceId: string };
  let shopProject = "";

  before(async () => {
    admin = await resetDb();
    await h.start();
    org = await makeOrg(admin, "multi-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addInstallation({ id: LABS_ID, account: LABS, repos: [API.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.addRepo({ id: API.id, fullName: API.full_name, ownerId: LABS.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.send("installation", labsCreated([API]));
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("both link to the organization; the trial starts once; each repository gets its project under its own installation", async () => {
    await h.app.service.linkInstallation(INSTALLATION_ID, org.workspaceId, org.userId);
    const first = (await admin.query("select trial_started_at, trial_ends_at, github_account from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0];
    await h.app.service.linkInstallation(LABS_ID, org.workspaceId, org.userId);
    const second = (await admin.query("select trial_started_at, trial_ends_at, github_account from ci_subscriptions where workspace_id = $1", [org.workspaceId])).rows[0];
    assert.deepEqual(second, first, "the second link neither restarts the trial nor changes the account shown first");
    assert.deepEqual((await admin.query("select installation_id, workspace_id from gh_installations order by installation_id")).rows,
      [{ installation_id: INSTALLATION_ID, workspace_id: org.workspaceId }, { installation_id: LABS_ID, workspace_id: org.workspaceId }]);
    const projects = (await admin.query("select id, full_name, installation_id, workspace_id from ci_projects order by full_name")).rows;
    assert.deepEqual(projects.map((p) => [p.full_name, p.installation_id, p.workspace_id]), [[API.full_name, LABS_ID, org.workspaceId], [REPOS.shop.full_name, INSTALLATION_ID, org.workspaceId]]);
    shopProject = projects[1]!.id;
  });

  it("a run on each: both in the organization, each with its usage event", async () => {
    const shaA = "1".repeat(40);
    const shaB = "2".repeat(40);
    h.gh.addRun(REPOS.shop.full_name, 9501, { event: "push", headSha: shaA, headBranch: "main", message: "shop" });
    h.gh.addRun(API.full_name, 9502, { event: "push", headSha: shaB, headBranch: "main", message: "api" });
    await h.send("workflow_job", workflowJob("in_progress", { id: 9601, runId: 9501, sha: shaA, branch: "main" }));
    await h.summary({ runId: 9501, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", workflowJob("completed", { id: 9601, runId: 9501, sha: shaA, branch: "main" }));
    await h.send("workflow_job", labsJob("in_progress", { id: 9602, runId: 9502, sha: shaB, branch: "main", repo: API }));
    await h.summary({ repositoryId: API.id, runId: 9502, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", labsJob("completed", { id: 9602, runId: 9502, sha: shaB, branch: "main", repo: API }));
    const runs = (await admin.query("select p.full_name, r.number, r.status, r.workspace_id from ci_runs r join ci_projects p on p.id = r.project_id order by p.full_name")).rows;
    assert.deepEqual(runs.map((r) => [r.full_name, r.number, r.status, r.workspace_id]), [[API.full_name, 1, "passed", org.workspaceId], [REPOS.shop.full_name, 1, "passed", org.workspaceId]]);
    const ev = (await admin.query("select installation_id, workspace_id, billable from ci_usage_events order by installation_id")).rows;
    assert.deepEqual(ev, [{ installation_id: INSTALLATION_ID, workspace_id: org.workspaceId, billable: true }, { installation_id: LABS_ID, workspace_id: org.workspaceId, billable: true }]);
    // Each installation's checks went to its own repository, with its own token.
    assert.equal(h.gh.repos.get(REPOS.shop.full_name)!.checkRuns.size, 1);
    assert.equal(h.gh.repos.get(API.full_name)!.checkRuns.size, 1);
  });

  it("a repository moved to the other installation (and renamed) keeps its project and its runs", async () => {
    h.gh.addRepo({ id: MOVED.id, fullName: MOVED.full_name, ownerId: LABS.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    h.gh.installations.get(INSTALLATION_ID)!.repos = [];
    h.gh.installations.get(LABS_ID)!.repos.push(MOVED.id);
    await h.send("installation_repositories", repositoriesChanged(INSTALLATION_ID, ACCOUNT, "removed", [REPOS.shop]));
    await h.send("installation_repositories", repositoriesChanged(LABS_ID, LABS, "added", [MOVED]));
    const repo = (await admin.query("select installation_id, full_name, removed_at, project_id from gh_repositories where repository_id = $1", [MOVED.id])).rows[0];
    assert.deepEqual(repo, { installation_id: LABS_ID, full_name: MOVED.full_name, removed_at: null, project_id: shopProject });
    const sha = "3".repeat(40);
    h.gh.addRun(MOVED.full_name, 9503, { event: "push", headSha: sha, headBranch: "main", message: "moved" });
    await h.send("workflow_job", labsJob("in_progress", { id: 9603, runId: 9503, sha, branch: "main", repo: MOVED }));
    await h.summary({ repositoryId: MOVED.id, runId: 9503, summary: summary("job3-warm-pass") });
    await h.send("workflow_job", labsJob("completed", { id: 9603, runId: 9503, sha, branch: "main", repo: MOVED }));
    const p = (await admin.query("select id, full_name, installation_id from ci_projects where id = $1", [shopProject])).rows[0];
    assert.deepEqual(p, { id: shopProject, full_name: MOVED.full_name, installation_id: LABS_ID });
    assert.equal((await admin.query("select count(*)::int as n from ci_projects")).rows[0].n, 2, "no second project for the moved repository");
    assert.deepEqual((await admin.query("select number from ci_runs where project_id = $1 order by number", [shopProject])).rows.map((r) => r.number), [1, 2]);
  });

  it("every call the App made matches GitHub's REST description", () => {
    assert.deepEqual(h.gh.validateAll().map((x) => `${x.method} ${x.path} ${x.status}: ${JSON.stringify(x.problems)}`), []);
  });
});
