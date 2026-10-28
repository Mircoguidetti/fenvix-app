import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoServerError } from "mongodb";
import { dataSettings, loadConfig } from "../../src/config.ts";
import { MongoDataClient, mapError } from "../../src/engine/data-mongo.ts";
import { DataError, dataTarget, targetDbName } from "../../src/engine/data.ts";
import { logPath } from "../../src/app.ts";

const REGIONS = ["eu-central-1"];
const base = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://x@localhost/x", SUPABASE_URL: "https://p.supabase.invalid", SUPABASE_ANON_KEY: "anon",
  DOWNLOAD_SIGNING_KEY: "k".repeat(32), API_PUBLIC_URL: "https://api.example.test/v1",
};
const PASSWORD = "Sup3r-Secret-Engine-Password!";

test("defaults: fake with the fake engine, off with the real one, safe values everywhere", () => {
  const fake = dataSettings({}, "development", "fake", REGIONS);
  assert.equal(fake.driver, "fake");
  assert.equal(fake.tls, true);
  assert.equal(fake.authMechanism, "SCRAM-SHA-256");
  assert.equal(fake.defaultPageSize, 25);
  assert.equal(fake.maxPageSize, 100);
  assert.equal(fake.commandTimeoutMs, 10_000);
  assert.equal(dataSettings({}, "production", "real", REGIONS).driver, "off");
});

test("mongo: credentials and TLS are required unless the local-only flag is set", () => {
  const ep = { DATA_ENGINE_ENDPOINTS: "engine.internal:27018" };
  assert.throws(() => dataSettings(ep, "development", "real", REGIONS), /DATA_ENGINE_USERNAME/);
  assert.throws(() => dataSettings({ ...ep, DATA_ENGINE_USERNAME: "cp", DATA_ENGINE_PASSWORD: PASSWORD, DATA_ENGINE_TLS: "false" }, "development", "real", REGIONS), /INSECURE_LOCAL/);
  // One shared credential for every database: development only. Production needs per-database users (ENGINE_USER_KEY).
  assert.throws(() => dataSettings({ ...ep, DATA_ENGINE_USERNAME: "cp", DATA_ENGINE_PASSWORD: PASSWORD }, "production", "real", REGIONS), /refused in production/);
  const ok = dataSettings({ ...ep, DATA_ENGINE_USERNAME: "cp", DATA_ENGINE_PASSWORD: PASSWORD }, "development", "real", REGIONS);
  assert.equal(ok.driver, "mongo");
  assert.equal(ok.tls, true);
  const perDb = dataSettings({ ...ep, ENGINE_USER_KEY: `v1:${"k".repeat(40)}` }, "production", "real", REGIONS);
  assert.equal(perDb.perDatabaseUsers, true);
  assert.equal(perDb.username, undefined);
  const local = dataSettings({ ...ep, DATA_ENGINE_INSECURE_LOCAL: "true", DATA_ENGINE_TLS: "false" }, "development", "fake", REGIONS);
  assert.equal(local.tls, false);
  assert.equal(local.username, undefined);
});

test("the local-only flag refuses to start in production, and so does no TLS", () => {
  assert.throws(() => dataSettings({ DATA_ENGINE_INSECURE_LOCAL: "true" }, "production", "fake", REGIONS), /refused with NODE_ENV=production/);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "production", ENGINE_DRIVER: "fake", TRUST_PROXY: "true", DASHBOARD_ORIGINS: "https://app.example.test", DATA_ENGINE_INSECURE_LOCAL: "true" }), /refused/);
  assert.throws(() => dataSettings({ DATA_ENGINE_ENDPOINTS: "e:1", DATA_ENGINE_USERNAME: "u", DATA_ENGINE_PASSWORD: "p", DATA_ENGINE_TLS: "false" }, "production", "real", REGIONS), /INSECURE_LOCAL/);
});

test("endpoints: host:port only; URLs, credentials and options are refused", () => {
  for (const bad of ["mongodb://e:27018", "user:pw@e:27018", "e:27018/?tls=false", "e", "e:99999", "x=e:1"]) {
    assert.throws(() => dataSettings({ DATA_ENGINE_ENDPOINTS: bad, DATA_ENGINE_INSECURE_LOCAL: "true" }, "development", "fake", REGIONS), Error, bad);
  }
  assert.deepEqual(dataSettings({ DATA_ENGINE_ENDPOINTS: "eu-central-1=10.0.0.5:27018", DATA_ENGINE_INSECURE_LOCAL: "true" }, "development", "fake", REGIONS).endpoints, { "eu-central-1": "10.0.0.5:27018" });
  assert.throws(() => dataSettings({ DATA_ENGINE_ENDPOINTS: "e:1", DATA_ENGINE_INSECURE_LOCAL: "true" }, "development", "fake", ["eu-central-1", "us-east-1"]), /needs a region/);
});

test("password from a file; username and password go together; limits cannot exceed their ceilings", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-"));
  writeFileSync(join(dir, "pw"), `${PASSWORD}\n`);
  const s = dataSettings({ DATA_ENGINE_ENDPOINTS: "e:1", DATA_ENGINE_USERNAME: "cp", DATA_ENGINE_PASSWORD_FILE: join(dir, "pw") }, "development", "real", REGIONS);
  assert.equal(s.password, PASSWORD);
  assert.throws(() => dataSettings({ DATA_ENGINE_USERNAME: "cp" }, "development", "fake", REGIONS), /go together/);
  assert.throws(() => dataSettings({ DATA_MAX_PAGE_SIZE: "500" }, "development", "fake", REGIONS), /at most 100/);
  assert.throws(() => dataSettings({ DATA_MAX_DOCUMENT_BYTES: String(16 * 1024 * 1024) }, "development", "fake", REGIONS), /at most/);
  assert.throws(() => dataSettings({ DATA_DEFAULT_PAGE_SIZE: "50", DATA_MAX_PAGE_SIZE: "40" }, "development", "fake", REGIONS), /at most 40/);
});

test("driver options: TLS on, SCRAM in `auth` (never in the URL), small pool with idle limits, no retries", () => {
  const s = dataSettings({ DATA_ENGINE_ENDPOINTS: "e:27018", DATA_ENGINE_USERNAME: "cp", DATA_ENGINE_PASSWORD: PASSWORD }, "development", "real", REGIONS);
  const c = new MongoDataClient(s);
  const o = c.options();
  assert.equal(o.tls, true);
  assert.deepEqual(o.auth, { username: "cp", password: PASSWORD });
  assert.equal(o.authMechanism, "SCRAM-SHA-256");
  assert.equal(o.maxPoolSize, 5);
  assert.equal(o.minPoolSize, 0);
  assert.equal(o.maxIdleTimeMS, 30_000);
  assert.equal(o.retryWrites, false);
  assert.equal(o.directConnection, true);
  assert.equal(o.promoteValues, undefined, "BSON types are kept on find/findOne only, not on the engine's own answers");
  void c.close();
});

test("errors from the driver become kinds and numbers, never their message", () => {
  const dup = new MongoServerError({ message: 'E11000 duplicate key error collection: db_x.c index: _id_ dup key: { _id: "SECRET-VALUE" }', code: 11000 });
  const d = mapError(dup);
  assert.equal(d.kind, "duplicate");
  assert.ok(!d.message.includes("SECRET-VALUE"));
  assert.equal(mapError(new MongoServerError({ message: "operation exceeded time limit", code: 50, codeName: "MaxTimeMSExpired" })).kind, "timeout");
  assert.equal(mapError(new MongoServerError({ message: "Authentication failed.", code: 18 })).kind, "unavailable");
  assert.equal(mapError(new MongoServerError({ message: "unknown operator: $foo", code: 2 })).kind, "refused");
  assert.equal(mapError(new MongoServerError({ message: "Operation put_opts not implemented by LocalFileSystem(file:///secret/path)", code: 1, codeName: "InternalError" })).kind, "unavailable");
  const asInt32 = mapError(Object.assign(new MongoServerError({ message: "E11000 dup" }), { code: { valueOf: () => 11000 } }));
  assert.equal(asInt32.kind, "duplicate", "a code that arrives as a BSON Int32 is still recognised");
  const net = Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:27018"), { name: "MongoServerSelectionError" });
  const n = mapError(net);
  assert.equal(n.kind, "unavailable");
  assert.ok(!n.message.includes("10.1.2.3"));
});

test("an unreachable engine is 'unavailable' within the connect timeout; idle clients are closed", async () => {
  const s = dataSettings({ DATA_ENGINE_ENDPOINTS: "127.0.0.1:1", DATA_ENGINE_INSECURE_LOCAL: "true", DATA_ENGINE_TLS: "false", DATA_ENGINE_CONNECT_TIMEOUT_MS: "300", DATA_ENGINE_CLIENT_IDLE_CLOSE_MS: "1000" }, "development", "fake", REGIONS);
  const c = new MongoDataClient(s);
  const t = dataTarget({ id: "6f1d2c3b-4a59-4687-9876-543210fedcba", region: "eu-central-1" });
  const started = Date.now();
  await assert.rejects(c.find(t, "c", { filter: {}, sort: { _id: 1 }, projection: undefined, skip: 0, limit: 1, maxBytes: 1000, maxTimeMS: 100 }), (e: unknown) => e instanceof DataError && e.kind === "unavailable");
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(c.openRegions(), ["eu-central-1"]);
  await c.closeIdle(Date.now() + 5000);
  assert.deepEqual(c.openRegions(), [], "the client and its monitoring connection are closed when idle");
  await c.close();
});

test("a DataTarget cannot be forged: the name comes only from a target made by dataTarget()", () => {
  const t = dataTarget({ id: "6F1D2C3B-4A59-4687-9876-543210FEDCBA", region: "r" });
  assert.equal(targetDbName(t), "db_6f1d2c3b4a5946879876543210fedcba");
  assert.throws(() => targetDbName({ id: t.id, region: "r" } as never), /not a DataTarget/);
  assert.throws(() => dataTarget({ id: "admin", region: "r" }) && targetDbName(dataTarget({ id: "admin", region: "r" })), /not a database id/);
  assert.ok(Object.isFrozen(t));
});

test("log paths: nothing after /data/ is logged", () => {
  assert.equal(logPath("/v1/databases/abc/data/collections/secret_coll/documents/%7B%22x%22%7D?filter=%7B%7D"), "/v1/databases/abc/data/[redacted]");
  assert.equal(logPath("/v1/databases/abc?x=1"), "/v1/databases/abc");
});
