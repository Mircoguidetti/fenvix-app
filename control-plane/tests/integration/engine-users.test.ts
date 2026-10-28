import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";
import { FakeEngineUsers } from "../../src/engine/users.ts";
import { reconcileEngineUsers } from "../../src/services/engine-users.ts";

/**
 * The life of each database's engine user, with the in-memory engine and users: made with create and fork, dropped with
 * erase, given back when an erase is refused, a create that cannot make its user erases what it made, a clean-up that
 * cannot reach the engine waits, and the sweep. The same paths run against the real engine in tests/engine-real/.
 */
let h: Harness;
let u: Fixture;
const users = new FakeEngineUsers();
before(async () => { h = await startHarness({}, { usersFactory: () => users }); u = await h.user("Users"); });
after(async () => { await h.close(); });

const create = async (name: string) => {
  const r = await h.as(u).post("/databases", { name, region: "eu-central-1" });
  assert.equal(r.statusCode, 201, r.body);
  return json(r) as { id: string };
};
const sweep = async () => {
  await h.admin.query("update public.operations set retry_at = now() where status = 'queued'");
  await h.app.deps.runner.sweepOnce();
};
const row = async (id: string) => (await h.admin.query("select engine_state from public.databases where id = $1", [id])).rows[0] as { engine_state: string } | undefined;

describe("per-database engine users", () => {
  test("create makes the database's user; fork makes a new one for the fork; erase drops it", async () => {
    const a = await create("users-a");
    assert.equal(users.users.get(a.id), "v1");
    const f = json(await h.as(u).post(`/databases/${a.id}/fork`, { name: "users-a-fork" }));
    assert.ok(users.users.has(f.id) && f.id !== a.id);
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [f.id, a.id] })), { affected: 2 });
    assert.equal(users.users.has(a.id), false);
    assert.equal(users.users.has(f.id), false);
  });

  test("an erase the engine refuses for good gives the user back, and the database stays ready", async () => {
    const a = await create("users-refused");
    h.engine.failNext("erase", "conflict");
    const r = await h.as(u).post("/databases/erase", { ids: [a.id] });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal((await row(a.id))!.engine_state, "ready");
    assert.equal(users.users.get(a.id), "v1", "the user was made again");
  });

  test("a user that cannot be made fails the create, and the engine's database is erased", async () => {
    const erases = h.engine.effects.erase;
    users.failNext("ensure", "invalid");
    const r = await h.as(u).post("/databases", { name: "users-cannot", region: "eu-central-1" });
    assert.equal(r.statusCode, 400, r.body);
    const id = (await h.admin.query("select database_id from public.operations where id = $1", [r.headers["operation-id"]])).rows[0].database_id;
    assert.equal(await row(id), undefined);
    assert.equal(h.engine.dbs.has(id), false);
    assert.equal(h.engine.effects.erase, erases + 1);
    assert.equal(users.users.has(id), false);
  });

  test("a user that cannot be made YET is retried: one database, one user", async () => {
    users.failNext("ensure", "unavailable");
    const r = await h.as(u).post("/databases", { name: "users-later", region: "eu-central-1" });
    assert.equal(r.statusCode, 202, r.body);
    const id = (await h.admin.query("select database_id from public.operations where id = $1", [r.headers["operation-id"]])).rows[0].database_id;
    await sweep();
    assert.equal((await row(id))!.engine_state, "ready");
    assert.ok(users.users.has(id));
  });

  test("when the clean-up cannot reach the engine, the failure is kept and the clean-up retried; then it is failed", async () => {
    users.failNext("ensure", "invalid");
    h.engine.failNext("erase", "unavailable");
    const r = await h.as(u).post("/databases", { name: "users-cleanup", region: "eu-central-1" });
    assert.equal(r.statusCode, 202, r.body);
    const opId = String(r.headers["operation-id"]);
    const id = (await h.admin.query("select database_id from public.operations where id = $1", [opId])).rows[0].database_id;
    let op = (await h.admin.query("select status, params from public.operations where id = $1", [opId])).rows[0];
    assert.equal(op.status, "queued");
    assert.equal(op.params.pendingFailure.code, "validation_failed");
    assert.equal((await row(id))!.engine_state, "provisioning");
    assert.ok(h.engine.dbs.has(id));
    assert.equal(json(await h.as(u).get("/databases?search=users-cleanup")).items.length, 0);
    await sweep();
    op = (await h.admin.query("select status, error from public.operations where id = $1", [opId])).rows[0];
    assert.equal(op.status, "failed");
    assert.equal(op.error.code, "validation_failed");
    assert.equal(await row(id), undefined);
    assert.equal(h.engine.dbs.has(id), false);
  });

  test("a restore whose user check fails is still a restore (the sweep repairs users)", async () => {
    const a = await create("users-restore");
    await h.admin.query("update public.databases set created_at = now() - interval '1 hour' where id = $1", [a.id]);
    users.failNext("ensure", "unavailable");
    const r = await h.as(u).post(`/databases/${a.id}/restore`, { at: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(h.logs.text(), /could not check the database's engine user after a restore/);
  });

  test("the sweep: orphans dropped, missing users made, users on another key version moved to the current one", async () => {
    const keep = await create("users-sweep-keep");
    const missing = await create("users-sweep-missing");
    const old = await create("users-sweep-old");
    const orphan = randomUUID();
    users.users.set(orphan, "v1");
    users.users.delete(missing.id);
    users.users.set(old.id, "v0");
    const out = await reconcileEngineUsers(h.app.deps.s);
    assert.ok(out.dropped >= 1 && out.created >= 1 && out.rotated >= 1 && out.failed === 0, JSON.stringify(out));
    assert.equal(users.users.has(orphan), false);
    assert.equal(users.users.get(missing.id), "v1");
    assert.equal(users.users.get(old.id), "v1");
    assert.equal(users.users.get(keep.id), "v1");
    assert.deepEqual(await reconcileEngineUsers(h.app.deps.s), { dropped: 0, created: 0, rotated: 0, failed: 0 });
  });

  test("the Data Explorer's filter with a $regex runs with the regex time limit (2000 ms by default)", async () => {
    const a = await create("users-regex");
    const base = `/databases/${a.id}/data/collections/items/documents`;
    assert.equal((await h.as(u).get(`${base}?filter=${encodeURIComponent('{"n":1}')}`)).statusCode, 200);
    assert.equal(h.data.lastMaxTimeMS, 10_000);
    assert.equal((await h.as(u).get(`${base}?filter=${encodeURIComponent('{"name":{"$regex":"^a","$options":"i"}}')}`)).statusCode, 200);
    assert.equal(h.data.lastMaxTimeMS, 2000);
  });
});
