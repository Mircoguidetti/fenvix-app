import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type Harness, json, startHarness } from "../helpers/harness.ts";

/**
 * The per-address counter (`anon:<ip>`, RATE_LIMIT_ANON_PER_MINUTE, 30 by default) is for failed sign-ins. Reading the
 * OpenAPI document does not use it, and a valid key is never held back by it. Every request here comes from the same
 * address (inject's 127.0.0.1).
 */
let h: Harness;
let token = "";
before(async () => {
  h = await startHarness();
  assert.equal(h.cfg.rateLimitAnonPerMinute, 30);
  const w = await h.user("Rate");
  token = json(await h.as(w).post("/public/api-keys", { name: "rl", role: "read_only" }, { "x-fenvix-workspace": w.workspaceId })).token;
});
after(async () => { await h.close(); });

test("fetching the spec 40 times in a minute neither fails nor locks out a valid key from the same address", async () => {
  for (let i = 0; i < 40; i++) {
    const r = await h.app.fastify.inject({ method: "GET", url: "/v1/openapi.json" });
    assert.equal(r.statusCode, 200, `spec fetch ${i + 1}`);
  }
  assert.equal((await h.as(token).get("/public/organization")).statusCode, 200);
});

test("failed keys from the same address are slowed down, but a valid key still works", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 35; i++) {
    codes.push((await h.as(`fvx_${randomBytes(32).toString("base64url")}`).get("/public/organization")).statusCode);
  }
  assert.ok(codes.slice(0, 30).every((c) => c === 401), codes.join(","));
  assert.ok(codes.slice(30).every((c) => c === 429), codes.join(","));
  // The address is over its failure budget; the valid key is not affected.
  const ok = await h.as(token).get("/public/organization");
  assert.equal(ok.statusCode, 200, ok.body);
  // Anonymous requests (no key at all) are failures too, and do not affect it either.
  assert.equal((await h.app.fastify.inject({ method: "GET", url: "/v1/public/databases" })).statusCode, 429);
  assert.equal((await h.as(token).get("/public/databases")).statusCode, 200);
});
