import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

/**
 * The IP allowlist of a database and the network blocks (docs/network-allowlist.md) with the in-memory engine: who may
 * read and change them, validation, the order "engine first, then Postgres", what a refusal or a silent engine leaves
 * behind, the comparison with the engine's list and "apply again", the audit trail, isolation between workspaces, and
 * what create, fork, erase and restore do to the list. tests/engine-real/network.test.ts runs the same paths against
 * the real engine.
 */
let h: Harness;
let owner: Fixture;
let admin: Fixture;
let member: Fixture;
let other: Fixture;

before(async () => {
  h = await startHarness();
  owner = await h.user("Owner");
  admin = await h.addMember(owner.workspaceId, "Admin", "admin");
  member = await h.addMember(owner.workspaceId, "Member", "member");
  other = await h.user("Other Workspace");
});
after(async () => { await h.close(); });

const create = async (name: string, who: Fixture = owner) => {
  const r = await h.as(who).post("/databases", { name, region: "eu-central-1" });
  assert.equal(r.statusCode, 201, r.body);
  return json(r).id as string;
};
const path = (id: string) => `/databases/${id}/ip-allowlist`;
const saved = async (id: string) => (await h.admin.query("select entries, updated_by_type, updated_by, updated_at from public.database_ip_allowlists where database_id = $1", [id])).rows[0];
const audits = async (id: string, like = "database.ip_allowlist.%") =>
  (await h.admin.query("select action, outcome, actor_type, actor_id, metadata from public.audit_log where target_id = $1 and action like $2 order by id", [id, like])).rows;

describe("reading and setting the list", () => {
  test("a new database has no list: every address is allowed", async () => {
    const id = await create("net-new-01");
    const r = await h.as(owner).get(path(id));
    assert.equal(r.statusCode, 200, r.body);
    const b = json(r);
    assert.deepEqual(b.entries, []);
    assert.equal(b.allowAll, true);
    assert.equal(b.maxEntries, 100);
    assert.equal(b.updatedAt, null);
    assert.equal(b.updatedBy, null);
    assert.equal(b.engine.status, "in_sync");
    assert.equal(h.engine.allowlists.get(id), undefined);
  });

  test("an owner sets it: the engine gets it first, then it is saved in the engine's form, with who and when, and audited", async () => {
    const id = await create("net-set-01");
    const r = await h.as(owner).put(path(id), { entries: ["203.0.113.7", "10.0.0.0/8", "2001:DB8::/32", "::ffff:192.0.2.0/120"] });
    assert.equal(r.statusCode, 200, r.body);
    const want = ["203.0.113.7/32", "10.0.0.0/8", "2001:db8::/32", "192.0.2.0/24"];
    assert.deepEqual(json(r).entries, want);
    assert.equal(json(r).allowAll, false);
    assert.equal(json(r).engine.status, "in_sync");
    assert.deepEqual(h.engine.allowlists.get(id), want, "the engine has the list");
    const row = await saved(id);
    assert.deepEqual(row.entries, want);
    assert.equal(row.updated_by_type, "user");
    assert.equal(row.updated_by, owner.userId);
    assert.ok(Date.now() - new Date(row.updated_at).getTime() < 60_000);
    const g = json(await h.as(owner).get(path(id)));
    assert.deepEqual(g.updatedBy, { type: "user", id: owner.userId, name: "Owner" });
    const a = await audits(id);
    assert.equal(a.length, 1);
    assert.deepEqual(a[0], { action: "database.ip_allowlist.set", outcome: "ok", actor_type: "user", actor_id: owner.userId, metadata: { before: [], after: want } });
  });

  test("an admin can change it; a member can read it and gets 403 on a change, and nothing moves", async () => {
    const id = await create("net-roles-01");
    assert.equal((await h.as(admin).put(path(id), { entries: ["198.51.100.0/24"] })).statusCode, 200);
    const calls = h.engine.calls.allowlist;
    const r = await h.as(member).put(path(id), { entries: [] });
    assert.equal(r.statusCode, 403, r.body);
    assert.match(json(r).error.message, /read only/i);
    assert.equal(h.engine.calls.allowlist, calls, "the engine was not asked");
    assert.deepEqual(h.engine.allowlists.get(id), ["198.51.100.0/24"]);
    assert.deepEqual((await saved(id)).entries, ["198.51.100.0/24"]);
    const g = await h.as(member).get(path(id));
    assert.equal(g.statusCode, 200);
    assert.deepEqual(json(g).entries, ["198.51.100.0/24"]);
    assert.equal((await h.as(member).post(`${path(id)}/reapply`)).statusCode, 403);
  });

  test("an API key can read and change it, like the other database operations", async () => {
    const id = await create("net-key-01");
    const key = await h.apiKey(owner.workspaceId);
    const r = await h.as(key).put(path(id), { entries: ["192.0.2.1"] });
    assert.equal(r.statusCode, 200, r.body);
    const a = await audits(id);
    assert.equal(a[0].actor_type, "api_key");
    assert.equal(json(await h.as(key).get(path(id))).updatedBy.type, "api_key");
  });

  test("an empty list clears it in the engine and in Postgres: every address is allowed again", async () => {
    const id = await create("net-clear-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.1"] });
    const r = await h.as(owner).put(path(id), { entries: [] });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(json(r).allowAll, true);
    assert.deepEqual(h.engine.allowlists.get(id) ?? [], []);
    assert.deepEqual((await saved(id)).entries, []);
    assert.deepEqual((await audits(id)).map((x) => x.metadata), [{ before: [], after: ["192.0.2.1/32"] }, { before: ["192.0.2.1/32"], after: [] }]);
  });

  test("100 entries are accepted; the audit keeps all of them", async () => {
    const id = await create("net-100-01");
    const list = Array.from({ length: 100 }, (_, i) => `10.1.${i}.0/24`);
    assert.equal((await h.as(owner).put(path(id), { entries: list })).statusCode, 200);
    const a = await audits(id);
    assert.equal(a.at(-1).metadata.after.length, 100);
  });
});

describe("validation: the engine's rules, said in plain words, before the engine is asked", () => {
  let id: string;
  before(async () => { id = await create("net-valid-01"); });
  const cases: [string, unknown, RegExp, string?][] = [
    ["bits after the prefix", { entries: ["10.0.0.1/8"] }, /Entry 1 .*bits set after the prefix.*10\.0\.0\.0\/8/, "entries[0]"],
    ["not an address", { entries: ["10.0.0.0/8", "example.com"] }, /Entry 2 \("example\.com"\) contains a character/, "entries[1]"],
    ["a zone id", { entries: ["fe80::1%eth0"] }, /character that is not allowed/, "entries[0]"],
    ["prefix too long", { entries: ["10.0.0.0/33"] }, /larger than \/32/, "entries[0]"],
    ["leading zero", { entries: ["010.0.0.1"] }, /not an IPv4 or IPv6 address/, "entries[0]"],
    ["spaces", { entries: [" 10.0.0.0/8"] }, /character/, "entries[0]"],
    ["empty entry", { entries: [""] }, /is empty/, "entries[0]"],
    ["duplicate once normalized", { entries: ["1.2.3.4", "1.2.3.4/32"] }, /Entry 2 .*same network as entry 1/, "entries[1]"],
    ["mapped duplicate", { entries: ["10.0.0.0/8", "::ffff:10.0.0.0/104"] }, /same network/, "entries[1]"],
    ["101 entries", { entries: Array.from({ length: 101 }, (_, i) => `10.2.${i}.0/24`) }, /at most 100/, "entries"],
    ["not text", { entries: [5] }, /not text/, "entries[0]"],
    ["not a list", { entries: "10.0.0.0/8" }, /list/, "entries"],
    ["missing", {}, /entries/, "entries"],
    ["unknown field", { entries: [], allowAll: true }, /Unknown field/, "allowAll"],
    ["not an object", ["10.0.0.0/8"], /JSON object/, undefined],
  ];
  for (const [what, body, msg, field] of cases) {
    test(what, async () => {
      const calls = h.engine.calls.allowlist;
      const r = await h.as(owner).put(path(id), body);
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(json(r).error.code, "validation_failed");
      assert.match(json(r).error.message, msg);
      assert.equal(json(r).error.field, field);
      assert.equal(h.engine.calls.allowlist, calls, "the engine was not asked");
      assert.equal(await saved(id), undefined, "nothing saved");
    });
  }
});

describe("engine first, then Postgres", () => {
  test("an engine that does not answer: a clear 503, nothing saved, the engine's list unchanged, the attempt audited", async () => {
    const id = await create("net-down-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    h.engine.failNext("allowlist", "unavailable");
    const r = await h.as(owner).put(path(id), { entries: ["198.51.100.7"] });
    assert.equal(r.statusCode, 503, r.body);
    assert.match(json(r).error.message, /engine did not answer.*Nothing was changed/i);
    assert.deepEqual((await saved(id)).entries, ["192.0.2.0/24"]);
    assert.deepEqual(h.engine.allowlists.get(id), ["192.0.2.0/24"]);
    const a = await audits(id);
    assert.deepEqual(a.at(-1), { action: "database.ip_allowlist.set", outcome: "failed", actor_type: "user", actor_id: owner.userId, metadata: { before: ["192.0.2.0/24"], after: ["198.51.100.7/32"], code: "unavailable" } });
  });

  test("an engine that refuses the list: a clear error, nothing saved", async () => {
    const id = await create("net-refused-01");
    h.engine.failNext("allowlist", "invalid");
    const r = await h.as(owner).put(path(id), { entries: ["198.51.100.7"] });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(json(r).error.message, /engine refused the list.*Nothing was changed/i);
    assert.equal(await saved(id), undefined);
    assert.equal(h.engine.allowlists.get(id), undefined);
  });

  test("a list that differs in the engine is shown as different, and 'apply again' puts the saved one back", async () => {
    const id = await create("net-drift-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    h.engine.allowlists.set(id, ["0.0.0.0/0"]); // changed behind our back (or a Postgres commit that failed after the engine)
    const g = json(await h.as(member).get(path(id)));
    assert.equal(g.engine.status, "different");
    assert.deepEqual(g.engine.entries, ["0.0.0.0/0"]);
    assert.deepEqual(g.entries, ["192.0.2.0/24"], "the saved list is what the page shows");
    const r = await h.as(admin).post(`${path(id)}/reapply`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(json(r).engine.status, "in_sync");
    assert.deepEqual(h.engine.allowlists.get(id), ["192.0.2.0/24"]);
    const a = await audits(id);
    assert.deepEqual(a.at(-1), { action: "database.ip_allowlist.reapply", outcome: "ok", actor_type: "user", actor_id: admin.userId, metadata: { before: ["0.0.0.0/0"], after: ["192.0.2.0/24"] } });
  });

  test("the same list in another order is not a difference", async () => {
    const id = await create("net-order-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24", "10.0.0.0/8"] });
    h.engine.allowlists.set(id, ["10.0.0.0/8", "192.0.2.0/24"]);
    assert.equal(json(await h.as(owner).get(path(id))).engine.status, "in_sync");
  });

  test("an engine that does not answer a read: the saved list is still shown, its state unknown", async () => {
    const id = await create("net-readdown-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    h.engine.failNext("allowlist", "unavailable");
    const r = await h.as(owner).get(path(id));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(json(r).engine.status, "unavailable");
    assert.deepEqual(json(r).entries, ["192.0.2.0/24"]);
  });

  test("the Data Explorer's own address: trusted by the engine (the default), or not (the page must not promise it)", async () => {
    const id = await create("net-trust-01");
    assert.equal(json(await h.as(owner).get(path(id))).dataExplorer.trusted, true);
    h.engine.trusted = ["10.99.0.0/16"];
    try {
      assert.equal(json(await h.as(owner).get(path(id))).dataExplorer.trusted, false);
    } finally { h.engine.trusted = ["127.0.0.0/8", "::1/128"]; }
  });

  test("a database being erased or restored cannot have its list changed; one being made does not exist", async () => {
    const id = await create("net-busy-01");
    await h.admin.query("update public.databases set engine_state = 'restoring' where id = $1", [id]);
    assert.equal((await h.as(owner).put(path(id), { entries: [] })).statusCode, 409);
    await h.admin.query("update public.databases set engine_state = 'provisioning' where id = $1", [id]);
    assert.equal((await h.as(owner).put(path(id), { entries: [] })).statusCode, 404);
    assert.equal((await h.as(owner).get(path(id))).statusCode, 404);
    await h.admin.query("update public.databases set engine_state = 'ready' where id = $1", [id]);
  });
});

describe("isolation", () => {
  test("another workspace's database is 'does not exist', for reading, setting, blocks and unblocking; nothing changes", async () => {
    const id = await create("net-iso-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    h.engine.blocks.push({ ip: "203.0.113.9", database: id, until: new Date(Date.now() + 60_000).toISOString() });
    for (const r of [
      await h.as(other).get(path(id)), await h.as(other).put(path(id), { entries: [] }), await h.as(other).post(`${path(id)}/reapply`),
      await h.as(other).get(`/databases/${id}/network/blocks`), await h.as(other).post(`/databases/${id}/network/unblock`, { ip: "203.0.113.9" }),
      await h.as(owner).get(path(randomUUID())), await h.as(owner).get("/databases/not-an-id/ip-allowlist"),
    ]) assert.equal(r.statusCode, 404, r.body);
    assert.deepEqual(h.engine.allowlists.get(id), ["192.0.2.0/24"]);
    assert.equal(h.engine.blocks.filter((b) => b.database === id).length, 1);
    h.engine.blocks.length = 0;
  });

  test("the restricted role sees only the workspace it acts for (row level security)", async () => {
    const id = await create("net-rls-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    const pg = (await import("pg")).default;
    const c = new pg.Client({ connectionString: h.cpUrl });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true)", [other.workspaceId]);
      assert.equal((await c.query("select count(*)::int as n from public.database_ip_allowlists where database_id = $1", [id])).rows[0].n, 0);
      await assert.rejects(c.query("insert into public.database_ip_allowlists (database_id, workspace_id, entries) values ($1, $2, '{}')", [id, owner.workspaceId]));
      await c.query("rollback");
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true)", [other.workspaceId]);
      // a row of another workspace's database, filed under one's own workspace: refused by the foreign key on (database, workspace)
      await assert.rejects(c.query("insert into public.database_ip_allowlists (database_id, workspace_id, entries) values ($1, $2, '{}')", [id, other.workspaceId]));
      await c.query("rollback");
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true)", [owner.workspaceId]);
      assert.equal((await c.query("select count(*)::int as n from public.database_ip_allowlists where database_id = $1", [id])).rows[0].n, 1);
      await c.query("rollback");
    } finally { await c.end(); }
  });
});

describe("create, fork, erase and restore", () => {
  test("a fork does not inherit the list, in Postgres or in the engine; the source keeps its own", async () => {
    const id = await create("net-fork-src");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    const f = await h.as(owner).post(`/databases/${id}/fork`, { name: "net-fork-copy" });
    assert.equal(f.statusCode, 201, f.body);
    const fork = json(f).id as string;
    assert.equal(await saved(fork), undefined);
    assert.equal(h.engine.allowlists.get(fork), undefined);
    const g = json(await h.as(owner).get(path(fork)));
    assert.equal(g.allowAll, true);
    assert.equal(g.engine.status, "in_sync");
    assert.deepEqual(h.engine.allowlists.get(id), ["192.0.2.0/24"]);
    assert.deepEqual((await saved(id)).entries, ["192.0.2.0/24"]);
  });

  test("a restore leaves the list as it is, in both", async () => {
    const id = await create("net-restore-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    await h.admin.query("update public.databases set created_at = now() - interval '1 day' where id = $1", [id]);
    const r = await h.as(owner).post(`/databases/${id}/restore`, { at: new Date(Date.now() - 3600_000).toISOString() });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(h.engine.allowlists.get(id), ["192.0.2.0/24"]);
    assert.deepEqual((await saved(id)).entries, ["192.0.2.0/24"]);
  });

  test("an erase removes it from both; a new database with the same name starts without one", async () => {
    const id = await create("net-erase-01");
    await h.as(owner).put(path(id), { entries: ["192.0.2.0/24"] });
    const r = await h.as(owner).post("/databases/erase", { ids: [id] });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(await saved(id), undefined);
    assert.equal(h.engine.allowlists.get(id), undefined);
    const again = await create("net-erase-01");
    assert.notEqual(again, id);
    assert.equal(json(await h.as(owner).get(path(again))).allowAll, true);
    assert.equal(h.engine.allowlists.get(again), undefined);
    assert.equal((await audits(id)).length, 1, "the audit of the erased database stays");
  });
});

describe("network blocks", () => {
  const blocks = (id: string) => `/databases/${id}/network/blocks`;
  test("owner and admin see the addresses blocked on this database with their end, nothing else; a member is refused", async () => {
    const id = await create("net-blocks-01");
    const elsewhere = await create("net-blocks-02");
    const until = new Date(Date.now() + 300_000).toISOString();
    h.engine.blocks.push(
      { ip: "203.0.113.9", database: id, until },
      { ip: "2001:db8:1:2::/64", database: id, until },
      { ip: "198.51.100.1", database: elsewhere, until },
      { ip: "192.0.2.77", database: null, until },
    );
    try {
      for (const who of [owner, admin]) {
        const r = await h.as(who).get(blocks(id));
        assert.equal(r.statusCode, 200, r.body);
        const items = json(r).items as { ip: string; until: string; remainingSecs: number }[];
        assert.deepEqual(items.map((b) => b.ip).sort(), ["2001:db8:1:2::/64", "203.0.113.9"]);
        for (const b of items) {
          assert.deepEqual(Object.keys(b).sort(), ["ip", "remainingSecs", "until"]);
          assert.equal(b.until, until);
          assert.ok(b.remainingSecs > 0 && b.remainingSecs <= 300);
        }
      }
      const m = await h.as(member).get(blocks(id));
      assert.equal(m.statusCode, 403, m.body);
    } finally { h.engine.blocks.length = 0; }
  });

  test("unblocking: owner and admin only, an address blocked on this database only, audited with the address", async () => {
    const id = await create("net-unblock-01");
    const until = new Date(Date.now() + 300_000).toISOString();
    h.engine.blocks.push({ ip: "203.0.113.9", database: id, until }, { ip: "2001:db8:1:2::/64", database: id, until }, { ip: "192.0.2.77", database: null, until });
    try {
      assert.equal((await h.as(member).post(`/databases/${id}/network/unblock`, { ip: "203.0.113.9" })).statusCode, 403);
      assert.equal((await h.as(owner).post(`/databases/${id}/network/unblock`, { ip: "192.0.2.77" })).statusCode, 404, "a block of all databases is not this database's to lift");
      assert.equal((await h.as(owner).post(`/databases/${id}/network/unblock`, { ip: "198.51.100.200" })).statusCode, 404);
      for (const bad of ["", "not-an-ip", "10.0.0.0/8", 7, null]) {
        const r = await h.as(owner).post(`/databases/${id}/network/unblock`, { ip: bad });
        assert.equal(r.statusCode, 400, `${JSON.stringify(bad)} ${r.body}`);
      }
      const r = await h.as(owner).post(`/databases/${id}/network/unblock`, { ip: "203.0.113.9" });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(json(r), { ip: "203.0.113.9", unblocked: true });
      assert.deepEqual(h.engine.unblocked, ["203.0.113.9"]);
      const r6 = await h.as(admin).post(`/databases/${id}/network/unblock`, { ip: "2001:db8:1:2::/64" });
      assert.equal(r6.statusCode, 200, r6.body);
      assert.deepEqual(h.engine.unblocked, ["203.0.113.9", "2001:db8:1:2::/64"], "as the engine showed it; the real adapter sends the /64's address");
      const a = await audits(id, "database.network.%");
      assert.deepEqual(a.map((x) => [x.action, x.outcome, x.actor_id, x.metadata]), [
        ["database.network.unblock", "ok", owner.userId, { ip: "203.0.113.9" }],
        ["database.network.unblock", "ok", admin.userId, { ip: "2001:db8:1:2::/64" }],
      ]);
      assert.deepEqual(json(await h.as(owner).get(blocks(id))).items, []);
    } finally { h.engine.blocks.length = 0; h.engine.unblocked.length = 0; }
  });

  test("unblocking lifts the address on THIS database only: the same address on another database and its address-wide block stay", async () => {
    const id = await create("net-unblock-02");
    const other = await create("net-unblock-03");
    const until = new Date(Date.now() + 300_000).toISOString();
    h.engine.blocks.push(
      { ip: "203.0.113.9", database: id, until }, { ip: "203.0.113.9", database: other, until }, { ip: "203.0.113.9", database: null, until },
      { ip: "2001:db8:1:2::/64", database: id, until }, { ip: "2001:db8:1:2::/64", database: other, until },
    );
    try {
      const r = await h.as(owner).post(`/databases/${id}/network/unblock`, { ip: "203.0.113.9" });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(json(r), { ip: "203.0.113.9", unblocked: true });
      const r6 = await h.as(owner).post(`/databases/${id}/network/unblock`, { ip: "2001:db8:1:2::/64" });
      assert.equal(r6.statusCode, 200, r6.body);
      assert.deepEqual(json(await h.as(owner).get(blocks(id))).items, []);
      assert.deepEqual(json(await h.as(owner).get(blocks(other))).items.map((b: { ip: string }) => b.ip).sort(), ["2001:db8:1:2::/64", "203.0.113.9"], "the other database stays blocked");
      assert.deepEqual(h.engine.blocks.map((b) => [b.ip, b.database]), [["203.0.113.9", other], ["203.0.113.9", null], ["2001:db8:1:2::/64", other]], "and the address-wide block too");
      // Unblocked again on this database: not blocked here any more, so 404 (the other database's block is not this one's).
      assert.equal((await h.as(owner).post(`/databases/${id}/network/unblock`, { ip: "203.0.113.9" })).statusCode, 404);
      const a = await audits(id, "database.network.%");
      assert.deepEqual(a.map((x) => [x.action, x.metadata]), [["database.network.unblock", { ip: "203.0.113.9" }], ["database.network.unblock", { ip: "2001:db8:1:2::/64" }]]);
      assert.deepEqual(await audits(other, "database.network.%"), [], "nothing audited on the other database");
    } finally { h.engine.blocks.length = 0; h.engine.unblocked.length = 0; }
  });

  test("an engine that does not answer: 503 for the blocks, nothing unblocked", async () => {
    const id = await create("net-blocks-down");
    h.engine.failNext("network", "unavailable");
    assert.equal((await h.as(owner).get(`/databases/${id}/network/blocks`)).statusCode, 503);
  });
});
