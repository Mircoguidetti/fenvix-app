import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LightMyRequestResponse as Res } from "fastify";
import { type Fixture, type Harness, json, sleep, startHarness } from "../helpers/harness.ts";
import { CUSTOMER_ROLES, type EngineUsers, FakeEngineUsers } from "../../src/engine/users.ts";
import { engineUserName } from "../../src/engine/credentials.ts";
import { reconcileEngineUsers } from "../../src/services/engine-users.ts";

/**
 * A database's own users (docs/database-users.md) with the in-memory engine: the initial user of create and fork, the
 * four routes, who may do what, isolation between workspaces, hostile payloads, idempotency, a password that appears in
 * exactly one answer and nowhere else, limits, and the users' part in erase. The same paths run against the real
 * engine in tests/engine-real/db-users.test.ts.
 */
const users = new FakeEngineUsers();
/** Every role the control plane ever sent to the engine for a customer user. */
const rolesSent: string[] = [];
const spy = (u: FakeEngineUsers): EngineUsers => new Proxy(u, {
  get(t, p) {
    if (p === "createCustomer" || p === "ensureCustomer") {
      return (id: string, r: string, x: { role: string }) => { rolesSent.push(x.role); return (t[p] as (...a: unknown[]) => Promise<void>).call(t, id, r, x); };
    }
    const v = (t as unknown as Record<string | symbol, unknown>)[p];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  },
});

function limitsFile(over: Record<string, number>): string {
  const base = JSON.parse(readFileSync(new URL("../../config/limits.json", import.meta.url), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "fenvix-limits-"));
  writeFileSync(join(dir, "limits.json"), JSON.stringify({ ...base, ...over }));
  return join(dir, "limits.json");
}

let h: Harness;
let u: Fixture;
let other: Fixture;
/** Every password any answer showed, and every answer body. */
const shown: string[] = [];
const bodies: string[] = [];
const keep = (r: Res) => { bodies.push(r.body); return r; };

before(async () => {
  h = await startHarness({ LIMITS_FILE: limitsFile({ maxUsersPerDatabase: 4, userChangesPerMinute: 1000, userListsPerMinute: 1000 }) }, { usersFactory: () => spy(users) });
  u = await h.user("Owner");
  other = await h.user("Other Workspace");
});
after(async () => { await h.close(); });

const create = async (name: string, extra: Record<string, unknown> = {}) => {
  const r = keep(await h.as(u).post("/databases", { name, region: "eu-central-1", ...extra }));
  assert.equal(r.statusCode, 201, r.body);
  const d = json(r);
  if (d.initialUser?.password) shown.push(d.initialUser.password);
  return d as { id: string; name: string; host: string; connectionString: string; initialUser: { username: string; role: string; password: string | null; connectionString: string | null } };
};
const path = (id: string, rest = "") => `/databases/${id}/users${rest}`;
const err = (r: Res) => json(r).error as { code: string; message: string; field?: string };
const addUser = async (who: Fixture | string, id: string, body: unknown, h2: Record<string, string> = {}) => {
  const r = keep(await h.as(who).post(path(id), body, h2));
  if (r.statusCode === 201) shown.push(json(r).password);
  return r;
};

describe("the initial user", () => {
  test("create makes `app` with readWrite; its password is in the first answer only, 40 letters and digits, and works", async () => {
    const d = await create("users-init-01");
    assert.equal(d.initialUser.username, "app");
    assert.equal(d.initialUser.role, "readWrite");
    assert.match(d.initialUser.password!, /^[A-Za-z0-9]{40}$/);
    assert.ok(users.checkPassword(d.id, "app", d.initialUser.password!), "the engine has this password");
    assert.match(d.connectionString, /^mongodb:\/\/app:<password>@/);
    assert.equal(d.initialUser.connectionString, d.connectionString.replace("<password>", d.initialUser.password!));
    // Read again: the database and the operation say who, never the password.
    const again = keep(await h.as(u).get(`/databases/${d.id}`));
    assert.equal(json(again).connectionString, d.connectionString);
    assert.ok(!again.body.includes(d.initialUser.password!));
    const op = keep(await h.as(u).get(`/operations/${(await h.admin.query("select id from public.operations where database_id = $1 and kind = 'create'", [d.id])).rows[0].id}`));
    assert.deepEqual(json(op).result.initialUser, { username: "app", role: "readWrite", password: null, connectionString: null });
    assert.ok(!op.body.includes(d.initialUser.password!));
    assert.equal(h.app.deps.s.once.size, 0, "nothing is left in memory once it was shown");
  });

  test("the answer that shows the password is not cacheable", async () => {
    const r = keep(await h.as(u).post("/databases", { name: "users-init-cache", region: "eu-central-1" }));
    shown.push(json(r).initialUser.password);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers.pragma, "no-cache");
  });

  test("a name can be given; a hostile or reserved one is refused before anything is made", async () => {
    const d = await create("users-init-named", { appUser: "web-api" });
    assert.equal(d.initialUser.username, "web-api");
    assert.match(d.connectionString, /^mongodb:\/\/web-api:<password>@/);
    for (const bad of ["cp_x", "admin", "root", "App", "a", "x".repeat(33), "<script>", "a b", "ä-user", { $ne: 1 }, ["app"], 7, "fenvix-x", "mongo1"]) {
      const r = keep(await h.as(u).post("/databases", { name: `users-bad-${randomUUID().slice(0, 6)}`, region: "eu-central-1", appUser: bad }));
      assert.equal(r.statusCode, 400, `${JSON.stringify(bad)}: ${r.body}`);
      assert.equal(err(r).field, "appUser");
    }
  });

  test("a repeat with the same Idempotency-Key gets the same database, no password, and no second user", async () => {
    const key = randomUUID();
    const one = keep(await h.as(u).post("/databases", { name: "users-idem-01", region: "eu-central-1" }, { "idempotency-key": key }));
    const two = keep(await h.as(u).post("/databases", { name: "users-idem-01", region: "eu-central-1" }, { "idempotency-key": key }));
    assert.equal(one.statusCode, 201);
    shown.push(json(one).initialUser.password);
    assert.equal(two.statusCode, 201);
    assert.equal(two.headers["idempotent-replay"], "true");
    assert.equal(json(two).id, json(one).id);
    assert.equal(json(two).initialUser.password, null);
    assert.equal(json(two).initialUser.connectionString, null);
    assert.equal(users.customers.get(json(one).id)!.size, 1);
    assert.ok(users.checkPassword(json(one).id, "app", json(one).initialUser.password), "the first password still works: nothing was reset");
  });

  test("when the answer is a 202 the password is never shown; the user exists and its password can be reset", async () => {
    h.engine.delay("create", 6000); // longer than OPERATION_WAIT_MS (5 s)
    const r = keep(await h.as(u).post("/databases", { name: "users-slow-01", region: "eu-central-1" }));
    h.engine.delay("create", 0);
    assert.equal(r.statusCode, 202, r.body);
    const opId = String(r.headers["operation-id"]);
    let op: { status: string; result: { id: string; initialUser: unknown } } = json(r).operation;
    for (let i = 0; i < 100 && op.status !== "succeeded"; i++) { await sleep(100); op = json(keep(await h.as(u).get(`/operations/${opId}`))); }
    assert.equal(op.status, "succeeded");
    assert.deepEqual(op.result.initialUser, { username: "app", role: "readWrite", password: null, connectionString: null });
    assert.equal(users.customers.get(op.result.id)!.has("app"), true);
    const reset = keep(await h.as(u).post(path(op.result.id, "/app/reset-password")));
    assert.equal(reset.statusCode, 200, reset.body);
    shown.push(json(reset).password);
  });

  test("fork: a new `app` with a new password; the source's users are not copied", async () => {
    const src = await create("users-fork-src");
    assert.equal((await addUser(u, src.id, { username: "reporting", role: "read" })).statusCode, 201);
    const r = keep(await h.as(u).post(`/databases/${src.id}/fork`, { name: "users-fork-copy" }));
    assert.equal(r.statusCode, 201, r.body);
    const f = json(r);
    shown.push(f.initialUser.password);
    assert.equal(f.initialUser.username, "app");
    assert.notEqual(f.initialUser.password, src.initialUser.password);
    assert.deepEqual([...users.customers.get(f.id)!.keys()], ["app"], "only its own initial user");
    assert.equal(users.checkPassword(f.id, "app", src.initialUser.password!), false);
    assert.deepEqual(json(keep(await h.as(u).get(path(f.id)))).items.map((x: { username: string }) => x.username), ["app"]);
  });

  test("an initial user that cannot be made fails the create; the engine's database and both users are gone", async () => {
    const erases = h.engine.effects.erase;
    users.failNext("customer", "invalid");
    const r = keep(await h.as(u).post("/databases", { name: "users-init-fails", region: "eu-central-1" }));
    assert.equal(r.statusCode, 500, r.body);
    assert.equal(err(r).message, "The database's first user could not be created, so the database was not created. Try again.");
    assert.doesNotMatch(r.body, /fake|engine refused|injected/i);
    const id = (await h.admin.query("select database_id from public.operations where id = $1", [r.headers["operation-id"]])).rows[0].database_id;
    assert.equal((await h.admin.query("select 1 from public.databases where id = $1", [id])).rowCount, 0);
    assert.equal(h.engine.dbs.has(id), false);
    assert.equal(h.engine.effects.erase, erases + 1);
    assert.equal(users.users.has(id), false, "the control plane's user is dropped too");
    assert.equal(users.customers.has(id), false);
    assert.equal(h.app.deps.s.once.take(String(r.headers["operation-id"])), null, "its password was forgotten");
  });
});

describe("the users routes", () => {
  let d: Awaited<ReturnType<typeof create>>;
  before(async () => { d = await create("users-routes-01"); });

  test("list: name, role, creation time; never a password, never the control plane's own user", async () => {
    const r = keep(await h.as(u).get(path(d.id)));
    assert.equal(r.statusCode, 200);
    const b = json(r);
    assert.equal(b.limit, 4);
    assert.deepEqual(b.items.map((x: object) => Object.keys(x).sort()), [["createdAt", "role", "username"]]);
    assert.equal(b.items[0].username, "app");
    assert.match(b.items[0].createdAt, /^\d{4}-\d\d-\d\dT/);
    assert.ok(!r.body.includes(engineUserName(d.id)));
    assert.ok(!/password|pwd|hash|scram/i.test(r.body));
    assert.equal(r.headers["cache-control"], "no-store");
  });

  test("create: 201 with the password once, a working connection string, readWrite by default or read", async () => {
    const r = await addUser(u, d.id, { username: "reporting", role: "read" });
    assert.equal(r.statusCode, 201, r.body);
    const b = json(r);
    assert.deepEqual(Object.keys(b).sort(), ["connectionString", "password", "user"]);
    assert.equal(b.user.username, "reporting");
    assert.equal(b.user.role, "read");
    assert.match(b.password, /^[A-Za-z0-9]{40}$/);
    assert.ok(b.connectionString.startsWith(`mongodb://reporting:${b.password}@${d.host}:`));
    assert.ok(users.checkPassword(d.id, "reporting", b.password));
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers.pragma, "no-cache");
    const def = await addUser(u, d.id, { username: "worker" });
    assert.equal(json(def).user.role, "readWrite");
    const list = json(keep(await h.as(u).get(path(d.id))));
    assert.deepEqual(list.items.map((x: { username: string }) => x.username), ["app", "reporting", "worker"]);
    assert.ok(!JSON.stringify(list).includes(b.password));
    assert.equal((await addUser(u, d.id, { username: "reporting", role: "read" })).statusCode, 409);
  });

  test("reset: a new password once; the old one stops working; unknown and control-plane users are 404", async () => {
    const before = users.customers.get(d.id)!.get("reporting")!.passwordHash;
    const r = keep(await h.as(u).post(path(d.id, "/reporting/reset-password")));
    assert.equal(r.statusCode, 200, r.body);
    const b = json(r);
    shown.push(b.password);
    assert.equal(b.user.username, "reporting");
    assert.equal(b.user.role, "read");
    assert.notEqual(users.customers.get(d.id)!.get("reporting")!.passwordHash, before);
    assert.ok(users.checkPassword(d.id, "reporting", b.password));
    assert.equal(r.headers.pragma, "no-cache");
    for (const name of ["nobody", engineUserName(d.id), "cp_x", "%3Cscript%3E", "ADMIN"]) {
      const x = keep(await h.as(u).post(path(d.id, `/${name}/reset-password`)));
      assert.equal(x.statusCode, 404, `${name}: ${x.body}`);
      assert.equal(err(x).message, "That user does not exist.");
    }
  });

  test("delete: gone from the engine; again is 404; the control plane's user cannot be deleted", async () => {
    const r = keep(await h.as(u).del(path(d.id, "/worker")));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(json(r), { username: "worker", deleted: true });
    assert.equal(users.customers.get(d.id)!.has("worker"), false);
    assert.equal(keep(await h.as(u).del(path(d.id, "/worker"))).statusCode, 404);
    assert.equal(keep(await h.as(u).del(path(d.id, `/${engineUserName(d.id)}`))).statusCode, 404);
    assert.equal(users.users.has(d.id), true, "cp_ is still there");
  });

  test("deleting the connection string's user makes the string say <username>; a new user takes its place", async () => {
    const x = await create("users-appuser-01");
    assert.equal(keep(await h.as(u).del(path(x.id, "/app"))).statusCode, 200);
    assert.match(json(keep(await h.as(u).get(`/databases/${x.id}`))).connectionString, /^mongodb:\/\/<username>:<password>@/);
    assert.equal((await addUser(u, x.id, { username: "next-app" })).statusCode, 201);
    assert.match(json(keep(await h.as(u).get(`/databases/${x.id}`))).connectionString, /^mongodb:\/\/next-app:<password>@/);
  });

  test("at most maxUsersPerDatabase users (4 in this suite)", async () => {
    const x = await create("users-limit-01");
    for (const n of ["u-one", "u-two", "u-three"]) assert.equal((await addUser(u, x.id, { username: n })).statusCode, 201);
    const over = await addUser(u, x.id, { username: "u-four" });
    assert.equal(over.statusCode, 409);
    assert.match(err(over).message, /up to 4 users/);
    assert.equal(users.customers.get(x.id)!.size, 4);
  });

  test("a repeated create or reset with the same Idempotency-Key is refused: no second user, no second password", async () => {
    const key = randomUUID();
    const one = await addUser(u, d.id, { username: "idem-user" }, { "idempotency-key": key });
    const two = await addUser(u, d.id, { username: "idem-user" }, { "idempotency-key": key });
    assert.equal(one.statusCode, 201);
    assert.equal(two.statusCode, 409);
    assert.match(err(two).message, /cannot be shown a second time/);
    assert.ok(users.checkPassword(d.id, "idem-user", json(one).password), "the first password was not replaced");
    const k2 = randomUUID();
    const r1 = keep(await h.as(u).post(path(d.id, "/idem-user/reset-password"), undefined, { "idempotency-key": k2 }));
    shown.push(json(r1).password);
    const r2 = keep(await h.as(u).post(path(d.id, "/idem-user/reset-password"), undefined, { "idempotency-key": k2 }));
    assert.equal(r2.statusCode, 409);
    assert.ok(users.checkPassword(d.id, "idem-user", json(r1).password));
    const rec = (await h.admin.query("select response_body from public.idempotency_keys where key = any($1)", [[key, k2]])).rows;
    assert.ok(rec.length === 2 && rec.every((x) => x.response_body === null), "only the status is kept");
  });
});

describe("hostile payloads", () => {
  let d: Awaited<ReturnType<typeof create>>;
  before(async () => { d = await create("users-hostile-01"); });

  test("roles other than the fixed list, in any shape, are refused; only readWrite and read ever reach the engine", async () => {
    const bad: unknown[] = [
      "root", "dbOwner", "userAdmin", "userAdminAnyDatabase", "readWriteAnyDatabase", "clusterAdmin", "__system", "dbAdmin", "readwrite", "READ", "readWrite ",
      { role: "readWrite", db: "admin" }, { role: "root", db: "admin" }, ["readWrite"], [{ role: "readWrite", db: "db_other" }], null, 1, true, "", "toString", "__proto__", "constructor", "hasOwnProperty",
    ];
    for (const role of bad) {
      const r = await addUser(u, d.id, { username: "hostile", role });
      assert.equal(r.statusCode, 400, `${JSON.stringify(role)}: ${r.body}`);
      assert.equal(err(r).field, "role");
    }
    for (const extra of [{ roles: [{ role: "root", db: "admin" }] }, { db: "admin" }, { privileges: [] }, { customData: {} }, { pwd: "x".repeat(40) }, { password: "chosen-by-me-1234567890" }, { mechanisms: ["SCRAM-SHA-1"] }]) {
      const r = await addUser(u, d.id, { username: "hostile", role: "read", ...extra });
      assert.equal(r.statusCode, 400, `${JSON.stringify(extra)}: ${r.body}`);
    }
    assert.equal(users.customers.get(d.id)!.has("hostile"), false);
    assert.ok(rolesSent.length > 0 && rolesSent.every((r) => Object.hasOwn(CUSTOMER_ROLES, r)), JSON.stringify(rolesSent));
  });

  test("names: length, characters, reserved names and prefixes", async () => {
    const bad: unknown[] = [
      "ab", "x".repeat(33), "Admin", "1user", "-user", "_user", "user name", "user.name", "user/x", "user$", "user\u0000x", "us\ner", "<script>alert(1)</script>",
      "ünïcode", "cp_123", "cp_" + "0".repeat(32), "cp-x", "admin", "root", "system", "fenvix", "fenvix-ops", "mongo-x", "provisioner", "local", "config", "__system",
      "fenvix_provisioner", { $gt: "" }, ["app"], 42, null, "",
    ];
    for (const username of bad) {
      const r = await addUser(u, d.id, { username, role: "read" });
      assert.equal(r.statusCode, 400, `${JSON.stringify(username)}: ${r.body}`);
      assert.equal(err(r).field, "username");
    }
    assert.deepEqual([...users.customers.get(d.id)!.keys()], ["app"]);
  });

  test("not a JSON object, or too big: a clean 400", async () => {
    for (const body of [[], "x", 5]) {
      const r = keep(await h.app.fastify.inject({ method: "POST", url: `/v1${path(d.id)}`, headers: { cookie: `fnx_session=${u.token}`, "content-type": "application/json" }, payload: JSON.stringify(body) }));
      assert.equal(r.statusCode, 400, r.body);
    }
    const big = keep(await h.app.fastify.inject({ method: "POST", url: `/v1${path(d.id)}`, headers: { cookie: `fnx_session=${u.token}`, "content-type": "application/json" }, payload: JSON.stringify({ username: "x".repeat(300_000) }) }));
    assert.equal(big.statusCode, 400);
  });
});

describe("who may do what", () => {
  let d: Awaited<ReturnType<typeof create>>;
  before(async () => { d = await create("users-perm-01"); });

  test("a member can list but not create, reset or delete; refusals are audited", async () => {
    const m = await h.addMember(u.workspaceId, "Member", "member");
    assert.equal(keep(await h.as(m).get(path(d.id))).statusCode, 200);
    const attempts = [
      await addUser(m, d.id, { username: "by-member" }),
      keep(await h.as(m).post(path(d.id, "/app/reset-password"))),
      keep(await h.as(m).del(path(d.id, "/app"))),
    ];
    for (const r of attempts) { assert.equal(r.statusCode, 403, r.body); assert.match(err(r).message, /owner or admin/); }
    const rows = (await h.admin.query("select action, outcome, metadata from public.audit_log where actor_id = $1 and action like 'database.user.%' order by id", [m.userId])).rows;
    assert.deepEqual(rows.map((r) => [r.action, r.outcome]), [["database.user.create", "denied"], ["database.user.reset_password", "denied"], ["database.user.delete", "denied"]]);
    assert.ok(users.customers.get(d.id)!.has("app"));
  });

  test("an admin can do everything", async () => {
    const a = await h.addMember(u.workspaceId, "Admin", "admin");
    assert.equal((await addUser(a, d.id, { username: "by-admin" })).statusCode, 201);
    const r = keep(await h.as(a).post(path(d.id, "/by-admin/reset-password")));
    shown.push(json(r).password);
    assert.equal(r.statusCode, 200);
    assert.equal(keep(await h.as(a).del(path(d.id, "/by-admin"))).statusCode, 200);
  });

  test("API keys: any key can list; only a key with user access manage can change users", async () => {
    for (const k of [await h.apiKey(u.workspaceId, "plain"), await h.apiKey(u.workspaceId, "data rw", "read_write")]) {
      assert.equal(keep(await h.as(k).get(path(d.id))).statusCode, 200);
      const r = await addUser(k, d.id, { username: "by-key" });
      assert.equal(r.statusCode, 403);
      assert.match(err(r).message, /user access manage/);
      assert.equal(keep(await h.as(k).post(path(d.id, "/app/reset-password"))).statusCode, 403);
      assert.equal(keep(await h.as(k).del(path(d.id, "/app"))).statusCode, 403);
    }
    const mk = await h.apiKey(u.workspaceId, "users", "read", "manage");
    assert.equal((await addUser(mk, d.id, { username: "by-key" })).statusCode, 201);
    const rs = keep(await h.as(mk).post(path(d.id, "/by-key/reset-password")));
    shown.push(json(rs).password);
    assert.equal(rs.statusCode, 200);
    assert.equal(keep(await h.as(mk).del(path(d.id, "/by-key"))).statusCode, 200);
    const row = (await h.admin.query("select actor_type from public.audit_log where action = 'database.user.create' and metadata->>'username' = 'by-key' and outcome = 'ok'")).rows[0];
    assert.equal(row.actor_type, "api_key");
  });

  test("POST /api-keys takes userAccess (none by default, or manage); anything else is refused", async () => {
    const plain = keep(await h.as(u).post("/api-keys", { name: "plain" }));
    assert.equal(json(plain).key.userAccess, "none");
    const man = keep(await h.as(u).post("/api-keys", { name: "manager", userAccess: "manage" }));
    assert.equal(json(man).key.userAccess, "manage");
    assert.equal(keep(await h.as(u).post("/api-keys", { name: "x", userAccess: "root" })).statusCode, 400);
    const k = json(man).secret as string;
    assert.equal((await addUser(k, d.id, { username: "via-made-key" })).statusCode, 201);
  });
});

describe("isolation between workspaces", () => {
  test("every route answers a database of another workspace with the same 404 as one that does not exist, as a person and as a key", async () => {
    const d = await create("users-iso-01");
    const otherKey = await h.apiKey(other.workspaceId, "other manage", "read", "manage");
    const otherAdmin = other;
    const missing = randomUUID();
    for (const who of [otherAdmin, otherKey] as (Fixture | string)[]) {
      const c = h.as(who);
      for (const id of [d.id, missing, "not-a-uuid", d.id.toUpperCase()]) {
        const answers = [
          keep(await c.get(path(id))),
          keep(await c.post(path(id), { username: "intruder", role: "readWrite" })),
          keep(await c.post(path(id, "/app/reset-password"))),
          keep(await c.del(path(id, "/app"))),
        ];
        for (const r of answers) {
          assert.equal(r.statusCode, 404, `${id}: ${r.body}`);
          assert.deepEqual(json(r), { error: { code: "not_found", message: "That database does not exist." } });
        }
      }
    }
    assert.deepEqual([...users.customers.get(d.id)!.keys()], ["app"]);
    assert.ok(users.checkPassword(d.id, "app", d.initialUser.password!), "the owner's password was not reset by anyone else");
    // Nothing about the other workspace's attempts is written in this workspace's audit log.
    const rows = (await h.admin.query("select 1 from public.audit_log where workspace_id = $1 and action like 'database.user.%' and target_id = $2", [u.workspaceId, d.id])).rows;
    assert.equal(rows.length, 0);
  });
});

describe("lifecycle", () => {
  test("erase drops every user of the database (ours and the customer's)", async () => {
    const d = await create("users-erase-01");
    await addUser(u, d.id, { username: "one-more" });
    assert.deepEqual(json(keep(await h.as(u).post("/databases/erase", { ids: [d.id] }))), { affected: 1 });
    assert.equal(users.customers.has(d.id), false);
    assert.equal(users.users.has(d.id), false);
  });

  test("an erase the engine refuses for good gives the customer's users their roles back", async () => {
    const d = await create("users-erase-refused");
    await addUser(u, d.id, { username: "keeps-working", role: "read" });
    h.engine.failNext("erase", "conflict");
    assert.equal(keep(await h.as(u).post("/databases/erase", { ids: [d.id] })).statusCode, 409);
    const list = json(keep(await h.as(u).get(path(d.id)))).items;
    assert.deepEqual(list.map((x: { username: string; role: string }) => [x.username, x.role]), [["app", "readWrite"], ["keeps-working", "read"]]);
    assert.ok(users.checkPassword(d.id, "app", d.initialUser.password!));
  });

  test("restore leaves users as they are", async () => {
    const d = await create("users-restore-01");
    await addUser(u, d.id, { username: "after-point", role: "read" });
    const r = keep(await h.as(u).post(`/databases/${d.id}/restore`, { at: new Date(Date.now() - 1000).toISOString() }));
    assert.ok([200, 400].includes(r.statusCode), r.body);
    assert.deepEqual(json(keep(await h.as(u).get(path(d.id)))).items.map((x: { username: string }) => x.username), ["after-point", "app"]);
  });

  test("a database being erased or restored: 409; one still being created: 404", async () => {
    const d = await create("users-busy-01");
    await h.admin.query("update public.databases set engine_state = 'restoring' where id = $1", [d.id]);
    assert.equal(keep(await h.as(u).get(path(d.id))).statusCode, 409);
    assert.equal((await addUser(u, d.id, { username: "busy" })).statusCode, 409);
    await h.admin.query("update public.databases set engine_state = 'provisioning' where id = $1", [d.id]);
    assert.equal(keep(await h.as(u).get(path(d.id))).statusCode, 404);
    await h.admin.query("update public.databases set engine_state = 'ready' where id = $1", [d.id]);
  });

  test("the user sweep never touches the customer's users", async () => {
    const d = await create("users-sweep-01");
    await addUser(u, d.id, { username: "sweep-safe" });
    users.users.delete(d.id); // our own user lost: the sweep makes it again
    const out = await reconcileEngineUsers(h.app.deps.s);
    assert.equal(out.created >= 1, true);
    assert.deepEqual([...users.customers.get(d.id)!.keys()].sort(), ["app", "sweep-safe"]);
  });
});

describe("errors, audit, and the password nowhere else", () => {
  test("an engine that does not answer: 503 with our words only, and the failure is audited", async () => {
    const d = await create("users-down-01");
    users.failNext("customer", "unavailable");
    const r = await addUser(u, d.id, { username: "while-down" });
    assert.equal(r.statusCode, 503, r.body);
    assert.deepEqual(json(r), { error: { code: "unavailable", message: "The database engine did not answer. Try again in a moment." } });
    users.failNext("customer", "unavailable");
    assert.equal(keep(await h.as(u).get(path(d.id))).statusCode, 503);
    const row = (await h.admin.query("select outcome, metadata from public.audit_log where action = 'database.user.create' and metadata->>'username' = 'while-down'")).rows[0];
    assert.equal(row.outcome, "failed");
    assert.equal(row.metadata.code, "unavailable");
  });

  test("every change is audited with who, which database, which user, when and the outcome", async () => {
    const d = await create("users-audit-01");
    await addUser(u, d.id, { username: "audited", role: "read" });
    shown.push(json(keep(await h.as(u).post(path(d.id, "/audited/reset-password")))).password);
    await h.as(u).del(path(d.id, "/audited"));
    const rows = (await h.admin.query("select action, outcome, actor_type, actor_id, target_type, target_id, metadata, at from public.audit_log where target_id = $1 and action like 'database.user.%' order by id", [d.id])).rows;
    assert.deepEqual(rows.map((r) => [r.action, r.outcome, r.metadata.username]), [
      ["database.user.create", "ok", "audited"], ["database.user.reset_password", "ok", "audited"], ["database.user.delete", "ok", "audited"],
    ]);
    assert.ok(rows.every((r) => r.actor_type === "user" && r.actor_id === u.userId && r.target_type === "database" && r.at instanceof Date));
    assert.equal(rows[0].metadata.role, "read");
  });

  test("rate limits per person and per key on changes (429 with Retry-After)", async () => {
    const tight = await startHarness({ LIMITS_FILE: limitsFile({ userChangesPerMinute: 2, userListsPerMinute: 3 }) }, { usersFactory: () => new FakeEngineUsers() });
    try {
      const w = await tight.user();
      const r = await tight.as(w).post("/databases", { name: "rl-01", region: "eu-central-1" });
      const id = json(r).id;
      const codes = [];
      for (const n of ["rl-a", "rl-b", "rl-c"]) codes.push((await tight.as(w).post(`/databases/${id}/users`, { username: n })).statusCode);
      assert.deepEqual(codes, [201, 201, 429]);
      const k = await tight.apiKey(w.workspaceId, "k", "read", "manage");
      const byKey = await tight.as(k).post(`/databases/${id}/users`, { username: "rl-d" });
      assert.equal(byKey.statusCode, 201, "the key has its own budget");
      assert.ok(Number((await tight.as(w).post(`/databases/${id}/users`, { username: "rl-e" })).headers["retry-after"]) > 0);
      const lists = [];
      for (let i = 0; i < 5; i++) lists.push((await tight.as(k).get(`/databases/${id}/users`)).statusCode);
      assert.deepEqual(lists, [200, 200, 200, 200, 429], "lists and changes share the per-key budget of 3 + 2, the key used one change");
    } finally { await tight.close(); }
  });

  test("no password in any later answer, the log, the audit logs, operations, idempotency records or database rows", async () => {
    assert.ok(shown.length >= 15, `passwords shown: ${shown.length}`);
    const firsts = new Set<string>();
    // Each password was in exactly one answer.
    for (const p of shown) {
      const n = bodies.filter((b) => b.includes(p)).length;
      assert.equal(n, 1, "a password appeared in more than one answer");
      firsts.add(p);
    }
    const tables = ["audit_log", "data_audit_log", "operations", "idempotency_keys", "databases", "api_keys"];
    const dump = (await Promise.all(tables.map(async (t) => JSON.stringify((await h.admin.query(`select * from public.${t}`)).rows)))).join("\n");
    const logs = h.logs.text();
    for (const p of firsts) {
      assert.ok(!dump.includes(p), "a password is stored in Postgres");
      assert.ok(!logs.includes(p), "a password is in the log");
    }
    assert.doesNotMatch(logs, /"pwd"|passwordHash/);
  });
});
