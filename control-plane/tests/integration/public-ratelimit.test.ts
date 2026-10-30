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

/** Counts the key lookups (fenvix_cp_resolve_public_api_key) the service makes from now on. */
function countLookups(): { n: number } {
  const db = h.app.deps.s.db;
  const counter = { n: 0 };
  const system = db.system.bind(db);
  db.system = (fn) => system((c) => fn(new Proxy(c, {
    get(target, prop) {
      if (prop === "query") {
        return (...args: unknown[]) => {
          if (String(args[0]).includes("fenvix_cp_resolve_public_api_key")) counter.n++;
          return (target.query as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  })));
  return counter;
}

test("more than 30 made-up keys from one address: refused before any lookup; a valid key and the spec still work", async () => {
  const lookups = countLookups();
  const codes: number[] = [];
  for (let i = 0; i < 45; i++) {
    codes.push((await h.as(`fvx_${randomBytes(32).toString("base64url")}`).get("/public/organization")).statusCode);
  }
  // The first 30 are looked up and refused (401); from the 31st on the address is over its budget and nothing more is
  // looked up (429).
  assert.ok(codes.slice(0, 30).every((c) => c === 401), codes.join(","));
  assert.ok(codes.slice(30).every((c) => c === 429), codes.join(","));
  assert.equal(lookups.n, 30, "no lookup once the address is over its budget");
  // Malformed keys and no key at all are refused without a lookup in any case.
  assert.equal((await h.as("fvx_short").get("/public/organization")).statusCode, 429);
  assert.equal((await h.app.fastify.inject({ method: "GET", url: "/v1/public/databases" })).statusCode, 429);
  assert.equal(lookups.n, 30);
  // The valid key (known to this instance: it made it, and it was used) still works from the same address, and is
  // still looked up every time (a revoke takes effect at once).
  const ok = await h.as(token).get("/public/organization");
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await h.as(token).get("/public/databases")).statusCode, 200);
  assert.equal(lookups.n, 32);
  // The spec has its own counter.
  assert.equal((await h.app.fastify.inject({ method: "GET", url: "/v1/openapi.json" })).statusCode, 200);
});

test("a known key that is revoked while the address is locked out is refused, and is not looked up again", async () => {
  const w = await h.user("Rev");
  // Made by a person from another address (the dashboard's own sign-in check also uses the locked-out address's budget).
  const made = await h.app.fastify.inject({
    method: "POST", url: "/v1/public/api-keys", remoteAddress: "10.0.0.9", payload: { name: "rv", role: "read_only" },
    headers: { cookie: `fnx_session=${w.token}`, "x-fenvix-workspace": w.workspaceId },
  });
  assert.equal(made.statusCode, 201, made.body);
  const k = json(made);
  // 127.0.0.1 is still over its budget from the test above; the key is known (just made here), so it is looked up.
  assert.equal((await h.as(k.token).get("/public/organization")).statusCode, 200);
  await h.admin.query("update public.public_api_keys set revoked_at = now() where id = $1", [k.key.id]);
  const lookups = countLookups();
  assert.equal((await h.as(k.token).get("/public/organization")).statusCode, 429, "revoked: refused (the address is over its budget)");
  assert.equal(lookups.n, 1);
  assert.equal((await h.as(k.token).get("/public/organization")).statusCode, 429);
  assert.equal(lookups.n, 1, "no longer known: no second lookup");
});
