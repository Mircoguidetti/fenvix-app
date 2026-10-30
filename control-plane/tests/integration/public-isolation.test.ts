import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import type { LightMyRequestResponse as Res } from "fastify";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

/**
 * A public API key of organization A can never read, change or delete anything of organization B, on any route.
 * B's rows are compared before and after A tries every route with B's ids; the route list comes from the app, so a new
 * public route without a case here fails the last test.
 */
let h: Harness;
let a: Fixture;
let b: Fixture;
let aKey = "";
let bKey = "";
let bKeyId = "";
let bDb = "";
let bOp = "";
let aDb = "";
const A_REQUESTS = 111;
const MONTH = new Date().toISOString().slice(0, 7);

async function snapshotOf(ws: string): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await h.admin.query(sql, [ws])).rows);
  return [
    await q("select id, name, state, engine_state, app_user from public.databases where workspace_id = $1 order by id"),
    await q("select id, name, role, revoked_at, expires_at from public.public_api_keys where workspace_id = $1 order by id"),
    await q("select database_id, entries from public.database_ip_allowlists where workspace_id = $1 order by database_id"),
    await q("select id, kind, status from public.operations where workspace_id = $1 order by id"),
    await q("select name from public.workspaces where id = $1"),
    // B's database users live in the engine only.
    JSON.stringify((await h.app.deps.s.users.listCustomer(bDb, "eu-central-1")).map((u) => [u.username, u.role]).sort()),
  ].join("\n");
}

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", PUBLIC_API_RATE_LIMIT_PER_MINUTE: "100000" });
  a = await h.user("Alice");
  b = await h.user("Bob");
  aKey = json(await h.as(a).post("/public/api-keys", { name: "a", role: "admin" }, { "x-fenvix-workspace": a.workspaceId })).token;
  const made = json(await h.as(b).post("/public/api-keys", { name: "b", role: "admin" }, { "x-fenvix-workspace": b.workspaceId }));
  bKey = made.token;
  bKeyId = made.key.id;
  const created = await h.as(bKey).post("/public/databases", { name: "bob-secret", region: "eu-central-1" });
  assert.equal(created.statusCode, 201, created.body);
  bDb = json(created).id;
  bOp = String(created.headers["operation-id"]);
  assert.equal((await h.as(bKey).post(`/public/databases/${bDb}/users`, { username: "bobuser" })).statusCode, 201);
  assert.equal((await h.as(bKey).put(`/public/databases/${bDb}/ip-allowlist`, { entries: ["198.51.100.0/24"] })).statusCode, 200);
  // Usage for both: B's numbers are ones A's could never add up to.
  const created2 = await h.as(aKey).post("/public/databases", { name: "alice-own", region: "eu-central-1" });
  assert.equal(created2.statusCode, 201, created2.body);
  aDb = json(created2).id;
  for (const [id, ws, requests] of [[aDb, a.workspaceId, A_REQUESTS], [bDb, b.workspaceId, 7_777_777]] as const) {
    await h.admin.query("insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes) values ($1, $2, (now() at time zone 'UTC')::date, $3, $3)", [id, ws, requests]);
    await h.admin.query("insert into public.usage_hourly (database_id, workspace_id, hour, requests, storage_bytes) values ($1, $2, date_trunc('hour', now()), $3, $3)", [id, ws, requests]);
  }
});
after(async () => { await h.close(); });

/** Each public route, tried by A's key against B. Keys are "METHOD /v1/public/path" as the app lists them. */
const cases: Record<string, () => Promise<{ res: Res; check?: (r: Res) => void }>> = {
  "GET /v1/public/databases": async () => ({ res: await h.as(aKey).get("/public/databases?limit=100"), check: (r) => assert.ok(!r.body.includes(bDb) && !r.body.includes("bob-secret")) }),
  "POST /v1/public/databases": async () => ({
    // A creates a database with B's name: it is A's (names are per organization), and B's is untouched.
    res: await h.as(aKey).post("/public/databases", { name: "bob-secret", region: "eu-central-1" }),
    check: (r) => { assert.equal(r.statusCode, 201); assert.notEqual(json(r).id, bDb); },
  }),
  "GET /v1/public/databases/:id": async () => ({ res: await h.as(aKey).get(`/public/databases/${bDb}`) }),
  "DELETE /v1/public/databases/:id": async () => ({ res: await h.as(aKey).del(`/public/databases/${bDb}`) }),
  "GET /v1/public/databases/:id/users": async () => ({ res: await h.as(aKey).get(`/public/databases/${bDb}/users`) }),
  "POST /v1/public/databases/:id/users": async () => ({ res: await h.as(aKey).post(`/public/databases/${bDb}/users`, { username: "intruder" }) }),
  "DELETE /v1/public/databases/:id/users/:username": async () => ({ res: await h.as(aKey).del(`/public/databases/${bDb}/users/bobuser`) }),
  "GET /v1/public/databases/:id/ip-allowlist": async () => ({ res: await h.as(aKey).get(`/public/databases/${bDb}/ip-allowlist`) }),
  "PUT /v1/public/databases/:id/ip-allowlist": async () => ({ res: await h.as(aKey).put(`/public/databases/${bDb}/ip-allowlist`, { entries: [] }) }),
  "GET /v1/public/usage": async () => ({
    // A's organization: A's numbers only. (B's database as databaseId: the next test.)
    res: await h.as(aKey).get("/public/usage?range=24h"),
    check: (r) => { assert.equal(json(r).totals.requests, A_REQUESTS); assert.ok(!r.body.includes(bDb)); },
  }),
  "GET /v1/public/databases/:id/usage": async () => ({ res: await h.as(aKey).get(`/public/databases/${bDb}/usage?range=30d`) }),
  "GET /v1/public/usage/export": async () => {
    const res = await h.as(aKey).get(`/public/usage/export?month=${MONTH}&by=database`);
    const file = res.statusCode === 200 ? (await h.app.fastify.inject(json(res).downloadUrl.replace("https://api.fenvix.test", ""))).body : "";
    return { res, check: () => { assert.ok(file.includes("alice-own") && !file.includes("bob-secret") && !file.includes("7777777"), file); } };
  },
  "GET /v1/public/organization": async () => ({ res: await h.as(aKey).get("/public/organization"), check: (r) => { assert.equal(json(r).id, a.workspaceId); assert.ok(!r.body.includes(b.workspaceId)); } }),
  "GET /v1/public/operations/:id": async () => ({ res: await h.as(aKey).get(`/public/operations/${bOp}`) }),
  "GET /v1/public/api-keys": async () => ({ res: await h.as(aKey).get("/public/api-keys?limit=100"), check: (r) => assert.ok(!r.body.includes(bKeyId)) }),
  "POST /v1/public/api-keys": async () => ({
    res: await h.as(aKey).post("/public/api-keys", { name: "made by a", role: "read_only" }),
    check: (r) => { assert.equal(r.statusCode, 201); },
  }),
  "DELETE /v1/public/api-keys/:id": async () => ({ res: await h.as(aKey).del(`/public/api-keys/${bKeyId}`) }),
};

test("A's key gets 404 (or only its own data) on every route, and B is unchanged", async () => {
  const before = await snapshotOf(b.workspaceId);
  for (const [route, run] of Object.entries(cases)) {
    const { res, check } = await run();
    if (check) {
      assert.ok(res.statusCode < 300, `${route}: ${res.statusCode} ${res.body}`);
      check(res);
    } else {
      assert.equal(res.statusCode, 404, `${route}: ${res.statusCode} ${res.body}`);
    }
    assert.ok(!res.body.includes("bobuser") && !res.body.includes("198.51.100"), route);
  }
  // A cannot name B's organization either.
  assert.equal((await h.as(aKey).get("/public/databases", { "x-fenvix-workspace": b.workspaceId })).statusCode, 404);
  assert.equal(await snapshotOf(b.workspaceId), before);
  // B's key still works and still sees its own things.
  assert.equal(json(await h.as(bKey).get(`/public/databases/${bDb}`)).id, bDb);
  assert.deepEqual(json(await h.as(bKey).get(`/public/databases/${bDb}/users`)).items.map((u: { username: string }) => u.username).sort(), ["app", "bobuser"]);
  // The key A made belongs to A.
  assert.equal((await h.admin.query("select count(*)::int as n from public.public_api_keys where workspace_id = $1 and name = 'made by a'", [b.workspaceId])).rows[0].n, 0);
});

test("A's key cannot name B's database in GET /usage, in any range", async () => {
  for (const range of ["24h", "7d", "30d"]) {
    const r = await h.as(aKey).get(`/public/usage?range=${range}&databaseId=${bDb}`);
    assert.equal(r.statusCode, 404, `${range}: ${r.body}`);
    assert.ok(!r.body.includes("7777777"));
    assert.equal((await h.as(aKey).get(`/public/databases/${bDb}/usage?range=${range}`)).statusCode, 404);
  }
  // B still sees its own.
  assert.equal(json(await h.as(bKey).get(`/public/usage?range=24h&databaseId=${bDb}`)).totals.requests, 7_777_777);
});

test("A's cursor cannot page into B: a cursor only narrows A's own rows", async () => {
  // A cursor built from B's newest database (time and id) still only returns A's databases.
  const row = (await h.admin.query("select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as at, id from public.databases where id = $1", [bDb])).rows[0];
  const cursor = Buffer.from(`${row.at}|${row.id}`).toString("base64url");
  const r = await h.as(aKey).get(`/public/databases?cursor=${cursor}&limit=100`);
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes(bDb));
  for (const d of json(r).items) assert.equal((await h.admin.query("select workspace_id from public.databases where id = $1", [d.id])).rows[0].workspace_id, a.workspaceId);
});

test("every public route has an isolation case", () => {
  const routes = h.app.routes.filter((r) => r.includes(" /v1/public/")).sort();
  assert.deepEqual(Object.keys(cases).sort(), routes);
});

test("in Postgres: the service role sees one workspace's keys; the dashboard's roles see none", async () => {
  const cp = new pg.Client({ connectionString: h.cpUrl });
  await cp.connect();
  try {
    await cp.query("begin");
    await cp.query("select set_config('app.workspace_id', $1, true)", [a.workspaceId]);
    assert.equal((await cp.query("select count(*)::int as n from public.public_api_keys where workspace_id = $1", [b.workspaceId])).rows[0].n, 0);
    assert.ok((await cp.query("select count(*)::int as n from public.public_api_keys")).rows[0].n > 0);
    await cp.query("rollback");
    for (const sql of ["update public.public_api_keys set key_hash = repeat('0', 64)", "delete from public.public_api_keys"]) {
      await cp.query("begin");
      await cp.query("select set_config('app.workspace_id', $1, true)", [a.workspaceId]);
      await assert.rejects(cp.query(sql), /permission denied/, sql);
      await cp.query("rollback");
    }
    // No workspace named: nothing.
    assert.equal((await cp.query("select count(*)::int as n from public.public_api_keys")).rows[0].n, 0);
  } finally { await cp.end(); }
  for (const role of ["anon", "authenticated"]) {
    const c = await h.admin.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${role}`);
      await assert.rejects(c.query("select * from public.public_api_keys"), /permission denied/, role);
      await c.query("rollback");
      await c.query("begin");
      await c.query(`set local role ${role}`);
      await assert.rejects(c.query("select * from public.fenvix_cp_resolve_public_api_key('x')"), /permission denied/, role);
      await c.query("rollback");
    } finally { c.release(); }
  }
  assert.equal((await h.admin.query("select relrowsecurity from pg_class where oid = 'public.public_api_keys'::regclass")).rows[0].relrowsecurity, true);
});
