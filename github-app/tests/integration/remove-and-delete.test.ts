// Removing a project and deleting an organization (migration 0021): the dashboard API (as fenvix_api on the scratch
// database, sessions signed by the harness's stand-in Supabase Auth) and the App's side (the excluded repository gets no
// project and no machine; "sync_repository" brings the project back; "uninstall_installation" removes the App on GitHub).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { loadApiConfig } from "../../src/api/config.ts";
import type { OnboardWork } from "../../src/api/context.ts";
import { type Api, buildApi } from "../../src/api/server.ts";
import type { RunnerLaunch, RunnerLauncher } from "../../src/runners/launcher.ts";
import { runWork } from "../../src/work.ts";
import { ACCOUNT, ADMIN_URL, CI_YAML, Harness, INSTALLATION_ID, installationCreated, makeOrg, REPOS, resetDb, SUPABASE, workflowJob } from "../helpers/harness.ts";

type Json = Record<string, unknown>;

class FakeLauncher implements RunnerLauncher {
  launches: RunnerLaunch[] = [];
  canPlace() { return true; }
  async launch(l: RunnerLaunch) { this.launches.push(l); return { instanceId: `i-${l.jobId}`, already: false }; }
}

class RecordingQueue {
  sent: OnboardWork[] = [];
  async enqueue(w: OnboardWork) { this.sent.push(w); }
}

const OTHER_INSTALLATION = 4343;

describe("remove a project, add it again, delete the organization", () => {
  const h = new Harness();
  const launcher = new FakeLauncher();
  const queue = new RecordingQueue();
  let admin: pg.Client;
  let api: Api;
  let owner: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };
  let memberId: string;
  let adminId: string;
  let projectId: string;

  const call = async (userId: string, method: "GET" | "POST" | "DELETE", url: string, ws: string) => api.fastify.inject({
    method, url, headers: { authorization: `Bearer ${await h.token(userId)}`, "x-fenvix-workspace": ws },
  });
  const projectOf = async (fullName: string) => (await admin.query<{ id: string }>("select id from ci_projects where full_name = $1", [fullName])).rows[0]?.id ?? null;
  const excludedAt = async () => (await admin.query<{ excluded_at: Date | null }>("select excluded_at from gh_repositories where repository_id = $1", [REPOS.shop.id])).rows[0]!.excluded_at;
  const person = async (name: string) => (await admin.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data, email_confirmed_at) values ($1, '{}', now()) returning id", [`${name}@gh.fenvix.invalid`])).rows[0]!.id;
  const join = (ws: string, userId: string, role: string) => admin.query(
    "insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3) on conflict (workspace_id, user_id) do update set role = excluded.role", [ws, userId, role]);

  /**
   * Two runs, a defect that points at them (first_run_id, last_run_id) and a skip receipt of the second that reuses the
   * first (reused_run_id): deleting the project sets those references to null on the way (on delete set null).
   */
  const seedHistory = async (ws: string, project: string) => {
    const runs = [];
    for (const n of [1, 2]) {
      runs.push((await admin.query<{ id: string }>(`insert into ci_runs (workspace_id, project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at)
        values ($1, $2, $3, $4, 'main', 'push', 'passed', now(), now()) returning id`, [ws, project, n, String(n).repeat(40)])).rows[0]!.id);
    }
    await admin.query(`insert into ci_defects (workspace_id, project_id, test_id, status, cause, minimal_order, fingerprint, family_key, first_seen_at, last_seen_at, language, first_run_id, last_run_id)
      values ($1, $2, 't::a', 'reproduced', 'polluter', array['t::b', 't::a'], $3, 'fam', now(), now(), 'python', $4, $5)`, [ws, project, "a".repeat(32), runs[0], runs[1]]);
    await admin.query(`insert into ci_skip_receipts (workspace_id, run_id, test_id, cache_key, reused_engine_run_id, fingerprint, reused_run_id)
      values ($1, $2, 't::c', $3, 'engine-1', $4, $5)`, [ws, runs[1], "b".repeat(32), "c".repeat(32), runs[0]]);
    assert.equal((await admin.query("select count(*)::int as n from ci_runs where project_id = $1", [project])).rows[0].n, 2);
  };

  before(async () => {
    admin = await resetDb();
    await h.start({}, { launcher });
    owner = await makeOrg(admin, "rd-owner");
    other = await makeOrg(admin, "rd-other");
    // Members of the owner's organization (their sign-up organizations stay theirs).
    memberId = await person("rd-member");
    adminId = await person("rd-admin");
    await join(owner.workspaceId, memberId, "member");
    await join(owner.workspaceId, adminId, "admin");
    h.gh.addInstallation({ id: INSTALLATION_ID, account: ACCOUNT, repos: [REPOS.shop.id], selection: "selected" });
    h.gh.addRepo({ id: REPOS.shop.id, fullName: REPOS.shop.full_name, ownerId: ACCOUNT.id, files: { ".github/workflows/ci.yml": CI_YAML } });
    await h.send("installation", installationCreated([REPOS.shop]));
    await h.app.service.linkInstallation(INSTALLATION_ID, owner.workspaceId, owner.userId);
    projectId = (await projectOf(REPOS.shop.full_name))!;
    assert.ok(projectId, "the linked repository has its project");
    const u = new URL(ADMIN_URL); u.username = "fenvix_api"; u.password = "local-test-only";
    const cfg = loadApiConfig({
      NODE_ENV: "test", API_DATABASE_URL: u.toString(), SUPABASE_URL: SUPABASE, STATE_SIGNING_KEY: "s".repeat(40),
      DASHBOARD_URL: "https://console.fenvix.test", GITHUB_APP_SLUG: "fenvix-test", LOG_LEVEL: "silent",
    });
    api = buildApi({ cfg, sessions: h.sessions, queue, logger: false });
  });
  after(async () => { await api?.close(); await h.stop(); await admin.end(); });

  it("DELETE /v1/projects/{id}: a member gets 403, another organization's owner and an unknown id get 404; nothing changes", async () => {
    assert.equal((await call(memberId, "DELETE", `/v1/projects/${projectId}`, owner.workspaceId)).statusCode, 403);
    assert.equal((await call(other.userId, "DELETE", `/v1/projects/${projectId}`, other.workspaceId)).statusCode, 404);
    assert.equal((await call(owner.userId, "DELETE", "/v1/projects/00000000-0000-4000-8000-000000000000", owner.workspaceId)).statusCode, 404);
    assert.equal(await projectOf(REPOS.shop.full_name), projectId);
    assert.equal(await excludedAt(), null);
  });

  it("an admin removes the project: 204, the project and its runs are gone, the repository is excluded", async () => {
    await seedHistory(owner.workspaceId, projectId);
    const res = await call(adminId, "DELETE", `/v1/projects/${projectId}`, owner.workspaceId);
    assert.equal(res.statusCode, 204, res.body);
    assert.equal(await projectOf(REPOS.shop.full_name), null);
    for (const t of ["ci_runs", "ci_defects"]) assert.equal((await admin.query(`select count(*)::int as n from ${t} where project_id = $1`, [projectId])).rows[0].n, 0, t);
    assert.equal((await admin.query("select count(*)::int as n from ci_skip_receipts where workspace_id = $1", [owner.workspaceId])).rows[0].n, 0);
    assert.ok(await excludedAt(), "excluded_at is set");
    // The repository listing says so, for Connect's "Removed from fenvix".
    const list = await call(owner.userId, "GET", "/v1/github/repositories", owner.workspaceId);
    const repo = (list.json() as { items: { repositoryId: number; excludedAt: string | null; projectId: string | null }[] }).items.find((r) => r.repositoryId === REPOS.shop.id)!;
    assert.ok(repo.excludedAt);
    assert.equal(repo.projectId, null);
  });

  it("the App skips the excluded repository: no project on sync, no machine for its queued job, no setup pull request", async () => {
    await h.app.service.syncInstallation(INSTALLATION_ID);
    assert.equal(await projectOf(REPOS.shop.full_name), null);
    // GitHub sends the repository again on the same installation (a redelivery): it stays removed.
    await h.send("installation", installationCreated([REPOS.shop]));
    assert.ok(await excludedAt(), "a redelivered installation event cleared the removal");
    assert.equal(await projectOf(REPOS.shop.full_name), null);
    h.gh.addRun("acme/shop", 9700, { event: "push", headSha: "a".repeat(40), headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 970, runId: 9700, sha: "a".repeat(40), branch: "main" }));
    assert.equal(launcher.launches.length, 0);
    assert.equal(h.gh.repos.get("acme/shop")!.jitRunners.length, 0);
    const pulls = h.gh.repos.get("acme/shop")!.pulls.length;
    const res = await h.app.service.onboard(REPOS.shop.id);
    assert.equal(res.state, "failed");
    assert.equal(h.gh.repos.get("acme/shop")!.pulls.length, pulls);
    // The dashboard's "open the setup pull request" is refused too.
    assert.equal((await call(owner.userId, "POST", `/v1/github/repositories/${REPOS.shop.id}/setup-pull-request`, owner.workspaceId)).statusCode, 409);
  });

  it("a removal and a sync at the same moment: the sync waits for the removal and creates no project", async () => {
    // The project back for this test (as Add again does), then a removal left uncommitted while the App syncs.
    await admin.query("update gh_repositories set excluded_at = null where repository_id = $1", [REPOS.shop.id]);
    await h.app.service.syncInstallation(INSTALLATION_ID);
    const id = (await projectOf(REPOS.shop.full_name))!;
    assert.ok(id);
    const u = new URL(ADMIN_URL); u.username = "fenvix_api"; u.password = "local-test-only";
    const remover = new pg.Client({ connectionString: u.toString() });
    await remover.connect();
    try {
      await remover.query("begin");
      await remover.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [owner.userId, owner.workspaceId]);
      assert.equal((await remover.query("select public.api_remove_project($1::uuid) as ok", [id])).rows[0].ok, true);
      let synced = false;
      const sync = h.app.service.syncInstallation(INSTALLATION_ID).then(() => { synced = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(synced, false, "the sync did not wait for the removal");
      await remover.query("commit");
      await sync;
    } finally {
      await remover.end();
    }
    assert.equal(await projectOf(REPOS.shop.full_name), null, "the sync created the project again");
    assert.ok(await excludedAt());
  });

  it("Add again: a member gets 403, another organization 404; the owner gets 202, sync_repository is queued and the project comes back", async () => {
    const url = `/v1/github/repositories/${REPOS.shop.id}/restore`;
    assert.equal((await call(memberId, "POST", url, owner.workspaceId)).statusCode, 403);
    assert.equal((await call(other.userId, "POST", url, other.workspaceId)).statusCode, 404);
    assert.ok(await excludedAt());
    queue.sent = [];
    const res = await call(owner.userId, "POST", url, owner.workspaceId);
    assert.equal(res.statusCode, 202, res.body);
    assert.equal((res.json() as { excludedAt: string | null }).excludedAt, null);
    assert.deepEqual(queue.sent, [{ kind: "sync_repository", repositoryId: REPOS.shop.id }]);
    assert.equal(await excludedAt(), null);
    await runWork(h.app.service, queue.sent[0]!);
    projectId = (await projectOf(REPOS.shop.full_name))!;
    assert.ok(projectId, "the project is back");
    // And its queued jobs start machines again (the control for the "no machine" checks).
    h.gh.addRun("acme/shop", 9702, { event: "push", headSha: "c".repeat(40), headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 972, runId: 9702, sha: "c".repeat(40), branch: "main" }));
    assert.equal(launcher.launches.length, 1);
  });

  it("DELETE /v1/organization: an admin and a member get 403; nothing changes", async () => {
    assert.equal((await call(adminId, "DELETE", "/v1/organization", owner.workspaceId)).statusCode, 403);
    assert.equal((await call(memberId, "DELETE", "/v1/organization", owner.workspaceId)).statusCode, 403);
    assert.equal((await admin.query("select count(*)::int as n from workspaces where id = $1", [owner.workspaceId])).rows[0].n, 1);
  });

  it("the owner deletes it: one uninstall_installation per installation, its rows gone, another organization untouched, the owner's login deleted", async () => {
    // A second installation of the organization (another GitHub account).
    h.gh.addInstallation({ id: OTHER_INSTALLATION, account: { login: "acme-two", id: 9002, type: "Organization" }, repos: [], selection: "selected" });
    await admin.query(`insert into gh_installations (installation_id, workspace_id, account_id, account_login, account_type) values ($1, $2, 9002, 'acme-two', 'Organization')`,
      [OTHER_INSTALLATION, owner.workspaceId]);
    await seedHistory(owner.workspaceId, projectId);
    // Removed from fenvix by this organization: that removal goes with the organization.
    await admin.query("update gh_repositories set excluded_at = now() where repository_id = $1", [REPOS.shop.id]);
    const otherBefore = (await admin.query("select count(*)::int as n from workspace_members where workspace_id = $1", [other.workspaceId])).rows[0].n;
    queue.sent = [];
    const res = await call(owner.userId, "DELETE", "/v1/organization", owner.workspaceId);
    assert.equal(res.statusCode, 204, res.body);
    assert.deepEqual(queue.sent.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
      { kind: "uninstall_installation", installationId: INSTALLATION_ID }, { kind: "uninstall_installation", installationId: OTHER_INSTALLATION },
    ]);
    assert.equal((await admin.query("select count(*)::int as n from workspaces where id = $1", [owner.workspaceId])).rows[0].n, 0);
    assert.equal((await admin.query("select count(*)::int as n from workspace_members where workspace_id = $1", [owner.workspaceId])).rows[0].n, 0);
    assert.equal((await admin.query("select count(*)::int as n from ci_projects where workspace_id = $1", [owner.workspaceId])).rows[0].n, 0);
    assert.equal((await admin.query("select count(*)::int as n from ci_subscriptions where workspace_id = $1", [owner.workspaceId])).rows[0].n, 0);
    assert.deepEqual((await admin.query("select workspace_id from gh_installations where installation_id = any($1::bigint[]) order by installation_id", [[INSTALLATION_ID, OTHER_INSTALLATION]])).rows,
      [{ workspace_id: null }, { workspace_id: null }]);
    assert.equal(await excludedAt(), null, "the organization's removal of the repository outlived it");
    // The owner belonged to no other organization: their login is gone. The member and the admin keep theirs.
    assert.equal((await admin.query("select count(*)::int as n from auth.users where id = $1", [owner.userId])).rows[0].n, 0);
    assert.equal((await admin.query("select count(*)::int as n from auth.users where id = any($1::uuid[])", [[memberId, adminId]])).rows[0].n, 2);
    // Another organization is untouched.
    assert.equal((await admin.query("select count(*)::int as n from workspaces where id = $1", [other.workspaceId])).rows[0].n, 1);
    assert.equal((await admin.query("select count(*)::int as n from workspace_members where workspace_id = $1", [other.workspaceId])).rows[0].n, otherBefore);
    // Its jobs start no machine any more (the installation is not linked).
    h.gh.addRun("acme/shop", 9701, { event: "push", headSha: "b".repeat(40), headBranch: "main", message: "x" });
    await h.send("workflow_job", workflowJob("queued", { id: 971, runId: 9701, sha: "b".repeat(40), branch: "main" }));
    assert.equal(launcher.launches.length, 1);
  });

  it("uninstall_installation: DELETE /app/installations/{id} once per message; GitHub's 404 counts as done; only a deleted organization's installation", async () => {
    const deletes = (id: number) => h.gh.exchanges.filter((x) => x.method === "DELETE" && x.path === `/app/installations/${id}`);
    const marked = async (id: number) => (await admin.query<{ uninstall_requested_at: Date | null }>("select uninstall_requested_at from gh_installations where installation_id = $1", [id])).rows[0]!.uninstall_requested_at;
    assert.ok(await marked(INSTALLATION_ID), "the deleted organization marked its installation");
    assert.equal(await h.app.service.uninstallInstallation(INSTALLATION_ID), "uninstalled");
    assert.equal(deletes(INSTALLATION_ID).length, 1);
    assert.equal(deletes(INSTALLATION_ID)[0]!.status, 204);
    assert.ok((await admin.query<{ deleted_at: Date | null }>("select deleted_at from gh_installations where installation_id = $1", [INSTALLATION_ID])).rows[0]!.deleted_at);
    assert.equal(await marked(INSTALLATION_ID), null);
    // The same message again (the queue delivers at least once): done already, GitHub is not asked again.
    await runWork(h.app.service, { kind: "uninstall_installation", installationId: INSTALLATION_ID });
    assert.equal(deletes(INSTALLATION_ID).length, 1);
    // Uninstalled on GitHub by the customer before the message ran: GitHub answers 404, the work is done, nothing throws.
    h.gh.installations.delete(OTHER_INSTALLATION);
    assert.equal(await h.app.service.uninstallInstallation(OTHER_INSTALLATION), "gone");
    assert.equal(deletes(OTHER_INSTALLATION).length, 1);
    assert.equal(deletes(OTHER_INSTALLATION)[0]!.status, 404);
    assert.equal(await marked(OTHER_INSTALLATION), null);
  });

  it("a forged uninstall_installation changes nothing: a never-linked installation, or one linked again before it ran", async () => {
    const deletes = () => h.gh.exchanges.filter((x) => x.method === "DELETE" && x.path.startsWith("/app/installations/")).length;
    const before = deletes();
    // Installed on GitHub, not linked to any organization yet (workspace_id null, no request).
    h.gh.addInstallation({ id: 4545, account: { login: "acme-three", id: 9003, type: "Organization" }, repos: [], selection: "selected" });
    await admin.query(`insert into gh_installations (installation_id, account_id, account_login, account_type) values (4545, 9003, 'acme-three', 'Organization')`);
    assert.equal(await h.app.service.uninstallInstallation(4545), "skipped");
    // Asked for by a deleted organization, then linked to another before the message ran.
    await admin.query("update gh_installations set uninstall_requested_at = now(), workspace_id = $1 where installation_id = 4545", [other.workspaceId]);
    assert.equal(await h.app.service.uninstallInstallation(4545), "skipped");
    assert.equal(deletes(), before);
    assert.equal((await admin.query("select uninstall_requested_at from gh_installations where installation_id = 4545")).rows[0].uninstall_requested_at, null);
  });

  it("a lost message: the sweep uninstalls a marked installation later", async () => {
    h.gh.addInstallation({ id: 4646, account: { login: "acme-four", id: 9004, type: "Organization" }, repos: [], selection: "selected" });
    await admin.query(`insert into gh_installations (installation_id, account_id, account_login, account_type, uninstall_requested_at) values (4646, 9004, 'acme-four', 'Organization', now() - interval '1 hour')`);
    await h.app.service.sweep();
    assert.equal(h.gh.exchanges.filter((x) => x.method === "DELETE" && x.path === "/app/installations/4646").length, 1);
    assert.ok((await admin.query("select deleted_at from gh_installations where installation_id = 4646")).rows[0].deleted_at);
  });

  it("a removal stays with its installation: the repository in another installation is not excluded there", async () => {
    await admin.query("update gh_repositories set excluded_at = now() where repository_id = $1", [REPOS.shop.id]);
    // Installed again by the same account (a new installation id), with the repository.
    const again = installationCreated([REPOS.shop]);
    (again.installation as Json).id = 4444;
    await h.send("installation", again);
    assert.equal(await excludedAt(), null);
  });

  it("an owner who belongs to another organization keeps their login", async () => {
    const second = await makeOrg(admin, "rd-second");
    await join(other.workspaceId, second.userId, "member");
    queue.sent = [];
    const res = await call(second.userId, "DELETE", "/v1/organization", second.workspaceId);
    assert.equal(res.statusCode, 204, res.body);
    assert.deepEqual(queue.sent, []);
    assert.equal((await admin.query("select count(*)::int as n from workspaces where id = $1", [second.workspaceId])).rows[0].n, 0);
    assert.equal((await admin.query("select count(*)::int as n from auth.users where id = $1", [second.userId])).rows[0].n, 1);
    assert.equal((await admin.query("select count(*)::int as n from workspace_members where user_id = $1", [second.userId])).rows[0].n, 1);
  });
});
