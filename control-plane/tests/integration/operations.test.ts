import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type Fixture, type Harness, json, sleep, startHarness } from "../helpers/harness.ts";

let h: Harness;
let u: Fixture;
before(async () => { h = await startHarness(); u = await h.user("Ops"); });
after(async () => { await h.close(); });

const err = (res: { body: string }) => json(res).error as { code: string; message: string; field?: string };
const create = async (name: string, tags: string[] = [], who: Fixture = u) => {
  const r = await h.as(who).post("/databases", { name, region: "eu-central-1", tags });
  assert.equal(r.statusCode, 201, r.body);
  return json(r);
};
const ops = async (who: Fixture = u) => json(await h.as(who).get("/operations?pageSize=100")).items as { id: string; kind: string; status: string; error: unknown; result: unknown }[];
const countOps = async (kind: string, ws = u.workspaceId) => Number((await h.admin.query("select count(*) from public.operations where workspace_id = $1 and kind = $2", [ws, kind])).rows[0].count);
const dbRows = async (ws = u.workspaceId) => Number((await h.admin.query("select count(*) from public.databases where workspace_id = $1", [ws])).rows[0].count);

describe("forkDatabase", () => {
  test("201 with the same region and tags, asleep, forkedFrom set; the engine forked once", async () => {
    const src = await create("fork-src-01", ["customer:acme", "env:prod"]);
    const forks = h.engine.effects.fork;
    const res = await h.as(u).post(`/databases/${src.id}/fork`, { name: "Fork-Src-01-Fork" });
    assert.equal(res.statusCode, 201, res.body);
    const f = json(res);
    assert.equal(f.name, "fork-src-01-fork");
    assert.equal(f.forkedFrom, src.id);
    assert.equal(f.state, "asleep");
    assert.equal(f.region, src.region);
    assert.deepEqual(f.tags, src.tags);
    assert.equal(f.keepAwake, false);
    assert.equal(h.engine.effects.fork, forks + 1);
    assert.ok(res.headers["operation-id"], "the operation id is in a header");
    assert.equal(h.engine.dbs.get(f.id)!.db.forkedFrom, src.id);
  });

  test("404 for an unknown source, 400 for a bad name, 409 for a taken name", async () => {
    const src = await create("fork-err-01");
    assert.equal((await h.as(u).post("/databases/00000000-0000-4000-8000-000000000000/fork", { name: "whatever-01" })).statusCode, 404);
    assert.equal((await h.as(u).post("/databases/nope/fork", { name: "whatever-01" })).statusCode, 404);
    const bad = await h.as(u).post(`/databases/${src.id}/fork`, { name: "x" });
    assert.equal(bad.statusCode, 400);
    assert.equal(err(bad).field, "name");
    const taken = await h.as(u).post(`/databases/${src.id}/fork`, { name: "fork-err-01" });
    assert.equal(taken.statusCode, 409);
    assert.equal(err(taken).code, "conflict");
  });

  test("a failing engine rolls the fork back: no row, name free", async () => {
    const src = await create("fork-fail-01");
    h.engine.failNext("fork", "invalid", 1);
    const res = await h.as(u).post(`/databases/${src.id}/fork`, { name: "fork-fail-01-copy" });
    assert.equal(res.statusCode, 400);
    assert.equal(json(await h.as(u).get("/databases?search=fork-fail-01-copy")).total, 0);
    assert.equal((await h.as(u).post(`/databases/${src.id}/fork`, { name: "fork-fail-01-copy" })).statusCode, 201);
  });
});

describe("restoreDatabase", () => {
  test("200 with restoredTo set; the engine restored once", async () => {
    const d = await create("restore-ok-01");
    await h.admin.query("update public.databases set created_at = now() - interval '30 days' where id = $1", [d.id]);
    const at = new Date(Date.now() - 3 * 86400_000).toISOString();
    const before = h.engine.effects.restore;
    const res = await h.as(u).post(`/databases/${d.id}/restore`, { at });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).restoredTo, at.replace(".000Z", "Z"));
    assert.equal(json(res).id, d.id);
    assert.equal(h.engine.effects.restore, before + 1);
    assert.equal(json(await h.as(u).get(`/databases/${d.id}`)).restoredTo, at.replace(".000Z", "Z"));
  });

  test("400 for a time in the future, before creation, malformed, or missing; 404 for unknown", async () => {
    const d = await create("restore-bad-01");
    const cases: [unknown, string][] = [
      [{ at: new Date(Date.now() + 3600_000).toISOString() }, "Choose a time in the past."],
      [{ at: new Date(Date.now() - 86400_000 * 400).toISOString() }, "before this database was created"],
      [{ at: "yesterday" }, "date and time"],
      [{}, "date and time"],
    ];
    for (const [body, msg] of cases) {
      const res = await h.as(u).post(`/databases/${d.id}/restore`, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(err(res).field, "at");
      assert.match(err(res).message, new RegExp(msg));
    }
    assert.equal((await h.as(u).post("/databases/00000000-0000-4000-8000-000000000000/restore", { at: new Date().toISOString() })).statusCode, 404);
    assert.equal(json(await h.as(u).get(`/databases/${d.id}`)).restoredTo, null);
  });

  test("409 while a restore is running; the same point in time just returns the running one", async () => {
    const d = await create("restore-busy-01");
    await h.admin.query("update public.databases set created_at = now() - interval '30 days' where id = $1", [d.id]);
    h.engine.delay("restore", 600);
    const at1 = new Date(Date.now() - 86400_000).toISOString();
    const first = h.as(u).post(`/databases/${d.id}/restore`, { at: at1 });
    await sleep(150);
    const other = await h.as(u).post(`/databases/${d.id}/restore`, { at: new Date(Date.now() - 2 * 86400_000).toISOString() });
    assert.equal(other.statusCode, 409);
    assert.match(err(other).message, /already running/);
    const same = await h.as(u).post(`/databases/${d.id}/restore`, { at: at1 });
    assert.equal(same.statusCode, 200, same.body);
    assert.equal((await first).statusCode, 200);
    h.engine.delay("restore", 0);
    assert.equal(await countOps("restore", u.workspaceId) >= 1, true);
    const mine = (await h.admin.query("select count(*)::int as n from public.operations where database_id = $1 and kind = 'restore'", [d.id])).rows[0].n;
    assert.equal(mine, 1, "one restore operation, not two");
    assert.equal(h.engine.calls.restore >= 1, true);
  });

  test("an engine that refuses the point in time answers 400 and the database is usable again", async () => {
    const d = await create("restore-window-01");
    await h.admin.query("update public.databases set created_at = now() - interval '30 days' where id = $1", [d.id]);
    h.engine.failNext("restore", "invalid", 1);
    const res = await h.as(u).post(`/databases/${d.id}/restore`, { at: new Date(Date.now() - 86400_000).toISOString() });
    assert.equal(res.statusCode, 400);
    assert.equal((await h.as(u).post(`/databases/${d.id}/restore`, { at: new Date(Date.now() - 86400_000).toISOString() })).statusCode, 200);
  });

  test("the plan's retention window is enforced when the plan file sets one", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cat = JSON.parse(readFileSync(new URL("../../config/plans.json", import.meta.url), "utf8"));
    cat.plans.find((p: { id: string }) => p.id === "managed").limits.retentionDays = 7;
    const f = join(mkdtempSync(join(tmpdir(), "cp-plans-")), "plans.json");
    writeFileSync(f, JSON.stringify(cat));
    const t = await startHarness({ PLANS_FILE: f });
    try {
      const w = await t.user();
      const d = json(await t.as(w).post("/databases", { name: "retain-01", region: "eu-central-1" }));
      await t.admin.query("update public.databases set created_at = now() - interval '60 days' where id = $1", [d.id]);
      const old = await t.as(w).post(`/databases/${d.id}/restore`, { at: new Date(Date.now() - 10 * 86400_000).toISOString() });
      assert.equal(old.statusCode, 400);
      assert.match(err(old).message, /keeps history for 7 days/);
      assert.equal((await t.as(w).post(`/databases/${d.id}/restore`, { at: new Date(Date.now() - 2 * 86400_000).toISOString() })).statusCode, 200);
    } finally { await t.close(); }
  });
});

describe("exportDatabases", () => {
  test("200 with filename, mimeType and a link; the link is made fresh with the configured lifetime", async () => {
    const a = await create("export-a-01");
    const b = await create("export-b-01");
    const res = await h.as(u).post("/databases/export", { ids: [a.id, b.id] });
    assert.equal(res.statusCode, 200, res.body);
    const r = json(res);
    assert.deepEqual(Object.keys(r).sort(), ["downloadUrl", "filename", "mimeType"]);
    assert.match(r.downloadUrl, /ttl=900/, "15 minutes");
    assert.equal(h.engine.exports.size >= 1, true);
    const opId = res.headers["operation-id"] as string;
    const polled = json(await h.as(u).get(`/operations/${opId}`));
    assert.equal(polled.status, "succeeded");
    assert.equal(polled.result.filename, r.filename);
  });

  test("400 for no ids, over 100 ids or bad ids; 404 when one does not exist", async () => {
    const a = await create("export-err-01");
    assert.equal((await h.as(u).post("/databases/export", { ids: [] })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases/export", { ids: Array.from({ length: 101 }, () => randomUUID()) })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases/export", { ids: ["x"] })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases/export", { ids: [a.id, randomUUID()] })).statusCode, 404);
    assert.equal((await h.as(u).post("/databases/export", { ids: Array.from({ length: 100 }, () => a.id) })).statusCode, 200, "duplicates collapse, 100 is allowed");
  });
});

describe("eraseDatabases", () => {
  test("200 with affected; missing ids are skipped; rows and engine data are gone", async () => {
    const a = await create("erase-a-01", ["env:x"]);
    const b = await create("erase-b-01");
    const res = await h.as(u).post("/databases/erase", { ids: [a.id, b.id, randomUUID()] });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res), { affected: 2 });
    assert.equal((await h.as(u).get(`/databases/${a.id}`)).statusCode, 404);
    assert.equal(h.engine.dbs.has(a.id), false);
    assert.equal(h.engine.dbs.has(b.id), false);
    assert.equal(Number((await h.admin.query("select count(*) from public.database_tags where database_id = $1", [a.id])).rows[0].count), 0);
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [randomUUID()] })), { affected: 0 });
  });

  test("400 for no ids or more than 1,000", async () => {
    assert.equal((await h.as(u).post("/databases/erase", { ids: [] })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases/erase", { ids: Array.from({ length: 1001 }, () => randomUUID()) })).statusCode, 400);
  });

  test("a database being restored cannot be erased (409); a member cannot erase at all (403)", async () => {
    const d = await create("erase-busy-01");
    await h.admin.query("update public.databases set engine_state = 'restoring' where id = $1", [d.id]);
    assert.equal((await h.as(u).post("/databases/erase", { ids: [d.id] })).statusCode, 409);
    await h.admin.query("update public.databases set engine_state = 'ready' where id = $1", [d.id]);
    const member = await h.addMember(u.workspaceId, "Mia Member", "member");
    const res = await h.as(member).post("/databases/erase", { ids: [d.id] });
    assert.equal(res.statusCode, 403);
    assert.equal(err(res).code, "forbidden");
    assert.equal((await h.as(u).get(`/databases/${d.id}`)).statusCode, 200);
  });
});

describe("setKeepAwake", () => {
  test("pins and unpins; the database wakes when pinned; the engine agrees", async () => {
    const a = await create("keep-a-01");
    const b = await create("keep-b-01");
    const on = await h.as(u).post("/databases/keep-awake", { ids: [a.id, b.id, randomUUID()], enabled: true });
    assert.deepEqual(json(on), { affected: 2 });
    const got = json(await h.as(u).get(`/databases/${a.id}`));
    assert.equal(got.keepAwake, true);
    assert.equal(got.state, "awake");
    assert.equal(h.engine.dbs.get(a.id)!.db.keepAwake, true);
    const off = await h.as(u).post("/databases/keep-awake", { ids: [a.id], enabled: false });
    assert.deepEqual(json(off), { affected: 1 });
    assert.equal(json(await h.as(u).get(`/databases/${a.id}`)).keepAwake, false);
    assert.equal(h.engine.dbs.get(a.id)!.db.keepAwake, false);
    assert.equal(json(await h.as(u).get(`/databases/${b.id}`)).keepAwake, true);
  });

  test("400 for a missing flag, no ids, or over 1,000 ids", async () => {
    const a = await create("keep-err-01");
    assert.equal((await h.as(u).post("/databases/keep-awake", { ids: [a.id] })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases/keep-awake", { ids: [a.id], enabled: "yes" })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases/keep-awake", { ids: [], enabled: true })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases/keep-awake", { ids: Array.from({ length: 1001 }, () => randomUUID()), enabled: true })).statusCode, 400);
  });

  test("when the engine fails for one database, Postgres keeps the old value for it and a retry finishes the job", async () => {
    const a = await create("keep-fail-a-01");
    const b = await create("keep-fail-b-01");
    h.engine.failNext("keepAwake", "unavailable", 1);
    const res = await h.as(u).post("/databases/keep-awake", { ids: [a.id, b.id], enabled: true });
    assert.equal(res.statusCode, 500);
    assert.equal(err(res).code, "internal");
    const flags = [json(await h.as(u).get(`/databases/${a.id}`)).keepAwake, json(await h.as(u).get(`/databases/${b.id}`)).keepAwake];
    assert.equal(flags.filter(Boolean).length, 1, "exactly the one that succeeded is pinned");
    assert.deepEqual(json(await h.as(u).post("/databases/keep-awake", { ids: [a.id, b.id], enabled: true })), { affected: 2 });
    assert.deepEqual([a.id, b.id].map((id) => h.engine.dbs.get(id)!.db.keepAwake), [true, true]);
  });
});

describe("idempotency: retries never duplicate", () => {
  test("create: the same Idempotency-Key replays the first answer, one database, one engine create", async () => {
    const key = randomUUID();
    const before = h.engine.effects.create;
    const body = { name: "idem-create-01", region: "eu-central-1", tags: ["a:b"] };
    const first = await h.as(u).post("/databases", body, { "idempotency-key": key });
    const second = await h.as(u).post("/databases", body, { "idempotency-key": key });
    const third = await h.as(u).post("/databases", body, { "idempotency-key": key });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(json(second).id, json(first).id);
    assert.equal(json(third).id, json(first).id);
    assert.equal(second.headers["idempotent-replay"], "true");
    assert.equal(first.headers["idempotent-replay"], undefined);
    assert.equal(h.engine.effects.create, before + 1);
    assert.equal(json(await h.as(u).get("/databases?search=idem-create-01")).total, 1);
  });

  test("the same key with a different body is a 409, not a second action", async () => {
    const key = randomUUID();
    await h.as(u).post("/databases", { name: "idem-diff-01", region: "eu-central-1" }, { "idempotency-key": key });
    const res = await h.as(u).post("/databases", { name: "idem-diff-02", region: "eu-central-1" }, { "idempotency-key": key });
    assert.equal(res.statusCode, 409);
    assert.match(err(res).message, /different request/);
    assert.equal(json(await h.as(u).get("/databases?search=idem-diff-02")).total, 0);
  });

  test("a validation error does not use up the key: fix the body and retry with the same key", async () => {
    const key = randomUUID();
    assert.equal((await h.as(u).post("/databases", { name: "x", region: "eu-central-1" }, { "idempotency-key": key })).statusCode, 400);
    assert.equal((await h.as(u).post("/databases", { name: "idem-fixed-01", region: "eu-central-1" }, { "idempotency-key": key })).statusCode, 201);
  });

  test("keys belong to the workspace: another workspace's same key is unrelated", async () => {
    const other = await h.user("Other");
    const key = randomUUID();
    const a = await h.as(u).post("/databases", { name: "idem-ws-01", region: "eu-central-1" }, { "idempotency-key": key });
    const b = await h.as(other).post("/databases", { name: "idem-ws-01", region: "eu-central-1" }, { "idempotency-key": key });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.notEqual(json(a).id, json(b).id);
  });

  test("fork with a key: replay returns the same database, one fork in the engine", async () => {
    const src = await create("idem-fork-src-01");
    const key = randomUUID();
    const before = h.engine.effects.fork;
    const a = await h.as(u).post(`/databases/${src.id}/fork`, { name: "idem-fork-01" }, { "idempotency-key": key });
    const b = await h.as(u).post(`/databases/${src.id}/fork`, { name: "idem-fork-01" }, { "idempotency-key": key });
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.equal(json(b).id, json(a).id);
    assert.equal(h.engine.effects.fork, before + 1);
    assert.equal(await h.admin.query("select count(*)::int as n from public.databases where name = 'idem-fork-01' and workspace_id = $1", [u.workspaceId]).then((r) => r.rows[0].n), 1);
  });

  test("restore with a key: replay does not roll back twice", async () => {
    const d = await create("idem-restore-01");
    await h.admin.query("update public.databases set created_at = now() - interval '30 days' where id = $1", [d.id]);
    const key = randomUUID();
    const at = new Date(Date.now() - 86400_000).toISOString();
    const before = h.engine.effects.restore;
    const a = await h.as(u).post(`/databases/${d.id}/restore`, { at }, { "idempotency-key": key });
    const b = await h.as(u).post(`/databases/${d.id}/restore`, { at }, { "idempotency-key": key });
    assert.deepEqual([a.statusCode, b.statusCode], [200, 200]);
    assert.equal(h.engine.effects.restore, before + 1);
    assert.equal(await h.admin.query("select count(*)::int as n from public.operations where database_id = $1 and kind = 'restore'", [d.id]).then((r) => r.rows[0].n), 1);
  });

  test("erase with a key: replay gives the same count and erases once", async () => {
    const a = await create("idem-erase-a-01");
    const b = await create("idem-erase-b-01");
    const key = randomUUID();
    const before = h.engine.effects.erase;
    const one = await h.as(u).post("/databases/erase", { ids: [a.id, b.id] }, { "idempotency-key": key });
    const two = await h.as(u).post("/databases/erase", { ids: [a.id, b.id] }, { "idempotency-key": key });
    assert.deepEqual([json(one), json(two)], [{ affected: 2 }, { affected: 2 }]);
    assert.equal(h.engine.effects.erase, before + 2);
  });

  test("export with a key: replay returns a link for the same file and makes no second export", async () => {
    const a = await create("idem-export-01");
    const key = randomUUID();
    const before = h.engine.effects.export;
    const one = await h.as(u).post("/databases/export", { ids: [a.id] }, { "idempotency-key": key });
    const two = await h.as(u).post("/databases/export", { ids: [a.id] }, { "idempotency-key": key });
    assert.equal(json(two).filename, json(one).filename);
    assert.equal(h.engine.effects.export, before + 1);
  });

  test("without a key, a repeated create is a 409 (nothing is duplicated); a repeated erase is harmless", async () => {
    const a = await create("nokey-01");
    const before = await dbRows();
    assert.equal((await h.as(u).post("/databases", { name: "nokey-01", region: "eu-central-1" })).statusCode, 409);
    assert.equal(await dbRows(), before);
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [a.id] })), { affected: 1 });
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [a.id] })), { affected: 0 });
  });

  test("an invalid Idempotency-Key is a 400", async () => {
    const res = await h.as(u).post("/databases", { name: "idem-bad-01", region: "eu-central-1" }, { "idempotency-key": "has spaces" });
    assert.equal(res.statusCode, 400);
    assert.equal(err(res).field, "Idempotency-Key");
  });

  test("two identical requests at the same moment do not both run", async () => {
    const key = randomUUID();
    const body = { name: "idem-race-01", region: "eu-central-1" };
    h.engine.delay("create", 300);
    const [a, b] = await Promise.all([
      h.as(u).post("/databases", body, { "idempotency-key": key }),
      h.as(u).post("/databases", body, { "idempotency-key": key }),
    ]);
    h.engine.delay("create", 0);
    // The second request either replays the first (201) or is told the first is still running (409). Never a second action.
    const codes = [a.statusCode, b.statusCode].sort();
    assert.ok(codes[0] === 201 && (codes[1] === 201 || codes[1] === 409), `got ${codes}`);
    if (codes[1] === 201) assert.equal(json(a).id, json(b).id);
    assert.equal(await h.admin.query("select count(*)::int as n from public.databases where name = 'idem-race-01' and workspace_id = $1", [u.workspaceId]).then((r) => r.rows[0].n), 1);
    assert.equal([...h.engine.dbs.values()].filter((s) => s.db.name === "idem-race-01" && s.db.workspaceId === u.workspaceId).length, 1);
  });
});

describe("long operations: records, polling, retries, crash recovery", () => {
  test("a slow engine gets a 202 with an operation to poll; the work finishes by itself", async () => {
    const t = await startHarness({ OPERATION_WAIT_MS: "100" });
    try {
      const w = await t.user();
      t.engine.delay("create", 500);
      const res = await t.as(w).post("/databases", { name: "slow-create-01", region: "eu-central-1" });
      assert.equal(res.statusCode, 202, res.body);
      const op = json(res).operation;
      assert.equal(op.kind, "create");
      assert.ok(["queued", "running"].includes(op.status));
      assert.equal(res.headers["location"], `https://api.fenvix.test/v1/operations/${op.id}`);
      assert.equal(res.headers["operation-id"], op.id);
      assert.ok(res.headers["retry-after"]);
      let done = op;
      for (let i = 0; i < 40 && done.status !== "succeeded"; i++) { await sleep(100); done = json(await t.as(w).get(`/operations/${op.id}`)); }
      assert.equal(done.status, "succeeded");
      assert.equal(done.result.name, "slow-create-01");
      assert.equal(done.databaseId, done.result.id);
      assert.equal(json(await t.as(w).get(`/databases/${done.result.id}`)).name, "slow-create-01");
      assert.equal(t.engine.effects.create, 1);
    } finally { t.engine.delay("create", 0); await t.close(); }
  });

  test("a database that is still being created is invisible, and its name is already taken", async () => {
    const t = await startHarness({ OPERATION_WAIT_MS: "50" });
    try {
      const w = await t.user();
      t.engine.delay("create", 400);
      const res = await t.as(w).post("/databases", { name: "provisioning-01", region: "eu-central-1" });
      assert.equal(res.statusCode, 202);
      assert.equal(json(await t.as(w).get("/databases")).total, 0);
      assert.equal((await t.as(w).get(`/databases/${json(res).operation.databaseId}`)).statusCode, 404);
      assert.equal((await t.as(w).post("/databases", { name: "provisioning-01", region: "eu-central-1" })).statusCode, 202, "an identical retry finds the running operation");
      assert.equal(await t.admin.query("select count(*)::int as n from public.operations where workspace_id = $1 and kind = 'create'", [w.workspaceId]).then((r) => r.rows[0].n), 1);
      await sleep(600);
      assert.equal(json(await t.as(w).get("/databases")).total, 1);
    } finally { t.engine.delay("create", 0); await t.close(); }
  });

  test("an engine outage is retried by the sweeper with the same idempotency key; no duplicate in the engine", async () => {
    const t = await startHarness({ OPERATION_WAIT_MS: "2000" });
    try {
      const w = await t.user();
      t.engine.failNext("create", "unavailable", 2);
      const res = await t.as(w).post("/databases", { name: "outage-01", region: "eu-central-1" });
      assert.equal(res.statusCode, 202, "queued for a retry rather than failed");
      const opId = json(res).operation.id;
      assert.equal(json(await t.as(w).get(`/operations/${opId}`)).status, "queued");
      for (let i = 0; i < 2; i++) {
        await t.admin.query("update public.operations set retry_at = now() where id = $1", [opId]);
        await t.app.deps.runner.sweepOnce();
      }
      const done = json(await t.as(w).get(`/operations/${opId}`));
      assert.equal(done.status, "succeeded");
      assert.equal(t.engine.calls.create, 3);
      assert.equal(t.engine.effects.create, 1);
      assert.equal(t.engine.dbs.size, 1);
      assert.equal(json(await t.as(w).get("/databases")).total, 1);
    } finally { await t.close(); }
  });

  test("a runner that died mid-operation: after the lease runs out the sweeper finishes it, once", async () => {
    const t = await startHarness({ OPERATION_WAIT_MS: "100" });
    try {
      const w = await t.user();
      const src = json(await t.as(w).post("/databases", { name: "crash-src-01", region: "eu-central-1" }));
      // an operation that a dead process had claimed, mid-fork
      const forkId = randomUUID();
      await t.admin.query("insert into public.databases (id, workspace_id, name, region, forked_from, engine_state) values ($1, $2, 'crash-fork-01', 'eu-central-1', $3, 'provisioning')", [forkId, w.workspaceId, src.id]);
      const opId = (await t.admin.query(
        `insert into public.operations (workspace_id, kind, status, database_id, params, attempts, locked_until, actor_type, actor_id)
         values ($1, 'fork', 'running', $2, $3, 1, now() + interval '1 hour', 'user', $4) returning id`,
        [w.workspaceId, forkId, JSON.stringify({ sourceId: src.id, name: "crash-fork-01" }), w.userId])).rows[0].id;
      assert.equal(await t.app.deps.runner.sweepOnce(), 0, "a live lease is left alone");
      await t.admin.query("update public.operations set locked_until = now() - interval '1 second' where id = $1", [opId]);
      assert.equal(await t.app.deps.runner.sweepOnce(), 1);
      assert.equal(json(await t.as(w).get(`/operations/${opId}`)).status, "succeeded");
      assert.equal(json(await t.as(w).get(`/databases/${forkId}`)).forkedFrom, src.id);
      assert.equal(await t.app.deps.runner.sweepOnce(), 0);
      assert.equal(t.engine.effects.fork, 1);
    } finally { await t.close(); }
  });

  test("after too many failed attempts the operation fails for good and the database row is removed", async () => {
    const t = await startHarness({ OPERATION_WAIT_MS: "2000" });
    try {
      const w = await t.user();
      t.engine.failNext("create", "unavailable", 100);
      const res = await t.as(w).post("/databases", { name: "hopeless-01", region: "eu-central-1" });
      const opId = json(res).operation.id;
      for (let i = 0; i < 10; i++) {
        await t.admin.query("update public.operations set retry_at = now() where id = $1", [opId]);
        await t.app.deps.runner.sweepOnce();
      }
      const op = json(await t.as(w).get(`/operations/${opId}`));
      assert.equal(op.status, "failed");
      assert.equal(op.error.code, "internal");
      assert.equal(await t.admin.query("select count(*)::int as n from public.databases where workspace_id = $1", [w.workspaceId]).then((r) => r.rows[0].n), 0);
      assert.equal((await t.as(w).post("/databases", { name: "hopeless-01", region: "eu-central-1" })).statusCode, 202 /* queued again: the name is free */);
    } finally { await t.close(); }
  });

  test("a failed erase puts the remaining databases back to normal", async () => {
    const a = await create("erase-fail-a-01");
    const b = await create("erase-fail-b-01");
    h.engine.failNext("erase", "invalid", 1);
    const res = await h.as(u).post("/databases/erase", { ids: [a.id, b.id] });
    assert.equal(res.statusCode, 400);
    const states = (await h.admin.query("select engine_state from public.databases where id = any($1)", [[a.id, b.id]])).rows.map((r) => r.engine_state);
    assert.deepEqual(states, ["ready", "ready"]);
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [a.id, b.id] })), { affected: 2 });
  });

  test("GET /operations lists operations newest first, 404 for another id, filters by status", async () => {
    const list = await h.as(u).get("/operations?pageSize=5");
    assert.equal(list.statusCode, 200);
    const b = json(list);
    assert.equal(b.pageSize, 5);
    assert.ok(b.total >= 5 && b.items.length === 5);
    const times = b.items.map((o: { createdAt: string }) => o.createdAt);
    assert.deepEqual([...times].sort().reverse(), times);
    assert.ok(b.items.every((o: { status: string }) => o.status === "succeeded" || o.status === "failed"));
    assert.equal((await h.as(u).get(`/operations/${randomUUID()}`)).statusCode, 404);
    assert.equal((await h.as(u).get("/operations/nope")).statusCode, 404);
    assert.equal((await h.as(u).get("/operations?status=weird")).statusCode, 400);
    assert.ok((await ops()).length > 0);
  });
});

describe("plan limits", () => {
  test("a plan that caps databases refuses the one over the cap with 403, for create and fork", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cat = JSON.parse(readFileSync(new URL("../../config/plans.json", import.meta.url), "utf8"));
    cat.plans.find((p: { id: string }) => p.id === "managed").limits.maxDatabases = 2;
    const f = join(mkdtempSync(join(tmpdir(), "cp-plans-")), "plans.json");
    writeFileSync(f, JSON.stringify(cat));
    const t = await startHarness({ PLANS_FILE: f });
    try {
      const w = await t.user();
      const a = json(await t.as(w).post("/databases", { name: "cap-a-01", region: "eu-central-1" }));
      assert.equal((await t.as(w).post("/databases", { name: "cap-b-01", region: "eu-central-1" })).statusCode, 201);
      const third = await t.as(w).post("/databases", { name: "cap-c-01", region: "eu-central-1" });
      assert.equal(third.statusCode, 403);
      assert.match(err(third).message, /allows 2 databases/);
      assert.equal((await t.as(w).post(`/databases/${a.id}/fork`, { name: "cap-fork-01" })).statusCode, 403);
      assert.equal(t.engine.dbs.size, 2);
    } finally { await t.close(); }
  });
});
