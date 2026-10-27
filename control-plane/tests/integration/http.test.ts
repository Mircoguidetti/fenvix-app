import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";

let h: Harness;
let u: Fixture;
before(async () => { h = await startHarness(); u = await h.user("Http Hana"); });
after(async () => { await h.close(); });

describe("request ids and error shape", () => {
  test("every answer has an X-Request-Id; a good one sent by the caller is kept, a bad one is replaced", async () => {
    const a = await h.app.fastify.inject("/healthz");
    assert.match(String(a.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
    const b = await h.app.fastify.inject({ url: "/healthz", headers: { "x-request-id": "client-chosen-id-1" } });
    assert.equal(b.headers["x-request-id"], "client-chosen-id-1");
    const c = await h.app.fastify.inject({ url: "/healthz", headers: { "x-request-id": "bad id with spaces\nand newline" } });
    assert.notEqual(c.headers["x-request-id"], "bad id with spaces\nand newline");
    const err = await h.app.fastify.inject("/v1/databases");
    assert.ok(err.headers["x-request-id"], "also on errors");
  });

  test("unknown paths are 404 not_found in the contract shape; so are wrong methods", async () => {
    const res = await h.app.fastify.inject("/v1/nope");
    assert.equal(res.statusCode, 404);
    assert.equal(json(res).error.code, "not_found");
    assert.equal((await h.app.fastify.inject({ method: "DELETE", url: "/v1/databases" })).statusCode, 404);
  });

  test("a body that is not JSON, or a JSON array, is 400 validation_failed; so is an oversized body", async () => {
    const bad = await h.app.fastify.inject({ method: "POST", url: "/v1/databases", headers: { cookie: `fnx_session=${u.token}`, "content-type": "application/json" }, payload: "{not json" });
    assert.equal(bad.statusCode, 400);
    assert.equal(json(bad).error.code, "validation_failed");
    const big = await h.app.fastify.inject({ method: "POST", url: "/v1/databases", headers: { cookie: `fnx_session=${u.token}`, "content-type": "application/json" }, payload: JSON.stringify({ name: "x".repeat(300_000) }) });
    assert.equal(big.statusCode, 400);
    const text = await h.app.fastify.inject({ method: "POST", url: "/v1/databases", headers: { cookie: `fnx_session=${u.token}`, "content-type": "text/plain" }, payload: "hello" });
    assert.equal(text.statusCode, 400);
  });

  test("an unexpected failure is a 500 internal with a plain message and no internals; the log has the details and the request id", async () => {
    const db = h.app.deps.s.db;
    const real = db.tx.bind(db);
    db.tx = (async () => { throw new Error("connect ECONNREFUSED 10.9.8.7:5432 (internal-detail-xyz)"); }) as typeof db.tx;
    h.logs.lines.length = 0;
    let res;
    try { res = await h.app.fastify.inject({ method: "GET", url: "/v1/databases", headers: { cookie: `fnx_session=${u.token}`, "x-request-id": "boom-request-0001" } }); }
    finally { db.tx = real; }
    assert.equal(res.statusCode, 500);
    assert.deepEqual(json(res), { error: { code: "internal", message: "Something went wrong on our side. Try again in a moment." } });
    assert.ok(!/ECONN|internal-detail|10\.9\.8\.7/.test(res.body));
    const line = h.logs.lines.map((l) => JSON.parse(l)).find((o) => o.msg === "request failed");
    assert.ok(line, "the failure is logged");
    assert.equal(line.reqId, "boom-request-0001");
    assert.match(JSON.stringify(line.err), /internal-detail-xyz/);
    assert.equal(line.level, 50);
    assert.equal((await h.as(u).get("/databases")).statusCode, 200, "and the service carries on");
  });

  test("responses that carry data are not cacheable", async () => {
    assert.equal((await h.as(u).get("/databases")).headers["cache-control"], "no-store");
    assert.equal((await h.as(u).post("/databases/keep-awake", { ids: ["00000000-0000-4000-8000-000000000000"], enabled: false })).headers["cache-control"], "no-store");
  });
});

describe("logs: structured, with request ids, and no secrets", () => {
  test("a busy mix of requests leaves JSON lines with request ids, and none of the secrets we know about", async () => {
    const key = await h.apiKey(u.workspaceId);
    const created = json(await h.as(u).post("/api-keys", { name: "log check" }));
    h.logs.lines.length = 0;

    await h.as(key).get("/databases?search=secret-looking");
    await h.as(u).post("/databases", { name: "log-db-01", region: "eu-central-1", tags: ["customer:acme"] });
    await h.as(created.secret).get("/regions");
    await h.app.fastify.inject({ method: "GET", url: "/v1/regions", headers: { authorization: "Bearer fnx_not_a_real_key_but_looks_like_one" } });
    await h.app.fastify.inject({ method: "GET", url: "/v1/session/providers/github/callback?code=oauth-code-12345&state=abc" });
    await h.app.fastify.inject({ method: "POST", url: "/v1/session/email-link/complete", payload: { token: "email-token-hash-98765" } });
    await h.app.fastify.inject({ method: "POST", url: "/v1/session/email-link", payload: { email: "private.person@example.invalid" } });
    const res = await h.as(u).post("/databases/export", { ids: [json(await h.as(u).get("/databases")).items[0].id] });
    assert.equal(res.statusCode, 200);

    const text = h.logs.text();
    assert.ok(h.logs.lines.length > 10, "there are log lines");
    for (const line of h.logs.lines) {
      const o = JSON.parse(line);
      assert.ok(o.level !== undefined && o.time !== undefined);
      if (o.msg === "request completed") {
        assert.ok(o.reqId, "request id on the access log line");
        assert.equal(typeof o.res.statusCode, "number");
        assert.equal(typeof o.responseTime, "number");
      }
      if (o.msg === "incoming request") {
        assert.ok(o.reqId && o.req.path.startsWith("/"), "request id and path on the first line of each request");
        assert.ok(!o.req.path.includes("?"), "no query string in the path");
      }
    }
    const forbidden: [string, string][] = [
      ["API key", key], ["new API key secret", created.secret], ["session token", u.token], ["tokens in a cookie header", "fnx_session="],
      ["partial key", "fnx_not_a_real_key"], ["oauth code", "oauth-code-12345"], ["email token", "email-token-hash-98765"], ["email address", "private.person@example.invalid"],
      ["database password", cpPasswordOf(h)], ["database url", "postgresql://"], ["connection string", "mongodb://"], ["authorization header", "Bearer "], ["signing key", h.cfg.downloadSigningKey],
    ];
    for (const [what, needle] of forbidden) assert.ok(!text.includes(needle), `${what} must not be in the logs`);
    assert.ok(text.includes("workspaceId"), "authenticated requests are tagged with their workspace");
  });
});

const cpPasswordOf = (hh: Harness) => hh.cpPassword;
