import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { type Fixture, type Harness, json, sleep, startHarness } from "../helpers/harness.ts";
import { MongoDataClient } from "../../src/engine/data-mongo.ts";
import { engineName } from "../../src/engine/names.ts";

/**
 * Optional: the Data Explorer against a REAL FENVIX engine (Mircoguidetti/test5, branch merge-engine), through the
 * official driver. Skipped unless DATA_ENGINE_TEST_ENDPOINT names its MongoDB listener (host:port), for example:
 *
 *   ./target/release/mongo-server --listen 127.0.0.1:27018 --store local --local-dir /tmp/store --idle-secs 5
 *   DATA_ENGINE_TEST_ENDPOINT=127.0.0.1:27018 DATA_ENGINE_TEST_IDLE_SECS=5 node --test tests/integration/explorer-real-engine.test.ts
 *
 * merge-engine has no authentication and no TLS, so by default this runs with DATA_ENGINE_INSECURE_LOCAL=true (development
 * only). Against an engine with SCRAM and TLS (branch compat-gaps: --auth --tls-mode requireTLS) set
 * DATA_ENGINE_TEST_USERNAME, DATA_ENGINE_TEST_PASSWORD_FILE and DATA_ENGINE_TEST_TLS_CA_FILE: the control plane then
 * connects exactly as in production (TLS required, SCRAM-SHA-256).
 * The admin side (create database) uses the fake engine: merge-engine has no admin interface, and the engine creates a
 * database on its first write anyway.
 */
const endpoint = process.env.DATA_ENGINE_TEST_ENDPOINT;
const idleSecs = Number(process.env.DATA_ENGINE_TEST_IDLE_SECS ?? "0");
const user = process.env.DATA_ENGINE_TEST_USERNAME;
const passwordFile = process.env.DATA_ENGINE_TEST_PASSWORD_FILE;
const caFile = process.env.DATA_ENGINE_TEST_TLS_CA_FILE;
const secure = !!(user && passwordFile && caFile);
const connection = secure
  ? { DATA_ENGINE_USERNAME: user, DATA_ENGINE_PASSWORD_FILE: passwordFile, DATA_ENGINE_TLS: "true", DATA_ENGINE_TLS_CA_FILE: caFile }
  : { DATA_ENGINE_INSECURE_LOCAL: "true", DATA_ENGINE_TLS: "false" };
const cookie = { origin: "https://app.fenvix.test" };
const enc = encodeURIComponent;

describe("Data Explorer against the real engine", { skip: endpoint ? false : "set DATA_ENGINE_TEST_ENDPOINT to run against a real engine" }, () => {
  let h: Harness;
  let client: MongoDataClient;
  let direct: MongoClient;
  let a: Fixture;
  let b: Fixture;
  let aDb = "";
  let bDb = "";
  const docs = (db: string, c = "items") => `/databases/${db}/data/collections/${c}/documents`;

  before(async () => {
    h = await startHarness({
      RATE_LIMIT_PER_MINUTE: "100000", DATA_RATE_LIMIT_PER_MINUTE: "100000", DATA_WRITE_RATE_LIMIT_PER_MINUTE: "100000",
      DATA_ENGINE_ENDPOINTS: endpoint, ...connection, DATA_COMMAND_TIMEOUT_MS: "15000",
      DATA_ENGINE_CLIENT_IDLE_CLOSE_MS: "2000",
    }, { dataFactory: (cfg) => (client = new MongoDataClient(cfg.data)) });
    direct = new MongoClient(`mongodb://${endpoint}/`, { directConnection: true, ...(secure ? { tls: true, tlsCAFile: caFile, auth: { username: user, password: readFileSync(passwordFile!, "utf8").trim() }, authSource: "admin" } : {}) });
    a = await h.user("Real A");
    b = await h.user("Real B");
    aDb = json(await h.as(a).post("/databases", { name: "real-a", region: "eu-central-1" }, cookie)).id;
    bDb = json(await h.as(b).post("/databases", { name: "real-b", region: "eu-central-1" }, cookie)).id;
  });
  after(async () => {
    await client?.close();
    await direct?.close();
    await h?.close();
  });

  const typed = {
    _id: { $oid: "65f1a2b3c4d5e6f708192a3b" },
    int: { $numberInt: "42" }, long: { $numberLong: "9007199254740993" }, dbl: { $numberDouble: "1.5" }, dec: { $numberDecimal: "1234.5678" },
    when: { $date: { $numberLong: "1700000000000" } }, bin: { $binary: { base64: "AQIDBA==", subType: "00" } },
    uuid: { $binary: { base64: "Ej5FZ+ibEtOkVkJmFBdAAA==", subType: "04" } }, ts: { $timestamp: { t: 1700000000, i: 7 } },
    flag: true, nothing: null, text: "<script>alert('x')</script><img src=x onerror=alert(1)>", tags: ["a", "b"], nested: { k: { $numberInt: "1" } },
  };

  test("insert documents with every common type and read them back exactly (canonical Extended JSON)", async () => {
    const res = await h.as(a).post(docs(aDb), { document: typed }, cookie);
    assert.equal(res.statusCode, 201, res.body);
    for (let i = 0; i < 30; i++) {
      const r = await h.as(a).post(docs(aDb), { document: { n: i, group: i % 3 === 0 ? "x" : "y", at: { $date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString() } } }, cookie);
      assert.equal(r.statusCode, 201, r.body);
    }
    const got = await h.as(a).get(`${docs(aDb)}/${enc('{"$oid":"65f1a2b3c4d5e6f708192a3b"}')}`);
    assert.equal(got.statusCode, 200, got.body);
    assert.deepEqual(json(got).document, typed);
  });

  test("collections with estimated counts", async () => {
    const res = await h.as(a).get(`/databases/${aDb}/data/collections`);
    assert.equal(res.statusCode, 200, res.body);
    const items = json(res).items;
    const it = items.find((c: { name: string }) => c.name === "items");
    assert.ok(it, res.body);
    assert.equal(it.estimatedCount, 31);
  });

  test("filter, sort, projection and paging on the engine", async () => {
    const f = enc(JSON.stringify({ group: "x", n: { $gte: 3, $lt: 28 }, at: { $gte: { $date: "2024-01-05T00:00:00Z" } } }));
    const res = await h.as(a).get(`${docs(aDb)}?filter=${f}&sort=${enc('{"n": -1}')}&projection=${enc('{"n": 1}')}&pageSize=3`);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual(body.items.map((d: { document: { n: { $numberInt: string } } }) => d.document.n.$numberInt), ["27", "24", "21"]);
    assert.equal(body.hasMore, true);
    const p2 = json(await h.as(a).get(`${docs(aDb)}?filter=${f}&sort=${enc('{"n": -1}')}&pageSize=3&page=2`));
    assert.deepEqual(p2.items.map((d: { document: { n: { $numberInt: string } } }) => d.document.n.$numberInt), ["18", "15", "12"]);
    for (const q of [{ text: { $regex: "^<script", $options: "i" } }, { tags: { $in: ["b"] } }, { nothing: { $exists: true } }, { n: { $not: { $gt: 1 } } }, { $or: [{ n: 0 }, { n: 1 }] }]) {
      const r = await h.as(a).get(`${docs(aDb)}?filter=${enc(JSON.stringify(q))}`);
      assert.equal(r.statusCode, 200, `${JSON.stringify(q)}: ${r.body}`);
      assert.ok(json(r).items.length >= 1, `${JSON.stringify(q)} found nothing`);
    }
  });

  test("replace with version (the engine evaluates the $eq filter over every type), stale version 409, delete", async () => {
    const id = '{"$oid":"65f1a2b3c4d5e6f708192a3b"}';
    const cur = json(await h.as(a).get(`${docs(aDb)}/${enc(id)}`));
    const changed = { ...typed, int: { $numberInt: "43" } };
    const ok = await h.as(a).put(`${docs(aDb)}/${enc(id)}`, { document: changed, version: cur.version }, cookie);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(json(await h.as(a).get(`${docs(aDb)}/${enc(id)}`)).document, changed);
    const stale = await h.as(a).put(`${docs(aDb)}/${enc(id)}`, { document: typed, version: cur.version }, cookie);
    assert.equal(stale.statusCode, 409);
    const dup = await h.as(a).post(docs(aDb), { document: { _id: { $oid: "65f1a2b3c4d5e6f708192a3b" } } }, cookie);
    assert.equal(dup.statusCode, 409, dup.body);
    const del = await h.as(a).del(`${docs(aDb)}/${enc(id)}?version=${json(ok).version}`, cookie);
    assert.equal(del.statusCode, 200, del.body);
    assert.equal((await h.as(a).get(`${docs(aDb)}/${enc(id)}`)).statusCode, 404);
  });

  test("two workspaces: B sees only B, cannot reach A's database, and the engine holds them apart", async () => {
    assert.equal((await h.as(b).post(docs(bDb), { document: { owner: "B" } }, cookie)).statusCode, 201);
    assert.equal((await h.as(b).get(docs(aDb))).statusCode, 404);
    assert.equal((await h.as(b).get(`/databases/${aDb}/data/collections`)).statusCode, 404);
    assert.equal((await h.as(b).post(docs(aDb), { document: { owner: "B-in-A" } }, cookie)).statusCode, 404);
    const bItems = json(await h.as(b).get(docs(bDb))).items;
    assert.deepEqual(bItems.map((d: { document: { owner: string } }) => d.document.owner), ["B"]);
    // Directly in the engine: two databases with the names derived from the ids, and nothing of B's in A's.
    assert.equal(await direct.db(engineName(bDb)).collection("items").countDocuments({}), 1);
    assert.equal(await direct.db(engineName(aDb)).collection("items").countDocuments({ owner: { $exists: true } }), 0);
  });

  test("the connection is the one configured (TLS and SCRAM when set)", { skip: secure ? false : "plain local engine" }, () => {
    const o = client.options();
    assert.equal(o.tls, true);
    assert.equal(o.authMechanism, "SCRAM-SHA-256");
  });

  test("hostile filters are refused before they reach the engine", async () => {
    const r = await h.as(a).get(`${docs(aDb)}?filter=${enc('{"$where": "sleep(5000) || true"}')}`);
    assert.equal(r.statusCode, 400);
  });

  test("a sleeping database is woken by the next request; the idle client is closed", { skip: idleSecs > 0 ? false : "set DATA_ENGINE_TEST_IDLE_SECS to the engine's --idle-secs" }, async () => {
    await sleep((idleSecs + 3) * 1000);
    assert.deepEqual(client.openRegions(), [], "no connection was kept open to the engine while idle");
    const started = Date.now();
    const res = await h.as(a).get(docs(aDb));
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(json(res).items.length > 0);
    console.log(`first request after sleep: ${Date.now() - started} ms`);
  });
});

describe("Data Explorer against the real engine with wrong credentials", { skip: endpoint && secure ? false : "needs a real engine with SCRAM (DATA_ENGINE_TEST_USERNAME, ...)" }, () => {
  test("wrong password: a clean 503, and neither password appears in the answer or the logs", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cp-wrong-"));
    const wrongPw = "Wrong-Password-For-The-Test-123";
    writeFileSync(join(dir, "pw"), wrongPw);
    let c: MongoDataClient | undefined;
    const hx = await startHarness({
      DATA_ENGINE_ENDPOINTS: endpoint, DATA_ENGINE_USERNAME: user, DATA_ENGINE_PASSWORD_FILE: join(dir, "pw"), DATA_ENGINE_TLS: "true", DATA_ENGINE_TLS_CA_FILE: caFile,
    }, { dataFactory: (cfg) => (c = new MongoDataClient(cfg.data)) });
    try {
      const o = await hx.user("Wrong Creds");
      const db = json(await hx.as(o).post("/databases", { name: "wrong-creds", region: "eu-central-1" }, cookie)).id;
      const res = await hx.as(o).get(`/databases/${db}/data/collections`);
      assert.equal(res.statusCode, 503, res.body);
      const realPw = readFileSync(passwordFile!, "utf8").trim();
      const port = endpoint!.slice(endpoint!.lastIndexOf(":") + 1);
      for (const text of [res.body, hx.logs.text()]) {
        assert.ok(!text.includes(wrongPw) && !text.includes(realPw), "a password leaked");
        assert.ok(!/Authentication ?Failed|SCRAM/i.test(text), "the engine's message leaked");
        assert.ok(!text.includes(`:${port}`), "the engine's address leaked");
      }
    } finally {
      await c?.close();
      await hx.close();
    }
  });
});
