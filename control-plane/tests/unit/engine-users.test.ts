import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { loadConfig, dataSettings } from "../../src/config.ts";
import {
  MIN_SECRET_LENGTH, PASSWORD_LENGTH, deriveEnginePassword, engineCredential, engineUserName, idFromEngineUserName, isEngineUserName, parseEngineUserKey,
} from "../../src/engine/credentials.ts";
import { MongoDataClient } from "../../src/engine/data-mongo.ts";
import { hasRegex } from "../../src/services/explorer.ts";
import { olderVersion } from "../../src/services/engine-users.ts";
import { BSONRegExp } from "bson";

const ID = "0123abcd-4567-489a-bcde-f0123456789a";
const SECRET = "s".repeat(40);
const key = (v = "v1", s = SECRET) => parseEngineUserKey(`${v}:${s}`, "ENGINE_USER_KEY");

const base = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://x@localhost/x", SUPABASE_URL: "https://p.supabase.invalid", SUPABASE_ANON_KEY: "anon",
  DOWNLOAD_SIGNING_KEY: "k".repeat(32), API_PUBLIC_URL: "https://api.example.test/v1",
};
const real = {
  ...base, ENGINE_DRIVER: "real", ENGINE_ADMIN_ENDPOINTS: "http://engine.internal:8443", ENGINE_ADMIN_TOKEN: "admin-token-0123456789",
  CONNECTION_PORT: "27018", BASE_DOMAIN: "db.example.test", HOST_TEMPLATE: "<name>-<workspace>.<region>.<BASE_DOMAIN>", CONNECTION_DB_NAME: "engine",
  DATA_ENGINE_ENDPOINTS: "engine.internal:27018",
};
const users = { ENGINE_USER_KEY: `v1:${SECRET}`, ENGINE_PROVISIONER_USERNAME: "fenvix_provisioner", ENGINE_PROVISIONER_PASSWORD: "provisioner-password-0123" };

test("passwords: deterministic per key and database, different across databases, versions and secrets", () => {
  const p = deriveEnginePassword(key(), ID);
  assert.equal(p, deriveEnginePassword(key(), ID));
  assert.equal(p.length, PASSWORD_LENGTH);
  assert.match(p, /^[A-Za-z0-9]+$/, "letters and digits only: no escaping in a URI, unchanged by SASLprep");
  assert.notEqual(p, deriveEnginePassword(key(), "1123abcd-4567-489a-bcde-f0123456789a"));
  assert.notEqual(p, deriveEnginePassword(key("v2"), ID), "the version is part of the derivation");
  assert.notEqual(p, deriveEnginePassword(key("v1", "t".repeat(40)), ID));
  // the alphabet is used evenly enough (no character takes more than twice its share over many passwords)
  const counts = new Map<string, number>();
  for (let i = 0; i < 400; i++) for (const ch of deriveEnginePassword(key(), `0123abcd-4567-489a-bcde-${String(i).padStart(12, "0")}`)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const share = (400 * PASSWORD_LENGTH) / 62;
  assert.equal(counts.size, 62);
  assert.ok([...counts.values()].every((n) => n < 2 * share && n > share / 2));
});

test("names: cp_<hex> on db_<hex>; only names this service makes are recognised", () => {
  assert.equal(engineUserName(ID), "cp_0123abcd4567489abcdef0123456789a");
  assert.equal(idFromEngineUserName(engineUserName(ID)), ID);
  const c = engineCredential(key(), ID);
  assert.deepEqual({ ...c, password: "" }, { username: "cp_0123abcd4567489abcdef0123456789a", password: "", authSource: "db_0123abcd4567489abcdef0123456789a", version: "v1" });
  for (const bad of ["cp_0123", "CP_0123abcd4567489abcdef0123456789a", "fenvix_provisioner", "admin", "cp_0123abcd4567489abcdef0123456789aX"]) assert.equal(isEngineUserName(bad), false, bad);
  assert.throws(() => engineUserName("../admin"));
});

test("the master key: <version>:<secret>; errors never contain the secret", () => {
  for (const [raw, re] of [["nocolon", /<version>:<secret>/], [`1:${SECRET}`, /version/], [`v0:${SECRET}`, /version/], ["v1:short", new RegExp(String(MIN_SECRET_LENGTH))]] as const) {
    let msg = "";
    try { parseEngineUserKey(raw, "ENGINE_USER_KEY"); } catch (e) { msg = (e as Error).message; }
    assert.match(msg, re);
    assert.ok(!msg.includes(SECRET) && !msg.includes("short"), msg);
  }
});

test("config: per-database users are required with the real driver and the Data Explorer, and refuse the shared credential", () => {
  assert.throws(() => loadConfig(real), /ENGINE_USER_KEY/);
  const cfg = loadConfig({ ...real, ...users });
  assert.equal(cfg.engineUsers!.current.version, "v1");
  assert.equal(cfg.data.perDatabaseUsers, true);
  assert.equal(cfg.engineUsers!.sweepSeconds, 3600);
  assert.throws(() => loadConfig({ ...real, ...users, DATA_ENGINE_USERNAME: "cp", DATA_ENGINE_PASSWORD: "x".repeat(20) }), /cannot be set together/);
  assert.throws(() => loadConfig({ ...real, ENGINE_USER_KEY: users.ENGINE_USER_KEY }), /ENGINE_PROVISIONER_USERNAME/);
  assert.throws(() => loadConfig({ ...real, ...users, ENGINE_PROVISIONER_USERNAME: "cp_x" }), /must not start with cp_/);
  // one secret, one purpose
  assert.throws(() => loadConfig({ ...real, ...users, ENGINE_USER_KEY: `v1:${"admin-token-0123456789".padEnd(32, "x")}`, ENGINE_ADMIN_TOKEN: "admin-token-0123456789".padEnd(32, "x") }), /its own secret/);
  assert.throws(() => loadConfig({ ...real, ...users, ENGINE_PROVISIONER_PASSWORD: "admin-token-0123456789" }), /its own secret/);
  // rotation: the previous key must be another version and another secret
  assert.equal(loadConfig({ ...real, ...users, ENGINE_USER_KEY: `v2:${"n".repeat(40)}`, ENGINE_USER_KEY_PREVIOUS: `v1:${SECRET}` }).engineUsers!.previous!.version, "v1");
  assert.throws(() => loadConfig({ ...real, ...users, ENGINE_USER_KEY_PREVIOUS: `v1:${"n".repeat(40)}` }), /another version/);
  assert.throws(() => loadConfig({ ...real, ...users, ENGINE_USER_KEY: `v2:${SECRET}`, ENGINE_USER_KEY_PREVIOUS: `v1:${SECRET}` }), /another secret/);
  assert.throws(() => loadConfig({ ...base, ENGINE_DRIVER: "fake", ENGINE_USER_KEY_PREVIOUS: `v1:${SECRET}` }), /needs ENGINE_USER_KEY/);
  // without the Data Explorer there is nothing to make users for
  assert.equal(loadConfig({ ...real, DATA_ENGINE_ENDPOINTS: undefined }).engineUsers, null);
});

test("config errors never contain a secret", () => {
  const secrets = [SECRET, "provisioner-password-0123", "admin-token-0123456789"];
  for (const env of [{ ...real }, { ...real, ...users, ENGINE_PROVISIONER_USERNAME: "cp_x" }, { ...real, ...users, ENGINE_USER_KEY_PREVIOUS: `v1:${"n".repeat(40)}` }]) {
    try { loadConfig(env); assert.fail("should throw"); } catch (e) { for (const s of secrets) assert.ok(!(e as Error).message.includes(s)); }
  }
});

test("the Data Explorer client: per-database credentials in `auth`, the database as authSource; never the provisioner", () => {
  const cfg = loadConfig({ ...real, ...users });
  assert.throws(() => new MongoDataClient(cfg.data), /master key/);
  const c = new MongoDataClient(cfg.data, { current: cfg.engineUsers!.current, previous: null });
  const cred = engineCredential(cfg.engineUsers!.current, ID);
  const o = c.options(cred);
  assert.deepEqual(o.auth, { username: cred.username, password: cred.password });
  assert.equal(o.authSource, "db_0123abcd4567489abcdef0123456789a");
  assert.equal(o.authMechanism, "SCRAM-SHA-256");
  assert.equal(o.tls, true);
  assert.ok(!JSON.stringify(o).includes("provisioner-password-0123"));
  assert.ok(!inspect(c, { depth: 8 }).includes("provisioner-password-0123"), "the client holds nothing of the provisioner");
  void c.close();
});

test("regex filters get their own, shorter time limit (DATA_REGEX_TIMEOUT_MS, default 2000 ms, never above the command limit)", () => {
  assert.equal(dataSettings({}, "development", "fake", ["eu-central-1"]).regexTimeoutMs, 2000);
  assert.equal(dataSettings({ DATA_REGEX_TIMEOUT_MS: "500" }, "development", "fake", ["eu-central-1"]).regexTimeoutMs, 500);
  assert.equal(dataSettings({ DATA_REGEX_TIMEOUT_MS: "5000", DATA_COMMAND_TIMEOUT_MS: "3000" }, "development", "fake", ["eu-central-1"]).regexTimeoutMs, 3000);
  assert.throws(() => dataSettings({ DATA_REGEX_TIMEOUT_MS: "50" }, "development", "fake", ["eu-central-1"]), /DATA_REGEX_TIMEOUT_MS/);
  assert.equal(hasRegex({ a: { $regex: "x" } }), true);
  assert.equal(hasRegex({ $or: [{ a: 1 }, { b: { $not: new BSONRegExp("x", "i") } }] }), true);
  assert.equal(hasRegex({ a: "$regex", b: { $in: ["x"] } }), false);
});

test("the sweep only moves users forward: an instance still on v1 leaves v2 users alone", () => {
  assert.equal(olderVersion("v1", "v2"), true);
  assert.equal(olderVersion(null, "v1"), true);
  assert.equal(olderVersion("v2", "v2"), false);
  assert.equal(olderVersion("v2", "v1"), false);
  assert.equal(olderVersion("v9", "v10"), true, "numbers, not text");
});
