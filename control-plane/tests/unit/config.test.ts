import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HOST_TEMPLATE, loadConfig, renderHost } from "../../src/config.ts";
import { parseCatalogue, parseLimits, planFor } from "../../src/limits.ts";
import { readFileSync } from "node:fs";

const base = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://x@localhost/db", SUPABASE_URL: "https://p.supabase.invalid", SUPABASE_ANON_KEY: "anon",
  DOWNLOAD_SIGNING_KEY: "k".repeat(32), ENGINE_DRIVER: "fake",
};

test("defaults: empty base domain, one region, the documented host template", () => {
  const c = loadConfig(base);
  assert.equal(c.baseDomain, "");
  assert.deepEqual(c.regions, ["eu-central-1"]);
  assert.equal(c.hostTemplate, DEFAULT_HOST_TEMPLATE);
  assert.equal(c.hostTemplate, "<name>.<region>.db.<BASE_DOMAIN>");
  assert.equal(c.supabaseJwksUrl, "https://p.supabase.invalid/auth/v1/.well-known/jwks.json");
});

test("host template is configuration, with and without a base domain", () => {
  const vars = { name: "acme-prod-01", region: "eu-central-1", workspace: "12345678-aaaa-bbbb-cccc-dddddddddddd" };
  assert.equal(renderHost(loadConfig(base), vars), "acme-prod-01.eu-central-1.db");
  assert.equal(renderHost(loadConfig({ ...base, BASE_DOMAIN: "example.test" }), vars), "acme-prod-01.eu-central-1.db.example.test");
  assert.equal(renderHost(loadConfig({ ...base, BASE_DOMAIN: ".example.test." }), vars), "acme-prod-01.eu-central-1.db.example.test");
  assert.equal(renderHost(loadConfig({ ...base, BASE_DOMAIN: "example.test", HOST_TEMPLATE: "<name>-<workspace>.<BASE_DOMAIN>" }), vars), "acme-prod-01-12345678.example.test");
});

test("regions come from REGIONS", () => {
  assert.deepEqual(loadConfig({ ...base, REGIONS: "eu-central-1, us-east-1" }).regions, ["eu-central-1", "us-east-1"]);
  assert.throws(() => loadConfig({ ...base, REGIONS: "EU West" }), /REGIONS/);
});

test("missing or wrong settings fail with a readable message, never with a value", () => {
  assert.throws(() => loadConfig({ ...base, CONTROL_PLANE_DATABASE_URL: undefined }), /CONTROL_PLANE_DATABASE_URL is required/);
  assert.throws(() => loadConfig({ ...base, DOWNLOAD_SIGNING_KEY: "short" }), /at least 32/);
  assert.throws(() => loadConfig({ ...base, ENGINE_DRIVER: undefined }), /ENGINE_DRIVER is required/);
  assert.throws(() => loadConfig({ ...base, DASHBOARD_ORIGINS: "https://app.test/" }), /no trailing slash/);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "production", API_PUBLIC_URL: "http://x" }), /https/);
  assert.throws(() => loadConfig({ ...base, PORT: "abc" }), /PORT/);
  const prod = { ...base, NODE_ENV: "production", API_PUBLIC_URL: "https://api.test/v1", DASHBOARD_ORIGINS: "https://app.test" };
  assert.throws(() => loadConfig(prod), /TRUST_PROXY must be set/);
  assert.equal(loadConfig({ ...prod, TRUST_PROXY: "true" }).trustProxy, true);
  assert.equal(loadConfig({ ...prod, TRUST_PROXY: "false" }).trustProxy, false);
  try { loadConfig({ ...base, DOWNLOAD_SIGNING_KEY: "secret-value-that-is-too-short" }); } catch (e) { assert.ok(!String((e as Error).message).includes("secret-value")); }
});

test("the shipped plans file carries no price, no rate and no limit", () => {
  const raw = JSON.parse(readFileSync(new URL("../../config/plans.json", import.meta.url), "utf8"));
  const cat = parseCatalogue(raw);
  assert.equal(cat.rates.storagePerGbMonth, null);
  assert.equal(cat.rates.requestsPerMillion, null);
  for (const p of cat.plans) {
    assert.equal(p.price, "", p.id);
    assert.equal(p.period, "", p.id);
    assert.deepEqual(p.limits, { maxDatabases: null, maxStorageGb: null, retentionDays: null }, p.id);
    assert.ok(!/[$€£]\s?\d|\d+\s?(GB|million)/i.test(JSON.stringify(p)), `${p.id} mentions a price or an amount`);
  }
  assert.equal(planFor(cat, "managed").id, "managed");
  assert.equal(planFor(cat, "no-such-plan").id, cat.defaultPlan);
});

test("catalogue and limits reject nonsense", () => {
  assert.throws(() => parseCatalogue({ plans: [] }), /non-empty/);
  assert.throws(() => parseCatalogue({ defaultPlan: "x", plans: [{ id: "a", name: "A" }] }), /defaultPlan/);
  assert.throws(() => parseCatalogue({ plans: [{ id: "a", name: "A", limits: { maxDatabases: -1 } }] }), /maxDatabases/);
  assert.throws(() => parseLimits({}), /positive integer/);
});
