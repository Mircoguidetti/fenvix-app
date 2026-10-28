import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MongoClient } from "mongodb";
import { engineCredential, engineUserName, parseEngineUserKey } from "../../src/engine/credentials.ts";
import { DataError, dataTarget } from "../../src/engine/data.ts";
import { engineName } from "../../src/engine/names.ts";
import { reconcileEngineUsers } from "../../src/services/engine-users.ts";
import { sleep } from "../helpers/harness.ts";
import { makeTls } from "../helpers/engine-proc.ts";
import { SKIP, type World, cookie, engineUsers, secretsOf, startWorld } from "./common.ts";

/**
 * One engine user per database, proved against the real engine:
 *  (a) database A's user cannot read or write database B, whatever it sends;
 *  (b) a bug in our code that forces another database name is refused by the engine itself;
 *  (c) after erase the user cannot connect, and connections already open lose their rights;
 *  (d) wrong password, TLS required, wrong CA, wrong provisioner: clean answers, no secret anywhere;
 *  (e) logs, audit, operation records, idempotency records and answers hold no password or token;
 * plus the rotation of the master key with two versions valid at once.
 */
describe("engine-real: one engine user per database", { skip: SKIP }, () => {
  let w: World;
  let a: { id: string };
  let b: { id: string };
  const responses: string[] = [];
  const passwords: string[] = [];

  const mk = async (name: string) => {
    const d = await w.settle(await w.h.as(w.u).post("/databases", { name, region: "eu-central-1" }, cookie));
    assert.ok([200, 201].includes(d.status), JSON.stringify(d.body));
    const db = (d.body.result ?? d.body) as { id: string };
    passwords.push(engineCredential(w.h.cfg.engineUsers!.current, db.id).password);
    return db;
  };
  const docs = (id: string, c = "items") => `/databases/${id}/data/collections/${c}/documents`;
  const credOf = (id: string) => engineCredential(w.h.cfg.engineUsers!.current, id);
  /** A second harness changes the control-plane role's password on the scratch Postgres: give the main one its own back. */
  const restorePg = () => w.h.admin.query(`alter role fenvix_control_plane with password '${w.h.cpPassword}'`);
  const fingerprint = async (id: string) => {
    const c = w.e.clientAs(credOf(id));
    try {
      const all = await c.db(engineName(id)).collection("items").find({}, { sort: { _id: 1 } }).toArray();
      const cols = (await c.db(engineName(id)).listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort();
      return createHash("sha256").update(JSON.stringify({ all, cols })).digest("hex");
    } finally { await c.close(); }
  };

  before(async () => {
    w = await startWorld();
    a = await mk("sec-a");
    b = await mk("sec-b");
    for (const [db, tag] of [[a, "A"], [b, "B"]] as const) {
      for (let i = 0; i < 3; i++) {
        const r = await w.h.as(w.u).post(docs(db.id), { document: { _id: `${tag}${i}`, owner: tag, secret: `${tag}-SECRET-${i}` } }, cookie);
        assert.equal(r.statusCode, 201, r.body);
        responses.push(r.body);
      }
    }
  });
  after(async () => { await w?.close(); });

  test("(a) A's user cannot read or write B, by any command; B is unchanged and A's listDatabases shows only A", async () => {
    const before = await fingerprint(b.id);
    const ua = w.e.clientAs(credOf(a.id));
    const A = engineName(a.id);
    const B = engineName(b.id);
    const refused = async (what: string, p: Promise<unknown>) => {
      const e = await p.then(() => null, (x: { code?: number }) => x);
      assert.ok(e && (e as { code?: number }).code === 13, `${what}: expected Unauthorized, got ${e ? (e as { code?: number }).code : "success"}`);
    };
    try {
      await refused("find", ua.db(B).collection("items").findOne({}));
      await refused("count", ua.db(B).command({ count: "items" }));
      await refused("listCollections", ua.db(B).command({ listCollections: 1 }));
      await refused("insert", ua.db(B).collection("items").insertOne({ _id: "evil" } as never));
      await refused("update", ua.db(B).collection("items").updateMany({}, { $set: { owner: "A" } }));
      await refused("delete", ua.db(B).collection("items").deleteMany({}));
      await refused("upsert", ua.db(B).collection("new").updateOne({ x: 1 }, { $set: { x: 1 } }, { upsert: true }));
      await refused("create collection", ua.db(B).createCollection("evil"));
      await refused("drop collection", ua.db(B).command({ drop: "items" }));
      await refused("createIndexes", ua.db(B).collection("items").createIndex({ owner: 1 }));
      await refused("dropDatabase B", ua.db(B).command({ dropDatabase: 1 }));
      await refused("$merge from A into B", ua.db(A).collection("items").aggregate([{ $merge: { into: { db: B, coll: "items" } } }]).toArray());
      await refused("$out from A into B", ua.db(A).collection("items").aggregate([{ $out: { db: B, coll: "stolen" } }]).toArray());
      await refused("renameCollection A -> B", ua.db("admin").command({ renameCollection: `${A}.items`, to: `${B}.stolen` }));
      await refused("createUser in B", ua.db(B).command({ createUser: "evil", pwd: "Evil-Password-123456", roles: [{ role: "readWrite", db: B }] }));
      await refused("grant itself more", ua.db(A).command({ grantRolesToUser: engineUserName(a.id), roles: [{ role: "readWrite", db: B }] }));
      await refused("read the users", ua.db("admin").collection("system.users").findOne({}));
      await refused("dropDatabase A (its own)", ua.db(A).command({ dropDatabase: 1 }));
      const dbs = await ua.db("admin").command({ listDatabases: 1, nameOnly: true });
      assert.deepEqual(dbs.databases.map((d: { name: string }) => d.name), [A]);
      // and its own database works
      await ua.db(A).collection("items").insertOne({ _id: "A-own", owner: "A" } as never);
    } finally { await ua.close(); }
    assert.equal(await fingerprint(b.id), before, "B is byte for byte the same");
  });

  test("(b) a bug that forces database B while serving A: the engine refuses, B's data never comes back, B is unchanged", async () => {
    const before = await fingerprint(b.id);
    const B = engineName(b.id);
    const orig = MongoClient.prototype.db;
    // The simulated bug: whatever name our code asks for, the driver is told B.
    MongoClient.prototype.db = function (this: MongoClient, _name?: string, o?: Parameters<MongoClient["db"]>[1]) { return orig.call(this, B, o); };
    try {
      const read = await w.h.as(w.u).get(docs(a.id));
      responses.push(read.body);
      assert.equal(read.statusCode, 503, read.body);
      assert.ok(!read.body.includes("B-SECRET"));
      const write = await w.h.as(w.u).post(docs(a.id), { document: { _id: "via-bug", owner: "A" } }, cookie);
      responses.push(write.body);
      assert.equal(write.statusCode, 503, write.body);
      const cols = await w.h.as(w.u).get(`/databases/${a.id}/data/collections`);
      responses.push(cols.body);
      assert.equal(cols.statusCode, 503);
    } finally {
      MongoClient.prototype.db = orig;
    }
    // It was the engine that refused (Unauthorized, 13), not something else on the way.
    const refusals = w.h.logs.lines.filter((l) => l.includes('"dataExplorer"') && l.includes(`"databaseId":"${a.id}"`) && l.includes('"outcome":"failed"'));
    assert.ok(refusals.length >= 3 && refusals.slice(-3).every((l) => l.includes('"code":13')), refusals.slice(-3).join("\n"));
    assert.equal(await fingerprint(b.id), before);
    const audit = (await w.h.admin.query("select outcome from public.data_audit_log where database_id = $1 and document_id = $2", [a.id, '"via-bug"'])).rows.map((r) => r.outcome);
    assert.deepEqual(audit, ["attempted", "failed"]);
    // and without the bug everything is normal again
    assert.equal((await w.h.as(w.u).get(docs(a.id))).statusCode, 200);
  });

  test("(c) after erase the user cannot connect, and a connection that was open loses its rights at once", async () => {
    const c = await mk("sec-c");
    assert.equal((await w.h.as(w.u).post(docs(c.id), { document: { _id: 1 } }, cookie)).statusCode, 201);
    assert.equal((await w.h.as(w.u).get(docs(c.id))).statusCode, 200); // the Data Explorer now holds an authenticated client for C
    const open = w.e.clientAs(credOf(c.id));
    await open.db(engineName(c.id)).command({ ping: 1 });
    const d = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [c.id] }, cookie));
    assert.deepEqual(d.body.result ?? d.body, { affected: 1 });
    await assert.rejects(open.db(engineName(c.id)).collection("items").findOne({}), (e: { code?: number }) => e.code === 13);
    await open.close();
    const fresh = w.e.clientAs(credOf(c.id));
    await assert.rejects(fresh.db(engineName(c.id)).command({ ping: 1 }), (e: { code?: number }) => e.code === 18);
    await fresh.close();
    // the Data Explorer's own cached client for C, used directly (the route itself answers 404: the row is gone)
    const e = await w.data.find(dataTarget({ id: c.id, region: "eu-central-1" }), "items", { maxTimeMS: 2000, filter: {}, sort: {}, projection: undefined, skip: 0, limit: 1, maxBytes: 1 << 20 }).catch((x) => x);
    assert.ok(e instanceof DataError && e.kind === "unavailable" && (e.code === 13 || e.code === 18), String(e));
    assert.equal((await w.h.as(w.u).get(docs(c.id))).statusCode, 404);
    assert.equal((await engineUsers(w.e)).some((x) => x.user === engineUserName(c.id)), false);
  });

  test("(d1) TLS is required: a plain connection is refused by the engine; DATA_ENGINE_TLS=false is refused by the config", async () => {
    const plain = new MongoClient(`mongodb://${w.e.dataAddr}/`, { directConnection: true, serverSelectionTimeoutMS: 1500, auth: { username: engineUserName(a.id), password: credOf(a.id).password }, authSource: engineName(a.id) });
    await assert.rejects(plain.db(engineName(a.id)).command({ ping: 1 }), (e: Error) => /ServerSelection/.test(e.name));
    await plain.close();
    assert.ok(!w.e.auth.log.includes(credOf(a.id).password), "the password did not reach the engine's log");
    const { loadConfig } = await import("../../src/config.ts");
    assert.throws(() => loadConfig({ ...process.env, ...minimalEnv(), DATA_ENGINE_TLS: "false" } as never), /INSECURE_LOCAL/);
  });

  test("(d2) wrong password: a clean 503, no password, key or engine message in the answer or the log", async () => {
    // B's user gets a password our key does not make (as if the key had changed without a rotation).
    const root = w.e.rootClient();
    try { await root.db(engineName(b.id)).command({ updateUser: engineUserName(b.id), pwd: "Not-The-Derived-Password-12345" }); } finally { await root.close(); }
    await w.data.closeIdle(Date.now() + 3_600_000); // drop authenticated clients: the next request authenticates again
    const r = await w.h.as(w.u).get(docs(b.id));
    responses.push(r.body);
    assert.equal(r.statusCode, 503, r.body);
    const text = r.body + w.h.logs.text();
    assert.ok(!text.includes("Not-The-Derived-Password-12345") && !text.includes(credOf(b.id).password));
    assert.ok(!/Authentication failed/i.test(r.body));
    // the user sweep cannot see passwords; ensure() repairs it (what an operation on B, or a rotation, does)
    await w.users.ensure(b.id, "eu-central-1");
    assert.equal((await w.h.as(w.u).get(docs(b.id))).statusCode, 200);
  });

  test("(d3) wrong CA for the engine's certificate: the Data Explorer is unavailable and a create waits; nothing leaks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fenvix-ca-"));
    const other = makeTls(dir);
    const x = await startWorld({ DATA_ENGINE_TLS_CA_FILE: other.caFile }, { engines: w.e });
    try {
      const d = await x.settle(await x.h.as(x.u).post("/databases", { name: "wrong-ca", region: "eu-central-1" }, cookie));
      // the provisioner cannot reach the engine either: the create waits (202), nothing half-made is shown
      assert.equal(d.status, 202, JSON.stringify(d.body));
      const e = await x.data.find(dataTarget({ id: a.id, region: "eu-central-1" }), "items", { maxTimeMS: 2000, filter: {}, sort: {}, projection: undefined, skip: 0, limit: 1, maxBytes: 1 << 20 }).catch((y) => y);
      assert.ok(e instanceof DataError && e.kind === "unavailable", String(e));
      assert.doesNotMatch(e.message, /127\.0\.0\.1|certificate|self.signed/i);
      const text = JSON.stringify(d.body) + x.h.logs.text();
      for (const s of secretsOf(x)) assert.ok(!text.includes(s));
      assert.doesNotMatch(text, /127\.0\.0\.1:\d+/);
    } finally { await x.close(); await restorePg(); }
  });

  test("(d4) wrong provisioner password, and a provisioner without the right: the create waits; the engine echoes commands in its refusals, we pass none of it on", async () => {
    // The engine's Unauthorized message contains the whole command, password included: make it happen and look for it.
    const root = w.e.rootClient();
    const weak = { username: "weak_provisioner", password: randomBytes(18).toString("base64url") };
    try { await root.db("admin").command({ createUser: weak.username, pwd: weak.password, roles: [{ role: "fenvix_provisioner_view", db: "admin" }] }).catch(async () => {
      await root.db("admin").command({ createRole: "fenvix_provisioner_view", privileges: [{ resource: { db: "", collection: "" }, actions: ["viewUser"] }], roles: [] });
      await root.db("admin").command({ createUser: weak.username, pwd: weak.password, roles: [{ role: "fenvix_provisioner_view", db: "admin" }] });
    }); } finally { await root.close(); }
    for (const prov of [{ ENGINE_PROVISIONER_PASSWORD: "Wrong-Provisioner-Password-123" }, { ENGINE_PROVISIONER_USERNAME: weak.username, ENGINE_PROVISIONER_PASSWORD: weak.password }]) {
      const x = await startWorld(prov, { engines: w.e });
      try {
        const r = await x.h.as(x.u).post("/databases", { name: "weak-prov", region: "eu-central-1" }, cookie);
        assert.equal(r.statusCode, 202, r.body);
        const opId = String(r.headers["operation-id"]);
        const id = (await x.h.admin.query("select database_id from public.operations where id = $1", [opId])).rows[0].database_id as string;
        const derived = engineCredential(x.h.cfg.engineUsers!.current, id).password;
        const rows = JSON.stringify((await x.h.admin.query("select * from public.operations where id = $1", [opId])).rows);
        const text = [r.body, x.h.logs.text(), rows].join("\n");
        assert.ok(!text.includes(derived), "the derived password is nowhere");
        assert.ok(!text.includes(prov.ENGINE_PROVISIONER_PASSWORD));
        assert.doesNotMatch(text, /not authorized on|pwd:/);
        assert.match(x.h.logs.text(), /the engine refused the provisioner \(create the database's user, code (13|18)\)/);
      } finally { await x.close(); await restorePg(); }
    }
  });

  test("rotation: v2 current + v1 previous both work at once; the sweep moves every user to v2; then v1 can go", async () => {
    const r = await mk("sec-rot");
    assert.equal((await w.h.as(w.u).post(docs(r.id), { document: { _id: "rot" } }, cookie)).statusCode, 201);
    const v1 = w.e.userKey;
    const v2 = `v2:${randomBytes(32).toString("base64url")}`;
    const t = dataTarget({ id: r.id, region: "eu-central-1" });
    const find = { maxTimeMS: 3000, filter: {}, sort: {}, projection: undefined, skip: 0, limit: 5, maxBytes: 1 << 20 };
    const rot = await startWorld({ ENGINE_USER_KEY: v2, ENGINE_USER_KEY_PREVIOUS: v1 }, { engines: w.e });
    try {
      // 1. the users still have v1: the Data Explorer falls back to the previous key
      assert.equal((await rot.data.find(t, "items", find)).docs.length, 1);
      assert.ok(rot.data.openClients().some((c) => c.db === engineName(r.id) && c.version === "v1"), JSON.stringify(rot.data.openClients()));
      // 2. the sweep gives every user the v2 password
      const out = await reconcileEngineUsers(rot.h.app.deps.s);
      assert.ok(out.rotated >= 3 && out.failed === 0, JSON.stringify(out));
      const info = await (async () => { const c = w.e.rootClient(); try { return (await c.db("admin").command({ usersInfo: { forAllDBs: true } })).users as { user: string; customData?: { fenvix?: { keyVersion?: string } } }[]; } finally { await c.close(); } })();
      assert.ok(info.filter((u) => u.user.startsWith("cp_")).every((u) => u.customData?.fenvix?.keyVersion === "v2"));
      // 3. new connections: v2 works (after v1 fails once for a client that remembered v1)
      await rot.data.closeIdle(Date.now() + 3_600_000);
      assert.equal((await rot.data.find(t, "items", find)).docs.length, 1);
      assert.ok(rot.data.openClients().some((c) => c.db === engineName(r.id) && c.version === "v2"));
    } finally { await rot.close(); await restorePg(); }
    // 4. with v2 alone (previous removed) everything works
    const only2 = await startWorld({ ENGINE_USER_KEY: v2 }, { engines: w.e });
    try {
      assert.equal((await only2.data.find(t, "items", find)).docs.length, 1);
      const p2 = engineCredential(parseEngineUserKey(v2, "v2"), r.id).password;
      assert.ok(!only2.h.logs.text().includes(p2));
    } finally { await only2.close(); await restorePg(); }
    // 5. and an instance still on v1 alone is now refused cleanly: roll the new key out everywhere before the sweep
    await w.data.closeIdle(Date.now() + 3_600_000);
    const stale = await w.h.as(w.u).get(docs(r.id));
    assert.equal(stale.statusCode, 503);
    responses.push(stale.body);
    await sleep(10);
  });

  test("ENGINE GAP (reported, not ours to fix): the provisioner can create a root user, because createUser does not check grantRole", { todo: "the engine must require grantRole on each granted role's database (as mongod does); until then the provisioner's password is as strong as root" }, async () => {
    const p = w.e.clientAs({ ...w.e.provisioner, authSource: "admin" });
    try {
      const r = await p.db("admin").command({ createUser: "gap_check", pwd: randomBytes(18).toString("base64url"), roles: ["root"] }).then(() => "created", (e: { code?: number }) => `refused ${e.code}`);
      assert.equal(r, "refused 13", "the provisioner was able to create a root user");
    } finally {
      const root = w.e.rootClient();
      await root.db("admin").command({ dropUser: "gap_check" }).catch(() => {});
      await root.close();
      await p.close();
    }
  });

  test("(e) no password or token in logs, audit, operations, idempotency records, answers or engine logs", async () => {
    const pg = JSON.stringify([
      (await w.h.admin.query("select * from public.data_audit_log")).rows,
      (await w.h.admin.query("select * from public.operations")).rows,
      (await w.h.admin.query("select * from public.idempotency_keys")).rows,
      (await w.h.admin.query("select * from public.audit_log")).rows,
    ]);
    const everything = [w.h.logs.text(), pg, ...responses, w.e.admin.log, w.e.auth.log].join("\n");
    for (const s of [...secretsOf(w), ...passwords]) assert.ok(!everything.includes(s), "a secret is stored or logged somewhere");
    assert.doesNotMatch(everything, /"pwd"|pwd: "/, "no createUser/updateUser command text");
    // documents' contents are not logged either
    assert.ok(!w.h.logs.text().includes("A-SECRET-0"));
  });
});

function minimalEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "cp-"));
  writeFileSync(join(dir, "x"), "x");
  return {
    CONTROL_PLANE_DATABASE_URL: "postgresql://x@localhost/x", SUPABASE_URL: "https://p.supabase.invalid", SUPABASE_ANON_KEY: "anon",
    DOWNLOAD_SIGNING_KEY: "k".repeat(32), API_PUBLIC_URL: "https://api.example.test/v1", ENGINE_DRIVER: "fake",
    DATA_ENGINE_ENDPOINTS: "127.0.0.1:1", ENGINE_USER_KEY: `v1:${"z".repeat(40)}`, ENGINE_PROVISIONER_USERNAME: "p", ENGINE_PROVISIONER_PASSWORD: "q".repeat(20),
  };
}
