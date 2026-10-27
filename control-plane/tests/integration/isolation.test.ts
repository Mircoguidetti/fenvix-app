import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

/**
 * A user can never read or change another workspace's data. Two workspaces, A and B, each with
 * databases, tags, keys, operations, invoices and usage. A then tries everything against B's ids
 * and B's names, and B's data is compared before and after.
 */
let h: Harness;
let a: Fixture;
let b: Fixture;
let aKey: string;
let bKey: string;
const bIds: string[] = [];
let bDb = "";
let bKeyId = "";
let bInvoice = "";
let bOperation = "";

async function snapshotOf(ws: string): Promise<string> {
  const q = async (sql: string) => JSON.stringify((await h.admin.query(sql, [ws])).rows);
  return [
    await q("select id, name, state, keep_awake, region, storage_bytes, restored_to, forked_from, engine_state from public.databases where workspace_id = $1 order by id"),
    await q("select database_id, key, value from public.database_tags where workspace_id = $1 order by database_id, key"),
    await q("select id, name, revoked_at, last4 from public.api_keys where workspace_id = $1 order by id"),
    await q("select name from public.workspaces where id = $1"),
    await q("select idle_minutes, email_notices, plan from public.workspace_settings where workspace_id = $1"),
    await q("select id, kind, status, params from public.operations where workspace_id = $1 order by id"),
    await q("select id, number, status from public.invoices where workspace_id = $1 order by id"),
    await q("select database_id, day, requests from public.usage_daily where workspace_id = $1 order by database_id, day"),
  ].join("\n");
}

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000" });
  a = await h.user("Alice");
  b = await h.user("Bob");
  aKey = await h.apiKey(a.workspaceId);
  bKey = await h.apiKey(b.workspaceId, "bob key");
  for (const [who, prefix] of [[a, "alice"], [b, "bob"]] as const) {
    for (let i = 1; i <= 3; i++) {
      const r = await h.as(who).post("/databases", { name: `${prefix}-prod-0${i}`, region: "eu-central-1", tags: [`customer:${prefix}`, "env:prod"] });
      assert.equal(r.statusCode, 201, r.body);
      if (who === b) bIds.push(json(r).id);
    }
  }
  bDb = bIds[0]!;
  bKeyId = (await h.admin.query("select id from public.api_keys where workspace_id = $1", [b.workspaceId])).rows[0].id;
  await h.admin.query("insert into public.invoices (workspace_id, number, month, issued_at, amount_cents, status) values ($1, 'B-001', '2026-09-01', now(), 1234, 'paid')", [b.workspaceId]);
  bInvoice = (await h.admin.query("select id from public.invoices where workspace_id = $1", [b.workspaceId])).rows[0].id;
  for (const id of bIds) {
    await h.admin.query("insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes) values ($1, $2, current_date, 777, 1073741824)", [id, b.workspaceId]);
    await h.admin.query("insert into public.usage_hourly (database_id, workspace_id, hour, requests, storage_bytes) values ($1, $2, date_trunc('hour', now()), 55, 1048576)", [id, b.workspaceId]);
  }
  await h.admin.query("update public.databases set requests_24h = 4242 where workspace_id = $1", [b.workspaceId]);
  bOperation = (await h.admin.query("select id from public.operations where workspace_id = $1 limit 1", [b.workspaceId])).rows[0].id;
});
after(async () => { await h.close(); });

describe("reading: A never sees B", () => {
  test("lists, ids, groups, tags, breakdown, overview and usage contain only A's data", async () => {
    for (const who of [a, aKey] as const) {
      const list = json(await h.as(who).get("/databases?pageSize=200"));
      assert.equal(list.total, 3);
      assert.ok(list.items.every((d: { name: string }) => d.name.startsWith("alice-")));
      const ids = json(await h.as(who).get("/databases/ids")).ids as string[];
      assert.equal(ids.length, 3);
      assert.ok(ids.every((id) => !bIds.includes(id)));
      assert.deepEqual(json(await h.as(who).get("/databases/groups?groupBy=customer")).groups.map((g: { value: string }) => g.value), ["alice"]);
      assert.ok(json(await h.as(who).get("/tags")).items.every((t: { key: string; value: string }) => t.key !== "customer" || t.value === "alice"));
      assert.deepEqual(json(await h.as(who).get("/tags/breakdown?key=customer")).items.map((r: { value: string }) => r.value), ["alice"]);
      const ov = json(await h.as(who).get("/overview?range=7d"));
      assert.equal(ov.totals.databases, 3);
      assert.equal(ov.totals.requests, 0, "none of B's 777 requests");
      assert.ok(ov.topDatabases.every((t: { name: string }) => t.name.startsWith("alice-")));
      assert.ok(!JSON.stringify(ov).includes("bob-"));
      assert.deepEqual(json(await h.as(who).get("/usage/months")).items, []);
    }
  });

  test("B's own API key sees B's data and nothing of A's", async () => {
    const list = json(await h.as(bKey).get("/databases"));
    assert.equal(list.total, 3);
    assert.ok(list.items.every((d: { name: string }) => d.name.startsWith("bob-")));
    assert.equal((await h.as(bKey).get(`/databases/${json(await h.as(a).get("/databases")).items[0].id}`)).statusCode, 404);
  });

  test("searching for B's names or tags finds nothing", async () => {
    assert.equal(json(await h.as(a).get("/databases?search=bob")).total, 0);
    assert.equal(json(await h.as(a).get("/databases?tag=customer:bob")).total, 0);
    assert.equal(json(await h.as(a).get("/databases?tag=!customer")).total, 0);
  });

  test("B's ids give 404 on every endpoint that takes one id", async () => {
    for (const who of [a, aKey] as const) {
      const c = h.as(who);
      const responses = [
        await c.get(`/databases/${bDb}`),
        await c.get(`/databases/${bDb}/usage?range=7d`),
        await c.post(`/databases/${bDb}/fork`, { name: "stolen-fork-01" }),
        await c.post(`/databases/${bDb}/restore`, { at: new Date(Date.now() - 1000).toISOString() }),
        await c.put(`/databases/${bDb}/tags`, { tags: ["customer:alice"] }),
        await c.get(`/operations/${bOperation}`),
        await c.post(`/invoices/${bInvoice}/download`),
      ];
      for (const r of responses) {
        assert.equal(r.statusCode, 404, r.body);
        assert.equal(json(r).error.code, "not_found");
      }
    }
  });

  test("B's invoices and keys are not in A's lists", async () => {
    assert.deepEqual(json(await h.as(a).get("/invoices")).items, []);
    assert.equal(json(await h.as(a).get("/invoices")).total, 0);
    assert.ok(json(await h.as(a).get("/api-keys")).items.every((k: { id: string }) => k.id !== bKeyId));
    assert.deepEqual(json(await h.as(a).get("/operations?pageSize=100")).items.filter((o: { id: string }) => o.id === bOperation), []);
  });

  test("A's usage report cannot reach B's usage, even by naming B's month and keys", async () => {
    const res = await h.as(a).get(`/usage?month=${new Date().toISOString().slice(0, 7)}&by=database`);
    assert.equal(res.statusCode, 400, "A has no report at all");
    assert.equal((await h.as(a).get(`/usage/export?month=${new Date().toISOString().slice(0, 7)}&by=database`)).statusCode, 400);
    assert.deepEqual(json(await h.as(a).get(`/usage/trend?month=${new Date().toISOString().slice(0, 7)}&tagKey=customer`)).series, []);
  });
});

describe("changing: A's attempts leave B untouched", () => {
  test("every mutating endpoint, aimed at B's ids, changes nothing of B's", async () => {
    const before = await snapshotOf(b.workspaceId);
    const c = h.as(a);
    const attempts = [
      await c.post("/databases/erase", { ids: bIds }),
      await c.post("/databases/keep-awake", { ids: bIds, enabled: true }),
      await c.post("/databases/tags/add", { ids: bIds, tags: ["hacked:yes", "customer:alice"] }),
      await c.post("/databases/tags/remove", { ids: bIds, tags: ["customer", "env:prod"] }),
      await c.put(`/databases/${bDb}/tags`, { tags: [] }),
      await c.post(`/databases/${bDb}/fork`, { name: "stolen-01" }),
      await c.post(`/databases/${bDb}/restore`, { at: new Date(Date.now() - 1000).toISOString() }),
      await c.post("/databases/export", { ids: bIds }),
      await c.post(`/api-keys/${bKeyId}/revoke`),
      await c.post(`/invoices/${bInvoice}/download`),
    ];
    const outcomes = attempts.map((r) => `${r.statusCode}:${r.statusCode === 200 ? r.body : ""}`);
    assert.deepEqual(outcomes, ["200:{\"affected\":0}", "200:{\"affected\":0}", "200:{\"affected\":0}", "200:{\"affected\":0}", "404:", "404:", "404:", "404:", "404:", "404:"]);
    assert.equal(await snapshotOf(b.workspaceId), before, "B's rows are byte-for-byte the same");
    assert.equal(h.engine.dbs.size >= 6, true);
    for (const id of bIds) {
      assert.equal(h.engine.dbs.get(id)!.db.keepAwake, false, "the engine was not told to pin B's database");
      assert.ok(h.engine.dbs.has(id), "the engine still has B's database");
    }
    // and B can still use everything
    assert.equal(json(await h.as(b).get("/databases")).total, 3);
  });

  test("A's settings save changes A's workspace only", async () => {
    const before = await snapshotOf(b.workspaceId);
    const res = await h.as(a).put("/settings", { workspaceName: "Alice Inc", idleMinutes: 15, emailNotices: false });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(await h.as(a).get("/settings")), { workspaceName: "Alice Inc", idleMinutes: 15, emailNotices: false });
    assert.equal(await snapshotOf(b.workspaceId), before);
    assert.notEqual(json(await h.as(b).get("/settings")).workspaceName, "Alice Inc");
  });

  test("B's Idempotency-Key cannot be used to read B's earlier answer", async () => {
    const key = randomUUID();
    const first = await h.as(b).post("/databases", { name: "bob-idem-01", region: "eu-central-1" }, { "idempotency-key": key });
    assert.equal(first.statusCode, 201);
    const theirs = await h.as(a).post("/databases", { name: "bob-idem-01", region: "eu-central-1" }, { "idempotency-key": key });
    assert.equal(theirs.statusCode, 201);
    assert.notEqual(json(theirs).id, json(first).id);
    assert.equal(json(theirs).tags.length, 0);
  });

  test("a token for A with B's workspace id anywhere in the request still only reaches A", async () => {
    const own = json(await h.as(a).get("/databases")).total;
    const res = await h.as(a).get(`/databases?workspaceId=${b.workspaceId}&workspace_id=${b.workspaceId}`);
    assert.equal(json(res).total, own);
    const owners = (await h.admin.query("select distinct workspace_id from public.databases where id = any($1)", [json(res).items.map((d: { id: string }) => d.id)])).rows;
    assert.deepEqual(owners.map((r) => r.workspace_id), [a.workspaceId]);
    const created = await h.as(a).post("/databases", { name: "alice-sneaky-01", region: "eu-central-1", workspaceId: b.workspaceId, workspace_id: b.workspaceId });
    assert.equal(created.statusCode, 201);
    assert.equal((await h.admin.query("select workspace_id from public.databases where id = $1", [json(created).id])).rows[0].workspace_id, a.workspaceId);
  });

  test("hostile input in filters is data, not SQL", async () => {
    for (const q of ["search=%27%3B%20drop%20table%20public.databases%3B--", "tag=a%27%20or%20%271%27%3D%271", "state=awake%27--", "sort=name%3Bdrop%20table%20x"]) {
      const res = await h.as(a).get(`/databases?${q}`);
      assert.ok([200, 400].includes(res.statusCode), q);
      if (res.statusCode === 200) assert.equal(json(res).total, 0, q);
    }
    assert.equal((await h.as(a).get("/databases/groups?groupBy=x%27")).statusCode, 400);
    assert.equal(Number((await h.admin.query("select count(*) from public.databases")).rows[0].count) >= 6, true);
  });
});

describe("the database role itself cannot cross workspaces", () => {
  let c: pg.Client;
  before(async () => { c = new pg.Client({ connectionString: h.cpUrl }); await c.connect(); });
  after(async () => { await c.end(); });
  /** A statement that Postgres refuses aborts the transaction, so each one gets its own savepoint. */
  const refused = async (sql: string, params: unknown[], re: RegExp) => {
    await c.query("savepoint s");
    await assert.rejects(c.query(sql, params), re, sql);
    await c.query("rollback to savepoint s");
  };
  const as = async (ws: string | null, fn: () => Promise<void>) => {
    await c.query("begin");
    try {
      if (ws) await c.query("select set_config('app.workspace_id', $1, true)", [ws]);
      await fn();
    } finally { await c.query("rollback"); }
  };

  test("with no workspace named, every table is empty; with A named, only A's rows show", async () => {
    await as(null, async () => {
      for (const t of ["databases", "database_tags", "usage_daily", "usage_hourly", "operations", "idempotency_keys", "audit_log", "api_keys", "invoices", "workspace_settings", "workspaces", "wake_events"]) {
        assert.equal(Number((await c.query(`select count(*) from public.${t}`)).rows[0].count), 0, t);
      }
    });
    await as(a.workspaceId, async () => {
      assert.equal(Number((await c.query("select count(*) from public.databases where workspace_id <> $1", [a.workspaceId])).rows[0].count), 0);
      const mine = Number((await c.query("select count(*) from public.databases where workspace_id = $1", [a.workspaceId])).rows[0].count);
      assert.ok(mine >= 3);
      assert.equal(Number((await c.query("select count(*) from public.databases")).rows[0].count), mine, "everything visible is A's");
      assert.equal((await c.query("select id from public.workspaces")).rows.length, 1);
    });
  });

  test("writes aimed at another workspace fail or touch no rows", async () => {
    await as(a.workspaceId, async () => {
      assert.equal((await c.query("update public.databases set keep_awake = true where workspace_id = $1", [b.workspaceId])).rowCount, 0);
      assert.equal((await c.query("delete from public.databases where workspace_id = $1", [b.workspaceId])).rowCount, 0);
      assert.equal((await c.query("update public.api_keys set revoked_at = now() where workspace_id = $1", [b.workspaceId])).rowCount, 0);
      await refused("insert into public.databases (workspace_id, name, region) values ($1, 'plant-01', 'eu-central-1')", [b.workspaceId], /row-level security/);
      await refused("insert into public.audit_log (workspace_id, actor_type, action) values ($1, 'system', 'forged')", [b.workspaceId], /row-level security/);
      await refused("insert into public.operations (workspace_id, kind, actor_type) values ($1, 'erase', 'system')", [b.workspaceId], /row-level security/);
    });
  });

  test("a transaction cannot read another workspace by changing the setting mid-way after commit: the setting is local", async () => {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [a.workspaceId]);
    await c.query("commit");
    assert.equal(Number((await c.query("select count(*) from public.databases")).rows[0].count), 0, "the setting did not outlive its transaction");
  });

  test("the role has the narrow rights the migration promises", async () => {
    const attrs = (await h.admin.query("select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit from pg_roles where rolname = 'fenvix_control_plane'")).rows[0];
    assert.deepEqual(attrs, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false });
    const member = (await h.admin.query("select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'fenvix_control_plane'")).rows[0].n;
    assert.equal(member, 0, "it is a member of no role (not authenticated, not service_role)");
    await as(a.workspaceId, async () => {
      await refused("update public.audit_log set action = 'x'", [], /permission denied/);
      await refused("delete from public.audit_log", [], /permission denied/);
      await refused("delete from public.invoices", [], /permission denied/);
      await refused("insert into public.invoices (workspace_id, number, month, issued_at, amount_cents) values ($1, 'x', now(), now(), 1)", [a.workspaceId], /permission denied/);
      await refused("update public.api_keys set key_hash = repeat('0', 64)", [], /permission denied/);
      await refused("update public.workspace_settings set plan = 'free'", [], /permission denied/);
      await refused("select * from auth.users", [], /permission denied/);
      await refused("select * from public.workspace_members", [], /permission denied/);
      await refused("select public.fenvix_list_databases()", [], /permission denied/);
      await refused("create table public.x (a int)", [], /permission denied/);
      await refused("set role service_role", [], /permission denied|must be member/);
    });
  });

  test("the cross-workspace functions return only ids and roles", async () => {
    const r = await c.query("select * from public.fenvix_cp_workspace_for_user($1)", [b.userId]);
    assert.deepEqual(Object.keys(r.rows[0]), ["workspace_id", "role"]);
    const k = await c.query("select * from public.fenvix_cp_resolve_api_key($1)", ["0".repeat(64)]);
    assert.equal(k.rowCount, 0);
    const due = await c.query("select * from public.fenvix_cp_due_operations(5)");
    for (const row of due.rows) assert.deepEqual(Object.keys(row), ["id", "workspace_id"]);
  });

  test("anon and authenticated (the dashboard's roles) cannot touch the control-plane tables", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["operations", "idempotency_keys", "audit_log"]) {
        const r = await h.admin.query("select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i, has_table_privilege($1, $2, 'update') as u, has_table_privilege($1, $2, 'delete') as d", [role, `public.${t}`]);
        assert.deepEqual(r.rows[0], { s: false, i: false, u: false, d: false }, `${role} on ${t}`);
      }
      const f = await h.admin.query("select has_function_privilege($1, 'public.fenvix_cp_resolve_api_key(text)', 'execute') as e", [role]);
      assert.equal(f.rows[0].e, false, `${role} cannot resolve API keys`);
    }
  });
});
