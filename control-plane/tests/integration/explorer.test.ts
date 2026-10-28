import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Fixture, type Harness, json, sleep, startHarness } from "../helpers/harness.ts";
import { dataTarget, targetDbName } from "../../src/engine/data.ts";
import { engineName } from "../../src/engine/names.ts";

/**
 * The Data Explorer against the in-memory MongoDB listener: every route, the roles, 403/404, limits, timeouts,
 * the waking database, the audit log, and what reaches the logs. Isolation between workspaces and hostile payloads
 * have their own files (explorer-isolation, explorer-hostile).
 */
let h: Harness;
let owner: Fixture;
let dbId = "";
const enc = encodeURIComponent;
const base = () => `/databases/${dbId}/data/collections`;
const docsUrl = (c = "people") => `${base()}/${c}/documents`;
const docUrl = (id: string, c = "people") => `${docsUrl(c)}/${enc(id)}`;
const oid = (n: number) => n.toString(16).padStart(24, "0");

async function createDb(who: Fixture, name: string): Promise<string> {
  const res = await h.as(who).post("/databases", { name, region: "eu-central-1" }, { origin: "https://app.fenvix.test" });
  assert.equal(res.statusCode, 201, res.body);
  return json(res).id as string;
}

const auditRows = async (ws: string) => (await h.admin.query("select * from public.data_audit_log where workspace_id = $1 order by id", [ws])).rows;
const target = (id: string) => dataTarget({ id, region: "eu-central-1" });

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", DATA_RATE_LIMIT_PER_MINUTE: "100000", DATA_WRITE_RATE_LIMIT_PER_MINUTE: "100000" });
  owner = await h.user("Olivia Owner");
  dbId = await createDb(owner, "explorer-main");
  h.data.seed(target(dbId), "people", Array.from({ length: 130 }, (_, i) => ({
    _id: { $oid: oid(i + 1) }, n: { $numberInt: String(i) }, name: `person-${String(i).padStart(3, "0")}`, group: i % 2 ? "odd" : "even",
    joined: { $date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString() }, balance: { $numberDecimal: `${i}.50` },
  })));
  h.data.seed(target(dbId), "empty_one", []);
});
after(async () => { await h.close(); });

const cookie = { origin: "https://app.fenvix.test" };

describe("reading", () => {
  test("collections: names and estimated counts, sorted, system collections hidden", async () => {
    h.data.seed(target(dbId), "system.views", [{ x: 1 }]);
    const res = await h.as(owner).get(base());
    assert.equal(res.statusCode, 200, res.body);
    const items = json(res).items as { name: string; estimatedCount: number | null; browsable: boolean }[];
    assert.deepEqual(items.map((c) => c.name), ["empty_one", "people"]);
    assert.equal(items.find((c) => c.name === "people")!.estimatedCount, 130);
    assert.ok(items.every((c) => c.browsable));
    assert.equal(json(res).truncated, false);
  });

  test("documents: 25 per page by default, in Extended JSON (canonical), with id and version", async () => {
    const res = await h.as(owner).get(docsUrl());
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.equal(body.pageSize, 25);
    assert.equal(body.items.length, 25);
    assert.equal(body.hasMore, true);
    const first = body.items[0];
    assert.equal(first.id, `{"$oid":"${oid(1)}"}`);
    assert.match(first.version, /^[0-9a-f]{32}$/);
    assert.deepEqual(first.document.n, { $numberInt: "0" });
    assert.deepEqual(first.document.balance, { $numberDecimal: "0.50" });
    assert.ok(first.document.joined.$date);
  });

  test("documents: page size up to 100, never more; pages follow _id order", async () => {
    const p = await h.as(owner).get(`${docsUrl()}?pageSize=100&page=2`);
    assert.equal(p.statusCode, 200);
    assert.equal(json(p).items.length, 30);
    assert.equal(json(p).hasMore, false);
    assert.equal(json(p).items[0].id, `{"$oid":"${oid(101)}"}`);
    for (const bad of ["101", "0", "-1", "abc", "2.5", "1e9"]) {
      const r = await h.as(owner).get(`${docsUrl()}?pageSize=${bad}`);
      assert.equal(r.statusCode, 400, bad);
    }
  });

  test("documents: filter, sort and projection", async () => {
    const filter = enc(JSON.stringify({ group: "odd", n: { $gte: 100 }, name: { $regex: "^PERSON-1", $options: "i" } }));
    const res = await h.as(owner).get(`${docsUrl()}?filter=${filter}&sort=${enc('{"n": -1}')}&projection=${enc('{"name": 1}')}`);
    assert.equal(res.statusCode, 200, res.body);
    const items = json(res).items;
    assert.equal(items.length, 15);
    assert.equal(items[0].document.name, "person-129");
    assert.deepEqual(Object.keys(items[0].document), ["_id", "name"]);
    assert.equal(items[0].partial, true);
    assert.equal(items[0].version, null, "a projected document cannot be saved, so it has no version");
  });

  test("documents: an invalid filter is a clear 400 and never reaches the engine", async () => {
    const before = h.data.calls.find;
    const res = await h.as(owner).get(`${docsUrl()}?filter=${enc('{"$where": "sleep(10000)"}')}`);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error.code, "validation_failed");
    assert.match(json(res).error.message, /\$where is not allowed/);
    assert.equal(json(res).error.field, "filter");
    assert.equal(h.data.calls.find, before);
  });

  test("documents: skip is capped (no deep paging through a big collection)", async () => {
    const res = await h.as(owner).get(`${docsUrl()}?pageSize=100&page=102`);
    assert.equal(res.statusCode, 400);
    assert.match(json(res).error.message, /10000 documents deep/);
  });

  test("one document by _id; a missing one is 404", async () => {
    const res = await h.as(owner).get(docUrl(`{"$oid":"${oid(5)}"}`));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).document.name, "person-004");
    const gone = await h.as(owner).get(docUrl(`{"$oid":"${oid(9999)}"}`));
    assert.equal(gone.statusCode, 404);
    assert.equal(json(gone).error.message, "That document does not exist.");
  });

  test("an empty or unknown collection is an empty page, not an error", async () => {
    for (const c of ["empty_one", "never_created"]) {
      const res = await h.as(owner).get(docsUrl(c));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(json(res).items, []);
      assert.equal(json(res).hasMore, false);
    }
  });

  test("data answers carry no-store and the security headers, errors too", async () => {
    for (const url of [base(), docsUrl(), docUrl(`{"$oid":"${oid(9999)}"}`), `/databases/${randomUUID()}/data/collections`]) {
      const res = await h.as(owner).get(url);
      assert.equal(res.headers["cache-control"], "no-store", url);
      assert.equal(res.headers.pragma, "no-cache");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.equal(res.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.match(String(res.headers["content-type"]), /application\/json/);
    }
  });
});

describe("writing", () => {
  test("insert: 201 with id and version; the document is stored with its types; _id added when missing", async () => {
    const res = await h.as(owner).post(docsUrl("things"), { document: { name: "widget", qty: 3, price: { $numberDecimal: "9.99" }, at: { $date: "2024-05-01T10:00:00Z" } } }, cookie);
    assert.equal(res.statusCode, 201, res.body);
    const { id, version } = json(res);
    assert.match(id, /^\{"\$oid":"[0-9a-f]{24}"\}$/);
    assert.match(version, /^[0-9a-f]{32}$/);
    const back = json(await h.as(owner).get(docUrl(id, "things")));
    assert.deepEqual(back.document.qty, { $numberInt: "3" });
    assert.deepEqual(back.document.price, { $numberDecimal: "9.99" });
    assert.equal(back.version, version);
  });

  test("insert: the same _id twice is 409", async () => {
    const doc = { document: { _id: "fixed-id", a: 1 } };
    assert.equal((await h.as(owner).post(docsUrl("things"), doc, cookie)).statusCode, 201);
    const again = await h.as(owner).post(docsUrl("things"), doc, cookie);
    assert.equal(again.statusCode, 409);
    assert.equal(json(again).error.message, "A document with this _id already exists in this collection.");
  });

  test("replace with the version last read; a stale version is 409 and changes nothing", async () => {
    const created = json(await h.as(owner).post(docsUrl("things"), { document: { _id: "edit-me", v: 1 } }, cookie));
    const ok = await h.as(owner).put(docUrl(created.id, "things"), { document: { _id: "edit-me", v: 2 }, version: created.version }, cookie);
    assert.equal(ok.statusCode, 200, ok.body);
    const stale = await h.as(owner).put(docUrl(created.id, "things"), { document: { _id: "edit-me", v: 3 }, version: created.version }, cookie);
    assert.equal(stale.statusCode, 409);
    assert.equal(json(stale).error.field, "version");
    const now = json(await h.as(owner).get(docUrl(created.id, "things")));
    assert.deepEqual(now.document.v, { $numberInt: "2" });
    assert.equal(now.version, json(ok).version);
  });

  test("replace: without a version 400, with another _id 400, the _id of the URL is kept when the body has none", async () => {
    const created = json(await h.as(owner).post(docsUrl("things"), { document: { _id: "keep-id", v: 1 } }, cookie));
    const noVersion = await h.as(owner).put(docUrl(created.id, "things"), { document: { v: 2 } }, cookie);
    assert.equal(noVersion.statusCode, 400);
    const otherId = await h.as(owner).put(docUrl(created.id, "things"), { document: { _id: "other", v: 2 }, version: created.version }, cookie);
    assert.equal(otherId.statusCode, 400);
    assert.match(json(otherId).error.message, /_id of a document cannot be changed/);
    const kept = await h.as(owner).put(docUrl(created.id, "things"), { document: { v: 2 }, version: created.version }, cookie);
    assert.equal(kept.statusCode, 200, kept.body);
    assert.equal(json(kept).id, '"keep-id"');
  });

  test("a change made by someone else between read and save is caught by the engine-side filter too", async () => {
    const created = json(await h.as(owner).post(docsUrl("things"), { document: { _id: "race", v: 1 } }, cookie));
    // The version check passes, then another writer changes the document before the replace runs.
    const real = h.data.replaceOne.bind(h.data);
    h.data.replaceOne = async (t, c, filter, doc, o) => {
      const coll = h.data.dbs.get(targetDbName(t))!.get("things")!;
      const { BSON } = await import("bson");
      const i = coll.findIndex((b) => BSON.deserialize(b)._id === "race");
      coll[i] = Buffer.from(BSON.serialize({ _id: "race", v: 99 }));
      return real(t, c, filter, doc, o);
    };
    try {
      const res = await h.as(owner).put(docUrl(created.id, "things"), { document: { _id: "race", v: 2 }, version: created.version }, cookie);
      assert.equal(res.statusCode, 409);
    } finally {
      h.data.replaceOne = real;
    }
    assert.deepEqual(json(await h.as(owner).get(docUrl(created.id, "things"))).document.v, { $numberInt: "99" });
  });

  test("delete with the version; stale or missing version refused; deleting what is gone is 404", async () => {
    const created = json(await h.as(owner).post(docsUrl("things"), { document: { _id: "bye", v: 1 } }, cookie));
    assert.equal((await h.as(owner).del(docUrl(created.id, "things"), cookie)).statusCode, 400);
    assert.equal((await h.as(owner).del(`${docUrl(created.id, "things")}?version=${"0".repeat(32)}`, cookie)).statusCode, 409);
    const ok = await h.as(owner).del(`${docUrl(created.id, "things")}?version=${created.version}`, cookie);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(json(ok), { deleted: true });
    assert.equal((await h.as(owner).del(`${docUrl(created.id, "things")}?version=${created.version}`, cookie)).statusCode, 404);
  });

  test("a retried insert with the same Idempotency-Key does not insert twice, and stores no document", async () => {
    const key = `ins-${randomUUID()}`;
    const doc = { document: { name: "only-once", secretValue: "IDEMPOTENT-SECRET-123" } };
    const first = await h.as(owner).post(docsUrl("idem"), doc, { ...cookie, "idempotency-key": key });
    assert.equal(first.statusCode, 201);
    const second = await h.as(owner).post(docsUrl("idem"), doc, { ...cookie, "idempotency-key": key });
    assert.equal(second.statusCode, 409);
    assert.equal(json(await h.as(owner).get(docsUrl("idem"))).items.length, 1);
    const stored = JSON.stringify((await h.admin.query("select * from public.idempotency_keys where key = $1", [key])).rows);
    assert.ok(!stored.includes("IDEMPOTENT-SECRET-123"));
  });

  test("a cookie session from another site cannot write (same origin rule as every route)", async () => {
    const res = await h.as(owner).post(docsUrl("things"), { document: { a: 1 } }, { origin: "https://evil.example" });
    assert.equal(res.statusCode, 403);
  });
});

describe("roles and API keys", () => {
  let ws = "";
  let db = "";
  let admin: Fixture;
  let member: Fixture;
  let readKey = "";
  let writeKey = "";
  let id = "";
  let version = "";

  before(async () => {
    const o = await h.user("Role Owner");
    ws = o.workspaceId;
    db = await createDb(o, "roles-db");
    admin = await h.addMember(ws, "Ada Admin", "admin");
    member = await h.addMember(ws, "Max Member", "member");
    readKey = await h.apiKey(ws, "reader");
    writeKey = await h.apiKey(ws, "writer", "read_write");
    h.data.seed(target(db), "c", [{ _id: "d1", v: 1 }]);
    const got = json(await h.as(o).get(`/databases/${db}/data/collections/c/documents/${enc('"d1"')}`));
    id = got.id;
    version = got.version;
  });

  const url = () => `/databases/${db}/data/collections/c/documents`;

  test("everyone in the workspace can read: owner, admin, member, read key, read-write key", async () => {
    for (const who of [admin, member, readKey, writeKey]) {
      const res = await h.as(who).get(url());
      assert.equal(res.statusCode, 200, typeof who === "string" ? "key" : who.name);
      assert.equal((await h.as(who).get(`/databases/${db}/data/collections`)).statusCode, 200);
    }
  });

  test("a read-only API key gets 403 on insert, replace and delete, and each refusal is audited", async () => {
    const before = (await auditRows(ws)).length;
    const ins = await h.as(readKey).post(url(), { document: { a: 1 } });
    const rep = await h.as(readKey).put(`${url()}/${enc(id)}`, { document: { v: 5 }, version });
    const del = await h.as(readKey).del(`${url()}/${enc(id)}?version=${version}`);
    for (const r of [ins, rep, del]) {
      assert.equal(r.statusCode, 403);
      assert.match(json(r).error.message, /can only read data/);
    }
    const rows = (await auditRows(ws)).slice(before);
    assert.deepEqual(rows.map((r) => [r.operation, r.outcome, r.actor_type]), [["insert", "denied", "api_key"], ["replace", "denied", "api_key"], ["delete", "denied", "api_key"]]);
    assert.deepEqual(json(await h.as(readKey).get(`${url()}/${enc(id)}`)).document.v, { $numberInt: "1" });
  });

  test("a read-write key, the owner, an admin and a member can write", async () => {
    for (const who of [writeKey, admin, member]) {
      const res = await h.as(who).post(url(), { document: { by: typeof who === "string" ? "key" : who.name } }, cookie);
      assert.equal(res.statusCode, 201, res.body);
    }
  });

  test("a revoked key can do nothing", async () => {
    const k = await h.apiKey(ws, "soon revoked", "read_write");
    await h.admin.query("update public.api_keys set revoked_at = now() where workspace_id = $1 and name = 'soon revoked'", [ws]);
    assert.equal((await h.as(k).get(url())).statusCode, 401);
    assert.equal((await h.as(k).post(url(), { document: {} })).statusCode, 401);
  });

  test("POST /api-keys makes read keys unless dataAccess readWrite is asked; keys cannot make keys", async () => {
    const o = await h.user("Key Maker");
    const readMade = json(await h.as(o).post("/api-keys", { name: "default" }, cookie));
    assert.equal(readMade.key.dataAccess, "read");
    const rwMade = await h.as(o).post("/api-keys", { name: "rw", dataAccess: "readWrite" }, cookie);
    assert.equal(rwMade.statusCode, 201, rwMade.body);
    assert.equal(json(rwMade).key.dataAccess, "readWrite");
    assert.equal((await h.as(o).post("/api-keys", { name: "bad", dataAccess: "admin" }, cookie)).statusCode, 400);
    assert.equal((await h.as(json(rwMade).secret).post("/api-keys", { name: "from a key", dataAccess: "readWrite" })).statusCode, 403);
    const odb = await createDb(o, "keymaker-db");
    assert.equal((await h.as(readMade.secret).post(`/databases/${odb}/data/collections/c/documents`, { document: {} })).statusCode, 403);
    assert.equal((await h.as(json(rwMade).secret).post(`/databases/${odb}/data/collections/c/documents`, { document: {} })).statusCode, 201);
    const listed = json(await h.as(o).get("/api-keys")).items.map((k: { name: string; dataAccess: string }) => [k.name, k.dataAccess]).sort();
    assert.deepEqual(listed, [["default", "read"], ["rw", "readWrite"]]);
  });

  test("signed out: 401 on every route", async () => {
    const f = h.app.fastify;
    for (const [method, u] of [["GET", `/v1/databases/${db}/data/collections`], ["GET", `/v1${url()}`], ["POST", `/v1${url()}`], ["DELETE", `/v1${url()}/${enc(id)}?version=${version}`]] as const) {
      const res = await f.inject({ method, url: u, ...(method === "POST" ? { payload: { document: {} } } : {}) });
      assert.equal(res.statusCode, 401, `${method} ${u}`);
    }
  });
});

describe("audit log", () => {
  test("insert, replace and delete leave attempted + ok rows: who, database, collection, operation, _id, time; never the content", async () => {
    const o = await h.user("Audited");
    const db = await createDb(o, "audited-db");
    const u = `/databases/${db}/data/collections/ledger/documents`;
    const ins = json(await h.as(o).post(u, { document: { _id: "a1", card: "4111-SECRET-CARD", note: "TOP-SECRET-NOTE" } }, cookie));
    const rep = json(await h.as(o).put(`${u}/${enc(ins.id)}`, { document: { card: "4111-SECRET-CARD-2" }, version: ins.version }, cookie));
    await h.as(o).del(`${u}/${enc(ins.id)}?version=${rep.version}`, cookie);
    await h.as(o).get(u); // reads are not audited
    const rows = await auditRows(o.workspaceId);
    assert.deepEqual(rows.map((r) => [r.operation, r.outcome]), [["insert", "attempted"], ["insert", "ok"], ["replace", "attempted"], ["replace", "ok"], ["delete", "attempted"], ["delete", "ok"]]);
    for (const r of rows) {
      assert.equal(r.workspace_id, o.workspaceId);
      assert.equal(r.actor_type, "user");
      assert.equal(r.actor_id, o.userId);
      assert.equal(r.database_id, db);
      assert.equal(r.collection, "ledger");
      assert.equal(r.document_id, '"a1"');
      assert.ok(r.at instanceof Date);
      assert.ok(r.request_id);
    }
    const all = JSON.stringify(rows);
    assert.ok(!all.includes("SECRET"), "no document content in the audit log");
  });

  test("a failed engine write is audited as failed, a lost race as conflict", async () => {
    const o = await h.user("Audited Failures");
    const db = await createDb(o, "audit-fail-db");
    const u = `/databases/${db}/data/collections/c/documents`;
    h.data.failNext("insertOne", "unavailable");
    assert.equal((await h.as(o).post(u, { document: { _id: "x" } }, cookie)).statusCode, 503);
    assert.equal((await h.as(o).post(u, { document: { _id: "x" } }, cookie)).statusCode, 201);
    assert.equal((await h.as(o).post(u, { document: { _id: "x" } }, cookie)).statusCode, 409);
    const rows = await auditRows(o.workspaceId);
    assert.deepEqual(rows.map((r) => r.outcome), ["attempted", "failed", "attempted", "ok", "attempted", "conflict"]);
  });

  test("the control-plane role cannot change or delete audit rows, and the dashboard role cannot read them", async () => {
    const pg = (await import("pg")).default;
    const cp = new pg.Client({ connectionString: h.cpUrl });
    await cp.connect();
    try {
      await cp.query("begin");
      await cp.query("select set_config('app.workspace_id', $1, true)", [owner.workspaceId]);
      await assert.rejects(cp.query("update public.data_audit_log set outcome = 'ok'"), /permission denied/);
      await cp.query("rollback");
      await cp.query("begin");
      await cp.query("select set_config('app.workspace_id', $1, true)", [owner.workspaceId]);
      await assert.rejects(cp.query("delete from public.data_audit_log"), /permission denied/);
      await cp.query("rollback");
    } finally {
      await cp.end();
    }
    const has = (await h.admin.query("select has_table_privilege('authenticated', 'public.data_audit_log', 'select') as s, has_table_privilege('anon', 'public.data_audit_log', 'select') as a")).rows[0];
    assert.deepEqual(has, { s: false, a: false });
  });
});

describe("timeouts, waking and engine failures", () => {
  let o: Fixture;
  let db = "";
  let hx: Harness;

  before(async () => {
    hx = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", DATA_COMMAND_TIMEOUT_MS: "200" });
    o = await hx.user("Sleepy");
    const res = await hx.as(o).post("/databases", { name: "sleepy-db", region: "eu-central-1" }, cookie);
    db = json(res).id;
    hx.data.seed(target(db), "c", [{ _id: 1 }]);
  });
  after(async () => { await hx.close(); });

  test("maxTimeMS is sent with every command", async () => {
    assert.equal((await hx.as(o).get(`/databases/${db}/data/collections/c/documents`)).statusCode, 200);
    assert.equal(hx.data.lastMaxTimeMS, 200);
  });

  test("a command slower than the deadline answers 503 with Retry-After and a clean message", async () => {
    hx.data.delay("find", 2600);
    try {
      const started = Date.now();
      const res = await hx.as(o).get(`/databases/${db}/data/collections/c/documents`);
      assert.equal(res.statusCode, 503);
      assert.ok(Date.now() - started < 2550, "the client gave up at maxTimeMS + grace");
      assert.equal(json(res).error.code, "unavailable");
      assert.equal(res.headers["retry-after"], "2");
      assert.match(json(res).error.message, /waking up/);
    } finally {
      hx.data.delay("find", 0);
    }
  });

  test("a sleeping database: the first request may time out while it wakes, the next one works", async () => {
    hx.data.sleepAll();
    hx.data.wakeMs = 2500;
    try {
      const first = await hx.as(o).get(`/databases/${db}/data/collections`);
      assert.equal(first.statusCode, 503);
      await sleep(600);
      const second = await hx.as(o).get(`/databases/${db}/data/collections`);
      assert.equal(second.statusCode, 200);
    } finally {
      hx.data.wakeMs = 0;
    }
  });

  test("engine unreachable, timeout, refusal: clean codes, nothing of the engine in the answer", async () => {
    for (const [kind, status] of [["unavailable", 503], ["timeout", 503], ["refused", 400]] as const) {
      hx.data.failNext("find", kind);
      const res = await hx.as(o).get(`/databases/${db}/data/collections/c/documents`);
      assert.equal(res.statusCode, status, kind);
      assert.deepEqual(Object.keys(json(res)), ["error"]);
      assert.ok(!/data (unavailable|timeout|refused)|stack|at |mongo|db_[0-9a-f]{32}|27018|localhost/i.test(res.body), res.body);
    }
  });

  test("a database being restored or erased cannot be browsed (409), a provisioning one does not exist (404)", async () => {
    for (const [state, status] of [["restoring", 409], ["erasing", 409], ["provisioning", 404]] as const) {
      await hx.admin.query("update public.databases set engine_state = $2 where id = $1", [db, state]);
      assert.equal((await hx.as(o).get(`/databases/${db}/data/collections`)).statusCode, status, state);
    }
    await hx.admin.query("update public.databases set engine_state = 'ready' where id = $1", [db]);
  });
});

describe("limits", () => {
  let hx: Harness;
  let o: Fixture;
  let db = "";
  before(async () => {
    hx = await startHarness({
      RATE_LIMIT_PER_MINUTE: "100000", DATA_RATE_LIMIT_PER_MINUTE: "8", DATA_WRITE_RATE_LIMIT_PER_MINUTE: "3",
      DATA_MAX_RESPONSE_BYTES: "65536", DATA_MAX_DOCUMENT_BYTES: "4096",
    });
    o = await hx.user("Limited");
    db = json(await hx.as(o).post("/databases", { name: "limited-db", region: "eu-central-1" }, cookie)).id;
    hx.data.seed(target(db), "big", Array.from({ length: 20 }, (_, i) => ({ _id: i, blob: "x".repeat(10_000) })));
  });
  after(async () => { await hx.close(); });

  test("a page stops when its documents reach the response budget (no collection is loaded whole)", async () => {
    const res = await hx.as(o).get(`/databases/${db}/data/collections/big/documents?pageSize=20`);
    assert.equal(res.statusCode, 200);
    const b = json(res);
    assert.ok(b.items.length < 20 && b.items.length >= 6, String(b.items.length));
    assert.equal(b.truncated, true);
    assert.equal(b.hasMore, true);
  });

  test("a document larger than DATA_MAX_DOCUMENT_BYTES is refused", async () => {
    const res = await hx.as(o).post(`/databases/${db}/data/collections/c/documents`, { document: { blob: "y".repeat(5000) } }, cookie);
    assert.equal(res.statusCode, 400);
    assert.match(json(res).error.message, /too large/);
  });

  test("writes have their own lower limit per person; reads are limited per person (429 with Retry-After)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await hx.as(o).post(`/databases/${db}/data/collections/w/documents`, { document: { i } }, cookie)).statusCode);
    assert.deepEqual(codes.slice(0, 2), [201, 201]);
    assert.equal(codes[3], 429);
    const reads: number[] = [];
    for (let i = 0; i < 10; i++) reads.push((await hx.as(o).get(`/databases/${db}/data/collections`)).statusCode);
    assert.ok(reads.includes(429));
    const limited = await hx.as(o).get(`/databases/${db}/data/collections`);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    // another person in another workspace is not affected
    const other = await hx.user("Unaffected");
    const odb = json(await hx.as(other).post("/databases", { name: "unaffected", region: "eu-central-1" }, cookie)).id;
    assert.equal((await hx.as(other).get(`/databases/${odb}/data/collections`)).statusCode, 200);
  });

  test("an API key has its own budget, separate from the people of its workspace", async () => {
    const k = await hx.apiKey(o.workspaceId, "budget", "read");
    assert.equal((await hx.as(k).get(`/databases/${db}/data/collections`)).statusCode, 200);
  });
});

describe("what the control plane logs and which database it touches", () => {
  test("logs: who, database, operation, outcome, duration, count; never content, filter values, collection names, _ids or engine names", async () => {
    const o = await h.user("Logged");
    const db = await createDb(o, "logged-db");
    const coll = "coll_MARKER_C1";
    const u = `/databases/${db}/data/collections/${coll}/documents`;
    const ins = json(await h.as(o).post(u, { document: { _id: "ID_MARKER_77", secret: "VALUE_MARKER_42" } }, cookie));
    await h.as(o).get(`${u}?filter=${enc('{"secret": "FILTER_MARKER_99"}')}`);
    await h.as(o).get(`${u}/${enc(ins.id)}`);
    await h.as(o).put(`${u}/${enc(ins.id)}`, { document: { secret: "VALUE_MARKER_43" }, version: ins.version }, cookie);
    const text = h.logs.text();
    for (const m of ["VALUE_MARKER", "FILTER_MARKER", "ID_MARKER", "MARKER_C1", engineName(db)]) assert.ok(!text.includes(m), `${m} leaked into the logs`);
    const lines = h.logs.lines.map((l) => JSON.parse(l)).filter((l) => l.dataExplorer?.databaseId === db);
    assert.ok(lines.length >= 4);
    for (const l of lines) {
      assert.deepEqual(Object.keys(l.dataExplorer).sort(), ["databaseId", "documents", "durationMs", "op", "outcome"].sort());
      assert.equal(l.workspaceId, o.workspaceId);
      assert.deepEqual(l.actor, { type: "user", id: o.userId });
    }
    assert.ok(h.logs.lines.some((l) => l.includes(`/v1/databases/${db}/data/[redacted]`)));
  });

  test("every engine call names the caller's own database and nothing else", async () => {
    const o = await h.user("Scoped");
    const db = await createDb(o, "scoped-db");
    const start = h.data.touched.length;
    await h.as(o).get(`/databases/${db}/data/collections`);
    await h.as(o).post(`/databases/${db}/data/collections/c/documents`, { document: { a: 1 } }, cookie);
    await h.as(o).get(`/databases/${db}/data/collections/c/documents`);
    const touched = new Set(h.data.touched.slice(start));
    assert.deepEqual([...touched], [engineName(db)]);
  });
});
