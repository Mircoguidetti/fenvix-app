import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { type Fixture, type Harness, json, sleep, startHarness } from "../helpers/harness.ts";

/**
 * No key outlives its creator, whatever the timing (migration 0010 and services/apikeys.ts createKey). Each test runs
 * a key creation through the API while another transaction demotes the creating person or revokes the creating key,
 * in both orders, and then checks that no active key made by that creator is left.
 */
let h: Harness;
let owner: Fixture;
const org = (f: Fixture) => ({ "x-fenvix-workspace": f.workspaceId });

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_ANON_PER_MINUTE: "100000", PUBLIC_API_RATE_LIMIT_PER_MINUTE: "100000" });
  owner = await h.user("Owner");
});
after(async () => { await h.close(); });

/**
 * Waits until a session (the service's, or the one with this pid) is waiting on a lock. With `required: false` it
 * gives up quietly after a moment: without the locks (a regression) the test must go on and fail on what matters,
 * a key that survived.
 */
async function waitForLockWait(pid?: number, required = true): Promise<void> {
  for (let i = 0; i < (required ? 100 : 50); i++) {
    const n = (await h.admin.query(
      pid === undefined
        ? "select count(*)::int as n from pg_stat_activity where usename = 'fenvix_control_plane' and wait_event_type = 'Lock'"
        : "select count(*)::int as n from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'",
      pid === undefined ? [] : [pid])).rows[0].n;
    if (n > 0) return;
    await sleep(20);
  }
  if (required) throw new Error("nobody started waiting on the lock");
}

/** Transactions opened by the current test; always ended and released afterwards, whatever happened. */
let open: pg.PoolClient[] = [];
afterEach(async () => {
  for (const c of open) { await c.query("rollback").catch(() => {}); c.release(); }
  open = [];
});

async function begin(): Promise<{ c: pg.PoolClient; pid: number }> {
  const c = await h.admin.connect();
  open.push(c);
  await c.query("begin");
  return { c, pid: (await c.query("select pg_backend_pid() as p")).rows[0].p };
}

/** Holds the per-organization lock createKey takes after checking its creator, so a create can be paused there. */
async function holdCreateLock(ws: string) {
  const t = await begin();
  await t.c.query("select pg_advisory_xact_lock(hashtext('public_api_keys:' || $1))", [ws]);
  return t;
}

const activeBy = async (createdBy: string) => (await h.admin.query(
  "select count(*)::int as n from public.public_api_keys where created_by = $1 and revoked_at is null and (expires_at is null or expires_at > now())", [createdBy])).rows[0].n as number;

async function adminKey(f: Fixture, name: string) {
  const r = await h.as(f).post("/public/api-keys", { name, role: "admin" }, org(f));
  assert.equal(r.statusCode, 201, r.body);
  return json<{ key: { id: string }; token: string }>(r);
}

test("demoted first: the create waits for the demotion, then is refused", async () => {
  const pat = await h.addMember(owner.workspaceId, "Pat", "admin");
  const t = await begin();
  await t.c.query("update public.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [owner.workspaceId, pat.userId]);
  const req = h.as(pat).post("/public/api-keys", { name: "race-1", role: "admin" }, org(pat));
  await waitForLockWait(undefined, false);
  await t.c.query("commit");
  const r = await req;
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(await activeBy(pat.userId), 0);
});

test("created first: the demotion waits for the new key, then revokes it", async () => {
  const pat = await h.addMember(owner.workspaceId, "Pat2", "admin");
  const hold = await holdCreateLock(owner.workspaceId);
  const req = h.as(pat).post("/public/api-keys", { name: "race-2", role: "admin" }, org(pat));
  await waitForLockWait();                     // the create has locked Pat's membership and waits on `hold`
  const demote = await begin();
  const done = demote.c.query("update public.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2", [owner.workspaceId, pat.userId]);
  await waitForLockWait(demote.pid, false);    // the demotion waits for the create
  await hold.c.query("commit");
  const r = await req;
  assert.equal(r.statusCode, 201, r.body);
  await done;
  await demote.c.query("commit");
  assert.equal(await activeBy(pat.userId), 0, "the key made during the demotion is revoked");
  assert.equal((await h.as(json(r).token).get("/public/organization")).statusCode, 401);
});

test("creating key revoked first: the create waits for the revoke, then is refused", async () => {
  const parent = await adminKey(owner, "parent-1");
  const t = await begin();
  await t.c.query("update public.public_api_keys set revoked_at = now() where id = $1", [parent.key.id]);
  const req = h.as(parent.token).post("/public/api-keys", { name: "race-3", role: "read_only" });
  await waitForLockWait(undefined, false);
  await t.c.query("commit");
  const r = await req;
  assert.equal(r.statusCode, 401, r.body);
  assert.equal(await activeBy(parent.key.id), 0);
});

test("key created first: the revoke of its creator waits for it, then revokes it too", async () => {
  const parent = await adminKey(owner, "parent-2");
  assert.equal((await h.as(parent.token).get("/public/organization")).statusCode, 200);
  const hold = await holdCreateLock(owner.workspaceId);
  const req = h.as(parent.token).post("/public/api-keys", { name: "race-4", role: "read_only" });
  await waitForLockWait();                     // waits on `hold`, after locking the creating key
  const revoke = await begin();
  const done = revoke.c.query("update public.public_api_keys set revoked_at = now() where id = $1", [parent.key.id]);
  await waitForLockWait(revoke.pid, false);
  await hold.c.query("commit");
  const r = await req;
  assert.equal(r.statusCode, 201, r.body);
  await done;
  await revoke.c.query("commit");
  assert.equal(await activeBy(parent.key.id), 0, "the key made during the revoke is revoked");
});

test("inserts made outside the service (the SQL editor) follow the same rules", async () => {
  const member = await h.addMember(owner.workspaceId, "Mem", "member");
  const parent = await adminKey(owner, "parent-3");
  const ins = (createdByType: string, createdBy: string, role = "read_only", expires: string | null = null) => {
    const token = `fvx_${randomBytes(32).toString("base64url")}`;
    return h.admin.query(
      `insert into public.public_api_keys (workspace_id, name, role, key_hash, prefix, created_by_type, created_by, expires_at)
       values ($1, 'sql', $2, $3, $4, $5, $6, $7)`,
      [owner.workspaceId, role, createHash("sha256").update(token).digest("hex"), token.slice(0, 12), createdByType, createdBy, expires]);
  };
  await assert.rejects(ins("user", member.userId), /not an owner or admin/);
  await assert.rejects(ins("api_key", parent.key.id, "admin"), /only create read_only/);
  await ins("api_key", parent.key.id);
  await ins("user", owner.userId, "admin");
  const expiring = json(await h.as(owner).post("/public/api-keys", { name: "exp", role: "admin", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, org(owner)));
  await assert.rejects(ins("api_key", expiring.key.id), /outlives it/);
  await assert.rejects(ins("api_key", expiring.key.id, "read_only", new Date(Date.now() + 2 * 86_400_000).toISOString()), /outlives it/);
  await h.admin.query("update public.public_api_keys set revoked_at = now() where id = $1", [parent.key.id]);
  await assert.rejects(ins("api_key", parent.key.id), /not active/);
});
