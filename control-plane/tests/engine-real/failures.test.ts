import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { LightMyRequestResponse as Res } from "fastify";
import { engineCredential, engineUserName } from "../../src/engine/credentials.ts";
import { engineName } from "../../src/engine/names.ts";
import { type EngineClient, EngineError, type EngineErrorKind } from "../../src/engine/types.ts";
import type { EngineUsers } from "../../src/engine/users.ts";
import { reconcileEngineUsers } from "../../src/services/engine-users.ts";
import { json, sleep } from "../helpers/harness.ts";
import { SKIP, type World, cookie, engineHas, engineUsers, secretsOf, startWorld } from "./common.ts";

/**
 * Failures, for real: the engine stopped, hung, restarted in the middle of an operation, refusing our token, already
 * holding the database, no longer holding it; Postgres refusing the write after the engine said yes, and the engine
 * failing after Postgres said yes. After each: clean errors, and Postgres and the engine agree (nothing left behind).
 */
const inject = { ensure: [] as EngineErrorKind[], erase: [] as EngineErrorKind[], ensureCustomer: [] as EngineErrorKind[] };

const wrapUsers = (u: EngineUsers): EngineUsers => new Proxy(u, {
  get(t, p) {
    if (p === "ensure") return async (id: string, r: string) => { const k = inject.ensure.shift(); if (k) throw new EngineError(k, "injected"); return t.ensure(id, r); };
    if (p === "ensureCustomer") return async (...a: Parameters<EngineUsers["ensureCustomer"]>) => { const k = inject.ensureCustomer.shift(); if (k) throw new EngineError(k, "injected"); return t.ensureCustomer(...a); };
    const v = (t as unknown as Record<string | symbol, unknown>)[p];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  },
});

const wrapEngine = (e: EngineClient): EngineClient => new Proxy(e, {
  get(t, p) {
    if (p === "eraseDatabase") return async (req: Parameters<EngineClient["eraseDatabase"]>[0]) => { const k = inject.erase.shift(); if (k) throw new EngineError(k, "injected"); return t.eraseDatabase(req); };
    const v = (t as unknown as Record<string | symbol, unknown>)[p];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
  },
});

describe("engine-real: failures", { skip: SKIP }, () => {
  let w: World;
  const responses: string[] = [];

  before(async () => { w = await startWorld({}, { wrapUsers, wrapEngine }); });
  after(async () => { await w?.close(); });

  const keep = (r: Res) => { responses.push(r.body); return r; };
  const create = async (name: string) => keep(await w.h.as(w.u).post("/databases", { name, region: "eu-central-1" }, cookie));
  const row = async (id: string) => (await w.h.admin.query("select engine_state from public.databases where id = $1", [id])).rows[0] as { engine_state: string } | undefined;
  const userOf = async (id: string) => (await engineUsers(w.e)).find((x) => x.user === engineUserName(id));
  const ready = async (name: string) => {
    const d = await w.settle(await create(name));
    assert.ok([200, 201].includes(d.status), JSON.stringify(d.body));
    return (d.body.result ?? d.body) as { id: string };
  };
  /** When the admin engine last came back EMPTY (memory store): databases made before are gone from it, by design of the test store. */
  let lastRestart = new Date(0);
  /** The admin engine comes back EMPTY (memory store); when fused, the users go too and are bootstrapped again. */
  const restartAdmin = async (env: Record<string, string> = {}) => {
    lastRestart = new Date();
    await w.e.admin.crashAndRestart(env);
    if (w.e.fused) await w.e.bootstrap();
  };
  const opIdOf = (r: Res) => String(r.headers["operation-id"]);
  const op = async (id: string) => (await w.h.admin.query("select status, attempts, params, error from public.operations where id = $1", [id])).rows[0];

  /** Text a customer or a log reader may see: no secret, no stack, no address, no engine name or engine sentence. */
  function assertClean(text: string, what: string) {
    for (const s of secretsOf(w)) assert.ok(!text.includes(s), `${what}: a secret`);
    assert.doesNotMatch(text, /\n\s+at |\bat [\w.<>$]+ \([^)]*:\d+:\d+\)/, `${what}: a stack`);
    assert.doesNotMatch(text, /127\.0\.0\.1|localhost:\d|\[::1\]/, `${what}: an address`);
    assert.doesNotMatch(text, /ECONN|EPIPE|MongoServer|MongoNetwork|put_opts|LocalFileSystem|not authorized on|is before the earliest restorable time|shallow forks that still read/, `${what}: an engine or driver sentence`);
  }

  test("Postgres refuses the write after the engine made the database: retried, then one database, one user", async () => {
    await w.h.admin.query("revoke update on public.databases from fenvix_control_plane");
    let id = "";
    try {
      const r = await create("pg-fails-01");
      assert.equal(r.statusCode, 202, r.body);
      const o = await op(opIdOf(r));
      assert.equal(o.status, "queued", "kept for a retry, not failed");
      id = (await w.h.admin.query("select database_id from public.operations where id = $1", [opIdOf(r)])).rows[0].database_id;
      assert.equal((await row(id))!.engine_state, "provisioning");
      assert.equal(await engineHas(w.e, engineName(id)), true, "the engine said yes");
    } finally {
      await w.h.admin.query("grant update on public.databases to fenvix_control_plane");
    }
    const d = await w.settle(String((await w.h.admin.query("select id from public.operations where database_id = $1", [id])).rows[0].id));
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal((await row(id))!.engine_state, "ready");
    assert.ok(await userOf(id));
    assert.equal(json(await w.h.as(w.u).get("/databases?search=pg-fails-01")).items.length, 1);
  });

  test("Postgres keeps refusing until the operation gives up: the engine's database and user are erased, nothing is left", async () => {
    await w.h.admin.query("revoke update on public.databases from fenvix_control_plane");
    let id = "";
    let opId = "";
    try {
      const r = await create("pg-fails-02");
      opId = opIdOf(r);
      id = (await w.h.admin.query("select database_id from public.operations where id = $1", [opId])).rows[0].database_id;
      assert.equal(await engineHas(w.e, engineName(id)), true);
      assert.ok(await userOf(id));
      await w.h.admin.query("update public.operations set attempts = 8 where id = $1", [opId]); // the last attempt
      await w.sweep();
    } finally {
      await w.h.admin.query("grant update on public.databases to fenvix_control_plane");
    }
    const o = await op(opId);
    assert.equal(o.status, "failed");
    assertClean(JSON.stringify(o.error), "operation error");
    assert.equal(await row(id), undefined, "no row");
    assert.equal(await engineHas(w.e, engineName(id)), false, "no database in the engine");
    assert.equal(await userOf(id), undefined, "no user in the engine");
  });

  test("the engine made the database but its user cannot be made: the create fails cleanly and the database is erased", async () => {
    inject.ensure.push("invalid");
    const r = await create("user-fails-01");
    const d = await w.settle(r);
    assert.notEqual(d.status, 201);
    assertClean(r.body, "response");
    const id = (await w.h.admin.query("select database_id from public.operations where id = $1", [opIdOf(r)])).rows[0].database_id;
    assert.equal(await row(id), undefined);
    assert.equal(await engineHas(w.e, engineName(id)), false);
    assert.equal(await userOf(id), undefined);
  });

  test("the database and its own user were made but the customer's initial user cannot be: the create fails, and the database and every user are gone", async () => {
    inject.ensureCustomer.push("invalid");
    const r = await create("initial-fails-01");
    const d = await w.settle(r);
    assert.notEqual(d.status, 201);
    assertClean(r.body, "response");
    assert.match(r.body, /first user could not be created/);
    const id = (await w.h.admin.query("select database_id from public.operations where id = $1", [opIdOf(r)])).rows[0].database_id;
    assert.equal(await row(id), undefined);
    assert.equal(await engineHas(w.e, engineName(id)), false);
    assert.equal(await userOf(id), undefined);
    const root = w.e.rootClient();
    try { assert.deepEqual((await root.db(engineName(id)).command({ usersInfo: 1 })).users, [], "no user of any kind is left on the database"); } finally { await root.close(); }
  });

  test("…and when the engine cannot be reached for that clean-up, the failure waits: nothing is marked failed until it is done", async () => {
    inject.ensure.push("invalid");
    inject.erase.push("unavailable");
    const r = await create("user-fails-02");
    const opId = opIdOf(r);
    const id = (await w.h.admin.query("select database_id from public.operations where id = $1", [opId])).rows[0].database_id;
    let o = await op(opId);
    assert.equal(o.status, "queued");
    assert.ok(o.params.pendingFailure, "the failure is kept for later");
    assert.equal((await row(id))!.engine_state, "provisioning", "the row stays (hidden) while the engine still has the database");
    assert.equal(await engineHas(w.e, engineName(id)), true);
    await w.sweep();
    o = await op(opId);
    assert.equal(o.status, "failed");
    assert.equal(await row(id), undefined);
    assert.equal(await engineHas(w.e, engineName(id)), false);
  });

  test("slow engine + database already there: a create whose answer never came is accepted on the retry (409 exists)", async () => {
    w.e.admin.pause();
    let r: Res;
    try {
      const t0 = Date.now();
      r = await create("slow-01");
      assert.equal(r.statusCode, 202, r.body);
      assert.ok(Date.now() - t0 < 10_000);
      assertClean(r.body, "response");
    } finally { w.e.admin.resume(); }
    const opId = opIdOf(r);
    const id = (await w.h.admin.query("select database_id from public.operations where id = $1", [opId])).rows[0].database_id;
    await sleep(500); // the engine works off the request it was holding: the database exists, nobody heard the answer
    assert.equal(await engineHas(w.e, engineName(id)), true);
    const d = await w.settle(opId);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.ok((await op(opId)).attempts >= 2);
    assert.ok(/ADMIN POST \/v1\/databases -> 409/.test(w.e.admin.log), "the engine answered exists to the retry");
    assert.equal((await row(id))!.engine_state, "ready");
    assert.ok(await userOf(id));
  });

  test("slow engine on the Data Explorer: 503 within the time limit, clean, and fine again afterwards", async () => {
    const db = await ready("slow-explorer");
    const base = `/databases/${db.id}/data/collections/items/documents`;
    assert.equal(keep(await w.h.as(w.u).post(base, { document: { _id: 1 } }, cookie)).statusCode, 201);
    w.e.auth.pause();
    try {
      const t0 = Date.now();
      const r = keep(await w.h.as(w.u).get(base));
      assert.equal(r.statusCode, 503, r.body);
      assert.ok(Date.now() - t0 < 5000 + 2000 + 3000, `took ${Date.now() - t0} ms`);
      assertClean(r.body, "response");
    } finally { w.e.auth.resume(); }
    await sleep(300);
    const ok = await w.h.as(w.u).get(base);
    assert.equal(ok.statusCode, 200, ok.body);
  });

  test("erase of an awake, pinned database that a client is using: erased, user gone, the open connection loses its rights", async () => {
    const db = await ready("awake-erase");
    const cred = engineCredential(w.h.cfg.engineUsers!.current, db.id);
    const open = w.e.clientAs(cred);
    await open.db(engineName(db.id)).collection("c").insertOne({ x: 1 });
    const writer = w.e.adminDataClient();
    await writer.db(engineName(db.id)).collection("c").insertOne({ awake: true });
    assert.deepEqual(json(await w.h.as(w.u).post("/databases/keep-awake", { ids: [db.id], enabled: true }, cookie)), { affected: 1 });
    const st = await (await fetch(`${w.e.adminUrl}/v1/databases/${engineName(db.id)}?storage=false`, { headers: { authorization: `Bearer ${w.e.token}` } })).json() as { state: string };
    assert.equal(st.state, "awake");
    await writer.close();
    const d = await w.settle(keep(await w.h.as(w.u).post("/databases/erase", { ids: [db.id] }, cookie)));
    assert.deepEqual(d.body.result ?? d.body, { affected: 1 });
    assert.equal(await engineHas(w.e, engineName(db.id)), false);
    assert.equal(await userOf(db.id), undefined);
    await assert.rejects(open.db(engineName(db.id)).collection("c").insertOne({ x: 2 }), (e: { code?: number }) => e.code === 13, "the already-open connection is refused at once");
    await open.close();
    const again = w.e.clientAs(cred);
    await assert.rejects(again.db(engineName(db.id)).command({ ping: 1 }), (e: { code?: number }) => e.code === 18);
    await again.close();
    assert.equal((await w.h.as(w.u).get(`/databases/${db.id}/data/collections`)).statusCode, 404);
  });

  test("restore of a database being written to: clean outcome, state back to ready", async () => {
    const db = await ready("busy-restore");
    const c = w.e.adminDataClient();
    const coll = c.db(engineName(db.id)).collection("w");
    await coll.insertOne({ i: -1 });
    await sleep(1500);
    const at = new Date().toISOString();
    await sleep(1200);
    let stop = false;
    let written = 0;
    let refused = 0;
    const loop = (async () => { while (!stop) { try { await coll.insertOne({ i: written }); written++; } catch { refused++; } await sleep(10); } })();
    await sleep(300);
    const r = keep(await w.h.as(w.u).post(`/databases/${db.id}/restore`, { at }, cookie));
    const d = await w.settle(r);
    stop = true;
    await loop;
    await c.close();
    assertClean(r.body, "response");
    assert.ok(d.status === 200 || d.status === 201 || [409, 503].includes(r.statusCode), `${r.statusCode} ${r.body}`);
    assert.equal((await row(db.id))!.engine_state, "ready");
    assert.ok(written > 0, "the writer was really writing during the restore");
    responses.push(JSON.stringify({ restoreWhileWriting: { status: r.statusCode, written, refused } }));
  });

  test("the engine lost a database (erased behind our back): every operation answers cleanly, erase makes them agree again", async () => {
    const db = await ready("lost-db");
    await fetch(`${w.e.adminUrl}/v1/databases/${engineName(db.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${w.e.token}` } }).then((r) => r.arrayBuffer());
    const fork = await w.settle(keep(await w.h.as(w.u).post(`/databases/${db.id}/fork`, { name: "lost-db-fork" }, cookie)));
    assert.equal(fork.body.error?.code ?? json({ body: responses.at(-1)! }).error.code, "not_found");
    assert.equal((await w.h.admin.query("select count(*)::int as n from public.databases where workspace_id = $1 and name = 'lost-db-fork'", [w.u.workspaceId])).rows[0].n, 0, "the fork's row is gone");
    await w.h.admin.query("update public.databases set created_at = now() - interval '1 hour' where id = $1", [db.id]);
    const restore = keep(await w.h.as(w.u).post(`/databases/${db.id}/restore`, { at: new Date(Date.now() - 1000).toISOString() }, cookie));
    assert.equal(restore.statusCode, 404, restore.body);
    assert.equal((await row(db.id))!.engine_state, "ready");
    const pin = keep(await w.h.as(w.u).post("/databases/keep-awake", { ids: [db.id], enabled: true }, cookie));
    assert.equal(pin.statusCode, 500);
    assert.equal(json(await w.h.as(w.u).get(`/databases/${db.id}`)).keepAwake, false, "Postgres unchanged");
    const exp = await w.settle(keep(await w.h.as(w.u).post("/databases/export", { ids: [db.id] }, cookie)));
    assert.equal(exp.body.error?.code ?? json({ body: responses.at(-1)! }).error.code, "not_found");
    const er = await w.settle(keep(await w.h.as(w.u).post("/databases/erase", { ids: [db.id] }, cookie)));
    assert.deepEqual(er.body.result ?? er.body, { affected: 1 });
    assert.equal(await row(db.id), undefined);
    assert.equal(await userOf(db.id), undefined);
  });

  test("engine stopped: a create waits (202, clean), nothing shows; started again, the retry finishes it", async () => {
    await w.e.admin.stop();
    let r: Res;
    try {
      r = await create("down-01");
      assert.equal(r.statusCode, 202, r.body);
      assertClean(r.body, "response");
      assert.equal(json(await w.h.as(w.u).get("/databases?search=down-01")).items.length, 0, "a database being made is not listed");
      const opRow = await op(opIdOf(r));
      assert.equal(opRow.status, "queued");
    } finally {
      lastRestart = new Date();
      await w.e.admin.start();
      if (w.e.fused) await w.e.bootstrap();
    }
    const d = await w.settle(opIdOf(r));
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const id = d.body.databaseId as string;
    assert.equal(await engineHas(w.e, engineName(id)), true);
    assert.ok(await userOf(id));
  });

  test("engine restarted in the middle of an erase (kill -9 at a failpoint): the retry finishes, nothing is left", async () => {
    await restartAdmin({ CTL_FAILPOINT: "erase.after_intent" });
    const db = await ready("crash-erase");
    const r = keep(await w.h.as(w.u).post("/databases/erase", { ids: [db.id] }, cookie));
    assert.equal(r.statusCode, 202, r.body);
    assert.ok(w.e.admin.log.includes("FAILPOINT erase.after_intent reached"));
    assert.equal(await userOf(db.id), undefined, "the user went first");
    await restartAdmin();
    const d = await w.settle(opIdOf(r));
    assert.deepEqual(d.body.result, { affected: 1 });
    assert.equal(await row(db.id), undefined);
    assert.equal(await engineHas(w.e, engineName(db.id)), false);
  });

  test("engine restarted in the middle of a fork: the fork fails cleanly and leaves no row, database or user", async () => {
    await restartAdmin({ CTL_FAILPOINT: "fork.after_intent" });
    const src = await ready("crash-fork-src");
    const r = keep(await w.h.as(w.u).post(`/databases/${src.id}/fork`, { name: "crash-fork" }, cookie));
    assert.equal(r.statusCode, 202, r.body);
    const forkId = (await w.h.admin.query("select database_id from public.operations where id = $1", [opIdOf(r)])).rows[0].database_id;
    await restartAdmin(); // memory store: the source is gone too, so the retry meets "source does not exist"
    const d = await w.settle(opIdOf(r));
    assert.equal(d.body.status, "failed");
    assertClean(JSON.stringify(d.body), "operation");
    assert.equal(await row(forkId), undefined);
    assert.equal(await engineHas(w.e, engineName(forkId)), false);
    assert.equal(await userOf(forkId), undefined);
    // the source's row is still there, the engine lost it (memory store); an erase makes them agree
    const er = await w.settle(keep(await w.h.as(w.u).post("/databases/erase", { ids: [src.id] }, cookie)));
    assert.deepEqual(er.body.result ?? er.body, { affected: 1 });
  });

  test("the user sweep drops orphan users and makes missing ones", async () => {
    const db = await ready("sweep-me");
    const orphan = "0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e";
    const root = w.e.rootClient();
    try {
      await root.db(engineName(orphan)).command({ createUser: engineUserName(orphan), pwd: "Orphan-Password-1234567890", roles: [{ role: "readWrite", db: engineName(orphan) }] });
      await root.db(engineName(db.id)).command({ dropUser: engineUserName(db.id) });
    } finally { await root.close(); }
    const out = await reconcileEngineUsers(w.h.app.deps.s);
    assert.ok(out.dropped >= 1 && out.created >= 1 && out.failed === 0, JSON.stringify(out));
    assert.equal(await userOf(orphan), undefined);
    assert.ok(await userOf(db.id));
    const second = await reconcileEngineUsers(w.h.app.deps.s);
    assert.deepEqual(second, { dropped: 0, created: 0, rotated: 0, failed: 0 });
  });

  test("Postgres and the engine agree at the end: every ready row has its database and user, and no user is an orphan", async () => {
    // Only rows made since the engine last restarted: with the memory store a restart forgets everything before it.
    const rows = (await w.h.admin.query("select id from public.databases where workspace_id = $1 and engine_state = 'ready' and created_at > $2", [w.u.workspaceId, lastRestart])).rows.map((r) => String(r.id));
    assert.ok(rows.length >= 1);
    for (const id of rows) {
      assert.equal(await engineHas(w.e, engineName(id)), true, `database ${id}`);
      assert.ok(await userOf(id), `user of ${id}`);
    }
    const all = new Set((await w.h.admin.query("select id from public.databases")).rows.map((r) => String(r.id)));
    for (const u of await engineUsers(w.e)) assert.ok(all.has(`${u.user.slice(3, 11)}-${u.user.slice(11, 15)}-${u.user.slice(15, 19)}-${u.user.slice(19, 23)}-${u.user.slice(23)}`), `orphan ${u.user}`);
  });

  test("no secret, stack, address or engine sentence in any answer or in the log", () => {
    for (const [i, b] of responses.entries()) assertClean(b, `response ${i}`);
    for (const s of secretsOf(w)) assert.ok(!w.h.logs.text().includes(s), "a secret in the log");
  });

  test("wrong admin token: nothing happens in the engine, the operation waits, the token is in no answer or log", async () => {
    const bad = await startWorld({ ENGINE_ADMIN_TOKEN_FILE: undefined, ENGINE_ADMIN_TOKEN: "wrong-token-0123456789abcdef" }, { engines: w.e });
    try {
      const r = await bad.h.as(bad.u).post("/databases", { name: "bad-token", region: "eu-central-1" }, cookie);
      assert.equal(r.statusCode, 202, r.body);
      const opId = String(r.headers["operation-id"]);
      const id = (await bad.h.admin.query("select database_id from public.operations where id = $1", [opId])).rows[0].database_id;
      assert.equal(await engineHas(w.e, engineName(id)), false);
      assert.ok(/ADMIN \(rejected\) -> 401/.test(w.e.admin.log));
      await bad.h.admin.query("update public.operations set attempts = 8 where id = $1", [opId]);
      await bad.sweep();
      const o = (await bad.h.admin.query("select status, params from public.operations where id = $1", [opId])).rows[0];
      // The give-up wants to erase what the create may have made, and the engine refuses the token: it waits, row hidden.
      assert.equal(o.status, "queued");
      assert.ok(o.params.pendingFailure);
      const text = [r.body, bad.h.logs.text(), JSON.stringify(o)].join("\n");
      assert.ok(!text.includes("wrong-token-0123456789abcdef") && !text.includes(w.e.token));
      assert.match(bad.h.logs.text(), /refused the control plane's credentials/);
    } finally { await bad.close(); }
  });
});
