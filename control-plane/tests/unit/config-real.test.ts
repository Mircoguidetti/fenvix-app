import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, renderHost, workspaceCode } from "../../src/config.ts";

const base = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://x.invalid/db",
  SUPABASE_URL: "https://p.supabase.invalid",
  SUPABASE_ANON_KEY: "anon",
  DOWNLOAD_SIGNING_KEY: "k".repeat(32),
  API_PUBLIC_URL: "https://api.example.test/v1",
};
const real = {
  ...base,
  ENGINE_DRIVER: "real",
  ENGINE_ADMIN_ENDPOINTS: "https://engine.internal.invalid:9",
  ENGINE_ADMIN_TOKEN: "t".repeat(20),
  CONNECTION_PORT: "27018",
  BASE_DOMAIN: "db.example.test",
  HOST_TEMPLATE: "<name>-<workspace>.<region>.<BASE_DOMAIN>",
  CONNECTION_DB_NAME: "engine",
};
const fails = (env: Record<string, string | undefined>, re: RegExp) => assert.throws(() => loadConfig(env), re);

test("the fake driver needs none of the engine settings, and has no engine block", () => {
  const c = loadConfig({ ...base, ENGINE_DRIVER: "fake" });
  assert.equal(c.engine, null);
  assert.equal(c.connectionDbName, "name");
});

test("the real driver reads every engine value from the environment and has no default for an address, port, secret or certificate", () => {
  const c = loadConfig(real);
  assert.equal(c.engine!.endpoints["eu-central-1"]!.href, "https://engine.internal.invalid:9/");
  assert.equal(c.engine!.token, "t".repeat(20));
  assert.equal(c.engine!.forkMode, "clone");
  assert.equal(c.engine!.retentionWindowSecs, null);
  assert.equal(c.engine!.caPem, undefined);
  for (const name of ["ENGINE_ADMIN_ENDPOINTS", "ENGINE_ADMIN_TOKEN", "CONNECTION_PORT", "BASE_DOMAIN"]) {
    fails({ ...real, [name]: undefined }, new RegExp(name));
  }
});

test("addresses: region=url pairs for several regions, a bare url only for one, no credentials, no path, plain http only when said", () => {
  const two = { ...real, REGIONS: "eu-central-1,us-east-1" };
  fails({ ...two, ENGINE_ADMIN_ENDPOINTS: "https://a.invalid:1" }, /needs a region/);
  fails({ ...two, ENGINE_ADMIN_ENDPOINTS: "eu-central-1=https://a.invalid:1" }, /no address for region us-east-1/);
  fails({ ...two, ENGINE_ADMIN_ENDPOINTS: "eu-central-1=https://a.invalid:1,eu-central-1=https://b.invalid:1,us-east-1=https://c.invalid:1" }, /twice/);
  fails({ ...real, ENGINE_ADMIN_ENDPOINTS: "mars-1=https://a.invalid:1" }, /not in REGIONS/);
  const ok = loadConfig({ ...two, ENGINE_ADMIN_ENDPOINTS: "eu-central-1=https://a.invalid:1, us-east-1=https://b.invalid:2" });
  assert.deepEqual(Object.keys(ok.engine!.endpoints), ["eu-central-1", "us-east-1"]);
  fails({ ...real, ENGINE_ADMIN_ENDPOINTS: "https://u:p@a.invalid:1" }, /no credentials/);
  fails({ ...real, ENGINE_ADMIN_ENDPOINTS: "https://a.invalid:1/v1" }, /without a path/);
  fails({ ...real, ENGINE_ADMIN_ENDPOINTS: "ftp://a.invalid" }, /http/);
  fails({ ...real, ENGINE_ADMIN_ENDPOINTS: "not a url" }, /not a URL/);
  const prod = { ...real, NODE_ENV: "production", TRUST_PROXY: "true", DASHBOARD_ORIGINS: "https://app.example.test", ENGINE_ADMIN_ENDPOINTS: "http://a.invalid:1" };
  fails(prod, /plain http/);
  assert.ok(loadConfig({ ...prod, ENGINE_ADMIN_ALLOW_PLAIN_HTTP: "true" }).engine);
  assert.ok(loadConfig({ ...prod, ENGINE_ADMIN_ENDPOINTS: "https://a.invalid:1" }).engine);
});

test("the token comes from the environment or a file, at least 16 characters", () => {
  fails({ ...real, ENGINE_ADMIN_TOKEN: "short" }, /at least 16/);
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "token"), `${"f".repeat(24)}\n`);
  assert.equal(loadConfig({ ...real, ENGINE_ADMIN_TOKEN: undefined, ENGINE_ADMIN_TOKEN_FILE: join(dir, "token") }).engine!.token, "f".repeat(24));
  fails({ ...real, ENGINE_ADMIN_TOKEN: undefined, ENGINE_ADMIN_TOKEN_FILE: join(dir, "missing") }, /cannot read/);
});

test("certificates are read from files; a client certificate needs its key", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  for (const n of ["ca", "cert", "key"]) writeFileSync(join(dir, n), `PEM ${n}`);
  const c = loadConfig({ ...real, ENGINE_ADMIN_CA_FILE: join(dir, "ca"), ENGINE_ADMIN_CLIENT_CERT_FILE: join(dir, "cert"), ENGINE_ADMIN_CLIENT_KEY_FILE: join(dir, "key"), ENGINE_ADMIN_TLS_SERVER_NAME: "engine.example.test" });
  assert.deepEqual([c.engine!.caPem, c.engine!.clientCertPem, c.engine!.clientKeyPem, c.engine!.tlsServerName], ["PEM ca", "PEM cert", "PEM key", "engine.example.test"]);
  fails({ ...real, ENGINE_ADMIN_CLIENT_CERT_FILE: join(dir, "cert") }, /go together/);
});

test("fork mode, restore-point window, timeouts", () => {
  const c = loadConfig({ ...real, ENGINE_FORK_MODE: "copy", ENGINE_RETENTION_WINDOW_SECS: "86400", ENGINE_RETENTION_INTERVAL_SECS: "300", ENGINE_REQUEST_TIMEOUT_MS: "2000", ENGINE_LONG_REQUEST_TIMEOUT_MS: "90000" });
  assert.deepEqual([c.engine!.forkMode, c.engine!.retentionWindowSecs, c.engine!.retentionIntervalSecs, c.engine!.requestTimeoutMs, c.engine!.longRequestTimeoutMs], ["copy", 86400, 300, 2000, 90000]);
  fails({ ...real, ENGINE_FORK_MODE: "deep" }, /clone.*copy/);
  fails({ ...real, ENGINE_RETENTION_INTERVAL_SECS: "60" }, /needs ENGINE_RETENTION_WINDOW_SECS/);
  assert.equal(loadConfig({ ...real, ENGINE_RETENTION_WINDOW_SECS: "0" }).engine!.retentionWindowSecs, 0);
});

test("hostnames must carry the workspace code and connection strings the engine's own name", () => {
  fails({ ...real, HOST_TEMPLATE: "<name>.<region>.<BASE_DOMAIN>" }, /<workspace>/);
  fails({ ...real, CONNECTION_DB_NAME: undefined }, /CONNECTION_DB_NAME/);
  fails({ ...real, CONNECTION_DB_NAME: "name" }, /engine/);
  fails({ ...real, CONNECTION_DB_NAME: "other" }, /"name" or "engine"/);
});

test("the workspace code is the first 8 hex digits of the id, and appears in the host", () => {
  const ws = "ABCDEF12-0000-4000-8000-000000000001";
  assert.equal(workspaceCode(ws), "abcdef12");
  const c = loadConfig(real);
  assert.equal(renderHost(c, { name: "orders", region: "eu-central-1", workspace: ws }), "orders-abcdef12.eu-central-1.db.example.test");
  // the longest name the contract allows still fits a DNS label (63)
  const long = "a".repeat(48);
  assert.ok(renderHost(c, { name: long, region: "eu-central-1", workspace: ws }).split(".")[0]!.length <= 63);
});
