import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Harness, startHarness } from "../helpers/harness.ts";

/** Every endpoint the contract document lists exists in the service, with the documented method and path. */
let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const doc = readFileSync(new URL("../../../docs/control-plane-api.md", import.meta.url), "utf8");
const endpoints = [...doc.matchAll(/^### `(\w+)` — `(GET|POST|PUT|DELETE) (\S+)`/gm)].map((m) => ({ name: m[1]!, method: m[2]!, path: m[3]! }));

test("the contract lists the endpoints we expect (a guard against the parser finding nothing)", () => {
  assert.equal(endpoints.length, 37, `found ${endpoints.length}`);
  for (const n of ["listDatabases", "createDatabase", "eraseDatabases", "getUsageTrend", "completeEmailLink", "signOut", "setKeepAwake"]) {
    assert.ok(endpoints.some((e) => e.name === n), n);
  }
});

test("every endpoint of the contract is routed", () => {
  const missing: string[] = [];
  for (const e of endpoints) {
    const url = `/v1${e.path.replace(/\{(\w+)\}/g, ":$1")}`;
    if (!h.app.fastify.hasRoute({ method: e.method as "GET", url })) missing.push(`${e.name}: ${e.method} ${e.path}`);
  }
  assert.deepEqual(missing, []);
});

test("every route the service has beyond the contract is one we documented as an extension", () => {
  const known = new Set(endpoints.map((e) => `${e.method} /v1${e.path.replace(/\{(\w+)\}/g, ":$1")}`));
  known.add("GET /v1/session/providers/:provider/callback"); // described in the text of section 3, not as its own heading
  const extra = h.app.routes.filter((r) => !known.has(r)).sort();
  assert.deepEqual(extra.filter((r) => !/^GET \/(healthz|readyz)$/.test(r)), [
    // The Data Explorer (docs/api-extensions.md, "Data Explorer").
    "DELETE /v1/databases/:id/data/collections/:collection/documents/:docId",
    "GET /v1/databases/:id/data/collections",
    "GET /v1/databases/:id/data/collections/:collection/documents",
    "GET /v1/databases/:id/data/collections/:collection/documents/:docId",
    "GET /v1/downloads/:token", "GET /v1/operations", "GET /v1/operations/:id",
    "POST /v1/databases/:id/data/collections/:collection/documents",
    "PUT /v1/databases/:id/data/collections/:collection/documents/:docId",
    // A database's own users (docs/api-extensions.md, "Database users").
    "DELETE /v1/databases/:id/users/:username",
    "GET /v1/databases/:id/users",
    "POST /v1/databases/:id/users",
    "POST /v1/databases/:id/users/:username/reset-password",
  ].sort());
});
