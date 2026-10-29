import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MongoClient } from "mongodb";
import { engineCredential, engineUserName } from "../../src/engine/credentials.ts";
import { engineName } from "../../src/engine/names.ts";
import { USER_ROLE } from "../../src/engine/users.ts";
import { sleep } from "../helpers/harness.ts";
import { GRANTABLE_ROLES } from "../helpers/engine-proc.ts";
import { SKIP, type World, cookie, engineHas, startWorld } from "./common.ts";

/**
 * Every user flow of the control plane against the engine of test5 engine-round2 (engine commit 3bcd7e5) started with
 * `--auth --grantable-roles=read,readWrite,dbAdmin`, as the provisioner `fenvix_provisioner` (custom role with createUser,
 * dropUser, viewUser, changePassword, changeCustomData, grantRole, revokeRole on admin). One test per item of the brief
 * (results-cp-engine-round2.md, part 2). Off unless ENGINE_E2E_BIN and ENGINE_E2E_GRANTABLE_ROLES are set.
 *
 * Each command is the control plane's own (src/engine/users.ts, MongoEngineUsers) or an API call; the checks read the
 * engine as root. Nothing here loosens the engine.
 */
const REGION = "eu-central-1";
const skip = SKIP || (GRANTABLE_ROLES ? false : "set ENGINE_E2E_GRANTABLE_ROLES (e.g. read,readWrite,dbAdmin) to run the engine with --grantable-roles");

describe("engine-real: the control plane's user flows with --auth and --grantable-roles (engine-round2)", { skip }, () => {
  let w: World;
  const clients: MongoClient[] = [];
  type Created = { id: string; connectionString: string; initialUser: { username: string; password: string; connectionString: string } };
  const code = async (p: Promise<unknown>) => p.then(() => 0, (e: { code?: number }) => e.code ?? -1);
  const asRoot = async <T>(f: (c: MongoClient) => Promise<T>) => { const r = w.e.rootClient(); try { return await f(r); } finally { await r.close(); } };
  const usersOn = (db: string) => asRoot(async (r) => (await r.db(db).command({ usersInfo: 1, showCustomData: true })).users as
    { user: string; db: string; roles: { role: string; db: string }[]; customData?: { fenvix?: Record<string, unknown> } }[]);
  const create = async (name: string): Promise<Created> => {
    const d = await w.settle(await w.h.as(w.u).post("/databases", { name, region: REGION }, cookie));
    assert.ok([200, 201].includes(d.status), JSON.stringify(d.body));
    return (d.body.result ?? d.body) as Created;
  };
  const local = (cs: string) => { const u = new URL(cs); u.host = `localhost:${w.e.dataAddr.split(":")[1]}`; return u.toString(); };
  const driver = (cs: string) => { const c = new MongoClient(local(cs), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 4000 }); clients.push(c); return c; };
  const provisioner = () => { const c = w.e.clientAs({ ...w.e.provisioner, authSource: "admin" }); clients.push(c); return c; };

  before(async () => {
    const base = JSON.parse(readFileSync(new URL("../../config/limits.json", import.meta.url), "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "fenvix-limits-"));
    writeFileSync(join(dir, "limits.json"), JSON.stringify({ ...base, userChangesPerMinute: 10_000, userListsPerMinute: 10_000 }));
    w = await startWorld({ LIMITS_FILE: join(dir, "limits.json") });
  });
  after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await w?.close();
  });

  test("0. the flag is in force: the provisioner may not grant dbOwner, a role on admin or its own role (13)", async () => {
    const d = await create("gr-flag");
    const db = engineName(d.id);
    const p = provisioner();
    const pwd = "Grant-test-password-0123456789";
    for (const roles of [[{ role: "dbOwner", db }], [{ role: "userAdmin", db }], [{ role: "readWrite", db: "admin" }], [{ role: "fenvix_provisioner", db: "admin" }]]) {
      assert.equal(await code(p.db(db).command({ createUser: "gr_x", pwd, roles })), 13, JSON.stringify(roles));
    }
    assert.equal(await code(p.db("admin").command({ createUser: "gr_x", pwd, roles: [] })), 13, "no user on admin");
    assert.deepEqual((await usersOn(db)).map((u) => u.user).sort(), ["app", engineUserName(d.id)]);
  });

  test("1. ensure of cp_<id>: createUser (create) and updateUser (repeat), one role USER_ROLE on its own db_<hex>", async () => {
    const d = await create("gr-ensure");
    const db = engineName(d.id);
    const own = () => usersOn(db).then((us) => us.find((u) => u.user === engineUserName(d.id)));
    assert.deepEqual((await own())!.roles, [{ role: USER_ROLE, db }], "made by the create (createUser)");
    // The repeat goes the updateUser way (51003 user exists -> updateUser with pwd, roles, customData).
    await w.users.ensure(d.id, REGION);
    assert.deepEqual((await own())!.roles, [{ role: USER_ROLE, db }]);
    // A changed user is repaired by ensure (updateUser puts the role back).
    await asRoot((r) => r.db(db).command({ updateUser: engineUserName(d.id), roles: [{ role: "read", db }] }));
    await w.users.ensure(d.id, REGION);
    assert.deepEqual((await own())!.roles, [{ role: USER_ROLE, db }], "repaired by updateUser");
    const cp = w.e.clientAs(engineCredential(w.h.cfg.engineUsers!.current, d.id));
    clients.push(cp);
    await cp.db(db).collection("probe").insertOne({ ok: 1 });
  });

  test("2. customer users with readWrite and read (create, role change, password, list, drop)", async () => {
    const d = await create("gr-customers");
    const db = engineName(d.id);
    const now = new Date().toISOString();
    const pwRW = "Customer-rw-password-0123456789", pwR = "Customer-r-password-0123456789";
    await w.users.createCustomer(d.id, REGION, { username: "rw", role: "readWrite", password: pwRW, createdAt: now });
    await w.users.createCustomer(d.id, REGION, { username: "ro", role: "read", password: pwR, createdAt: now });
    const roles = async () => Object.fromEntries((await usersOn(db)).map((u) => [u.user, u.roles]));
    assert.deepEqual((await roles()).rw, [{ role: "readWrite", db }]);
    assert.deepEqual((await roles()).ro, [{ role: "read", db }]);
    const ro = w.e.clientAs({ username: "ro", password: pwR, authSource: db });
    clients.push(ro);
    assert.equal(await code(ro.db(db).collection("c").findOne({})), 0);
    assert.equal(await code(ro.db(db).collection("c").insertOne({ x: 1 })), 13, "read cannot write");
    // ensureCustomer on an existing name: updateUser with pwd and roles (read -> readWrite).
    await w.users.ensureCustomer(d.id, REGION, { username: "ro", role: "readWrite", password: pwR, createdAt: now });
    assert.deepEqual((await roles()).ro, [{ role: "readWrite", db }]);
    await w.users.setCustomerPassword(d.id, REGION, "rw", "Customer-rw-password-new-0123456");
    const rw = w.e.clientAs({ username: "rw", password: "Customer-rw-password-new-0123456", authSource: db });
    clients.push(rw);
    assert.equal(await code(rw.db(db).collection("c").insertOne({ x: 1 })), 0);
    assert.deepEqual((await w.users.listCustomer(d.id, REGION)).map((u) => [u.username, u.role]), [["app", "readWrite"], ["ro", "readWrite"], ["rw", "readWrite"]]);
    assert.deepEqual(await w.users.dropCustomer(d.id, REGION, "ro"), { dropped: true });
    // Through the API as well.
    const api = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "reader", role: "read" }, cookie);
    assert.equal(api.statusCode, 201, api.body);
    assert.deepEqual((await roles()).reader, [{ role: "read", db }]);
  });

  test("3. lockCustomers (updateUser with roles []) and unlockCustomers (roles given back)", async () => {
    const d = await create("gr-lock");
    const db = engineName(d.id);
    await w.users.createCustomer(d.id, REGION, { username: "ro", role: "read", password: "Customer-r-password-0123456789", createdAt: new Date().toISOString() });
    const open = driver(d.initialUser.connectionString);
    await open.db().collection("k").insertOne({ _id: 1 } as never);
    assert.equal(await w.users.lockCustomers(d.id, REGION), 2);
    const locked = Object.fromEntries((await usersOn(db)).map((u) => [u.user, u]));
    assert.deepEqual(locked.app!.roles, []);
    assert.deepEqual(locked.ro!.roles, []);
    assert.deepEqual(locked.app!.customData?.fenvix?.lockedRoles, [{ role: "readWrite", db }]);
    assert.deepEqual(locked[engineUserName(d.id)]!.roles, [{ role: USER_ROLE, db }], "cp_<id> is not locked");
    assert.equal(await code(open.db().collection("k").findOne({})), 13, "locked: the open connection is refused");
    assert.equal(await w.users.unlockCustomers(d.id, REGION), 2);
    const back = Object.fromEntries((await usersOn(db)).map((u) => [u.user, u]));
    assert.deepEqual(back.app!.roles, [{ role: "readWrite", db }]);
    assert.deepEqual(back.ro!.roles, [{ role: "read", db }]);
    assert.equal(back.app!.customData?.fenvix?.lockedRoles, undefined);
    assert.deepEqual(await open.db().collection("k").findOne({}), { _id: 1 });
  });

  test("4. usersInfo forAllDBs on admin (the user sweep's list)", async () => {
    const d = await create("gr-list");
    const listed = await w.users.list(REGION);
    assert.ok(listed.some((u) => u.id === d.id), "cp_<id> of the new database is listed");
    assert.ok(listed.every((u) => typeof u.id === "string"));
  });

  test("5. drop of every user before the erase (dropAll), then the erase", async () => {
    const d = await create("gr-dropall");
    const db = engineName(d.id);
    await w.users.createCustomer(d.id, REGION, { username: "rw", role: "readWrite", password: "Customer-rw-password-0123456789", createdAt: new Date().toISOString() });
    assert.equal(await w.users.dropAll(d.id, REGION), 3, "app, rw and cp_<id>");
    assert.deepEqual(await usersOn(db), []);
    assert.equal(await w.users.dropAll(d.id, REGION), 0, "repeatable");
    // And the erase through the API (lock, engine erase, dropAll).
    const e = await create("gr-erase");
    const done = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [e.id] }, cookie));
    assert.deepEqual(done.body.result ?? done.body, { affected: 1 });
    assert.equal(await engineHas(w.e, engineName(e.id)), false);
    assert.deepEqual(await usersOn(engineName(e.id)), []);
  });

  test("6. fork: the fork gets its own cp_<id> and app (createUser on the fork's database)", async () => {
    const d = await create("gr-fork-src");
    await driver(d.initialUser.connectionString).db().collection("k").insertOne({ _id: "src" } as never);
    const f = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/fork`, { name: "gr-fork" }, cookie));
    assert.ok([200, 201].includes(f.status), JSON.stringify(f.body));
    const fork = (f.body.result ?? f.body) as Created;
    const fdb = engineName(fork.id);
    const us = await usersOn(fdb);
    assert.deepEqual(us.map((u) => [u.user, u.roles]).sort(), [["app", [{ role: "readWrite", db: fdb }]], [engineUserName(fork.id), [{ role: USER_ROLE, db: fdb }]]].sort());
    assert.deepEqual(await driver(fork.initialUser.connectionString).db().collection("k").findOne({}), { _id: "src" });
    for (const id of [fork.id, d.id]) await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [id] }, cookie));
  });

  test("7. restore: back to the point, users unchanged", async () => {
    const d = await create("gr-restore");
    const db = engineName(d.id);
    const app = driver(d.initialUser.connectionString);
    await app.db().collection("h").insertOne({ _id: "before" } as never);
    await sleep(1500);
    const at = new Date().toISOString();
    await sleep(1500);
    await app.db().collection("h").insertOne({ _id: "after" } as never);
    const usersBefore = (await usersOn(db)).map((u) => [u.user, u.roles]);
    const done = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/restore`, { at }, cookie));
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
    const again = driver(d.initialUser.connectionString);
    assert.deepEqual((await again.db().collection("h").find().toArray()).map((x) => x._id), ["before"]);
    assert.deepEqual((await usersOn(db)).map((u) => [u.user, u.roles]), usersBefore);
  });

  test("8. usage counters: tenantStats is root only (the control plane reads usage from the admin port, never tenantStats)", async () => {
    const d = await create("gr-stats");
    const db = engineName(d.id);
    assert.equal(await asRoot((r) => code(r.db("admin").command({ tenantStats: 1 }))), 0, "root");
    assert.equal(await code(provisioner().db("admin").command({ tenantStats: 1 })), 13, "the provisioner");
    const cp = w.e.clientAs(engineCredential(w.h.cfg.engineUsers!.current, d.id));
    clients.push(cp);
    assert.equal(await code(cp.db(db).command({ tenantStats: 1 })), 13, "cp_<id> (Data Explorer)");
    assert.equal(await code(driver(d.initialUser.connectionString).db().command({ tenantStats: 1 })), 13, "a customer user");
    // The usage sync works without it: the adapter reads GET /v1/databases/{db}/usage on the admin port (bearer token).
    const u = await w.engine.usage({ id: d.id, from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(typeof u.storageBytes, "number");
    assert.ok(Array.isArray(u.buckets));
  });
});
