import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { type Fixture, type Harness, DASHBOARD, json, startHarness } from "../helpers/harness.ts";

let h: Harness;
let u: Fixture;
before(async () => { h = await startHarness({ RATE_LIMIT_ANON_PER_MINUTE: "1000" }); u = await h.user("Auth Ann"); });
after(async () => { await h.close(); });

const err = (res: { body: string }) => json(res).error as { code: string; message: string; field?: string };
const inject = (method: string, url: string, headers: Record<string, string> = {}, payload?: unknown) =>
  h.app.fastify.inject({ method: method as "GET", url: `/v1${url}`, headers, payload: payload as object });
const cookiesOf = (res: { cookies: { name: string; value: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; maxAge?: number }[] }) =>
  Object.fromEntries(res.cookies.map((c) => [c.name, c]));

describe("every data endpoint needs a session or an API key", () => {
  const endpoints: [string, string][] = [
    ["GET", "/databases"], ["GET", "/databases/ids"], ["GET", "/databases/groups?groupBy=x"], ["GET", "/tags"], ["GET", "/regions"],
    ["GET", "/databases/00000000-0000-4000-8000-000000000000"], ["GET", "/databases/00000000-0000-4000-8000-000000000000/usage?range=7d"],
    ["POST", "/databases"], ["POST", "/databases/00000000-0000-4000-8000-000000000000/fork"], ["POST", "/databases/00000000-0000-4000-8000-000000000000/restore"],
    ["POST", "/databases/export"], ["POST", "/databases/erase"], ["POST", "/databases/keep-awake"], ["PUT", "/databases/00000000-0000-4000-8000-000000000000/tags"],
    ["POST", "/databases/tags/add"], ["POST", "/databases/tags/remove"], ["GET", "/overview?range=7d"], ["GET", "/tags/breakdown?key=x"],
    ["GET", "/usage/months"], ["GET", "/usage?month=2026-10&by=database"], ["GET", "/usage/export?month=2026-10&by=database"], ["GET", "/usage/history"],
    ["GET", "/usage/trend?month=2026-10&tagKey=x"], ["GET", "/plans"], ["GET", "/billing"], ["GET", "/invoices"],
    ["POST", "/invoices/00000000-0000-4000-8000-000000000000/download"], ["GET", "/api-keys"], ["POST", "/api-keys"],
    ["POST", "/api-keys/00000000-0000-4000-8000-000000000000/revoke"], ["GET", "/settings"], ["PUT", "/settings"],
    ["GET", "/operations"], ["GET", "/operations/00000000-0000-4000-8000-000000000000"],
  ];
  test("401 unauthenticated for all of them, with the contract error body", async () => {
    for (const [m, url] of endpoints) {
      const res = await inject(m, url, {}, m === "GET" ? undefined : {});
      assert.equal(res.statusCode, 401, `${m} ${url}`);
      assert.equal(err(res).code, "unauthenticated", `${m} ${url}`);
    }
  });

  test("a garbage cookie, an expired token, a wrong-audience token and a forged key are all 401", async () => {
    const expired = await h.signer.token({ id: u.userId, email: u.email }, { expiresIn: "-1m" });
    const wrongAud = await h.signer.token({ id: u.userId, email: u.email }, { audience: "anon" });
    const cases: Record<string, string>[] = [
      { cookie: "fnx_session=garbage" }, { cookie: `fnx_session=${expired}` }, { cookie: `fnx_session=${wrongAud}` },
      { authorization: "Bearer fnx_deadbeef" }, { authorization: `Bearer fnx_${randomBytes(32).toString("hex")}` }, { authorization: "Bearer nonsense" }, { authorization: "Basic abc" },
    ];
    for (const headers of cases) {
      const res = await inject("GET", "/databases", headers);
      assert.equal(res.statusCode, 401, JSON.stringify(headers));
    }
  });

  test("a valid token of a user without a workspace is 403 forbidden", async () => {
    const id = "99999999-9999-4999-8999-999999999999";
    await h.admin.query("insert into auth.users (id, email) values ($1, 'lonely@example.invalid') on conflict do nothing", [id]);
    await h.admin.query("delete from public.workspace_members where user_id = $1", [id]);
    const token = await h.signer.token({ id, email: "lonely@example.invalid" });
    const res = await inject("GET", "/databases", { cookie: `fnx_session=${token}` });
    assert.equal(res.statusCode, 403);
    assert.equal(err(res).code, "forbidden");
  });
});

describe("session JWT (Supabase, verified against the JWKS) and API keys", () => {
  test("a session cookie works, and so does a bearer JWT; the JWKS was fetched from the configured URL", async () => {
    assert.equal((await h.as(u).get("/regions")).statusCode, 200);
    const bearer = await inject("GET", "/regions", { authorization: `Bearer ${u.token}` });
    assert.equal(bearer.statusCode, 200);
    assert.ok(h.signer.jwksFetches >= 1);
  });

  test("an API key works, is scoped to its workspace, and records last use", async () => {
    const key = await h.apiKey(u.workspaceId);
    assert.equal(json(await h.as(u).get("/api-keys")).items[0].lastUsedAt, null);
    const created = await h.as(key).post("/databases", { name: "by-key-01", region: "eu-central-1" });
    assert.equal(created.statusCode, 201, created.body);
    const seen = await h.admin.query("select workspace_id from public.databases where id = $1", [json(created).id]);
    assert.equal(seen.rows[0].workspace_id, u.workspaceId);
    assert.ok(json(await h.as(u).get("/api-keys")).items.some((k: { lastUsedAt: string | null }) => k.lastUsedAt !== null));
  });

  test("a revoked API key stops working at once", async () => {
    const created = json(await h.as(u).post("/api-keys", { name: "to revoke" }));
    assert.equal((await h.as(created.secret).get("/regions")).statusCode, 200);
    assert.equal((await h.as(u).post(`/api-keys/${created.key.id}/revoke`)).statusCode, 200);
    const res = await h.as(created.secret).get("/regions");
    assert.equal(res.statusCode, 401);
  });

  test("keys made through the API are stored only as a hash, in the format the dashboard uses", async () => {
    const created = json(await h.as(u).post("/api-keys", { name: "format" }));
    assert.match(created.secret, /^fnx_[0-9a-f]{64}$/);
    assert.equal(created.key.hint, created.secret.slice(-4));
    const row = (await h.admin.query("select key_hash, name, last4 from public.api_keys where id = $1", [created.key.id])).rows[0];
    assert.equal(row.key_hash, createHash("sha256").update(created.secret).digest("hex"));
    const all = JSON.stringify((await h.admin.query("select * from public.api_keys")).rows) + JSON.stringify((await h.admin.query("select * from public.audit_log")).rows);
    assert.ok(!all.includes(created.secret), "the secret is nowhere in the database");
  });

  test("API keys cannot manage keys or settings; members cannot either", async () => {
    const key = await h.apiKey(u.workspaceId);
    for (const [m, url, body] of [["GET", "/api-keys"], ["POST", "/api-keys", { name: "x" }], ["PUT", "/settings", { workspaceName: "x", idleMinutes: 5, emailNotices: true }]] as const) {
      const res = await inject(m, `${url}`, { authorization: `Bearer ${key}` }, body);
      assert.equal(res.statusCode, 403, `${m} ${url}`);
      assert.equal(err(res).code, "forbidden");
    }
    const member = await h.addMember(u.workspaceId, "Mia", "member");
    assert.equal((await h.as(member).get("/api-keys")).statusCode, 403);
    assert.equal((await h.as(member).put("/settings", { workspaceName: "x", idleMinutes: 5, emailNotices: true })).statusCode, 403);
    assert.equal((await h.as(member).get("/settings")).statusCode, 200, "members can read");
    assert.equal((await h.as(member).post("/databases", { name: "member-made-01", region: "eu-central-1" })).statusCode, 201);
    const admin = await h.addMember(u.workspaceId, "Adam", "admin");
    assert.equal((await h.as(admin).get("/api-keys")).statusCode, 200);
  });

  test("a cookie-authenticated change from another site is refused; from the dashboard it is allowed", async () => {
    const evil = await inject("POST", "/databases/keep-awake", { cookie: `fnx_session=${u.token}`, origin: "https://evil.example" }, { ids: ["00000000-0000-4000-8000-000000000000"], enabled: true });
    assert.equal(evil.statusCode, 403);
    const ok = await inject("POST", "/databases/keep-awake", { cookie: `fnx_session=${u.token}`, origin: DASHBOARD }, { ids: ["00000000-0000-4000-8000-000000000000"], enabled: true });
    assert.equal(ok.statusCode, 200);
    const get = await inject("GET", "/regions", { cookie: `fnx_session=${u.token}`, origin: "https://evil.example" });
    assert.equal(get.statusCode, 200, "reads are not state changes");
  });

  test("CORS: the dashboard origin is allowed with credentials, others get nothing", async () => {
    const ok = await h.app.fastify.inject({ method: "OPTIONS", url: "/v1/databases", headers: { origin: DASHBOARD, "access-control-request-method": "POST", "access-control-request-headers": "content-type,idempotency-key" } });
    assert.equal(ok.headers["access-control-allow-origin"], DASHBOARD);
    assert.equal(ok.headers["access-control-allow-credentials"], "true");
    const no = await h.app.fastify.inject({ method: "OPTIONS", url: "/v1/databases", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(no.headers["access-control-allow-origin"], undefined);
  });

  test("an expired session cookie is renewed with the refresh cookie, and new cookies are set", async () => {
    h.gateway.accessLifetime = "-1m";
    const stale = await h.gateway.session({ id: u.userId, email: u.email, name: u.name });
    h.gateway.accessLifetime = "1h";
    const res = await inject("GET", "/databases", { cookie: `fnx_session=${stale.accessToken}; fnx_refresh=${stale.refreshToken}` });
    assert.equal(res.statusCode, 200);
    const c = cookiesOf(res);
    assert.ok(c.fnx_session && c.fnx_refresh, "cookies renewed");
    assert.notEqual(c.fnx_session!.value, stale.accessToken);
    const reuse = await inject("GET", "/databases", { cookie: `fnx_session=${stale.accessToken}; fnx_refresh=${stale.refreshToken}` });
    assert.equal(reuse.statusCode, 401, "a refresh token works once");
  });
});

describe("section 3: sign-in", () => {
  test("GET /session: 401 when signed out, the SessionUser when signed in", async () => {
    assert.equal(err(await inject("GET", "/session")).code, "unauthenticated");
    const res = await h.as(u).get("/session");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { id: u.userId, name: "Auth Ann", email: u.email, avatarUrl: null });
  });

  test("sign in with a provider: redirectUrl, then the callback sets the cookies and returns to returnTo", async () => {
    const start = await inject("POST", "/session/providers/github", {}, { returnTo: `${DASHBOARD}/overview` });
    assert.equal(start.statusCode, 200, start.body);
    const { redirectUrl } = json(start);
    const q = new URL(redirectUrl).searchParams;
    assert.equal(q.get("provider"), "github");
    assert.equal(q.get("redirect_to"), "https://api.fenvix.test/v1/session/providers/github/callback");
    assert.equal(q.get("code_challenge_method"), "s256");
    const oauth = cookiesOf(start).fnx_oauth!;
    assert.ok(oauth.httpOnly && oauth.secure && oauth.sameSite === "Lax");
    assert.ok(!redirectUrl.includes(Buffer.from(oauth.value, "base64url").toString("utf8").match(/"v":"([^"]+)"/)![1]!), "the verifier never leaves the server");

    const code = h.gateway.approve({ id: u.userId, email: u.email, name: u.name }, redirectUrl);
    const back = await inject("GET", `/session/providers/github/callback?code=${code}`, { cookie: `fnx_oauth=${oauth.value}` });
    assert.equal(back.statusCode, 302);
    assert.equal(back.headers.location, `${DASHBOARD}/overview`);
    const c = cookiesOf(back);
    assert.ok(c.fnx_session!.httpOnly && c.fnx_session!.secure && c.fnx_session!.sameSite === "Lax");
    assert.ok(c.fnx_refresh!.httpOnly);
    const me = await inject("GET", "/session", { cookie: `fnx_session=${c.fnx_session!.value}` });
    assert.equal(json(me).email, u.email);
  });

  test("a failed or cancelled sign-in goes back to returnTo with ?error=sign_in_failed", async () => {
    const start = await inject("POST", "/session/providers/google", {}, { returnTo: `${DASHBOARD}/overview` });
    const oauth = cookiesOf(start).fnx_oauth!.value;
    const cancelled = await inject("GET", "/session/providers/google/callback?error=access_denied", { cookie: `fnx_oauth=${oauth}` });
    assert.equal(cancelled.statusCode, 302);
    assert.equal(cancelled.headers.location, `${DASHBOARD}/overview?error=sign_in_failed`);
    const badCode = await inject("GET", "/session/providers/google/callback?code=wrong", { cookie: `fnx_oauth=${oauth}` });
    assert.equal(badCode.headers.location, `${DASHBOARD}/overview?error=sign_in_failed`);
    assert.equal(cookiesOf(badCode).fnx_session, undefined);
    const noCookie = await inject("GET", "/session/providers/google/callback?code=x");
    assert.equal(noCookie.headers.location, `${DASHBOARD}?error=sign_in_failed`.replace("https://app.fenvix.test?", "https://app.fenvix.test/?"));
  });

  test("a code only works with the browser that started the sign-in (PKCE)", async () => {
    const a = await inject("POST", "/session/providers/github", {}, { returnTo: `${DASHBOARD}/` });
    const b = await inject("POST", "/session/providers/github", {}, { returnTo: `${DASHBOARD}/` });
    const code = h.gateway.approve({ id: u.userId, email: u.email, name: u.name }, json(a).redirectUrl);
    const res = await inject("GET", `/session/providers/github/callback?code=${code}`, { cookie: `fnx_oauth=${cookiesOf(b).fnx_oauth!.value}` });
    assert.match(String(res.headers.location), /error=sign_in_failed/);
  });

  test("returnTo must be a dashboard address; the provider must be github or google", async () => {
    for (const returnTo of ["https://evil.example/", "javascript:alert(1)", "/overview", "", 5, undefined]) {
      const res = await inject("POST", "/session/providers/github", {}, { returnTo });
      assert.equal(res.statusCode, 400, String(returnTo));
      assert.equal(err(res).field, "returnTo");
    }
    assert.equal((await inject("POST", "/session/providers/facebook", {}, { returnTo: `${DASHBOARD}/` })).statusCode, 400);
  });

  test("email link: 202 {} whether or not the address exists; the link works once; the cookie is set", async () => {
    const known = await inject("POST", "/session/email-link", {}, { email: u.email });
    const unknown = await inject("POST", "/session/email-link", {}, { email: "nobody.at.all@example.invalid" });
    assert.equal(known.statusCode, 202);
    assert.equal(known.body, "{}");
    assert.equal(unknown.statusCode, 202);
    assert.equal(unknown.body, "{}");
    assert.equal(h.gateway.sentEmails.at(-1)!.redirectTo, `${DASHBOARD}/`);

    const token = h.gateway.latestToken(u.email);
    const done = await inject("POST", "/session/email-link/complete", {}, { token });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(json(done).email, u.email);
    assert.ok(cookiesOf(done).fnx_session);
    const again = await inject("POST", "/session/email-link/complete", {}, { token });
    assert.equal(again.statusCode, 400);
    assert.deepEqual(err(again), { code: "validation_failed", message: "This sign-in link has expired. Request a new one.", field: "token" });
  });

  test("an expired, unknown or missing token gets the same 400 message", async () => {
    await inject("POST", "/session/email-link", {}, { email: "expiry@example.invalid" });
    const token = h.gateway.latestToken("expiry@example.invalid");
    h.gateway.expireToken(token);
    for (const body of [{ token }, { token: "unknown" }, {}, { token: 5 }]) {
      const res = await inject("POST", "/session/email-link/complete", {}, body);
      assert.equal(res.statusCode, 400);
      assert.equal(err(res).message, "This sign-in link has expired. Request a new one.");
    }
  });

  test("email link: 400 for a malformed address; 429 with Retry-After after 5 links per address per hour", async () => {
    assert.equal((await inject("POST", "/session/email-link", {}, { email: "not an email" })).statusCode, 400);
    for (let i = 0; i < 5; i++) assert.equal((await inject("POST", "/session/email-link", {}, { email: "Limited@Example.invalid" })).statusCode, 202);
    const sixth = await inject("POST", "/session/email-link", {}, { email: "limited@example.invalid" });
    assert.equal(sixth.statusCode, 429);
    assert.equal(err(sixth).code, "rate_limited");
    assert.ok(Number(sixth.headers["retry-after"]) > 0);
    assert.equal((await inject("POST", "/session/email-link", {}, { email: "someone.else@example.invalid" })).statusCode, 202);
  });

  test("when Supabase cannot send the email the answer is still 202 (nothing is revealed)", async () => {
    h.gateway.failSending = true;
    const res = await inject("POST", "/session/email-link", {}, { email: "fails@example.invalid" });
    h.gateway.failSending = false;
    assert.equal(res.statusCode, 202);
  });

  test("DELETE /session: 204, cookies cleared, Supabase told; signing out again is also 204", async () => {
    const res = await inject("DELETE", "/session", { cookie: `fnx_session=${u.token}; fnx_refresh=x` });
    assert.equal(res.statusCode, 204);
    const cleared = res.cookies.filter((c) => c.value === "");
    assert.deepEqual(cleared.map((c) => c.name).sort(), ["fnx_refresh", "fnx_session"]);
    assert.ok(h.gateway.signedOut.includes(u.token));
    assert.equal((await inject("DELETE", "/session")).statusCode, 204);
  });
});

describe("rate limiting", () => {
  test("429 rate_limited with Retry-After once a workspace goes over its limit; other workspaces are unaffected", async () => {
    const t = await startHarness({ RATE_LIMIT_PER_MINUTE: "5", RATE_LIMIT_ANON_PER_MINUTE: "5" });
    try {
      const a = await t.user();
      const b = await t.user();
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await t.as(a).get("/regions")).statusCode);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
      const limited = await t.as(a).get("/regions");
      assert.equal(json(limited).error.code, "rate_limited");
      assert.match(String(limited.headers["retry-after"]), /^\d+$/);
      assert.equal((await t.as(b).get("/regions")).statusCode, 200);
    } finally { await t.close(); }
  });

  test("guessing API keys is slowed down per address", async () => {
    const t = await startHarness({ RATE_LIMIT_ANON_PER_MINUTE: "3" });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await t.app.fastify.inject({ method: "GET", url: "/v1/regions", headers: { authorization: `Bearer fnx_${i}` } })).statusCode);
      assert.deepEqual(codes, [401, 401, 401, 429, 429, 429]);
    } finally { await t.close(); }
  });
});
