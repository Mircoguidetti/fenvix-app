// "Cache warm since <commit>" through the dashboard API (GET /projects, /projects/{id}, /github/repositories) against
// the local Supabase: real tokens, the API as fenvix_api, row level security on gh_warmups.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import type { Api } from "../../src/api/server.ts";
import { admin as adminClient, at, call, githubId, type Person, signUp, SKIP, startApi } from "../api/helpers.ts";
import { type Seeded, seedOrg } from "../api/seed.ts";

describe("dashboard API: the shared cache of each repository (warm-ups)", { skip: SKIP }, () => {
  let admin: pg.Client;
  let api: Api;
  let ownerA: Person; let ownerB: Person;
  let A: Seeded; let B: Seeded;
  const shaA = "a1".repeat(20); const shaNext = "b2".repeat(20); const shaWeb = "c3".repeat(20); const shaB = "d4".repeat(20);

  before(async () => {
    admin = await adminClient();
    ({ api } = await startApi());
    ownerA = await signUp(admin, "warm-a", "Wanda Warm");
    ownerB = await signUp(admin, "warm-b", "Bert Other");
    A = await seedOrg(admin, ownerA.workspaceId, `warm-${githubId()}`);
    B = await seedOrg(admin, ownerB.workspaceId, `cold-${githubId()}`);
    const q = (sql: string, p: unknown[]) => admin.query(sql, p);
    // A's shop: warm since shaA (a warm-up), and a warm-up running for the next commit.
    await q("update gh_repositories set cache_warm_sha = $2, cache_warm_at = $3, cache_warm_source = 'warmup', cache_warm_pushed_at = $3 where repository_id = $1", [A.repoIds.shop, shaA, at(1)]);
    await q(`insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, detail, finished_at) values
               ($1, $2, $3, 'refs/heads/main', 'onboarded', 'succeeded', 'the cache holds this commit''s proofs', now()),
               ($1, $2, $4, 'refs/heads/main', 'push', 'running', 'running the test job', null)`, [A.repoIds.shop, A.installationId, shaA, shaNext]);
    // A's web: its last warm-up was not possible.
    await q(`insert into gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status, detail, finished_at) values
               ($1, $2, $3, 'refs/heads/main', 'push', 'unsupported', 'the job needs the outputs of job build', now())`, [A.repoIds.web, A.installationId, shaWeb]);
    // B's shop: warm from the customer's own run.
    await q("update gh_repositories set cache_warm_sha = $2, cache_warm_at = $3, cache_warm_source = 'run', cache_warm_pushed_at = $3 where repository_id = $1", [B.repoIds.shop, shaB, at(2)]);
  });
  after(async () => { await api?.close(); await admin?.end(); });

  it("GET /github/repositories: warming (warm since one commit, a warm-up running for the next), not possible, cold", async () => {
    const r = await call(api, "listGitHubRepositories", { token: ownerA.token, ws: ownerA.workspaceId });
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.items.map((x: { repositoryId: number; warmCache: unknown }) => [x.repositoryId, x.warmCache]));
    assert.deepEqual(by[A.repoIds.shop], {
      state: "warming", commitSha: shaA, warmAt: at(1).toISOString(), source: "warmup",
      warmup: { status: "running", commitSha: shaNext, detail: "running the test job", updatedAt: by[A.repoIds.shop].warmup.updatedAt },
    });
    assert.equal(by[A.repoIds.web].state, "cold");
    assert.deepEqual({ status: by[A.repoIds.web].warmup.status, detail: by[A.repoIds.web].warmup.detail }, { status: "unsupported", detail: "the job needs the outputs of job build" });
    assert.deepEqual(by[A.repoIds.loose], { state: "cold", commitSha: null, warmAt: null, source: null, warmup: null });
  });

  it("GET /projects and /projects/{id}: the same state on each project", async () => {
    const l = await call(api, "listProjects", { token: ownerA.token, ws: ownerA.workspaceId });
    const shop = l.body.items.find((p: { id: string }) => p.id === A.projects.shop);
    assert.equal(shop.warmCache.state, "warming");
    assert.equal(shop.warmCache.commitSha, shaA);
    const one = await call(api, "getProject", { token: ownerA.token, ws: ownerA.workspaceId, params: { projectId: A.projects.shop } });
    assert.deepEqual(one.body.warmCache, shop.warmCache);
    const b = await call(api, "getProject", { token: ownerB.token, ws: ownerB.workspaceId, params: { projectId: B.projects.shop } });
    assert.deepEqual({ ...b.body.warmCache, warmAt: null }, { state: "warm", commitSha: shaB, warmAt: null, source: "run", warmup: null });
  });

  it("another organization's warm-ups are invisible (row level security as fenvix_api)", async () => {
    const r = await call(api, "listGitHubRepositories", { token: ownerB.token, ws: ownerB.workspaceId });
    for (const x of r.body.items as { warmCache: { commitSha: string | null; warmup: { commitSha: string } | null } }[]) {
      assert.notEqual(x.warmCache.commitSha, shaA);
      assert.equal(x.warmCache.warmup, null, "B has no warm-up; A's never show");
    }
    assert.equal((await call(api, "listGitHubRepositories", { token: ownerB.token, ws: ownerA.workspaceId })).status, 404);
  });
});
