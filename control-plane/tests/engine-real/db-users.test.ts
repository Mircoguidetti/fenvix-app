import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MongoClient } from "mongodb";
import { engineUserName } from "../../src/engine/credentials.ts";
import { engineName } from "../../src/engine/names.ts";
import { reconcileEngineUsers } from "../../src/services/engine-users.ts";
import { json, sleep } from "../helpers/harness.ts";
import { SKIP, type World, cookie, engineHas, secretsOf, startWorld } from "./common.ts";

/**
 * A database's own users (docs/database-users.md) against the REAL engine: the connection string the control plane
 * gives a customer, used by the official Node.js driver as a customer's application would, connects, writes and reads;
 * a customer user cannot reach another database; roles are exactly the fixed list; reset and delete act at once; fork,
 * restore, erase (with and without a refusal) and the sweep; and no password anywhere it should not be.
 *
 * With two engine binaries (no fused branch) the users and the data written through them live in the "auth" process,
 * while fork / restore / erase of the data act on the "admin" process: the checks below say which process they prove.
 */
describe("engine-real: database users", { skip: SKIP }, () => {
  let w: World;
  const shown: string[] = [];
  const bodies: string[] = [];
  const clients: MongoClient[] = [];

  type Created = { id: string; name: string; host: string; connectionString: string; initialUser: { username: string; role: string; password: string; connectionString: string } };
  const create = async (name: string, extra: Record<string, unknown> = {}): Promise<Created> => {
    const res = await w.h.as(w.u).post("/databases", { name, region: "eu-central-1", ...extra }, cookie);
    bodies.push(res.body);
    assert.equal(res.statusCode, 201, res.body);
    const d = json(res) as Created;
    shown.push(d.initialUser.password);
    return d;
  };
  /**
   * The connection string exactly as the control plane wrote it, with only the host and port pointed at the local test
   * engine (the real host is a DNS name of the deployment). User, password, database, authSource, TLS and mechanism
   * are the control plane's. The CA is the test's throw-away CA.
   */
  const local = (cs: string) => {
    const u = new URL(cs);
    assert.equal(u.protocol, "mongodb:");
    u.host = `localhost:${w.e.dataAddr.split(":")[1]}`;
    return u.toString();
  };
  const driver = (cs: string) => {
    const c = new MongoClient(local(cs), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 4000 });
    clients.push(c);
    return c;
  };
  const code = async (p: Promise<unknown>) => p.then(() => 0, (e: { code?: number }) => e.code ?? -1);
  const usersOn = async (db: string) => {
    const r = w.e.rootClient();
    try { return ((await r.db(db).command({ usersInfo: 1 })).users as { user: string; db: string; roles: { role: string; db: string }[] }[]); } finally { await r.close(); }
  };

  before(async () => {
    // The per-person limit on user changes (10 a minute) is tested with the in-memory engine; this suite makes more.
    const base = JSON.parse(readFileSync(new URL("../../config/limits.json", import.meta.url), "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "fenvix-limits-"));
    writeFileSync(join(dir, "limits.json"), JSON.stringify({ ...base, userChangesPerMinute: 10_000, userListsPerMinute: 10_000 }));
    w = await startWorld({ LIMITS_FILE: join(dir, "limits.json") });
  });
  after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await w?.close();
  });

  test("the connection string of a new database connects, writes and reads with the official driver", async () => {
    const d = await create("conn-proof-01");
    const db = engineName(d.id);
    assert.equal(d.initialUser.connectionString,
      `mongodb://app:${d.initialUser.password}@${d.host}:27018/${db}?tls=true&authSource=${db}&authMechanism=SCRAM-SHA-256`);
    const c = driver(d.initialUser.connectionString);
    // No database or credential given in code: everything comes from the string (the driver's default database is the path).
    const coll = c.db().collection("orders");
    assert.equal(c.db().databaseName, db);
    await coll.insertOne({ _id: "o-1", total: 42 } as never);
    await coll.updateOne({ _id: "o-1" } as never, { $inc: { total: 1 } });
    assert.deepEqual(await coll.findOne({ _id: "o-1" } as never), { _id: "o-1", total: 43 });
    await coll.createIndex({ total: 1 });
    assert.equal(await coll.countDocuments(), 1);
    // The engine holds the user exactly as made: on the database itself, one role from the fixed list, on that database.
    const app = (await usersOn(db)).find((x) => x.user === "app")!;
    assert.deepEqual(app.roles, [{ role: "readWrite", db }]);
    // The string without TLS is refused by the engine.
    const plain = new MongoClient(local(d.initialUser.connectionString).replace("tls=true", "tls=false"), { serverSelectionTimeoutMS: 2000 });
    clients.push(plain);
    assert.notEqual(await code(plain.db().collection("orders").findOne({})), 0);
  });

  test("a user made through the API (role read) can read and not write; listing never shows cp_ or a password", async () => {
    const d = await create("conn-read-01");
    const writer = driver(d.initialUser.connectionString);
    await writer.db().collection("items").insertOne({ _id: 1 } as never);
    const r = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "reporting", role: "read" }, cookie);
    bodies.push(r.body);
    assert.equal(r.statusCode, 201, r.body);
    const b = json(r);
    shown.push(b.password);
    const reader = driver(b.connectionString);
    assert.deepEqual(await reader.db().collection("items").findOne({}), { _id: 1 });
    assert.equal(await code(reader.db().collection("items").insertOne({ _id: 2 } as never)), 13);
    const listed = await w.h.as(w.u).get(`/databases/${d.id}/users`);
    bodies.push(listed.body);
    assert.deepEqual(json(listed).items.map((x: { username: string; role: string }) => [x.username, x.role]), [["app", "readWrite"], ["reporting", "read"]]);
    assert.ok(!listed.body.includes(engineUserName(d.id)));
    assert.deepEqual((await usersOn(engineName(d.id))).find((x) => x.user === "reporting")!.roles, [{ role: "read", db: engineName(d.id) }]);
  });

  test("a customer user of A can do nothing on B: every command refused by the engine; B unchanged", async () => {
    const a = await create("iso-a-01");
    const b = await create("iso-b-01");
    const ub = driver(b.initialUser.connectionString);
    await ub.db().collection("items").insertMany([{ _id: "b1", secret: "B" }, { _id: "b2", secret: "B" }] as never);
    const ua = driver(a.initialUser.connectionString);
    const B = engineName(b.id);
    for (const [what, p] of [
      ["find", () => ua.db(B).collection("items").findOne({})],
      ["insert", () => ua.db(B).collection("items").insertOne({ _id: "evil" } as never)],
      ["update", () => ua.db(B).collection("items").updateMany({}, { $set: { secret: "A" } })],
      ["delete", () => ua.db(B).collection("items").deleteMany({})],
      ["drop", () => ua.db(B).collection("items").drop()],
      ["dropDatabase", () => ua.db(B).dropDatabase()],
      ["listCollections", () => ua.db(B).command({ listCollections: 1 })],
      ["createUser on B", () => ua.db(B).command({ createUser: "x-evil", pwd: "x".repeat(40), roles: [{ role: "readWrite", db: B }] })],
      ["createUser on A", () => ua.db().command({ createUser: "x-evil", pwd: "x".repeat(40), roles: [{ role: "readWrite", db: engineName(a.id) }] })],
      ["grantRoles", () => ua.db().command({ grantRolesToUser: "app", roles: [{ role: "readWrite", db: B }] })],
      ["$out to B", () => ua.db().collection("x").aggregate([{ $match: {} }, { $out: { db: B, coll: "items" } }]).toArray()],
      ["system.users", () => ua.db("admin").collection("system.users").find().toArray()],
    ] as const) {
      assert.equal(await code((p as () => Promise<unknown>)()), 13, what);
    }
    // A's user named with B as its authSource does not exist there.
    const wrongSource = new MongoClient(local(a.initialUser.connectionString).replace(`authSource=${engineName(a.id)}`, `authSource=${B}`), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 3000 });
    clients.push(wrongSource);
    assert.equal(await code(wrongSource.db(B).collection("items").findOne({})), 18);
    const dbs = (await ua.db("admin").admin().listDatabases({ nameOnly: true }).catch((e) => ({ databases: [], err: e }))).databases.map((x: { name: string }) => x.name);
    assert.ok(!dbs.includes(B), "B is not listed for A's user");
    assert.deepEqual((await ub.db().collection("items").find().sort({ _id: 1 }).toArray()), [{ _id: "b1", secret: "B" }, { _id: "b2", secret: "B" }]);
  });

  test("hostile requests never reach the engine as more powerful roles", async () => {
    const d = await create("hostile-01");
    for (const body of [
      { username: "hx", role: "root" }, { username: "hx", role: "dbOwner" }, { username: "hx", role: "userAdmin" },
      { username: "hx", role: { role: "readWrite", db: "admin" } }, { username: "hx", role: "readWrite", roles: [{ role: "root", db: "admin" }] },
      { username: "hx", role: "readWrite", db: "admin" }, { username: "cp_x", role: "read" }, { username: "admin", role: "read" },
    ]) {
      const r = await w.h.as(w.u).post(`/databases/${d.id}/users`, body, cookie);
      bodies.push(r.body);
      assert.equal(r.statusCode, 400, `${JSON.stringify(body)}: ${r.body}`);
    }
    const all = await usersOn(engineName(d.id));
    assert.deepEqual(all.map((x) => x.user).sort(), ["app", engineUserName(d.id)].sort());
    for (const u of all) assert.ok(u.roles.every((r) => ["readWrite", "read"].includes(r.role) && r.db === engineName(d.id)), JSON.stringify(u));
  });

  test("reset: the new password works, the old one no longer authenticates; delete: an open connection is cut at once", async () => {
    const d = await create("reset-del-01");
    const before = driver(d.initialUser.connectionString);
    await before.db().collection("k").insertOne({ _id: 1 } as never);
    const r = await w.h.as(w.u).post(`/databases/${d.id}/users/app/reset-password`, undefined, cookie);
    bodies.push(r.body);
    assert.equal(r.statusCode, 200, r.body);
    const next = json(r);
    shown.push(next.password);
    const old = new MongoClient(local(d.initialUser.connectionString), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 3000 });
    clients.push(old);
    assert.equal(await code(old.db().collection("k").findOne({})), 18, "a new connection with the old password is refused");
    const fresh = driver(next.connectionString);
    assert.deepEqual(await fresh.db().collection("k").findOne({}), { _id: 1 });
    // What a reset does NOT do: a connection that authenticated before the reset stays authenticated (as in MongoDB).
    const stillOpen = await code(before.db().collection("k").findOne({}));
    assert.equal(stillOpen, 0, "documented: a reset does not end sessions already open; delete the user to cut them");

    const del = await w.h.as(w.u).del(`/databases/${d.id}/users/app`, cookie);
    bodies.push(del.body);
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(await code(fresh.db().collection("k").findOne({})), 13, "the open connection loses its rights on its next command");
    assert.equal(await code(before.db().collection("k").findOne({})), 13);
    const again = new MongoClient(local(next.connectionString), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 3000 });
    clients.push(again);
    assert.equal(await code(again.db().collection("k").findOne({})), 18);
    assert.equal((await usersOn(engineName(d.id))).some((x) => x.user === "app"), false);
  });

  test("fork: the fork has a new `app` with a new password; the source's users have no right on it, and the reverse", async () => {
    const src = await create("fork-src-01");
    const extra = await w.h.as(w.u).post(`/databases/${src.id}/users`, { username: "src-only", role: "readWrite" }, cookie);
    shown.push(json(extra).password);
    const done = await w.settle(await w.h.as(w.u).post(`/databases/${src.id}/fork`, { name: "fork-copy-01" }, cookie));
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
    const f = (done.body.result ?? done.body) as Created;
    assert.ok(f.initialUser.password, "the fork's password was shown in the fork's answer");
    shown.push(f.initialUser.password);
    assert.notEqual(f.initialUser.password, src.initialUser.password);
    assert.deepEqual((await usersOn(engineName(f.id))).map((x) => x.user).sort(), ["app", engineUserName(f.id)].sort(), "no user of the source is copied");
    const fu = driver(f.initialUser.connectionString);
    await fu.db().collection("own").insertOne({ _id: "fork" } as never);
    const su = driver(src.initialUser.connectionString);
    assert.equal(await code(su.db(engineName(f.id)).collection("own").findOne({})), 13, "source app on the fork");
    assert.equal(await code(driver(json(extra).connectionString).db(engineName(f.id)).collection("own").findOne({})), 13, "source extra user on the fork");
    assert.equal(await code(fu.db(engineName(src.id)).collection("x").findOne({})), 13, "fork app on the source");
    // The source's password names the source's user (authSource = the source): on the fork it does not exist.
    const wrong = new MongoClient(local(f.initialUser.connectionString).replace(f.initialUser.password, src.initialUser.password), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 3000 });
    clients.push(wrong);
    assert.equal(await code(wrong.db().collection("own").findOne({})), 18);
  });

  test("restore leaves the users as they are (a user made after the restore point still works)", async () => {
    const d = await create("restore-users-01");
    await sleep(1500);
    const point = new Date().toISOString();
    await sleep(1500);
    const later = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "after-point", role: "readWrite" }, cookie);
    shown.push(json(later).password);
    const done = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/restore`, { at: point }, cookie));
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
    const c = driver(json(later).connectionString);
    await c.db().collection("after").insertOne({ ok: 1 });
    assert.deepEqual(json(await w.h.as(w.u).get(`/databases/${d.id}/users`)).items.map((x: { username: string }) => x.username), ["after-point", "app"]);
  });

  test("erase: customers' users lose their rights before the data goes, and every user of the database is gone after", async () => {
    const d = await create("erase-users-01");
    const more = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "worker", role: "readWrite" }, cookie);
    shown.push(json(more).password);
    const open = driver(d.initialUser.connectionString);
    await open.db().collection("k").insertOne({ _id: 1 } as never);
    const done = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [d.id] }, cookie));
    assert.deepEqual(done.body.result ?? done.body, { affected: 1 });
    assert.equal(await engineHas(w.e, engineName(d.id)), false);
    assert.deepEqual(await usersOn(engineName(d.id)), [], "no user of the database is left");
    assert.equal(await code(open.db().collection("k").insertOne({ _id: 2 } as never)), 13, "the open connection cannot write after the erase");
    assert.equal(await code(driver(json(more).connectionString).db().collection("k").findOne({})), 18);
  });

  test("lock (erase step 1) cuts an open connection at once; a refused erase gives the roles back and the same passwords work", async () => {
    const d = await create("erase-refused-01");
    const open = driver(d.initialUser.connectionString);
    await open.db().collection("k").insertOne({ _id: 1 } as never);
    await w.users.lockCustomers(d.id, "eu-central-1");
    assert.equal(await code(open.db().collection("k").insertOne({ _id: 2 } as never)), 13, "locked: the open connection is refused at once");
    assert.equal(await code(open.db().collection("k").findOne({})), 13);
    assert.deepEqual((await usersOn(engineName(d.id))).find((x) => x.user === "app")!.roles, []);
    await w.users.unlockCustomers(d.id, "eu-central-1");
    assert.deepEqual(await open.db().collection("k").findOne({}), { _id: 1 });

    // A real refusal: the engine will not erase a database that has a fork.
    const f = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/fork`, { name: "erase-refused-fork" }, cookie));
    const fork = (f.body.result ?? f.body) as Created;
    shown.push(fork.initialUser.password);
    const res = await w.h.as(w.u).post("/databases/erase", { ids: [d.id] }, cookie);
    const done = await w.settle(res);
    assert.match(JSON.stringify(done.body), /forks of this one/);
    assert.deepEqual((await usersOn(engineName(d.id))).find((x) => x.user === "app")!.roles, [{ role: "readWrite", db: engineName(d.id) }]);
    const again = driver(d.initialUser.connectionString);
    await again.db().collection("k").insertOne({ _id: 3 } as never);
    assert.equal(await again.db().collection("k").countDocuments(), 2);
    // Clean up in the order the engine allows.
    for (const id of [fork.id, d.id]) await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [id] }, cookie));
  });

  test("an initial user that cannot be made fails the create, and nothing is left on the engine", async () => {
    // A user name the engine itself refuses is not possible through the API (the name rule is stricter than the engine's),
    // so the provisioner is taken away for one call: the engine refuses createUser with Unauthorized.
    const root = w.e.rootClient();
    try {
      await root.db("admin").command({ revokeRolesFromUser: w.e.provisioner.username, roles: [{ role: "fenvix_provisioner", db: "admin" }] });
      const r = await w.h.as(w.u).post("/databases", { name: "no-initial-01", region: "eu-central-1" }, cookie);
      bodies.push(r.body);
      // The provisioner refused: retried as "unavailable" (the deployment is broken, not the customer's request).
      assert.equal(r.statusCode, 202, r.body);
      assert.doesNotMatch(r.body, /Unauthorized|pwd|createUser|code 13/);
      const opId = String(r.headers["operation-id"]);
      const id = (await w.h.admin.query("select database_id from public.operations where id = $1", [opId])).rows[0].database_id;
      // Make it fail for good: the last attempt, then the clean-up (which needs the provisioner back).
      await w.h.admin.query("update public.operations set attempts = 8 where id = $1", [opId]);
      await w.sweep();
      await root.db("admin").command({ grantRolesToUser: w.e.provisioner.username, roles: [{ role: "fenvix_provisioner", db: "admin" }] });
      const done = await w.settle(opId);
      assert.equal(done.body.status, "failed", JSON.stringify(done.body));
      assert.equal(await engineHas(w.e, engineName(id)), false);
      assert.deepEqual(await usersOn(engineName(id)), []);
      assert.equal((await w.h.admin.query("select 1 from public.databases where id = $1", [id])).rowCount, 0);
    } finally { await root.close(); }
  });

  test("the user sweep never drops a customer's user", async () => {
    const d = await create("sweep-safe-01");
    const out = await reconcileEngineUsers(w.h.app.deps.s);
    assert.equal(out.failed, 0);
    assert.ok((await usersOn(engineName(d.id))).some((x) => x.user === "app"));
    // A customer user on a database with no row at all (cannot happen through the API) is not the sweep's to drop either.
    const root = w.e.rootClient();
    const ghost = "db_" + "f".repeat(32);
    try {
      await root.db(ghost).command({ createUser: "ghost-app", pwd: "G".repeat(40), roles: [{ role: "readWrite", db: ghost }] });
      await reconcileEngineUsers(w.h.app.deps.s);
      assert.ok((await usersOn(ghost)).some((x) => x.user === "ghost-app"));
      await root.db(ghost).command({ dropUser: "ghost-app" });
    } finally { await root.close(); }
  });

  test("errors are ours: an engine that does not answer gives a clean 503", async () => {
    const d = await create("down-01");
    w.e.auth.pause();
    try {
      const r = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "while-paused" }, cookie);
      bodies.push(r.body);
      assert.equal(r.statusCode, 503, r.body);
      assert.deepEqual(json(r), { error: { code: "unavailable", message: "The database engine did not answer. Try again in a moment." } });
    } finally { w.e.auth.resume(); }
    await sleep(500);
    const ok = await w.h.as(w.u).get(`/databases/${d.id}/users`);
    assert.equal(ok.statusCode, 200, ok.body);
  });

  test("every password was in exactly one answer, and is in no log (ours and both engines'), no Postgres table", async () => {
    assert.ok(shown.length >= 12, String(shown.length));
    const logs = [w.h.logs.text(), w.e.admin.log, w.e.auth.log].join("\n");
    const tables = ["audit_log", "data_audit_log", "operations", "idempotency_keys", "databases", "api_keys"];
    const dump = (await Promise.all(tables.map(async (t) => JSON.stringify((await w.h.admin.query(`select * from public.${t}`)).rows)))).join("\n");
    for (const p of shown) {
      assert.equal(bodies.filter((b) => b.includes(p)).length <= 1, true, "a password in two answers");
      assert.ok(!logs.includes(p), "a password reached a log");
      assert.ok(!dump.includes(p), "a password is stored in Postgres");
    }
    for (const s of secretsOf(w)) assert.ok(!logs.includes(s), "a secret reached a log");
    assert.doesNotMatch(bodies.join("\n"), /storedKey|serverKey|SCRAM-SHA-256:|"pwd"|at \w+ \(|127\.0\.0\.1|ECONNREFUSED|MongoServerError/);
  });
});
