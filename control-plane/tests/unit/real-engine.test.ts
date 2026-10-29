import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { AdminHttp, ALLOWED_ROUTES, authorize } from "../../src/engine/admin-http.ts";
import { FakeEngine } from "../../src/engine/fake.ts";
import { engineName, idFromEngineName, isEngineName } from "../../src/engine/names.ts";
import { type EngineClient, EngineError } from "../../src/engine/types.ts";
import { verifyDownload } from "../../src/downloads.ts";
import { makeReal, realEnv } from "../helpers/real-engine.ts";
import { SimEngine } from "../helpers/sim-engine.ts";
import { unzip } from "../helpers/unzip.ts";
import { loadConfig } from "../../src/config.ts";

const WS = randomUUID();
const text = (b: AsyncIterable<Uint8Array>) => collect(b).then((x) => Buffer.from(x));
async function collect(b: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const c of b) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof EngineError ? e.kind : `other:${e}`));

describe("engine names", () => {
  test("derived from the id, reversible, and nothing else is accepted", () => {
    const id = randomUUID();
    const n = engineName(id);
    assert.match(n, /^db_[0-9a-f]{32}$/);
    assert.equal(idFromEngineName(n), id);
    assert.ok(isEngineName(n));
    for (const bad of ["db_", "orders-prod", "admin", `${n}x`, n.toUpperCase(), `${n}/../x`, "db_" + "0".repeat(31)]) {
      assert.equal(isEngineName(bad), false, bad);
      assert.equal(idFromEngineName(bad), null, bad);
    }
    assert.throws(() => engineName("not-a-uuid"));
  });
});

describe("permission boundary: the control plane can only do the operations it is meant to", () => {
  const db = engineName(randomUUID());
  const exp = `${db}.0123456789abcdef`;
  const allowed: [string, string][] = [
    ["POST", "/v1/databases"], ["GET", `/v1/databases/${db}`], ["GET", `/v1/databases/${db}?storage=false`], ["POST", `/v1/databases/${db}/fork`],
    ["DELETE", `/v1/databases/${db}`], ["PUT", `/v1/databases/${db}/keep-awake`], ["DELETE", `/v1/databases/${db}/keep-awake`],
    ["GET", `/v1/databases/${db}/usage?from=2026-01-01&to=2026-01-02`], ["PUT", `/v1/databases/${db}/retention`], ["GET", `/v1/databases/${db}/restore-points`],
    ["POST", `/v1/databases/${db}/restore`], ["POST", `/v1/databases/${db}/exports`], ["GET", `/v1/exports/${exp}`], ["GET", `/v1/exports/${exp}/files/${db}/c.bson`],
    ["GET", `/v1/databases/${db}/ip-allowlist`], ["PUT", `/v1/databases/${db}/ip-allowlist`], ["DELETE", `/v1/databases/${db}/ip-allowlist`],
    ["GET", "/v1/network"], ["DELETE", `/v1/network/blocks/203.0.113.9?database=${db}`], ["DELETE", `/v1/network/blocks/2001:db8::?database=${db}`],
  ];
  const refused: [string, string][] = [
    ["GET", "/v1/databases"], // would list every customer's databases
    ["GET", "/v1/health"], ["GET", `/v1/databases/${db}/manifest`], ["GET", `/v1/databases/${db}/checkpoints`],
    ["DELETE", `/v1/exports/${exp}`], ["PUT", `/v1/databases/${db}`], ["POST", `/v1/databases/${db}`], ["GET", `/v1/databases/${db}/restore`],
    ["GET", "/v1/databases/orders-prod"], ["DELETE", "/v1/databases/orders-prod"], ["DELETE", "/v1/databases/admin"], ["DELETE", "/v1/databases/local"],
    ["GET", `/v1/databases/${db}/../${db.replace("0", "1")}`], ["GET", `/v1/databases/${db}%2F..%2Fadmin`], ["GET", `/v2/databases/${db}`],
    ["DELETE", `/v1/databases/${db}/`], ["DELETE", `/v1/databases/${db}x`], ["GET", `/v1/exports/${db}.nothex`], ["GET", `/v1/exports/${exp}/files/orders/c.bson`],
    ["GET", `/v1/exports/${exp}/files/${db}/a/b.bson`], ["PATCH", `/v1/databases/${db}`], ["GET", `//v1/databases/${db}`],
    ["PUT", "/v1/databases/admin/ip-allowlist"], ["GET", "/v1/databases/orders/ip-allowlist"], ["DELETE", "/v1/network/blocks"],
    ["DELETE", "/v1/network/blocks/10.0.0.0/8"], ["DELETE", "/v1/network/blocks/..%2F"], ["PUT", "/v1/network"], ["DELETE", "/v1/network"],
    // The unblock without `?database=` lifts the address on EVERY database: never sent. Nor for another database, nor with more.
    ["DELETE", "/v1/network/blocks/203.0.113.9"], ["DELETE", "/v1/network/blocks/203.0.113.9?"], ["DELETE", "/v1/network/blocks/203.0.113.9?database="],
    ["DELETE", "/v1/network/blocks/203.0.113.9?database=admin"], ["DELETE", "/v1/network/blocks/203.0.113.9?database=orders"],
    ["DELETE", `/v1/network/blocks/203.0.113.9?database=${db}x`], ["DELETE", `/v1/network/blocks/203.0.113.9?database=${db}&database=admin`],
    ["DELETE", `/v1/network/blocks/203.0.113.9?all=1&database=${db}`], ["DELETE", `/v1/network/blocks/203.0.113.9?database=${db}#x`],
  ];
  test("every allowed route is on the list, and the list holds nothing else", () => {
    for (const [m, p] of allowed) assert.doesNotThrow(() => authorize(m, p), `${m} ${p}`);
    const hits = new Set(allowed.map(([m, p]) => ALLOWED_ROUTES.findIndex((r) => r.method === m && r.re.test(p.split("?")[0]!))));
    assert.equal(hits.size, ALLOWED_ROUTES.length, "each route of the list is used by an operation of the adapter");
  });
  test("everything else is refused before it reaches the network", async () => {
    for (const [m, p] of refused) assert.throws(() => authorize(m, p), (e: unknown) => e instanceof EngineError && e.kind === "invalid", `${m} ${p}`);
    const sim = new SimEngine();
    await sim.start();
    try {
      const http = new AdminHttp(realEnvSettings(sim));
      for (const [m, p] of refused) await assert.rejects(http.call("eu", m, p), EngineError);
      assert.deepEqual(sim.seen, [], "nothing was sent");
      assert.equal(sim.unauthorized, 0);
    } finally { await sim.stop(); }
  });
  test("a database the control plane did not name is out of reach even for allowed verbs", () => {
    for (const verb of [["GET", ""], ["DELETE", ""], ["POST", "/fork"], ["POST", "/restore"], ["PUT", "/keep-awake"]] as const) {
      assert.throws(() => authorize(verb[0], `/v1/databases/customers${verb[1]}`), EngineError);
    }
  });
  test("every call the adapter makes in a full run is on the list", async () => {
    const { sim, engine, stop } = await start();
    try {
      await runEverything(engine, sim);
      assert.ok(sim.seen.length > 20);
      // With the query string as sent (a route may require one: the unblock's `?database=`).
      for (const line of sim.seenQueries) { const [m, p] = line.split(" ") as [string, string]; assert.doesNotThrow(() => authorize(m, p), line); }
    } finally { await stop(); }
  });
});

function realEnvSettings(sim: SimEngine) {
  return loadConfig(realEnv({ eu: sim })).engine!;
}

async function start(over: Record<string, string | undefined> = {}) {
  const sim = new SimEngine();
  await sim.start();
  const { engine, cfg } = makeReal({ "eu-central-1": sim }, { REGIONS: "eu-central-1", ENGINE_ADMIN_ENDPOINTS: sim.url, ...over });
  return { sim, engine, cfg, stop: () => sim.stop() };
}

async function runEverything(engine: EngineClient, sim: SimEngine): Promise<void> {
  const a = randomUUID(), b = randomUUID();
  await engine.createDatabase({ id: a, workspaceId: WS, name: "a", region: "eu-central-1", idempotencyKey: randomUUID() });
  sim.write(engineName(a), ["one", "two"]);
  await engine.getDatabase(a);
  await engine.forkDatabase({ sourceId: a, id: b, workspaceId: WS, name: "b", idempotencyKey: randomUUID() });
  sim.takePoint(engineName(a), Date.now() - 5000);
  await engine.restoreDatabase({ id: a, at: new Date(Date.now() - 1000).toISOString(), idempotencyKey: randomUUID() });
  await engine.setKeepAwake({ id: a, enabled: true });
  await engine.setKeepAwake({ id: a, enabled: false });
  await engine.usage({ id: a, from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString() });
  await engine.setIpAllowlist({ id: a, entries: ["10.0.0.0/8"] });
  await engine.getIpAllowlist(a);
  await engine.setIpAllowlist({ id: a, entries: [] });
  await engine.networkBlocks(a);
  await engine.unblockAddress({ id: a, ip: "203.0.113.9" });
  await engine.trustedNetworks("eu-central-1");
  const e = await engine.exportDatabases({ ids: [a, b], idempotencyKey: randomUUID() });
  const link = await engine.exportDownloadUrl(e.exportId, 900);
  assert.ok(link.url.startsWith("https://api.fenvix.test/v1/downloads/"));
  await collect((await engine.openExportArchive!(e.exportId)).body);
  await engine.eraseDatabase({ id: a, idempotencyKey: randomUUID() }).catch(() => undefined); // has a fork: refused
  await engine.eraseDatabase({ id: b, idempotencyKey: randomUUID() });
  await engine.eraseDatabase({ id: a, idempotencyKey: randomUUID() });
}

/** The behaviour the control plane relies on, run against the fake and against the real adapter over the simulated engine. */
const drivers: { name: string; make: () => Promise<{ engine: EngineClient; stop: () => Promise<void> }> }[] = [
  { name: "fake", make: async () => ({ engine: new FakeEngine(), stop: async () => {} }) },
  { name: "real over the simulated engine", make: async () => { const s = await start(); return { engine: s.engine, stop: s.stop }; } },
];
for (const d of drivers) {
  describe(`contract: ${d.name}`, () => {
    let engine: EngineClient, stop: () => Promise<void>;
    before(async () => { ({ engine, stop } = await d.make()); });
    after(async () => { await stop(); });
    const mk = (id = randomUUID()) => ({ id, workspaceId: WS, name: "orders", region: "eu-central-1", idempotencyKey: randomUUID() });

    test("create makes an empty asleep database; creating the same id again gives the same one", async () => {
      const r = mk();
      const first = await engine.createDatabase(r);
      assert.equal(first.id, r.id);
      assert.equal(first.state, "asleep");
      assert.equal(first.storageBytes, 0);
      assert.equal(first.forkedFrom, null);
      const again = await engine.createDatabase({ ...r, idempotencyKey: randomUUID() });
      assert.equal(again.id, r.id);
      assert.equal((await engine.getDatabase(r.id))?.id, r.id);
    });
    test("get of an unknown id is null", async () => assert.equal(await engine.getDatabase(randomUUID()), null));
    test("fork gives an asleep copy that remembers its source; an unknown source is not_found", async () => {
      const src = mk();
      await engine.createDatabase(src);
      const id = randomUUID();
      const f = await engine.forkDatabase({ sourceId: src.id, id, workspaceId: WS, name: "copy", idempotencyKey: randomUUID() });
      assert.equal(f.forkedFrom, src.id);
      assert.equal(f.keepAwake, false);
      assert.equal(await kindOf(engine.forkDatabase({ sourceId: randomUUID(), id: randomUUID(), workspaceId: WS, name: "x", idempotencyKey: randomUUID() })), "not_found");
    });
    test("keep awake pins and unpins, and repeating changes nothing", async () => {
      const r = mk();
      await engine.createDatabase(r);
      assert.equal((await engine.setKeepAwake({ id: r.id, enabled: true })).keepAwake, true);
      assert.equal((await engine.setKeepAwake({ id: r.id, enabled: true })).keepAwake, true);
      assert.equal((await engine.setKeepAwake({ id: r.id, enabled: true })).state, "awake");
      assert.equal((await engine.setKeepAwake({ id: r.id, enabled: false })).keepAwake, false);
      assert.equal((await engine.setKeepAwake({ id: r.id, enabled: false })).keepAwake, false);
      assert.equal(await kindOf(engine.setKeepAwake({ id: randomUUID(), enabled: true })), "not_found");
    });
    test("erase removes it; erasing what is gone is { erased: false }, not an error", async () => {
      const r = mk();
      await engine.createDatabase(r);
      assert.deepEqual(await engine.eraseDatabase({ id: r.id, idempotencyKey: "k1" }), { erased: true });
      assert.equal(await engine.getDatabase(r.id), null);
      assert.deepEqual(await engine.eraseDatabase({ id: r.id, idempotencyKey: "k2" }), { erased: false });
      assert.deepEqual(await engine.eraseDatabase({ id: randomUUID(), idempotencyKey: "k3" }), { erased: false });
    });
    test("usage has the shape the sync needs; an unknown id is not_found", async () => {
      const r = mk();
      await engine.createDatabase(r);
      const u = await engine.usage({ id: r.id, from: new Date(Date.now() - 86400000).toISOString(), to: new Date().toISOString() });
      assert.ok(["awake", "asleep"].includes(u.state));
      assert.equal(typeof u.storageBytes, "number");
      assert.ok(Array.isArray(u.buckets) && Array.isArray(u.wakeUps));
      assert.ok(!Number.isNaN(Date.parse(u.lastActiveAt)));
      assert.equal(await kindOf(engine.usage({ id: randomUUID(), from: new Date().toISOString(), to: new Date().toISOString() })), "not_found");
    });
    test("restore of an unknown id is not_found; export of an unknown id is not_found", async () => {
      assert.equal(await kindOf(engine.restoreDatabase({ id: randomUUID(), at: new Date().toISOString(), idempotencyKey: "r" })), "not_found");
      assert.equal(await kindOf(engine.exportDatabases({ ids: [randomUUID()], idempotencyKey: "e" })), "not_found");
    });
    test("IP allowlist: none after create; set and read back in the engine's form; an empty list clears it; a fork has none; gone with an erase", async () => {
      const r = mk();
      await engine.createDatabase(r);
      assert.deepEqual((await engine.getIpAllowlist(r.id)).entries, []);
      const set = await engine.setIpAllowlist({ id: r.id, entries: ["10.0.0.0/8", "203.0.113.7/32"] });
      assert.deepEqual(set.entries, ["10.0.0.0/8", "203.0.113.7/32"]);
      assert.equal(set.enforced, true);
      assert.deepEqual((await engine.getIpAllowlist(r.id)).entries, ["10.0.0.0/8", "203.0.113.7/32"]);
      const f = randomUUID();
      await engine.forkDatabase({ sourceId: r.id, id: f, workspaceId: WS, name: "copy", idempotencyKey: randomUUID() });
      assert.deepEqual((await engine.getIpAllowlist(f)).entries, [], "a fork does not inherit the list");
      assert.deepEqual((await engine.getIpAllowlist(r.id)).entries, ["10.0.0.0/8", "203.0.113.7/32"]);
      assert.deepEqual((await engine.setIpAllowlist({ id: r.id, entries: [] })).entries, []);
      assert.deepEqual((await engine.getIpAllowlist(r.id)).entries, []);
      await engine.setIpAllowlist({ id: f, entries: ["192.0.2.0/24"] });
      await engine.eraseDatabase({ id: f, idempotencyKey: randomUUID() });
      assert.equal(await kindOf(engine.getIpAllowlist(f)), "not_found");
      assert.equal(await kindOf(engine.setIpAllowlist({ id: randomUUID(), entries: [] })), "not_found");
      assert.equal(await kindOf(engine.setIpAllowlist({ id: r.id, entries: ["10.0.0.1/8"] })), "invalid");
      assert.deepEqual(await engine.trustedNetworks("eu-central-1"), ["127.0.0.0/8", "::1/128"]);
    });
  });
}

describe("real adapter: IP allowlist and network blocks", () => {
  let sim: SimEngine, engine: EngineClient, stop: () => Promise<void>;
  before(async () => { ({ sim, engine, stop } = await start()); });
  after(async () => { await stop(); });
  const mk = () => ({ id: randomUUID(), workspaceId: WS, name: "orders", region: "eu-central-1", idempotencyKey: randomUUID() });

  test("an empty list is sent as DELETE, so the record carries no list; a list as PUT { entries }", async () => {
    const r = mk();
    await engine.createDatabase(r);
    sim.seen.length = 0;
    await engine.setIpAllowlist({ id: r.id, entries: ["10.0.0.0/8"] });
    await engine.setIpAllowlist({ id: r.id, entries: [] });
    assert.deepEqual(sim.seen, [`PUT /v1/databases/${engineName(r.id)}/ip-allowlist`, `DELETE /v1/databases/${engineName(r.id)}/ip-allowlist`]);
    assert.equal(sim.dbs.get(engineName(r.id))!.allowlist, null);
  });

  test("unblock: only the pair (address, this database); the same address on another database and its address-wide block stay", async () => {
    const r = mk(), o = mk();
    await engine.createDatabase(r);
    await engine.createDatabase(o);
    const until = new Date(Date.now() + 300_000).toISOString();
    sim.blocked.push(
      { ip: "203.0.113.9", database: engineName(r.id), until, remaining_secs: 300, strike: 1 },
      { ip: "203.0.113.9", database: engineName(o.id), until, remaining_secs: 300, strike: 1 },
      { ip: "203.0.113.9", database: null, until, remaining_secs: 300, strike: 1 },
    );
    try {
      sim.seenQueries.length = 0;
      assert.deepEqual(await engine.unblockAddress({ id: r.id, ip: "203.0.113.9" }), { unblocked: true });
      assert.deepEqual(sim.seenQueries, [`DELETE /v1/network/blocks/203.0.113.9?database=${engineName(r.id)}`]);
      assert.deepEqual(await engine.networkBlocks(r.id), []);
      assert.deepEqual((await engine.networkBlocks(o.id)).map((b) => b.ip), ["203.0.113.9"], "the other database stays blocked");
      assert.ok(sim.blocked.some((b) => b.ip === "203.0.113.9" && b.database === null), "the address-wide block stays");
      assert.deepEqual(await engine.unblockAddress({ id: r.id, ip: "203.0.113.9" }), { unblocked: false }, "nothing left on this database");
    } finally { sim.blocked.length = 0; }
  });

  test("unblock: an engine that ignores ?database= (older than engine-round2) is reported, never taken for a per-database unblock", async () => {
    const r = mk();
    await engine.createDatabase(r);
    sim.blocked.push({ ip: "203.0.113.9", database: engineName(r.id), until: new Date(Date.now() + 300_000).toISOString(), remaining_secs: 300, strike: 1 });
    sim.unblockIgnoresDatabase = true;
    try {
      assert.equal(await kindOf(engine.unblockAddress({ id: r.id, ip: "203.0.113.9" })), "unavailable");
    } finally { sim.blocked.length = 0; sim.unblockIgnoresDatabase = false; }
  });

  test("blocks: only this database's, only the address and its end; nothing of other databases, counters or connections", async () => {
    const r = mk(), o = mk();
    await engine.createDatabase(r);
    await engine.createDatabase(o);
    const until = new Date(Date.now() + 300_000).toISOString();
    sim.blocked.push(
      { ip: "203.0.113.9", database: engineName(r.id), until, remaining_secs: 300, strike: 1 },
      { ip: "2001:db8:1:2::/64", database: engineName(r.id), until, remaining_secs: 299, strike: 2 },
      { ip: "198.51.100.1", database: engineName(o.id), until, remaining_secs: 300, strike: 1 },
      { ip: "192.0.2.77", database: null, until, remaining_secs: 300, strike: 1 },
    );
    try {
      assert.deepEqual(await engine.networkBlocks(r.id), [
        { ip: "203.0.113.9", until, remainingSecs: 300 },
        { ip: "2001:db8:1:2::/64", until, remainingSecs: 299 },
      ]);
      sim.seen.length = 0;
      sim.seenQueries.length = 0;
      assert.deepEqual(await engine.unblockAddress({ id: r.id, ip: "2001:db8:1:2::/64" }), { unblocked: true });
      assert.deepEqual(sim.seen, ["DELETE /v1/network/blocks/2001:db8:1:2::"], "an IPv6 /64 is lifted by its address");
      assert.deepEqual(sim.seenQueries, [`DELETE /v1/network/blocks/2001:db8:1:2::?database=${engineName(r.id)}`], "on this database only");
      assert.deepEqual(await engine.unblockAddress({ id: r.id, ip: "203.0.113.9" }), { unblocked: true });
      assert.deepEqual(await engine.networkBlocks(r.id), []);
      assert.equal(await kindOf(engine.unblockAddress({ id: r.id, ip: "10.0.0.0/8" })), "invalid");
      assert.equal(await kindOf(engine.unblockAddress({ id: r.id, ip: "../admin" })), "invalid");
    } finally { sim.blocked.length = 0; }
  });

  test("a list the engine refuses is invalid, in our words (the engine's sentence is kept for the log only)", async () => {
    const r = mk();
    await engine.createDatabase(r);
    sim.failNext(/ip-allowlist$/, 400, "invalid_allowlist");
    const e = await engine.setIpAllowlist({ id: r.id, entries: ["10.0.0.0/8"] }).catch((x) => x);
    assert.ok(e instanceof EngineError && e.kind === "invalid");
    assert.equal(e.message, "The database engine refused the list.");
    sim.failNext(/ip-allowlist$/, 503, "internal");
    assert.equal(await kindOf(engine.setIpAllowlist({ id: r.id, entries: ["10.0.0.0/8"] })), "unavailable");
    sim.failNext(/network$/, 401, "unauthorized");
    assert.equal(await kindOf(engine.networkBlocks(r.id)), "unavailable");
  });
});

describe("real adapter", () => {
  let sim: SimEngine, engine: EngineClient, stop: () => Promise<void>, cfg: ReturnType<typeof loadConfig>;
  const mk = (id = randomUUID()) => ({ id, workspaceId: WS, name: "orders", region: "eu-central-1", idempotencyKey: randomUUID() });
  beforeEach(async () => { ({ sim, engine, stop, cfg } = await start()); });
  const done = async () => { await stop(); };

  test("create asks the engine for the derived name, and only that", async () => {
    try {
      const r = mk();
      const d = await engine.createDatabase(r);
      assert.deepEqual([...sim.dbs.keys()], [engineName(r.id)]);
      assert.equal(d.workspaceId, WS);
      assert.equal(d.name, "orders");
      assert.equal(d.region, "eu-central-1");
      assert.deepEqual(sim.seen, ["POST /v1/databases"]);
    } finally { await done(); }
  });

  test("a create whose answer was lost is finished by the retry, once", async () => {
    try {
      const r = mk();
      sim.loseAnswer(/^POST \/v1\/databases$/);
      assert.equal(await kindOf(engine.createDatabase(r)), "unavailable");
      assert.equal(sim.dbs.size, 1, "the engine did create it");
      const d = await engine.createDatabase(r);
      assert.equal(d.id, r.id);
      assert.equal(sim.dbs.size, 1);
    } finally { await done(); }
  });

  test("a 409 exists while the engine is still finishing the name is retried, not failed", async () => {
    try {
      sim.failNext(/^POST \/v1\/databases$/, 409, "exists");
      assert.equal(await kindOf(engine.createDatabase(mk())), "unavailable");
    } finally { await done(); }
  });

  test("a fork whose answer was lost is accepted on retry; a different database under that id is a conflict", async () => {
    try {
      const src = mk(); await engine.createDatabase(src);
      const id = randomUUID();
      const req = { sourceId: src.id, id, workspaceId: WS, name: "copy", idempotencyKey: randomUUID() };
      sim.loseAnswer(/\/fork$/);
      assert.equal(await kindOf(engine.forkDatabase(req)), "unavailable");
      assert.equal((await engine.forkDatabase(req)).forkedFrom, src.id);
      assert.equal(sim.dbs.size, 2);
      const other = mk(); await engine.createDatabase(other);
      const clash = randomUUID(); await engine.createDatabase(mk(clash)); // exists, not a fork of `other`
      assert.equal(await kindOf(engine.forkDatabase({ sourceId: other.id, id: clash, workspaceId: WS, name: "c", idempotencyKey: randomUUID() })), "conflict");
    } finally { await done(); }
  });

  test("fork mode comes from configuration; a copy the engine refuses is a conflict", async () => {
    try {
      const src = mk(); await engine.createDatabase(src);
      const id = randomUUID();
      await engine.forkDatabase({ sourceId: src.id, id, workspaceId: WS, name: "c", idempotencyKey: "k" });
      assert.equal(sim.dbs.get(engineName(id))!.forkedFrom!.mode, "clone");
    } finally { await done(); }
    const c = await start({ ENGINE_FORK_MODE: "copy" });
    try {
      const src = mk(); await c.engine.createDatabase(src);
      const id = randomUUID();
      await c.engine.forkDatabase({ sourceId: src.id, id, workspaceId: WS, name: "c", idempotencyKey: "k" });
      assert.equal(c.sim.dbs.get(engineName(id))!.forkedFrom!.mode, "copy");
      c.sim.failNext(/\/fork$/, 409, "source_is_shallow_fork");
      assert.equal(await kindOf(c.engine.forkDatabase({ sourceId: id, id: randomUUID(), workspaceId: WS, name: "d", idempotencyKey: "k2" })), "conflict");
    } finally { await c.stop(); }
  });

  test("erase of a database that others were cloned from is a conflict until they are gone", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      const f = randomUUID();
      await engine.forkDatabase({ sourceId: a.id, id: f, workspaceId: WS, name: "f", idempotencyKey: "k" });
      assert.equal(await kindOf(engine.eraseDatabase({ id: a.id, idempotencyKey: "e1" })), "conflict");
      assert.equal(sim.dbs.size, 2);
      assert.deepEqual(await engine.eraseDatabase({ id: f, idempotencyKey: "e2" }), { erased: true });
      assert.deepEqual(await engine.eraseDatabase({ id: a.id, idempotencyKey: "e3" }), { erased: true });
    } finally { await done(); }
  });

  test("busy and failing engines are retried (unavailable); an unknown conflict is a conflict", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      for (const code of ["busy", "owned_elsewhere", "operation_in_progress", "transactions_open"]) {
        sim.failNext(/keep-awake/, 409, code);
        assert.equal(await kindOf(engine.setKeepAwake({ id: a.id, enabled: true })), "unavailable", code);
      }
      for (const status of [500, 502, 503]) {
        sim.failNext(/keep-awake/, status, "internal");
        assert.equal(await kindOf(engine.setKeepAwake({ id: a.id, enabled: true })), "unavailable", String(status));
      }
      sim.failNext(/keep-awake/, 409, "something_new");
      assert.equal(await kindOf(engine.setKeepAwake({ id: a.id, enabled: true })), "conflict");
    } finally { await done(); }
  });

  test("a wrong token is refused by the engine, reported as unavailable, and appears nowhere in the error", async () => {
    try {
      const wrong = "wrong-token-0123456789";
      const { engine: bad } = makeReal({ "eu-central-1": sim }, { ENGINE_ADMIN_TOKEN: wrong });
      const e = await bad.createDatabase(mk()).catch((x) => x);
      assert.ok(e instanceof EngineError && e.kind === "unavailable");
      assert.equal(sim.unauthorized, 1);
      assert.equal(sim.dbs.size, 0);
      assert.ok(!JSON.stringify([e.message, String(e.stack)]).includes(wrong));
    } finally { await done(); }
  });

  test("an engine that is not there is unavailable and the message does not carry its address", async () => {
    try {
      const { engine: gone } = makeReal({ eu: sim }, { ENGINE_ADMIN_ENDPOINTS: "http://127.0.0.1:1", REGIONS: "eu" });
      const e = await gone.getDatabase(randomUUID()).catch((x) => x);
      assert.ok(e instanceof EngineError && e.kind === "unavailable");
      assert.ok(!e.message.includes("127.0.0.1"));
    } finally { await done(); }
  });

  test("an engine that does not answer in time is unavailable", async () => {
    try {
      const { engine: slow } = makeReal({ eu: sim }, { ENGINE_REQUEST_TIMEOUT_MS: "200", REGIONS: "eu", ENGINE_ADMIN_ENDPOINTS: sim.url });
      const hang = (await import("node:net")).createServer(() => {});
      await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
      const port = (hang.address() as { port: number }).port;
      const { engine: stuck } = makeReal({ eu: sim }, { ENGINE_REQUEST_TIMEOUT_MS: "200", REGIONS: "eu", ENGINE_ADMIN_ENDPOINTS: `http://127.0.0.1:${port}` });
      const t0 = Date.now();
      assert.equal(await kindOf(stuck.getDatabase(randomUUID())), "unavailable");
      assert.ok(Date.now() - t0 < 3000);
      hang.close(); void slow;
    } finally { await done(); }
  });

  test("an unknown region is refused for create", async () => {
    try { assert.equal(await kindOf(engine.createDatabase({ ...mk(), region: "mars-1" })), "invalid"); assert.equal(sim.seen.length, 0); } finally { await done(); }
  });

  test("listing by workspace is not offered", async () => {
    try { assert.equal(await kindOf(engine.listDatabases(WS)), "invalid"); assert.equal(sim.seen.length, 0); } finally { await done(); }
  });

  test("restore: needs history; goes back to a point; refuses times outside it in our words", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      // retention was never switched on (no ENGINE_RETENTION_WINDOW_SECS): the engine has nothing to go back to
      const none = await engine.restoreDatabase({ id: a.id, at: new Date().toISOString(), idempotencyKey: "r" }).catch((x) => x);
      assert.ok(none instanceof EngineError && none.kind === "invalid" && /no backup/i.test(none.message), String(none.message));
      // with a window configured, create and fork switch it on
    } finally { await done(); }
    const c = await start({ ENGINE_RETENTION_WINDOW_SECS: "3600", ENGINE_RETENTION_INTERVAL_SECS: "60" });
    try {
      const a = mk(); await c.engine.createDatabase(a);
      const key = engineName(a.id);
      assert.deepEqual(c.sim.dbs.get(key)!.retention, { window_secs: 3600, interval_secs: 60 });
      const f = randomUUID();
      await c.engine.forkDatabase({ sourceId: a.id, id: f, workspaceId: WS, name: "f", idempotencyKey: "k" });
      assert.equal(c.sim.dbs.get(engineName(f))!.retention!.window_secs, 3600);
      c.sim.write(key, ["before-1", "before-2"]);
      c.sim.takePoint(key, Date.now() - 60_000);
      c.sim.write(key, ["after"]);
      const at = new Date(Date.now() - 30_000).toISOString();
      const r = await c.engine.restoreDatabase({ id: a.id, at, idempotencyKey: "r1" });
      assert.deepEqual(c.sim.dbs.get(key)!.docs, ["before-1", "before-2"]);
      assert.equal(r.restoredTo, new Date(at).toISOString());
      assert.ok(r.earliestRestorePoint, "the earliest restorable time is reported");
      const early = await c.engine.restoreDatabase({ id: a.id, at: new Date(Date.now() - 86_400_000).toISOString(), idempotencyKey: "r2" }).catch((x) => x);
      assert.ok(early instanceof EngineError && early.kind === "invalid" && /earliest restorable/.test(early.message), String(early.message));
      const future = await c.engine.restoreDatabase({ id: a.id, at: new Date(Date.now() + 3_600_000).toISOString(), idempotencyKey: "r3" }).catch((x) => x);
      assert.ok(future instanceof EngineError && future.kind === "invalid" && future.message === "Choose a time in the past.", String(future.message));
      // the engine's own retry finished it: that is a restore that worked
      c.sim.failNext(/\/restore$/, 500, "restore_retried");
      assert.equal((await c.engine.restoreDatabase({ id: a.id, at, idempotencyKey: "r4" })).restoredTo, at);
      // lost history is not retried
      c.sim.failNext(/\/restore$/, 409, "retention_gap");
      assert.equal(await kindOf(c.engine.restoreDatabase({ id: a.id, at, idempotencyKey: "r5" })), "invalid");
      c.sim.failNext(/\/restore$/, 409, "transactions_open");
      assert.equal(await kindOf(c.engine.restoreDatabase({ id: a.id, at, idempotencyKey: "r6" })), "unavailable");
    } finally { await c.stop(); }
  });

  test("a bad request of our own is never shown to the customer as advice", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      sim.failNext(/keep-awake/, 400, "bad_request");
      const e = await engine.setKeepAwake({ id: a.id, enabled: true }).catch((x) => x);
      assert.ok(e instanceof EngineError && e.kind === "invalid");
      assert.equal(e.message, "The database engine refused the request.");
    } finally { await done(); }
  });

  test("usage: the engine's days become buckets at 00:00 UTC, with wake-ups, inside [from, to)", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      const key = engineName(a.id);
      const day = (back: number) => new Date(Date.UTC(2026, 9, 28 - back)).toISOString().slice(0, 10);
      const d = sim.dbs.get(key)!;
      d.docs.push("xxxxxxxxxx");
      d.usage.set(day(0), { commands: 40, wakes: [{ at_ms: Date.UTC(2026, 9, 28, 6, 30), first_request_latency_ms: 123 }, { at_ms: Date.UTC(2026, 9, 28, 20, 0), first_request_latency_ms: 9 }] });
      d.usage.set(day(1), { commands: 7, wakes: [] });
      d.usage.set(day(5), { commands: 999, wakes: [] });
      const u = await engine.usage({ id: a.id, from: "2026-10-27T00:00:00.000Z", to: "2026-10-28T12:00:00.000Z" });
      assert.deepEqual(u.buckets.map((b) => [b.hour, b.requests, b.storageBytes]), [["2026-10-27T00:00:00.000Z", 7, 10], ["2026-10-28T00:00:00.000Z", 40, 10]]);
      assert.deepEqual(u.wakeUps, [{ at: "2026-10-28T06:30:00.000Z", firstRequestMs: 123 }]);
      assert.equal(u.storageBytes, 10);
      assert.equal(u.state, "asleep");
    } finally { await done(); }
  });

  test("export: one zip of every database's dump files, behind a signed link", async () => {
    try {
      const a = mk(), b = mk();
      await engine.createDatabase(a); await engine.createDatabase(b);
      sim.write(engineName(a.id), ["alpha-1", "alpha-2"], "orders");
      sim.write(engineName(b.id), ["beta-1"], "users");
      const e = await engine.exportDatabases({ ids: [a.id, b.id], idempotencyKey: "same-key" });
      assert.equal(e.mimeType, "application/zip");
      assert.match(e.filename, /^fenvix-export-2-databases\.zip$/);
      assert.equal(sim.exports.size, 2);
      assert.deepEqual(await engine.exportDatabases({ ids: [a.id, b.id], idempotencyKey: "same-key" }), e, "a retry in the same process is the same export");
      assert.equal(sim.exports.size, 2, "and made no second snapshot");

      const link = await engine.exportDownloadUrl(e.exportId, 900);
      const claim = verifyDownload(cfg.downloadSigningKey, link.url.split("/downloads/")[1]!);
      assert.equal(claim!.kind, "engine-export");
      assert.equal(claim!.p.exportId, e.exportId);
      assert.ok(Math.abs(Date.parse(link.expiresAt) - (Date.now() + 900_000)) < 5000);

      const arch = await engine.openExportArchive!(e.exportId);
      assert.equal(arch.mimeType, "application/zip");
      const files = unzip(await text(arch.body));
      const na = engineName(a.id), nb = engineName(b.id);
      assert.deepEqual(files.map((f) => f.name).sort(), [`${na}/orders.bson`, `${na}/orders.metadata.json`, `${nb}/users.bson`, `${nb}/users.metadata.json`].sort());
      assert.equal(files.find((f) => f.name === `${na}/orders.bson`)!.data.toString(), "alpha-1\nalpha-2\n");
      const { crc32 } = await import("node:zlib");
      for (const f of files) assert.equal(crc32(f.data), f.crc, f.name);
    } finally { await done(); }
  });

  test("export: a transfer that breaks off is continued from where it stopped, and the file is whole", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      const key = engineName(a.id);
      const docs = Array.from({ length: 200 }, (_, i) => `document-number-${i}`);
      sim.write(key, docs, "big");
      const e = await engine.exportDatabases({ ids: [a.id], idempotencyKey: "k" });
      const path = `/v1/exports/${e.exportId}/files/${key}/big.bson`;
      sim.breakDownload(path.replace("/v1/exports/", "/v1/exports/"), 300, 2);
      const files = unzip(await text((await engine.openExportArchive!(e.exportId)).body));
      assert.equal(files.find((f) => f.name.endsWith("big.bson"))!.data.toString(), docs.join("\n") + "\n");
      const ranges = sim.seen.filter((l) => l.includes("/files/") && l.endsWith("big.bson"));
      assert.equal(ranges.length, 3, "two breaks, three requests");
    } finally { await done(); }
  });

  test("export: more breaks than the adapter will resume ends in unavailable, never a silently short file", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      const key = engineName(a.id);
      sim.write(key, Array.from({ length: 100 }, (_, i) => `doc-${i}-xxxxxxxxxxxxxxxx`), "big");
      const e = await engine.exportDatabases({ ids: [a.id], idempotencyKey: "k" });
      sim.breakDownload(`/v1/exports/${e.exportId}/files/${key}/big.bson`, 50, 100);
      assert.equal(await kindOf(text((await engine.openExportArchive!(e.exportId)).body)), "unavailable");
    } finally { await done(); }
  });

  test("export: an expired snapshot is not_found when the link is made and when the archive is opened", async () => {
    try {
      const a = mk(); await engine.createDatabase(a);
      sim.write(engineName(a.id), ["x"]);
      const e = await engine.exportDatabases({ ids: [a.id], idempotencyKey: "k" });
      for (const x of sim.exports.values()) x.expiresMs = Date.now() - 1000;
      assert.equal(await kindOf(engine.exportDownloadUrl(e.exportId, 900)), "not_found");
      assert.equal(await kindOf(engine.openExportArchive!(e.exportId)), "not_found");
      assert.equal(await kindOf(engine.openExportArchive!("orders.0123456789abcdef")), "not_found");
      assert.equal(await kindOf(engine.openExportArchive!("")), "not_found");
    } finally { await done(); }
  });

  test("export: an id that is not ours is refused without a request", async () => {
    try {
      const before = sim.seen.length;
      assert.equal(await kindOf(engine.exportDownloadUrl("db_nothex.0123456789abcdef", 900)), "not_found");
      assert.equal(await kindOf(engine.openExportArchive!("customers.0123456789abcdef,db_x.1")), "not_found");
      assert.equal(sim.seen.length, before);
    } finally { await done(); }
  });
});

describe("real adapter with more than one region", () => {
  test("each database is created where asked and found again by id alone; unreachable is not the same as absent", async () => {
    const eu = new SimEngine(), us = new SimEngine();
    await eu.start(); await us.start();
    try {
      const { engine } = makeReal({ "eu-central-1": eu, "us-east-1": us });
      const id = randomUUID();
      await engine.createDatabase({ id, workspaceId: WS, name: "x", region: "us-east-1", idempotencyKey: "k" });
      assert.equal(eu.dbs.size, 0);
      assert.equal(us.dbs.size, 1);
      const { engine: fresh } = makeReal({ "eu-central-1": eu, "us-east-1": us }); // nothing remembered: it has to ask
      assert.equal((await fresh.getDatabase(id))?.region, "us-east-1");
      assert.equal((await fresh.setKeepAwake({ id, enabled: true })).region, "us-east-1");
      const f = randomUUID();
      const fork = await fresh.forkDatabase({ sourceId: id, id: f, workspaceId: WS, name: "y", idempotencyKey: "k2" });
      assert.equal(fork.region, "us-east-1");
      assert.equal(eu.dbs.size, 0, "a fork is made in the region of its source");
      assert.equal(await (await makeReal({ "eu-central-1": eu, "us-east-1": us }).engine).getDatabase(randomUUID()), null);
      assert.deepEqual(await fresh.eraseDatabase({ id: randomUUID(), idempotencyKey: "e" }), { erased: false });
      eu.failNext(/^GET/, 503, "internal", 5);
      const { engine: partial } = makeReal({ "eu-central-1": eu, "us-east-1": us });
      assert.equal(await kindOf(partial.getDatabase(randomUUID())), "unavailable", "one region could not answer: not 'nowhere'");
      assert.equal(await kindOf(partial.eraseDatabase({ id: randomUUID(), idempotencyKey: "e2" })), "unavailable");
    } finally { await eu.stop(); await us.stop(); }
  });
});

describe("real adapter over TLS, with certificates from configuration", () => {
  /** A throw-away CA-less self-signed certificate for 127.0.0.1 and `engine.test`, made with openssl at test time. */
  function selfSigned(): { key: string; cert: string; dir: string } | null {
    const dir = mkdtempSync(join(tmpdir(), "tls-"));
    const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=engine.test", "-addext", "subjectAltName=DNS:engine.test,IP:127.0.0.1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { encoding: "utf8" });
    if (r.status !== 0) return null;
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8"), dir };
  }

  test("trusted through ENGINE_ADMIN_CA_FILE; refused without it; refused for the wrong name", async (t) => {
    const pair = selfSigned();
    if (!pair) return t.skip("openssl is not available");
    const sim = new SimEngine("sim-admin-token-0123456789", pair);
    await sim.start();
    try {
      const id = randomUUID();
      const req = { id, workspaceId: WS, name: "tls", region: "eu-central-1", idempotencyKey: "k" };
      const caFile = join(pair.dir, "c.pem");
      const trusted = makeReal({ "eu-central-1": sim }, { ENGINE_ADMIN_CA_FILE: caFile }).engine;
      assert.equal((await trusted.createDatabase(req)).id, id);
      assert.equal(sim.dbs.size, 1);
      const untrusted = makeReal({ "eu-central-1": sim }).engine;
      assert.equal(await kindOf(untrusted.getDatabase(id)), "unavailable", "a certificate nobody vouches for is not accepted");
      const wrongName = makeReal({ "eu-central-1": sim }, { ENGINE_ADMIN_CA_FILE: caFile, ENGINE_ADMIN_TLS_SERVER_NAME: "other.test" }).engine;
      assert.equal(await kindOf(wrongName.getDatabase(id)), "unavailable");
      const rightName = makeReal({ "eu-central-1": sim }, { ENGINE_ADMIN_CA_FILE: caFile, ENGINE_ADMIN_TLS_SERVER_NAME: "engine.test" }).engine;
      assert.equal((await rightName.getDatabase(id))?.id, id);
    } finally { await sim.stop(); }
  });
});
