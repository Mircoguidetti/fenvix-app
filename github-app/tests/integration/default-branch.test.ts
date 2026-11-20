import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { runWork } from "../../src/work.ts";
import { ACCOUNT, CI_YAML, Harness, hook, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb } from "../helpers/harness.ts";

/** A repository's default branch changes on GitHub: the stored one (and its project's) follows, by webhook or by a read. */
describe("default branch refresh", () => {
  const h = new Harness();
  let admin: pg.Client;
  let projectId: string;
  const branch = async () => ({
    repo: (await admin.query("select default_branch, updated_at from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0],
    project: (await admin.query("select default_branch from ci_projects where id = $1", [projectId])).rows[0].default_branch as string,
  });
  const edited = (name: string, changes: Record<string, unknown>) => hook("repository", "edited", (p) => {
    p.changes = changes;
    (p.repository as Record<string, unknown>).id = REPOS.shop.id;
    (p.repository as Record<string, unknown>).full_name = REPOS.shop.full_name;
    (p.repository as Record<string, unknown>).default_branch = name;
  });

  before(async () => {
    admin = await resetDb();
    await h.start();
    const org = await makeOrg(admin, "branch-owner");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await admin.query("update gh_installations set workspace_id = $2 where installation_id = $1", [INSTALLATION_ID, org.workspaceId]);
    projectId = (await admin.query<{ id: string }>(
      `insert into ci_projects (workspace_id, full_name, language, test_runner, default_branch, installation_id) values ($1, $2, 'python', 'pytest', 'old-branch', $3) returning id`,
      [org.workspaceId, REPOS.shop.full_name, INSTALLATION_ID])).rows[0]!.id;
    await admin.query("update gh_repositories set workspace_id = $2, project_id = $3, default_branch = 'old-branch' where repository_id = $1", [REPOS.shop.id, org.workspaceId, projectId]);
  });
  after(async () => { await h.stop(); await admin.end(); });

  it("repository.edited with changes.default_branch updates the repository and its project", async () => {
    const res = await h.send("repository", edited("claude/release-1", { default_branch: { from: "old-branch" } }), { delivery: "repo-edited-1" });
    assert.equal(res.statusCode, 202);
    await h.app.service.idle();
    const b = await branch();
    assert.equal(b.repo.default_branch, "claude/release-1");
    assert.ok(b.repo.updated_at);
    assert.equal(b.project, "claude/release-1");
  });

  it("an edit that does not touch the default branch changes nothing", async () => {
    const res = await h.send("repository", edited("something-else", { description: { from: "old" } }), { delivery: "repo-edited-2" });
    assert.equal(res.statusCode, 202);
    await h.app.service.idle();
    assert.equal((await branch()).repo.default_branch, "claude/release-1");
  });

  it("the worker reads the branch from GitHub with the installation token, and not again within a minute", async () => {
    h.gh.repos.get(REPOS.shop.full_name)!.defaultBranch = "main";
    await admin.query("update gh_repositories set updated_at = now() - interval '10 minutes' where repository_id = $1", [REPOS.shop.id]);
    await runWork(h.app.service, { kind: "refresh_default_branch", repositoryId: REPOS.shop.id });
    let b = await branch();
    assert.equal(b.repo.default_branch, "main");
    assert.equal(b.project, "main");
    // Read a moment ago: GitHub's answer is not asked for again.
    h.gh.repos.get(REPOS.shop.full_name)!.defaultBranch = "trunk";
    await runWork(h.app.service, { kind: "refresh_default_branch", repositoryId: REPOS.shop.id });
    assert.equal((await branch()).repo.default_branch, "main");
    // A repository the App does not know is ignored.
    await runWork(h.app.service, { kind: "refresh_default_branch", repositoryId: 999999 });
  });
});
