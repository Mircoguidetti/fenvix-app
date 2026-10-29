import assert from "node:assert/strict";
import { randomBytes, X509Certificate } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { after, before, describe, test } from "node:test";
import { MongoClient } from "mongodb";
import { engineUserName } from "../../src/engine/credentials.ts";
import { engineName } from "../../src/engine/names.ts";
import { json, sleep } from "../helpers/harness.ts";
import { EngineProcess, GRANTABLE_ROLES, freePort, makeTls } from "../helpers/engine-proc.ts";
import { ADMIN_BIN, SKIP, type World, cookie, startWorld } from "./common.ts";

/**
 * The final engine (test5 `final-engine`): what changed for the control plane, checked against ONE engine process that
 * has the admin interface, --auth and requireTLS (with ENGINE_E2E_PROFILE=production: a local S3 store, leases, the admin
 * interface on its own address, and the engine's command log).
 *
 *  b. the control plane drives the engine through the admin interface with the token only; on the data port it sends
 *     user commands (as the provisioner) and data commands (as cp_<id>), never tenantAdmin or any other engine command;
 *  d. the engine's grantRole rule: the provisioner still makes every user the control plane makes, and a compromised
 *     provisioner cannot make root or cluster-wide roles (what it still can do is pinned here, see the report);
 *  e. a name with leftover users is refused by the engine's create/fork; erase then create again works;
 *  f. fork of data written by an application, in the same engine process;
 *  g. the Data Explorer under --auth: reads as cp_<id>, a member cannot write, writes and refusals audited;
 *  h. rotateCertificates: the control plane never sends it; what the engine does with it.
 */
const SRC = new URL("../../src/", import.meta.url).pathname;

/** Every .ts file under src/. */
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * Engine commands that are not MongoDB data or user commands: maintenance and control of the engine process. None may
 * ever be sent by the control plane on the data port (with --auth the engine refuses tenantAdmin even to root).
 */
const ENGINE_ONLY_COMMANDS = ["tenantAdmin", "rotateCertificates", "shutdown", "fsync", "closeAllDatabases", "setParameter", "logRotate", "replSetInitiate", "killAllSessions", "dropAllUsersFromDatabase", "dropAllRolesFromDatabase"];

/** The commands the control plane is expected to send on the data port (driver handshake included). */
const DATA_PORT_ALLOWED = new Set([
  // driver: handshake, authentication, sessions, monitoring
  "hello", "isMaster", "ismaster", "saslStart", "saslContinue", "ping", "endSessions", "buildInfo", "getMore", "killCursors",
  // provisioner (src/engine/users.ts)
  "createUser", "updateUser", "dropUser", "usersInfo",
  // Data Explorer as cp_<id> (src/engine/data-mongo.ts)
  "listCollections", "find", "aggregate", "count", "insert", "update", "delete", "findAndModify", "listDatabases",
]);

describe("engine-real: the final engine", { skip: SKIP }, () => {
  let w: World;
  const clients: MongoClient[] = [];
  type Created = { id: string; host: string; connectionString: string; initialUser: { username: string; password: string; connectionString: string } };

  before(async () => { w = await startWorld(); });
  after(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await w?.close();
  });

  const create = async (name: string): Promise<Created> => {
    const res = await w.h.as(w.u).post("/databases", { name, region: "eu-central-1" }, cookie);
    const d = await w.settle(res);
    assert.ok([200, 201].includes(d.status), JSON.stringify(d.body));
    return (d.body.result ?? d.body) as Created;
  };
  const local = (cs: string) => { const u = new URL(cs); u.host = `localhost:${w.e.dataAddr.split(":")[1]}`; return u.toString(); };
  const driver = (cs: string) => { const c = new MongoClient(local(cs), { tlsCAFile: w.e.caFile, serverSelectionTimeoutMS: 4000 }); clients.push(c); return c; };
  const code = async (p: Promise<unknown>) => p.then(() => 0, (e: { code?: number }) => e.code ?? -1);
  const usersOn = async (db: string) => {
    const r = w.e.rootClient();
    try { return ((await r.db(db).command({ usersInfo: 1 })).users as { user: string; db: string; roles: { role: string; db: string }[] }[]); } finally { await r.close(); }
  };
  const admin = async (method: string, path: string, body?: unknown, token: string | null = w.e.token) => {
    const r = await fetch(`${w.e.adminUrl}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };

  // ---------------------------------------------------------------- b. admin interface only, never engine commands

  test("b. source: no engine-only command is ever named in the control plane's code; the admin interface is the only control path", () => {
    const hits: string[] = [];
    for (const f of sources()) {
      const text = readFileSync(f, "utf8");
      for (const c of ENGINE_ONLY_COMMANDS) if (new RegExp(`\\b${c}\\b`).test(text)) hits.push(`${f.slice(SRC.length)}: ${c}`);
    }
    assert.deepEqual(hits, []);
    // The only module that sends raw `.command(` to the engine's MongoDB port is users.ts (the provisioner's user
    // commands); the Data Explorer (data-mongo.ts) uses the driver's collection methods only.
    const withCommand = sources().filter((f) => /\.command\(/.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length)).sort();
    assert.deepEqual(withCommand, ["engine/users.ts"]);
  });

  test("b. the engine: tenantAdmin on the data port is refused even to root; ctl is not reachable without the token", async () => {
    const r = w.e.rootClient();
    try {
      assert.equal(await code(r.db("admin").command({ tenantAdmin: 1, close: true })), 13);
    } finally { await r.close(); }
    assert.equal((await admin("GET", "/v1/health", undefined, null)).status, 401);
    assert.equal((await admin("GET", "/v1/health", undefined, "x".repeat(32))).status, 401);
    assert.equal((await admin("GET", "/v1/health", undefined, w.e.provisioner.password)).status, 401, "SCRAM credentials are not a token");
    assert.equal((await admin("GET", "/v1/health")).status, 200);
    if (w.e.profile === "production") {
      // The admin interface is bound to its own address: nothing answers on the data address at the admin port.
      const port = new URL(w.e.adminUrl).port;
      assert.notEqual(new URL(w.e.adminUrl).hostname, w.e.dataAddr.split(":")[0]);
      await assert.rejects(fetch(`http://${w.e.dataAddr.split(":")[0]}:${port}/v1/health`));
    }
  });

  test("b. at run time: during a full life cycle the data port only sees user and data commands (engine command log)", { skip: ADMIN_BIN && process.env.ENGINE_E2E_PROFILE === "production" ? false : "needs ENGINE_E2E_PROFILE=production (--log-commands)" }, async () => {
    const from = w.e.admin.log.length;
    // Everything the control plane does, and nothing done by the test on the data port in this window.
    const d = await create("cmdlog-01");
    const base = `/databases/${d.id}/data/collections`;
    assert.equal((await w.h.as(w.u).post(`${base}/c/documents`, { document: { _id: "a" } }, cookie)).statusCode, 201);
    assert.equal((await w.h.as(w.u).get(`${base}/c/documents`)).statusCode, 200);
    assert.equal((await w.h.as(w.u).get(base)).statusCode, 200);
    const one = json(await w.h.as(w.u).get(`${base}/c/documents/${encodeURIComponent('"a"')}`));
    assert.equal((await w.h.as(w.u).put(`${base}/c/documents/${encodeURIComponent('"a"')}`, { document: { _id: "a", v: 2 }, version: one.version }, cookie)).statusCode, 200);
    const u = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "worker", role: "read" }, cookie);
    assert.equal(u.statusCode, 201, u.body);
    assert.equal((await w.h.as(w.u).post(`/databases/${d.id}/users/worker/reset-password`, {}, cookie)).statusCode, 200);
    assert.equal((await w.h.as(w.u).del(`/databases/${d.id}/users/worker`, cookie)).statusCode, 200);
    const f = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/fork`, { name: "cmdlog-02" }, cookie));
    assert.ok([200, 201].includes(f.status), JSON.stringify(f.body));
    const fid = (f.body.result ?? f.body).id;
    assert.equal((await w.h.as(w.u).post("/databases/keep-awake", { ids: [d.id], enabled: true }, cookie)).statusCode, 200);
    for (const id of [fid, d.id]) {
      const e = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [id] }, cookie));
      assert.deepEqual(e.body.result ?? e.body, { affected: 1 });
    }
    await sleep(300);
    const lines = w.e.admin.log.slice(from).split("\n");
    const cmds = lines.flatMap((l) => { const m = /^CMD (\S+) db=(\S*)/.exec(l); return m ? [{ cmd: m[1]!, db: m[2]! }] : []; });
    const admins = lines.filter((l) => l.startsWith("ADMIN "));
    assert.ok(cmds.length > 10, `the engine logged the data port's commands (${cmds.length})`);
    assert.ok(admins.length > 5, "and the admin interface's requests");
    const unexpected = cmds.filter((c) => !DATA_PORT_ALLOWED.has(c.cmd));
    assert.deepEqual(unexpected, [], "only user and data commands on the data port");
    for (const c of ENGINE_ONLY_COMMANDS) assert.ok(!cmds.some((x) => x.cmd === c), c);
    // Every create, fork, keep-awake and erase went through the admin interface.
    for (const re of [/^ADMIN POST \/v1\/databases -> 20[01]/, /^ADMIN POST \/v1\/databases\/db_[0-9a-f]{32}\/fork -> 20[01]/, /^ADMIN PUT \/v1\/databases\/db_[0-9a-f]{32}\/keep-awake -> 200/, /^ADMIN DELETE \/v1\/databases\/db_[0-9a-f]{32} -> 200/]) {
      assert.ok(admins.some((l) => re.test(l)), `admin log has ${re}`);
    }
  });

  // ---------------------------------------------------------------- d. the grantRole rule and the provisioner

  test("d. the provisioner still makes what the control plane makes (cp_ readWrite, customer readWrite/read) under the grantRole rule", async () => {
    const d = await create("grant-ok-01");
    const db = engineName(d.id);
    const r = await w.h.as(w.u).post(`/databases/${d.id}/users`, { username: "reader", role: "read" }, cookie);
    assert.equal(r.statusCode, 201, r.body);
    const users = await usersOn(db);
    assert.deepEqual(users.map((x) => [x.user, x.roles]).sort(), [
      ["app", [{ role: "readWrite", db }]],
      [engineUserName(d.id), [{ role: "readWrite", db }]],
      ["reader", [{ role: "read", db }]],
    ].sort());
  });

  test("d. a compromised provisioner cannot make root, cluster or any-database roles, nor give them to itself", async () => {
    const p = w.e.clientAs({ ...w.e.provisioner, authSource: "admin" });
    const db = `db_${randomBytes(16).toString("hex")}`;
    const pwd = randomBytes(18).toString("base64url");
    const made: { db: string; user: string }[] = [];
    try {
      const refused: [string, unknown][] = [
        ["root", [{ role: "root", db: "admin" }]],
        ["__system", [{ role: "__system", db: "admin" }]],
        ["clusterAdmin", [{ role: "clusterAdmin", db: "admin" }]],
        ["clusterManager", [{ role: "clusterManager", db: "admin" }]],
        ["hostManager", [{ role: "hostManager", db: "admin" }]],
        ["readWriteAnyDatabase", [{ role: "readWriteAnyDatabase", db: "admin" }]],
        ["readAnyDatabase", [{ role: "readAnyDatabase", db: "admin" }]],
        ["userAdminAnyDatabase", [{ role: "userAdminAnyDatabase", db: "admin" }]],
        ["dbAdminAnyDatabase", [{ role: "dbAdminAnyDatabase", db: "admin" }]],
        ["backup", [{ role: "backup", db: "admin" }]],
        ["restore", [{ role: "restore", db: "admin" }]],
      ];
      for (const [what, roles] of refused) {
        const name = `x_${randomBytes(4).toString("hex")}`;
        const c = await code(p.db(db).command({ createUser: name, pwd, roles }));
        if (c === 0) made.push({ db, user: name });
        assert.equal(c, 13, `createUser with ${what}`);
      }
      assert.equal(await code(p.db("admin").command({ grantRolesToUser: w.e.provisioner.username, roles: [{ role: "root", db: "admin" }] })), 13, "grant root to itself");
      assert.equal(await code(p.db("admin").command({ updateUser: w.e.provisioner.username, roles: [{ role: "readWriteAnyDatabase", db: "admin" }] })), 13, "updateUser itself");
      assert.equal(await code(p.db("admin").command({ createRole: "esc", privileges: [{ resource: { cluster: true }, actions: ["shutdown"] }], roles: [] })), 13, "createRole is not one of its actions");
      // Without --grantable-roles the engine's rule still allows these (grantRole on any named database): pinned so a change
      // is noticed. The control plane never asks for these (its roles are a fixed list), but a stolen provisioner password
      // can. With --grantable-roles (engine-round2) every one of them is refused (13).
      const allowed: [string, string, unknown][] = [
        ["dbOwner on a customer database", db, [{ role: "dbOwner", db }]],
        ["userAdmin on admin", db, [{ role: "userAdmin", db: "admin" }]],
        ["readWrite on admin", db, [{ role: "readWrite", db: "admin" }]],
        // it holds every privilege of its own role, so it can make a second provisioner
        ["the provisioner's own role", db, [{ role: "fenvix_provisioner", db: "admin" }]],
      ];
      for (const [what, on, roles] of allowed) {
        const name = `y_${randomBytes(4).toString("hex")}`;
        const c = await code(p.db(on).command({ createUser: name, pwd, roles }));
        if (c === 0) made.push({ db: on, user: name });
        if (GRANTABLE_ROLES) assert.equal(c, 13, `refused with --grantable-roles: ${what}`);
        else assert.equal(c, 0, `still allowed by the engine without --grantable-roles: ${what}`);
      }
      if (GRANTABLE_ROLES) {
        // engine-round2: no user on admin at all, and no grant or role change on itself.
        assert.equal(await code(p.db("admin").command({ createUser: `z_${randomBytes(4).toString("hex")}`, pwd, roles: [] })), 13, "no user on admin");
        assert.equal(await code(p.db("admin").command({ updateUser: w.e.root.username, pwd })), 13, "root's password");
        assert.equal(made.length, 0);
        return;
      }
      // readWrite on admin does not open the users collection.
      const rw = made.find((m) => m.user.startsWith("y_") && m.db === db)!;
      const rwAdmin = made[made.length - 2]!;
      const sneaky = w.e.clientAs({ username: rwAdmin.user, password: pwd, authSource: db });
      try {
        assert.equal(await code(sneaky.db("admin").collection("system.users").findOne({})), 13, "readWrite@admin cannot read admin.system.users");
        assert.equal(await code(sneaky.db("admin").collection("system.users").insertOne({ _id: "x" } as never)), 13);
      } finally { await sneaky.close(); }
      assert.ok(rw);
    } finally {
      const root = w.e.rootClient();
      for (const m of made) await root.db(m.db).command({ dropUser: m.user }).catch(() => {});
      await root.close();
      await p.close();
    }
  });

  // ---------------------------------------------------------------- e. leftover users, erase then create again

  test("e. the engine refuses create and fork of a name that still has users (409 users_exist); after an erase the name is free", async () => {
    const name = `db_${randomBytes(16).toString("hex")}`;
    const root = w.e.rootClient();
    try {
      await root.db(name).command({ createUser: "left_over", pwd: randomBytes(18).toString("base64url"), roles: [{ role: "read", db: name }] });
      const c = await admin("POST", "/v1/databases", { name });
      assert.equal(c.status, 409);
      assert.equal(c.json.error.code, "users_exist");
      const src = await create("users-exist-src");
      const f = await admin("POST", `/v1/databases/${engineName(src.id)}/fork`, { target: name });
      assert.equal(f.status, 409);
      assert.equal(f.json.error.code, "users_exist");
      await root.db(name).command({ dropUser: "left_over" });
      assert.ok([200, 201].includes((await admin("POST", "/v1/databases", { name })).status));
      await root.db(name).command({ createUser: "second", pwd: randomBytes(18).toString("base64url"), roles: [{ role: "read", db: name }] });
      assert.equal((await admin("DELETE", `/v1/databases/${name}`)).status, 200);
      assert.deepEqual((await root.db(name).command({ usersInfo: 1 })).users, [], "the engine's erase took the users");
      assert.ok([200, 201].includes((await admin("POST", "/v1/databases", { name })).status), "the same name again after the erase");
      assert.equal((await admin("DELETE", `/v1/databases/${name}`)).status, 200);
    } finally { await root.close(); }
  });

  test("e. through the control plane: erase, then create again with the same name: works, new id, only the new users", async () => {
    const first = await create("again-01");
    const extra = await w.h.as(w.u).post(`/databases/${first.id}/users`, { username: "worker", role: "readWrite" }, cookie);
    assert.equal(extra.statusCode, 201);
    const er = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [first.id] }, cookie));
    assert.deepEqual(er.body.result ?? er.body, { affected: 1 });
    assert.deepEqual(await usersOn(engineName(first.id)), []);
    const second = await create("again-01");
    assert.notEqual(second.id, first.id);
    assert.deepEqual((await usersOn(engineName(second.id))).map((x) => x.user).sort(), ["app", engineUserName(second.id)].sort());
    const c = driver(second.initialUser.connectionString);
    await c.db().collection("k").insertOne({ _id: 1 } as never);
    assert.equal(await c.db().collection("k").countDocuments(), 1);
  });

  // ---------------------------------------------------------------- f. fork with application data, one process

  test("f. fork of data an application wrote, same engine process: the copy has it, is independent, and has only its new users", async () => {
    const src = await create("app-src-01");
    const app = driver(src.initialUser.connectionString);
    const orders = app.db().collection("orders");
    await orders.insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: `o-${i}`, n: i })) as never);
    await orders.createIndex({ n: 1 });
    await app.db().collection("customers").insertOne({ _id: "c-1", name: "Ada" } as never);
    const extra = await w.h.as(w.u).post(`/databases/${src.id}/users`, { username: "src-worker", role: "readWrite" }, cookie);
    assert.equal(extra.statusCode, 201);
    const done = await w.settle(await w.h.as(w.u).post(`/databases/${src.id}/fork`, { name: "app-copy-01" }, cookie));
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
    const f = (done.body.result ?? done.body) as Created;
    assert.ok(f.initialUser?.password, "the fork's new user's password is shown once");
    const fapp = driver(f.initialUser.connectionString);
    const fdb = fapp.db();
    assert.equal(fdb.databaseName, engineName(f.id));
    assert.equal(await fdb.collection("orders").countDocuments(), 50, "the copy has the application's data");
    assert.deepEqual(await fdb.collection("customers").findOne({ _id: "c-1" } as never), { _id: "c-1", name: "Ada" });
    assert.ok((await fdb.collection("orders").indexes()).some((i) => i.key.n === 1), "and its index");
    // Independent: writes on one side are not seen on the other.
    await fdb.collection("orders").insertOne({ _id: "fork-only", n: -1 } as never);
    await fdb.collection("orders").deleteOne({ _id: "o-0" } as never);
    await orders.insertOne({ _id: "src-only", n: -2 } as never);
    await orders.updateOne({ _id: "o-1" } as never, { $set: { n: 1000 } });
    assert.equal(await orders.countDocuments({ _id: "fork-only" } as never), 0);
    assert.equal(await orders.countDocuments({ _id: "o-0" } as never), 1);
    assert.equal(await fdb.collection("orders").countDocuments({ _id: "src-only" } as never), 0);
    assert.equal((await fdb.collection("orders").findOne({ _id: "o-1" } as never))!.n, 1);
    assert.equal(await orders.countDocuments(), 51);
    assert.equal(await fdb.collection("orders").countDocuments(), 50);
    // Users of the copy: only the new ones.
    assert.deepEqual((await usersOn(engineName(f.id))).map((x) => x.user).sort(), ["app", engineUserName(f.id)].sort());
    assert.equal(await code(driver(json(extra).connectionString).db(engineName(f.id)).collection("orders").findOne({})), 13);
    // The source keeps its users.
    assert.deepEqual((await usersOn(engineName(src.id))).map((x) => x.user).sort(), ["app", engineUserName(src.id), "src-worker"].sort());
  });

  test("f. restore of data an application wrote, same engine process: back to the point, users untouched", async () => {
    const d = await create("app-restore-01");
    const app = driver(d.initialUser.connectionString);
    await app.db().collection("k").insertOne({ _id: "before" } as never);
    await sleep(1500);
    const point = new Date().toISOString();
    await sleep(1500);
    await app.db().collection("k").insertOne({ _id: "after" } as never);
    const done = await w.settle(await w.h.as(w.u).post(`/databases/${d.id}/restore`, { at: point }, cookie));
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
    const again = driver(d.initialUser.connectionString);
    assert.deepEqual((await again.db().collection("k").find().toArray()).map((x) => x._id), ["before"]);
    assert.deepEqual((await usersOn(engineName(d.id))).map((x) => x.user).sort(), ["app", engineUserName(d.id)].sort());
  });

  // ---------------------------------------------------------------- g. Data Explorer under --auth

  test("g. Data Explorer under --auth: reads what the application wrote as cp_<id>; a member cannot write; writes and refusals audited", async () => {
    const d = await create("explorer-auth-01");
    const app = driver(d.initialUser.connectionString);
    await app.db().collection("items").insertOne({ _id: "from-app", v: 1 } as never);
    const base = `/databases/${d.id}/data/collections`;
    const list = json(await w.h.as(w.u).get(`${base}/items/documents`));
    assert.deepEqual(list.items.map((x: { id: string }) => x.id), ['"from-app"']);
    const open = w.data.openClients().filter((c) => c.db === engineName(d.id));
    assert.equal(open.length, 1, "one client for this database, authenticated as its own user");
    const member = await w.h.addMember(w.u.workspaceId, "Mia Member", "member");
    assert.equal((await w.h.as(member).get(`${base}/items/documents`)).statusCode, 200, "a member reads");
    const ins = await w.h.as(member).post(`${base}/items/documents`, { document: { _id: "by-member" } }, cookie);
    assert.equal(ins.statusCode, 403, ins.body);
    const one = json(await w.h.as(member).get(`${base}/items/documents/${encodeURIComponent('"from-app"')}`));
    assert.equal((await w.h.as(member).put(`${base}/items/documents/${encodeURIComponent('"from-app"')}`, { document: { _id: "from-app", v: 9 }, version: one.version }, cookie)).statusCode, 403);
    assert.equal((await w.h.as(member).del(`${base}/items/documents/${encodeURIComponent('"from-app"')}?version=${one.version}`, cookie)).statusCode, 403);
    assert.deepEqual(await app.db().collection("items").find().toArray(), [{ _id: "from-app", v: 1 }], "nothing changed on the engine");
    assert.equal((await w.h.as(w.u).post(`${base}/items/documents`, { document: { _id: "by-owner" } }, cookie)).statusCode, 201);
    const audit = (await w.h.admin.query("select actor_id, operation, outcome from public.data_audit_log where database_id = $1 order by id", [d.id])).rows;
    assert.deepEqual(audit.filter((r) => r.outcome === "denied").map((r) => r.operation).sort(), ["delete", "insert", "replace"]);
    assert.ok(audit.filter((r) => r.outcome === "denied").every((r) => r.actor_id === member.userId), "the member is the actor");
    assert.deepEqual(audit.filter((r) => r.operation === "insert" && r.outcome !== "denied").map((r) => r.outcome).sort(), ["attempted", "ok"]);
    // The Data Explorer's user is cp_<id> with readWrite on its own database only.
    const cp = (await usersOn(engineName(d.id))).find((x) => x.user === engineUserName(d.id))!;
    assert.deepEqual(cp.roles, [{ role: "readWrite", db: engineName(d.id) }]);
  });

  // ---------------------------------------------------------------- h. rotateCertificates

  test("h. rotateCertificates: never sent by the control plane; with TLS on the engine really reloads; with TLS off it answers ok and does nothing", async () => {
    for (const f of sources()) assert.ok(!/rotateCertificates/.test(readFileSync(f, "utf8")), f);
    const tmp = mkdtempSync(join(tmpdir(), "fenvix-rot-"));
    const procs: EngineProcess[] = [];
    try {
      const a = makeTls(mkdirIn(tmp, "a"));
      const b = makeTls(mkdirIn(tmp, "b"));
      const pem = join(tmp, "served.pem");
      copyFileSync(a.serverPem, pem);
      const caBoth = join(tmp, "ca-both.pem");
      writeFileSync(caBoth, readFileSync(a.caFile, "utf8") + readFileSync(b.caFile, "utf8"));
      // TLS on (requireTLS), no --auth: an operator on the machine rotates.
      const tlsPort = await freePort();
      const on = new EngineProcess({ bin: ADMIN_BIN!, dataPort: tlsPort, tls: { serverPem: pem } });
      procs.push(on);
      await on.start();
      const fpA = await served(tlsPort, caBoth);
      assert.equal(fpA, fingerprint(a.serverPem));
      const c = new MongoClient(`mongodb://127.0.0.1:${tlsPort}/`, { directConnection: true, tls: true, tlsCAFile: caBoth, serverSelectionTimeoutMS: 4000 });
      try {
        await c.db("admin").command({ ping: 1 });
        copyFileSync(b.serverPem, pem);
        assert.equal(await served(tlsPort, caBoth), fpA, "nothing changes before the command");
        assert.equal((await c.db("admin").command({ rotateCertificates: 1 })).ok, 1);
        assert.equal(await served(tlsPort, caBoth), fingerprint(b.serverPem), "new connections get the new certificate");
        assert.equal((await c.db("admin").command({ ping: 1 })).ok, 1, "an open connection keeps working");
        writeFileSync(pem, "not a pem");
        assert.notEqual(await code(c.db("admin").command({ rotateCertificates: 1 })), 0, "unusable files are refused");
        assert.equal(await served(tlsPort, caBoth), fingerprint(b.serverPem), "and the previous certificate stays");
      } finally { await c.close(); }
      // TLS disabled: ok, nothing to do (the engine's choice, as mongod).
      const plainPort = await freePort();
      const off = new EngineProcess({ bin: ADMIN_BIN!, dataPort: plainPort });
      procs.push(off);
      await off.start();
      const p = new MongoClient(`mongodb://127.0.0.1:${plainPort}/`, { directConnection: true, serverSelectionTimeoutMS: 4000 });
      try {
        assert.equal((await p.db("admin").command({ rotateCertificates: 1 })).ok, 1);
        assert.equal((await p.db("admin").command({ ping: 1 })).ok, 1, "still plain, nothing changed");
      } finally { await p.close(); }
    } finally {
      for (const x of procs) await x.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Was a `todo` (engine gap) until engine-round2: rotateCertificates now needs the cluster action rotateCertificates
  // (root, hostManager, clusterAdmin), as in mongod. The control plane still never sends it (point b).
  test("h. with --auth root can run rotateCertificates (engine-round2); the provisioner cannot", async () => {
    const r = w.e.rootClient();
    const p = w.e.clientAs({ ...w.e.provisioner, authSource: "admin" });
    try {
      assert.equal(await code(r.db("admin").command({ rotateCertificates: 1 })), 0, "root");
      assert.equal(await code(p.db("admin").command({ rotateCertificates: 1 })), 13, "the provisioner");
    } finally { await r.close(); await p.close(); }
  });
});

function mkdirIn(base: string, name: string): string { const d = join(base, name); mkdirSync(d); return d; }

function fingerprint(pemFile: string): string {
  const pem = readFileSync(pemFile, "utf8");
  return new X509Certificate(pem.slice(0, pem.indexOf("-----END CERTIFICATE-----") + 25)).fingerprint256;
}

/** SHA-256 fingerprint of the certificate a TLS listener serves. */
async function served(port: number, ca: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: "127.0.0.1", port, ca: readFileSync(ca), servername: "localhost" }, () => {
      const fp = s.getPeerCertificate().fingerprint256;
      s.end();
      resolve(fp);
    });
    s.on("error", reject);
  });
}
