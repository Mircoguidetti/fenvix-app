import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Harness, json, startHarness } from "../helpers/harness.ts";

/**
 * GET /v1/openapi.json describes exactly the public routes: none missing, none that do not exist. And the guide
 * (docs/public-api.md) has a curl example for every one of them.
 */
let h: Harness;
let spec: any;
before(async () => {
  h = await startHarness();
  const r = await h.app.fastify.inject({ method: "GET", url: "/v1/openapi.json" });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers["content-type"]), /application\/json/);
  assert.ok(r.headers["x-request-id"]);
  spec = json(r);
});
after(async () => { await h.close(); });

const METHODS = ["get", "post", "put", "delete", "patch"];
/** "METHOD /v1/public/path/:param" for every operation in the document. */
const specRoutes = () => Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(([path, item]) =>
  Object.keys(item).filter((m) => METHODS.includes(m)).map((m) => `${m.toUpperCase()} /v1/public${path.replace(/\{(\w+)\}/g, ":$1")}`));
const appRoutes = () => h.app.routes.filter((r) => r.includes(" /v1/public/"));

test("it is OpenAPI 3.1 with a server on the public prefix and a bearer scheme", () => {
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.servers[0].url, "https://api.fenvix.test/v1/public");
  assert.equal(spec.components.securitySchemes.apiKey.scheme, "bearer");
});

test("every public route is in the document", () => {
  const described = new Set(specRoutes());
  assert.deepEqual(appRoutes().filter((r) => !described.has(r)).sort(), []);
});

test("the document describes no route that does not exist", () => {
  const routed = new Set(appRoutes());
  assert.deepEqual(specRoutes().filter((r) => !routed.has(r)).sort(), []);
  for (const r of specRoutes()) {
    const [method, url] = r.split(" ");
    assert.ok(h.app.fastify.hasRoute({ method: method as "GET", url: url! }), r);
  }
});

test("every operation has an id, a summary, 2xx and 401 answers, and every $ref resolves", () => {
  const ids = new Set<string>();
  for (const item of Object.values(spec.paths as Record<string, Record<string, any>>)) {
    for (const [m, o] of Object.entries(item)) {
      if (!METHODS.includes(m)) continue;
      assert.ok(o.operationId && !ids.has(o.operationId), o.operationId);
      ids.add(o.operationId);
      assert.ok(o.summary);
      assert.ok(Object.keys(o.responses).some((c) => c.startsWith("2")), o.operationId);
      assert.ok(o.responses["401"], o.operationId);
    }
  }
  const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
  for (const r of refs) assert.ok(spec.components.schemas[r], `missing schema ${r}`);
});

test("the guide has a curl example for every public route", () => {
  const doc = readFileSync(new URL("../../docs/public-api.md", import.meta.url), "utf8");
  for (const r of specRoutes()) {
    const [method, url] = r.split(" ");
    const path = url!.replace("/v1/public", "").replace(/:(\w+)/g, "[^\\s\"']+");
    const methodFlag = method === "GET" ? "" : `-X ${method} `;
    const re = new RegExp(`curl[^\\n]*${methodFlag.replace(/ /g, "\\s+")}[^\\n]*\\$FENVIX_API${path}(\\?|\\s|"|$)`, "m");
    assert.match(doc, re, `no curl example for ${r}`);
  }
});
