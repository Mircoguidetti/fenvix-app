import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.ts";
import { PASSWORD_LENGTH, randomPassword } from "../../src/engine/credentials.ts";
import { CUSTOMER_ROLES, isCustomerRole, roleOf } from "../../src/engine/users.ts";
import { parseLimits } from "../../src/limits.ts";
import { OnceSecrets } from "../../src/once.ts";
import { connectionString } from "../../src/services/databases.ts";
import { parseNewUser, parseRole, parseUsername } from "../../src/services/db-users.ts";
import { ApiError } from "../../src/errors.ts";

const base = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://x@localhost/x", SUPABASE_URL: "https://p.supabase.invalid", SUPABASE_ANON_KEY: "anon",
  DOWNLOAD_SIGNING_KEY: "k".repeat(32), API_PUBLIC_URL: "https://api.example.test/v1", ENGINE_DRIVER: "fake",
};
const cfg = loadConfig(base);
const s = { cfg };
const refused = (f: () => unknown, field: string) => assert.throws(f, (e: unknown) => e instanceof ApiError && e.status === 400 && e.field === field);

test("random passwords: 40 letters and digits, from the OS random source, never repeated", () => {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (let i = 0; i < 2000; i++) {
    const p = randomPassword();
    assert.match(p, /^[A-Za-z0-9]{40}$/);
    assert.equal(p.length, PASSWORD_LENGTH);
    seen.add(p);
    for (const c of p) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  assert.equal(seen.size, 2000);
  // 80,000 characters over 62 letters: every letter is used, none far from the mean (no bias toward the first ones).
  assert.equal(counts.size, 62);
  const mean = 80_000 / 62;
  for (const n of counts.values()) assert.ok(Math.abs(n - mean) < mean * 0.2, String(n));
});

test("user names: the rule, reserved names and prefixes, and nothing is trimmed or lowercased", () => {
  for (const ok of ["app", "web-api", "reporting_ro", "a12", "x".repeat(32)]) assert.equal(parseUsername(ok, s), ok);
  for (const bad of ["ab", "x".repeat(33), "App", " app", "app ", "1app", "-app", "_app", "app.x", "app$", "app@x", "äpp", "app\n", "app\u0000",
    "cp_x", "cp-x", "admin", "root", "system", "local", "config", "fenvix", "fenvix-x", "mongo", "mongodb-x", "provisioner", "__x", "systemd", 7, null, undefined, {}, ["app"]]) {
    refused(() => parseUsername(bad, s), "username");
  }
  // The deployment's own provisioner name is reserved too, whatever it is.
  const withProv = loadConfig({ ...base, ENGINE_DRIVER: "fake" });
  (withProv as { engineUsers: unknown }).engineUsers = { provisioner: { username: "ops-maker" } };
  refused(() => parseUsername("ops-maker", { cfg: withProv }), "username");
});

test("roles: only the fixed list by name; prototype names, objects and lists are not roles", () => {
  assert.deepEqual(Object.keys(CUSTOMER_ROLES).sort(), ["read", "readWrite"]);
  assert.equal(parseRole("read"), "read");
  assert.equal(parseRole("readWrite"), "readWrite");
  for (const bad of ["root", "dbOwner", "userAdmin", "readwrite", "READ", "toString", "__proto__", "constructor", "hasOwnProperty", { role: "read" }, ["read"], null, 1]) {
    assert.equal(isCustomerRole(bad), false);
    refused(() => parseRole(bad), "role");
  }
});

test("a new user's body: username and role only; anything else is refused, not ignored", () => {
  assert.deepEqual(parseNewUser({ username: "app2" }, s), { username: "app2", role: "readWrite" });
  assert.deepEqual(parseNewUser({ username: "app2", role: "read" }, s), { username: "app2", role: "read" });
  for (const extra of ["roles", "db", "pwd", "password", "customData", "mechanisms", "privileges", "authenticationRestrictions"]) {
    assert.throws(() => parseNewUser({ username: "app2", role: "read", [extra]: 1 }, s), (e: unknown) => e instanceof ApiError && e.status === 400);
  }
  for (const body of [null, [], "x", 1]) assert.throws(() => parseNewUser(body, s), (e: unknown) => e instanceof ApiError && e.status === 400);
});

test("roleOf maps the engine's roles back to the list; anything else is \"other\"", () => {
  const db = "db_" + "a".repeat(32);
  assert.equal(roleOf([{ role: "readWrite", db }], db), "readWrite");
  assert.equal(roleOf([{ role: "read", db }], db), "read");
  assert.equal(roleOf([{ role: "read", db: "admin" }], db), "other");
  assert.equal(roleOf([{ role: "dbOwner", db }], db), "other");
  assert.equal(roleOf([{ role: "read", db }, { role: "readWrite", db }], db), "other");
  assert.equal(roleOf([], db), "other");
  assert.equal(roleOf(undefined, db), "other");
});

test("once: made once per key, taken once, forgotten after its time", () => {
  let t = 0;
  const o = new OnceSecrets(1000, () => t);
  let made = 0;
  const a = o.getOrMake("op1", () => `p${++made}`);
  assert.equal(o.getOrMake("op1", () => `p${++made}`), a, "a retry in this process gets the same password");
  assert.equal(made, 1);
  assert.equal(o.take("op1"), a);
  assert.equal(o.take("op1"), null, "taken once");
  o.getOrMake("op2", () => "x");
  t = 1001;
  assert.equal(o.take("op2"), null, "expired");
  o.getOrMake("op3", () => "y");
  o.forget("op3");
  assert.equal(o.size, 0);
});

test("connection string: the user, a placeholder or the password, authSource = the database, TLS and SCRAM-SHA-256", () => {
  const d = { id: "0123abcd-4567-489a-bcde-f0123456789a", name: "orders-prod", host: "orders-prod.eu.db.example.test" };
  assert.equal(connectionString(cfg, d, "app"), "mongodb://app:<password>@orders-prod.eu.db.example.test:27017/orders_prod?tls=true&authSource=orders_prod&authMechanism=SCRAM-SHA-256");
  assert.equal(connectionString(cfg, d, null), "mongodb://<username>:<password>@orders-prod.eu.db.example.test:27017/orders_prod?tls=true&authSource=orders_prod&authMechanism=SCRAM-SHA-256");
  assert.equal(connectionString(cfg, d, "app", "Secret123"), "mongodb://app:Secret123@orders-prod.eu.db.example.test:27017/orders_prod?tls=true&authSource=orders_prod&authMechanism=SCRAM-SHA-256");
  const engine = { ...cfg, connectionDbName: "engine" as const, connectionPort: 27018 };
  assert.equal(connectionString(engine, d, "app"), "mongodb://app:<password>@orders-prod.eu.db.example.test:27018/db_0123abcd4567489abcdef0123456789a?tls=true&authSource=db_0123abcd4567489abcdef0123456789a&authMechanism=SCRAM-SHA-256");
});

test("limits: the users limits have defaults for an older limits.json, and must be positive", () => {
  const old = JSON.parse(JSON.stringify(cfg.limits));
  delete old.maxUsersPerDatabase; delete old.userListsPerMinute; delete old.userChangesPerMinute;
  const l = parseLimits(old);
  assert.equal(l.maxUsersPerDatabase, 20);
  assert.equal(l.userListsPerMinute, 60);
  assert.equal(l.userChangesPerMinute, 10);
  assert.throws(() => parseLimits({ ...old, maxUsersPerDatabase: 0 }), /maxUsersPerDatabase/);
  assert.equal(cfg.limits.maxUsersPerDatabase, 20);
});
