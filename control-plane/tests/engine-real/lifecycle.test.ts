import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { workspaceCode } from "../../src/config.ts";
import { engineCredential, engineUserName } from "../../src/engine/credentials.ts";
import { engineName } from "../../src/engine/names.ts";
import { syncWorkspaceUsage } from "../../src/services/usage.ts";
import { json, sleep } from "../helpers/harness.ts";
import { unzip } from "../helpers/unzip.ts";
import { SKIP, type World, cookie, engineHas, engineUsers, secretsOf, startWorld } from "./common.ts";

/**
 * Every operation of the control plane, with ENGINE_DRIVER=real, against the real engine: create, list, get, tags,
 * the six Data Explorer routes, fork, restore, export (download), keep awake, usage, erase. Each database's own engine
 * user is checked at every step.
 */
describe("engine-real: every operation against the real engine", { skip: SKIP }, () => {
  let w: World;
  let a: { id: string; host: string; connectionString: string; name: string };
  let f: { id: string; forkedFrom: string | null };
  let restoreTo = "";

  before(async () => { w = await startWorld(); });
  after(async () => { await w?.close(); });

  const userOf = async (id: string) => (await engineUsers(w.e)).find((x) => x.user === engineUserName(id));

  test("create: the engine has db_<id>, with its own user cp_<id> whose only role is readWrite on it", async () => {
    const res = await w.h.as(w.u).post("/databases", { name: "orders-prod", region: "eu-central-1", tags: ["customer:acme", "env:prod"] }, cookie);
    const done = await w.settle(res);
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
    a = done.body.result ?? done.body;
    assert.equal(await engineHas(w.e, engineName(a.id)), true);
    assert.equal(a.host, `orders-prod-${workspaceCode(w.u.workspaceId)}.eu-central-1.db.example.test`);
    assert.equal(a.connectionString, `mongodb://app_user:<password>@${a.host}:27018/${engineName(a.id)}?tls=true`);
    const u = await userOf(a.id);
    assert.ok(u, "the database's user exists on the engine");
    assert.equal(u!.db, engineName(a.id), "defined on the database itself");
    assert.deepEqual(u!.roles, [{ role: "readWrite", db: engineName(a.id) }], "one role, on that database only");
    const row = (await w.h.admin.query("select engine_state from public.databases where id = $1", [a.id])).rows[0];
    assert.equal(row.engine_state, "ready");
  });

  test("list, get, tags: read from Postgres, consistent with what was created", async () => {
    const list = json(await w.h.as(w.u).get("/databases"));
    assert.ok(list.items.some((d: { id: string }) => d.id === a.id));
    const one = await w.h.as(w.u).get(`/databases/${a.id}`);
    assert.equal(one.statusCode, 200);
    assert.deepEqual(json(one).tags, ["customer:acme", "env:prod"]);
    assert.equal((await w.h.as(w.u).put(`/databases/${a.id}/tags`, { tags: ["customer:acme", "tier:gold"] }, cookie)).statusCode, 200);
    assert.equal((await w.h.as(w.u).post("/databases/tags/add", { ids: [a.id], tags: ["env:prod"] }, cookie)).statusCode, 200);
    assert.equal((await w.h.as(w.u).post("/databases/tags/remove", { ids: [a.id], tags: ["tier"] }, cookie)).statusCode, 200);
    assert.deepEqual(json(await w.h.as(w.u).get(`/databases/${a.id}`)).tags, ["customer:acme", "env:prod"]);
    assert.ok(json(await w.h.as(w.u).get("/tags")).items.length >= 2);
  });

  test("Data Explorer, all six routes, connected as the database's own user", async () => {
    const base = `/databases/${a.id}/data/collections`;
    const ins = await w.h.as(w.u).post(`${base}/items/documents`, { document: { _id: "k1", n: { $numberInt: "1" }, tag: "alpha" } }, cookie);
    assert.equal(ins.statusCode, 201, ins.body);
    for (let i = 2; i <= 5; i++) assert.equal((await w.h.as(w.u).post(`${base}/items/documents`, { document: { _id: `k${i}`, n: { $numberInt: String(i) }, tag: i % 2 ? "alpha" : "beta" } }, cookie)).statusCode, 201);
    const cols = json(await w.h.as(w.u).get(base));
    assert.deepEqual(cols.items.map((c: { name: string }) => c.name), ["items"]);
    const found = json(await w.h.as(w.u).get(`${base}/items/documents?filter=${encodeURIComponent('{"tag":{"$regex":"^al"}}')}&sort=${encodeURIComponent('{"n":-1}')}`));
    assert.deepEqual(found.items.map((d: { id: string }) => d.id), ['"k5"', '"k3"', '"k1"']);
    const one = json(await w.h.as(w.u).get(`${base}/items/documents/${encodeURIComponent('"k2"')}`));
    assert.equal(one.document.tag, "beta");
    const put = await w.h.as(w.u).put(`${base}/items/documents/${encodeURIComponent('"k2"')}`, { document: { _id: "k2", n: { $numberInt: "2" }, tag: "gamma" }, version: one.version }, cookie);
    assert.equal(put.statusCode, 200, put.body);
    const stale = await w.h.as(w.u).put(`${base}/items/documents/${encodeURIComponent('"k2"')}`, { document: { _id: "k2", tag: "x" }, version: one.version }, cookie);
    assert.equal(stale.statusCode, 409);
    const cur = json(await w.h.as(w.u).get(`${base}/items/documents/${encodeURIComponent('"k2"')}`));
    const del = await w.h.as(w.u).del(`${base}/items/documents/${encodeURIComponent('"k2"')}?version=${cur.version}`, cookie);
    assert.equal(del.statusCode, 200, del.body);
    // The driver clients: one per database, each authenticated as that database's user, none as the provisioner.
    const open = w.data.openClients();
    assert.ok(open.length >= 1 && open.every((c) => c.db === engineName(a.id) && c.version === "v1"), JSON.stringify(open));
    // In the engine: the documents are in db_<id>, written by cp_<id>.
    const mine = w.e.clientAs({ ...engineCredential(w.h.cfg.engineUsers!.current, a.id) });
    try { assert.equal(await mine.db(engineName(a.id)).collection("items").countDocuments(), 4); } finally { await mine.close(); }
  });

  test("fork: a new database with a NEW user; the source's user has no right on it, nor the fork's on the source", async () => {
    // History for the fork and the restore, on the admin engine's MongoDB listener (the data the admin routes act on).
    const c = w.e.adminDataClient();
    try {
      await c.db(engineName(a.id)).collection("history").insertOne({ _id: "before" } as never);
      await sleep(1500);
      restoreTo = new Date().toISOString();
      await sleep(1500);
      await c.db(engineName(a.id)).collection("history").insertOne({ _id: "after" } as never);
    } finally { await c.close(); }
    const res = await w.h.as(w.u).post(`/databases/${a.id}/fork`, { name: "orders-copy" }, cookie);
    const done = await w.settle(res);
    assert.ok([200, 201].includes(done.status), JSON.stringify(done.body));
    f = done.body.result ?? done.body;
    assert.equal(f.forkedFrom, a.id);
    assert.equal(await engineHas(w.e, engineName(f.id)), true);
    const fu = await userOf(f.id);
    assert.ok(fu && fu.user !== engineUserName(a.id));
    assert.deepEqual(fu!.roles, [{ role: "readWrite", db: engineName(f.id) }]);
    const reader = w.e.adminDataClient();
    try {
      const ids = (await reader.db(engineName(f.id)).collection("history").find().toArray()).map((d) => d._id).sort();
      assert.deepEqual(ids, ["after", "before"], "the fork holds the source's data");
    } finally { await reader.close(); }
    const srcUser = w.e.clientAs(engineCredential(w.h.cfg.engineUsers!.current, a.id));
    const forkUser = w.e.clientAs(engineCredential(w.h.cfg.engineUsers!.current, f.id));
    try {
      await assert.rejects(srcUser.db(engineName(f.id)).collection("history").findOne({}), (e: { code?: number }) => e.code === 13);
      await assert.rejects(forkUser.db(engineName(a.id)).collection("items").findOne({}), (e: { code?: number }) => e.code === 13);
      await forkUser.db(engineName(f.id)).collection("own").insertOne({ ok: true });
    } finally { await srcUser.close(); await forkUser.close(); }
  });

  test("restore: back to the point; writes after it are gone; the database keeps its user", async () => {
    const res = await w.h.as(w.u).post(`/databases/${a.id}/restore`, { at: restoreTo }, cookie);
    const done = await w.settle(res);
    assert.equal(done.status === 200 || done.status === 201, true, JSON.stringify(done.body));
    const c = w.e.adminDataClient();
    try {
      const ids = (await c.db(engineName(a.id)).collection("history").find().toArray()).map((d) => d._id);
      assert.deepEqual(ids, ["before"]);
    } finally { await c.close(); }
    assert.ok(await userOf(a.id));
    assert.equal((await w.h.admin.query("select engine_state from public.databases where id = $1", [a.id])).rows[0].engine_state, "ready");
  });

  test("restore before the first restore point: a clean 400 in our words", async () => {
    await w.h.admin.query("update public.databases set created_at = now() - interval '1 hour' where id = $1", [a.id]);
    const res = await w.h.as(w.u).post(`/databases/${a.id}/restore`, { at: new Date(Date.now() - 30 * 60_000).toISOString() }, cookie);
    assert.equal(res.statusCode, 400, res.body);
    assert.match(json(res).error.message, /^That time is before the earliest restorable point of this database \(\d{4}-\d\d-\d\dT[\d:.]+Z\)\. Choose a later time\.$/);
    assert.equal((await w.h.admin.query("select engine_state from public.databases where id = $1", [a.id])).rows[0].engine_state, "ready");
  });

  test("export: one zip behind a signed link, with each database's dump; no user or credential in it", async () => {
    const res = await w.h.as(w.u).post("/databases/export", { ids: [a.id, f.id] }, cookie);
    const done = await w.settle(res);
    const r = done.body.result ?? done.body;
    assert.ok(r.downloadUrl, JSON.stringify(done.body));
    const dl = await w.h.app.fastify.inject({ method: "GET", url: new URL(r.downloadUrl).pathname });
    assert.equal(dl.statusCode, 200);
    assert.equal(dl.headers["content-type"], "application/zip");
    const files = unzip(dl.rawPayload);
    const names = files.map((x) => x.name).sort();
    assert.ok(names.includes(`${engineName(a.id)}/history.bson`) && names.includes(`${engineName(f.id)}/history.bson`), names.join(", "));
    const all = Buffer.concat(files.map((x) => x.data)).toString("latin1");
    assert.ok(all.includes("before"));
    for (const word of ["SCRAM-SHA-256", "storedKey", "serverKey", engineUserName(a.id), "system.users"]) assert.ok(!all.includes(word), `the export contains ${word}`);
  });

  test("keep awake: pinned in the engine and in Postgres, then unpinned", async () => {
    assert.deepEqual(json(await w.h.as(w.u).post("/databases/keep-awake", { ids: [a.id], enabled: true }, cookie)), { affected: 1 });
    const on = await (await fetch(`${w.e.adminUrl}/v1/databases/${engineName(a.id)}?storage=false`, { headers: { authorization: `Bearer ${w.e.token}` } })).json() as { keep_awake: boolean };
    assert.equal(on.keep_awake, true);
    assert.equal(json(await w.h.as(w.u).get(`/databases/${a.id}`)).keepAwake, true);
    assert.deepEqual(json(await w.h.as(w.u).post("/databases/keep-awake", { ids: [a.id], enabled: false }, cookie)), { affected: 1 });
    const off = await (await fetch(`${w.e.adminUrl}/v1/databases/${engineName(a.id)}?storage=false`, { headers: { authorization: `Bearer ${w.e.token}` } })).json() as { keep_awake: boolean };
    assert.equal(off.keep_awake, false);
  });

  test("usage: the engine's daily counts reach Postgres and the usage route", async () => {
    const out = await syncWorkspaceUsage(w.h.app.deps.s, w.u.workspaceId);
    assert.deepEqual(out, { databases: 2, failed: 0 });
    const res = await w.h.as(w.u).get(`/databases/${a.id}/usage?range=24h`);
    assert.equal(res.statusCode, 200, res.body);
  });

  test("erase while a fork exists: refused cleanly, and the source keeps a working user", async () => {
    const res = await w.h.as(w.u).post("/databases/erase", { ids: [a.id] }, cookie);
    const done = await w.settle(res);
    assert.equal(done.status, res.statusCode === 202 ? 500 : 409, JSON.stringify(done.body));
    const msg = res.statusCode === 202 ? done.body.error.message : done.body.error.message;
    assert.match(msg, /forks of this one/);
    assert.equal(await engineHas(w.e, engineName(a.id)), true);
    assert.equal((await w.h.admin.query("select engine_state from public.databases where id = $1", [a.id])).rows[0].engine_state, "ready");
    const c = w.e.clientAs(engineCredential(w.h.cfg.engineUsers!.current, a.id));
    try { assert.ok(await c.db(engineName(a.id)).collection("items").findOne({})); } finally { await c.close(); }
  });

  test("erase the fork, then the source: databases and users gone; again affects nothing", async () => {
    for (const id of [f.id, a.id]) {
      const done = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [id] }, cookie));
      assert.deepEqual(done.body.result ?? done.body, { affected: 1 });
      assert.equal(await engineHas(w.e, engineName(id)), false);
      assert.equal(await userOf(id), undefined, "its user is gone too");
    }
    const again = await w.settle(await w.h.as(w.u).post("/databases/erase", { ids: [a.id] }, cookie));
    assert.deepEqual(again.body.result ?? again.body, { affected: 0 });
    assert.deepEqual(await engineUsers(w.e), [], "no user left behind on the engine");
  });

  test("the admin interface only ever saw the routes the adapter allows (never the list of every database)", () => {
    const lines = w.e.admin.log.split("\n").filter((l) => l.startsWith("ADMIN "));
    assert.ok(lines.length > 10);
    const ok = /^ADMIN (GET|POST|PUT|DELETE) \/v1\/(databases(\/db_[0-9a-f]{32}(\/(fork|restore|restore-points|retention|keep-awake|exports|usage))?)?|exports\/db_[0-9a-f]{32}\.[0-9a-f]{16}(\/files\/db_[0-9a-f]{32}\/[^ ]+)?) -> \d{3} /;
    const bad = lines.filter((l) => !ok.test(l));
    assert.deepEqual(bad, []);
    assert.ok(!lines.some((l) => /^ADMIN GET \/v1\/databases -> /.test(l)), "never GET /v1/databases");
  });

  test("no secret in the control plane's log or the engines' logs", () => {
    const logs = [w.h.logs.text(), w.e.admin.log, w.e.auth.log].join("\n");
    for (const s of secretsOf(w)) assert.ok(!logs.includes(s), "a secret reached a log");
    for (const id of [a.id, f.id]) assert.ok(!logs.includes(engineCredential(w.h.cfg.engineUsers!.current, id).password), "a database password reached a log");
  });
});
