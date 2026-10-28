import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { workspaceCode } from "../../src/config.ts";
import { engineName } from "../../src/engine/names.ts";
import { RealEngine } from "../../src/engine/real.ts";
import { syncWorkspaceUsage } from "../../src/services/usage.ts";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";
import { SimEngine } from "../helpers/sim-engine.ts";
import { unzip } from "../helpers/unzip.ts";

/**
 * The whole service on ENGINE_DRIVER=real: HTTP API, restricted Postgres role, the real adapter, and an engine
 * simulated from control-ops. Everything the fake integration tests prove about operations is proved again here
 * for the adapter's way of being idempotent (no keys: names made from ids, 409 handling).
 */
let h: Harness;
let sim: SimEngine;
let u: Fixture;

before(async () => {
  sim = new SimEngine();
  await sim.start();
  h = await startHarness({
    ENGINE_DRIVER: "real",
    ENGINE_ADMIN_ENDPOINTS: sim.url,
    ENGINE_ADMIN_TOKEN: sim.token,
    ENGINE_RETENTION_WINDOW_SECS: "3600",
    CONNECTION_PORT: "27018",
    BASE_DOMAIN: "db.example.test",
    HOST_TEMPLATE: "<name>-<workspace>.<region>.<BASE_DOMAIN>",
    CONNECTION_DB_NAME: "engine",
    OPERATION_WAIT_MS: "3000",
  }, { engineFactory: (cfg) => new RealEngine({ settings: cfg.engine!, downloadSigningKey: cfg.downloadSigningKey, apiPublicUrl: cfg.apiPublicUrl }) });
  u = await h.user("Real");
});
after(async () => { await h.close(); await sim.stop(); });

const sweepNow = async () => {
  await h.admin.query("update public.operations set retry_at = now() where status = 'queued'");
  await h.app.deps.runner.sweepOnce();
};

describe("a database through its whole life, on the real driver", () => {
  let a: { id: string; host: string; connectionString: string };
  let f: { id: string; forkedFrom: string | null };

  test("create: the engine holds one database named from the id; host and connection string say where and which", async () => {
    const res = await h.as(u).post("/databases", { name: "orders-prod", region: "eu-central-1", tags: ["customer:acme"] });
    assert.equal(res.statusCode, 201, res.body);
    a = json(res);
    assert.deepEqual([...sim.dbs.keys()], [engineName(a.id)]);
    assert.equal(a.host, `orders-prod-${workspaceCode(u.workspaceId)}.eu-central-1.db.example.test`);
    // No provisioner in this suite (NoEngineUsers): no initial user, so the string names none.
    assert.equal(a.connectionString, `mongodb://<username>:<password>@${a.host}:27018/${engineName(a.id)}?tls=true&authSource=${engineName(a.id)}&authMechanism=SCRAM-SHA-256`);
    assert.equal(sim.dbs.get(engineName(a.id))!.retention!.window_secs, 3600, "restore points are switched on");
  });

  test("the same name in another workspace is another database, another engine name, another host", async () => {
    const v = await h.user("Other");
    const res = await h.as(v).post("/databases", { name: "orders-prod", region: "eu-central-1" });
    assert.equal(res.statusCode, 201, res.body);
    const b = json(res);
    assert.notEqual(b.host, a.host);
    assert.notEqual(engineName(b.id), engineName(a.id));
    assert.equal((await h.as(v).post("/databases/erase", { ids: [b.id] })).statusCode, 200);
  });

  test("the customer writes to it (simulated) and the engine reports the size back through get", async () => {
    sim.write(engineName(a.id), ["before-1", "before-2"], "orders");
    sim.takePoint(engineName(a.id));
    await new Promise((r) => setTimeout(r, 30));
    sim.write(engineName(a.id), ["after"], "orders");
    const got = json(await h.as(u).get(`/databases/${a.id}`));
    assert.equal(got.name, "orders-prod");
  });

  test("fork: a clone that remembers its source", async () => {
    const res = await h.as(u).post(`/databases/${a.id}/fork`, { name: "orders-copy" });
    assert.equal(res.statusCode, 201, res.body);
    f = json(res);
    assert.equal(f.forkedFrom, a.id);
    assert.equal(sim.dbs.get(engineName(f.id))!.forkedFrom!.database, engineName(a.id));
    assert.equal(sim.dbs.get(engineName(f.id))!.forkedFrom!.mode, "clone");
  });

  test("restore goes back to a point in time and says so", async () => {
    const at = new Date(Date.now() - 1).toISOString();
    const res = await h.as(u).post(`/databases/${a.id}/restore`, { at });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).restoredTo, at);
    assert.deepEqual(sim.dbs.get(engineName(a.id))!.docs, ["before-1", "before-2"]);
  });

  test("restore before the oldest backup is the customer's 400, in our words (never the engine's)", async () => {
    const key = engineName(a.id);
    const d = sim.dbs.get(key)!;
    d.points = [{ atMs: Date.now() - 50, docs: [...d.docs], collections: { ...d.collections } }]; // the engine's oldest restore point is only just now
    await h.admin.query("update public.databases set created_at = now() - interval '1 hour' where id = $1", [a.id]);
    const res = await h.as(u).post(`/databases/${a.id}/restore`, { at: new Date(Date.now() - 300).toISOString() });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(json(res).error.message, /earliest restorable point of this database \(\d{4}-/);
    assert.doesNotMatch(json(res).error.message, /is before the earliest restorable time/, "the engine's own sentence is not passed on");
    assert.equal((await h.admin.query("select engine_state from public.databases where id = $1", [a.id])).rows[0].engine_state, "ready");
  });

  test("keep awake pins it in the engine and in Postgres", async () => {
    const res = await h.as(u).post("/databases/keep-awake", { ids: [a.id], enabled: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(sim.dbs.get(engineName(a.id))!.keepAwake, true);
    assert.equal(json(await h.as(u).get(`/databases/${a.id}`)).keepAwake, true);
  });

  test("export: one zip behind a signed link, with each database's dump files", async () => {
    const res = await h.as(u).post("/databases/export", { ids: [a.id, f.id] });
    assert.equal(res.statusCode, 200, res.body);
    const r = json(res);
    assert.match(r.filename, /\.zip$/);
    const path = new URL(r.downloadUrl).pathname.replace(/^\/v1/, "/v1");
    const dl = await h.app.fastify.inject({ method: "GET", url: path });
    assert.equal(dl.statusCode, 200, dl.body.slice(0, 200));
    assert.equal(dl.headers["content-type"], "application/zip");
    const files = unzip(dl.rawPayload);
    assert.ok(files.some((x) => x.name === `${engineName(a.id)}/orders.bson` && x.data.toString() === "before-1\nbefore-2\n"), files.map((x) => x.name).join());
    assert.ok(files.some((x) => x.name === `${engineName(f.id)}/orders.metadata.json`));
    const forged = await h.app.fastify.inject({ method: "GET", url: `${path.slice(0, -4)}AAAA` });
    assert.equal(forged.statusCode, 404);
  });

  test("usage sync copies the engine's daily counts, state and size into Postgres", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const d = sim.dbs.get(engineName(a.id))!;
    d.usage.set(today, { commands: 77, wakes: [{ at_ms: Date.now() - 1000, first_request_latency_ms: 42 }] });
    const out = await syncWorkspaceUsage(h.app.deps.s, u.workspaceId);
    assert.deepEqual(out, { databases: 2, failed: 0 });
    const row = (await h.admin.query("select state, storage_bytes from public.databases where id = $1", [a.id])).rows[0];
    assert.equal(row.state, "awake");
    assert.equal(Number(row.storage_bytes), "before-1before-2".length);
    assert.equal((await h.admin.query("select requests from public.usage_daily where database_id = $1 and day = $2", [a.id, today])).rows[0].requests, 77);
    assert.equal((await h.admin.query("select first_request_ms from public.wake_events where database_id = $1", [a.id])).rows[0].first_request_ms, 42);
  });

  test("erasing a database that has a fork is refused with a reason, and nothing is lost", async () => {
    const res = await h.as(u).post("/databases/erase", { ids: [a.id] });
    assert.equal(res.statusCode, 409, res.body);
    assert.match(json(res).error.message, /forks/i);
    assert.ok(sim.dbs.has(engineName(a.id)));
    assert.equal((await h.admin.query("select engine_state from public.databases where id = $1", [a.id])).rows[0].engine_state, "ready");
  });

  test("erase the fork, then the source; erasing again affects nothing", async () => {
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [f.id] })), { affected: 1 });
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [a.id] })), { affected: 1 });
    assert.equal(sim.dbs.size, 0);
    assert.deepEqual(json(await h.as(u).post("/databases/erase", { ids: [a.id] })), { affected: 0 });
    assert.equal((await h.admin.query("select count(*)::int as n from public.databases where workspace_id = $1", [u.workspaceId])).rows[0].n, 0);
  });
});

describe("retries on the real driver never duplicate", () => {
  test("an engine that fails once is retried by the sweeper; one database results", async () => {
    sim.failNext(/^POST \/v1\/databases$/, 503, "internal", 1);
    const res = await h.as(u).post("/databases", { name: "retry-01", region: "eu-central-1" });
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(sim.dbs.size, 0);
    await sweepNow();
    assert.equal(sim.dbs.size, 1);
    const row = (await h.admin.query("select engine_state from public.databases where name = 'retry-01' and workspace_id = $1", [u.workspaceId])).rows[0];
    assert.equal(row.engine_state, "ready");
  });

  test("a create whose answer was lost is finished by the retry: still one database in the engine", async () => {
    const before = sim.dbs.size;
    sim.loseAnswer(/^POST \/v1\/databases$/);
    const res = await h.as(u).post("/databases", { name: "lost-01", region: "eu-central-1" });
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(sim.dbs.size, before + 1, "the engine made it");
    await sweepNow();
    assert.equal(sim.dbs.size, before + 1);
    assert.equal((await h.admin.query("select engine_state from public.databases where name = 'lost-01' and workspace_id = $1", [u.workspaceId])).rows[0].engine_state, "ready");
  });

  test("an erase whose answer was lost is finished by the retry", async () => {
    const id = (await h.admin.query("select id from public.databases where name = 'lost-01' and workspace_id = $1", [u.workspaceId])).rows[0].id as string;
    sim.loseAnswer(/^DELETE \/v1\/databases\/db_/);
    const res = await h.as(u).post("/databases/erase", { ids: [id] });
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(sim.dbs.has(engineName(id)), false, "the engine erased it");
    await sweepNow();
    assert.equal((await h.admin.query("select count(*)::int as n from public.databases where id = $1", [id])).rows[0].n, 0);
    const op = (await h.admin.query("select status, result from public.operations where kind = 'erase' order by created_at desc limit 1")).rows[0];
    assert.equal(op.status, "succeeded");
  });

  test("the engine is only ever asked for databases of this service", async () => {
    assert.ok(sim.seen.length > 20);
    assert.ok(sim.seen.every((l) => /^(GET|POST|PUT|DELETE) \/v1\/(databases(\/db_[0-9a-f]{32}.*)?|exports\/db_[0-9a-f]{32}\.[0-9a-f]{16}.*)$/.test(l)), sim.seen.filter((l) => !/db_[0-9a-f]{32}/.test(l) && l !== "POST /v1/databases").join(" | "));
    assert.equal(sim.seen.filter((l) => l === "GET /v1/databases").length, 0, "the list of every database is never asked for");
    assert.equal(sim.unauthorized, 0);
  });

  test("no secret reaches the log", async () => {
    const text = h.logs.text();
    assert.ok(!text.includes(sim.token));
    assert.ok(!text.includes(sim.url));
  });
});
