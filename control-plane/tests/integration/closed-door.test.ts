import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

/** Migration 0003: the dashboard's own Supabase role can read, and can no longer write what the engine has to know about. */
let h: Harness;
let u: Fixture;
let dbId: string;
before(async () => {
  h = await startHarness();
  u = await h.user("Door");
  dbId = json(await h.as(u).post("/databases", { name: "door-01", region: "eu-central-1" })).id;
});
after(async () => { await h.close(); });

/** One statement as a signed-in dashboard user (`authenticated`, with their JWT claims), in its own transaction. */
async function asDashboard(userId: string, sql: string, params: unknown[] = []): Promise<{ ok: boolean; code?: string; rows?: unknown[] }> {
  const c: pg.PoolClient = await h.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    try {
      const r = await c.query(sql, params);
      return { ok: true, rows: r.rows };
    } catch (e) {
      return { ok: false, code: (e as { code?: string }).code };
    } finally { await c.query("rollback"); }
  } finally { c.release(); }
}

describe("the dashboard role after 0003", () => {
  test("it can still read what the dashboard shows", async () => {
    assert.equal((await asDashboard(u.userId, "select count(*)::int as n from public.databases")).rows![0]!["n" as never], 1);
    for (const q of ["select public.fenvix_list_tags()", "select public.fenvix_settings()", "select public.fenvix_billing()", "select public.fenvix_list_api_keys()", "select public.fenvix_usage_months()"]) {
      const r = await asDashboard(u.userId, q);
      assert.ok(r.ok, `${q}: ${r.code}`);
    }
    assert.ok((await asDashboard(u.userId, "select public.fenvix_get_database($1)", [dbId])).ok);
  });

  test("it cannot insert, update or delete in the four tables the engine has to know about", async () => {
    const ws = u.workspaceId;
    const attempts = [
      ["insert into public.databases (workspace_id, name, region) values ($1, 'sneaky-01', 'eu-central-1')", [ws]],
      ["update public.databases set keep_awake = true where workspace_id = $1", [ws]],
      ["update public.databases set name = 'renamed-01' where workspace_id = $1", [ws]],
      ["delete from public.databases where workspace_id = $1", [ws]],
      ["insert into public.database_tags (database_id, workspace_id, key, value) values ($1, $2, 'a', 'b')", [dbId, ws]],
      ["delete from public.database_tags where workspace_id = $1", [ws]],
      ["insert into public.api_keys (workspace_id, name, key_hash, last4) values ($1, 'k', repeat('a', 64), 'aaaa')", [ws]],
      ["update public.api_keys set revoked_at = now() where workspace_id = $1", [ws]],
      ["update public.workspace_settings set idle_minutes = 60 where workspace_id = $1", [ws]],
      ["delete from public.workspace_settings where workspace_id = $1", [ws]],
      ["truncate public.databases", []],
    ] as const;
    for (const [sql, params] of attempts) {
      const r = await asDashboard(u.userId, sql, [...params]);
      assert.deepEqual([r.ok, r.code], [false, "42501"], sql);
    }
  });

  test("it cannot call a function that changes data", async () => {
    const calls = [
      "select public.fenvix_create_database('sneaky-02', 'eu-west', '{}')",
      "select public.fenvix_fork_database($1, 'sneaky-03')",
      "select public.fenvix_restore_database($1, now() - interval '1 hour')",
      "select public.fenvix_erase_databases(array[$1]::uuid[])",
      "select public.fenvix_set_keep_awake(array[$1]::uuid[], true)",
      "select public.fenvix_set_tags($1, '{a:b}')",
      "select public.fenvix_add_tags(array[$1]::uuid[], '{a:b}')",
      "select public.fenvix_remove_tags(array[$1]::uuid[], '{a}')",
      "select public.fenvix_save_settings('x', 5, true)",
      "select public.fenvix_create_api_key('k', repeat('a', 64), 'aaaa')",
      "select public.fenvix_revoke_api_key($1)",
    ];
    for (const sql of calls) {
      const r = await asDashboard(u.userId, sql, sql.includes("$1") ? [dbId] : []);
      assert.deepEqual([r.ok, r.code], [false, "42501"], sql);
    }
  });

  test("nothing changed in the rows, and the control plane still works", async () => {
    const row = (await h.admin.query("select name, keep_awake from public.databases where id = $1", [dbId])).rows[0];
    assert.deepEqual(row, { name: "door-01", keep_awake: false });
    const res = await h.as(u).post("/databases/keep-awake", { ids: [dbId], enabled: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await h.admin.query("select keep_awake from public.databases where id = $1", [dbId])).rows[0].keep_awake, true);
  });

  test("the file is safe to run again", async () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/0003_close_dashboard_write_path.sql", import.meta.url), "utf8");
    await h.admin.query(sql);
    await h.admin.query(sql);
    assert.deepEqual((await asDashboard(u.userId, "update public.databases set keep_awake = false")).code, "42501");
  });
});

describe("hostnames cannot repeat", () => {
  test("two workspaces that share the first 8 characters of their id cannot both have a database of one name", async () => {
    const prefix = randomUUID().slice(0, 8);
    const a = `${prefix}-1111-4111-8111-111111111111`, b = `${prefix}-2222-4222-8222-222222222222`;
    await h.admin.query("insert into public.workspaces (id, name) values ($1, 'A'), ($2, 'B')", [a, b]);
    try {
      await h.admin.query("insert into public.databases (workspace_id, name, region) values ($1, 'same-name', 'eu-central-1')", [a]);
      await assert.rejects(h.admin.query("insert into public.databases (workspace_id, name, region) values ($1, 'same-name', 'eu-central-1')", [b]), (e: { code?: string; constraint?: string }) => e.code === "23505" && e.constraint === "databases_host_unique");
      await h.admin.query("insert into public.databases (workspace_id, name, region) values ($1, 'other-name', 'eu-central-1')", [b]);
    } finally {
      await h.admin.query("delete from public.workspaces where id in ($1, $2)", [a, b]);
    }
  });

  test("through the API that is the ordinary 409 'name already exists'", async () => {
    const prefix = u.workspaceId.slice(0, 8);
    const other = `${prefix}-9999-4999-8999-999999999999`;
    await h.admin.query("insert into public.workspaces (id, name) values ($1, 'Collides')", [other]);
    try {
      await h.admin.query("insert into public.databases (workspace_id, name, region) values ($1, 'taken-elsewhere', 'eu-central-1')", [other]);
      const before = h.engine.effects.create;
      const res = await h.as(u).post("/databases", { name: "taken-elsewhere", region: "eu-central-1" });
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(json(res).error.field, "name");
      assert.equal(h.engine.effects.create, before, "the engine was never asked");
    } finally {
      await h.admin.query("delete from public.workspaces where id = $1", [other]);
    }
  });
});
