import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Fixture, type Harness, json, startHarness } from "../helpers/harness.ts";
import { TOKEN_RE, auditThrottle, revokeUndelivered } from "../../src/services/apikeys.ts";

/** The public API (docs/public-api.md): keys, authentication, roles, idempotency, rate limits, the endpoints. */
let h: Harness;
let owner: Fixture;
let adminToken: string;
const PER_KEY = 200;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
/** A session must name the organization whose keys it manages. */
const inOrg = (f: Fixture) => ({ "x-fenvix-workspace": f.workspaceId });

async function makeKey(who: Fixture | string, role: "admin" | "read_only", extra: Record<string, unknown> = {}, headers?: Record<string, string>) {
  const r = await h.as(who).post("/public/api-keys", { name: `${role} key`, role, ...extra }, headers ?? (typeof who === "string" ? undefined : inOrg(who)));
  assert.equal(r.statusCode, 201, r.body);
  return json<{ key: { id: string; prefix: string; role: string; status: string }; token: string }>(r);
}

before(async () => {
  h = await startHarness({ RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_ANON_PER_MINUTE: "100000", PUBLIC_API_RATE_LIMIT_PER_MINUTE: String(PER_KEY) });
  owner = await h.user("Owner");
  adminToken = (await makeKey(owner, "admin")).token;
});
after(async () => { await h.close(); });

describe("API keys", () => {
  test("created by an owner's session: fvx_ token shown once, only the SHA-256 and a prefix stored", async () => {
    const r = await h.as(owner).post("/public/api-keys", { name: "ci", role: "read_only" }, inOrg(owner));
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.headers["pragma"], "no-cache");
    assert.equal(r.headers["cache-control"], "no-store");
    const { key, token } = json(r);
    assert.match(token, TOKEN_RE);
    assert.equal(key.prefix, token.slice(0, 12));
    assert.equal(key.role, "read_only");
    assert.equal(key.status, "active");
    const row = (await h.admin.query("select * from public.public_api_keys where id = $1", [key.id])).rows[0];
    assert.equal(row.key_hash, sha(token));
    assert.equal(row.workspace_id, owner.workspaceId);
    assert.equal(row.created_by_type, "user");
    // The token is in no column of the row, and not in the audit log.
    const all = (await h.admin.query("select row_to_json(k)::text as t from public.public_api_keys k")).rows.map((x) => x.t).join("\n");
    assert.ok(!all.includes(token) && !all.includes(token.slice(12)));
    const audit = (await h.admin.query("select action, metadata::text as m from public.audit_log where workspace_id = $1 and target_id = $2", [owner.workspaceId, key.id])).rows;
    assert.deepEqual(audit.map((a) => a.action), ["api_key.public.create"]);
    assert.ok(!audit.some((a) => a.m.includes(token)));
  });

  test("listed with prefix, role and status, never the key; newest first with cursor pages", async () => {
    const made = [await makeKey(owner, "read_only"), await makeKey(owner, "read_only"), await makeKey(owner, "admin")];
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await h.as(adminToken).get(`/public/api-keys?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(r.statusCode, 200, r.body);
      for (const t of made) assert.ok(!r.body.includes(t.token));
      for (const k of json(r).items) { assert.ok(!("token" in k) && !("keyHash" in k)); assert.match(k.prefix, /^fvx_.{8}$/); seen.push(k.id); }
      cursor = json(r).nextCursor;
      pages++;
    } while (cursor);
    assert.ok(pages >= 3);
    assert.equal(new Set(seen).size, seen.length, "no key twice across pages");
    assert.deepEqual(seen.slice(0, 3), made.map((m) => m.key.id).reverse());
  });

  test("revoked: refused at once with 401, recorded as a failed authentication", async () => {
    const k = await makeKey(owner, "admin");
    assert.equal((await h.as(k.token).get("/public/organization")).statusCode, 200);
    const r = await h.as(adminToken).del(`/public/api-keys/${k.key.id}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(json(r).status, "revoked");
    const refused = await h.as(k.token).get("/public/organization");
    assert.equal(refused.statusCode, 401);
    assert.equal(json(refused).error.code, "unauthenticated");
    assert.ok(!refused.body.includes(k.token) && !refused.body.includes(k.key.prefix));
    // However often the revoked key is tried, one audit row a minute.
    for (let i = 0; i < 5; i++) assert.equal((await h.as(k.token).get("/public/databases")).statusCode, 401);
    const a = (await h.admin.query("select actor_type, actor_id, outcome, metadata from public.audit_log where workspace_id = $1 and action = 'api_key.public.auth_failed' and target_id = $2", [owner.workspaceId, k.key.id])).rows;
    assert.equal(a.length, 1);
    assert.equal(a[0].outcome, "denied");
    assert.equal(a[0].metadata.reason, "revoked");
    const rev = (await h.admin.query("select action from public.audit_log where workspace_id = $1 and action = 'api_key.public.revoke' and target_id = $2", [owner.workspaceId, k.key.id])).rows;
    assert.equal(rev.length, 1);
  });

  test("expired: refused with 401 and listed as expired", async () => {
    const token = `fvx_${randomBytes(32).toString("base64url")}`;
    const id = (await h.admin.query(
      `insert into public.public_api_keys (workspace_id, name, role, key_hash, prefix, created_by_type, created_by, created_at, expires_at)
       values ($1, 'old', 'admin', $2, $3, 'user', $4, now() - interval '2 days', now() - interval '1 day') returning id`,
      [owner.workspaceId, sha(token), token.slice(0, 12), owner.userId])).rows[0].id;
    const r = await h.as(token).get("/public/databases");
    assert.equal(r.statusCode, 401);
    const a = (await h.admin.query("select metadata from public.audit_log where action = 'api_key.public.auth_failed' and target_id = $1", [id])).rows;
    assert.equal(a[0].metadata.reason, "expired");
    const listed = json(await h.as(adminToken).get("/public/api-keys?limit=100")).items.find((k: { id: string }) => k.id === id);
    assert.equal(listed.status, "expired");
  });

  test("an expiry date is kept, and must be in the future", async () => {
    const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const k = await makeKey(owner, "read_only", { expiresAt: at });
    assert.equal(new Date(json(await h.as(adminToken).get("/public/api-keys?limit=100")).items.find((x: { id: string }) => x.id === k.key.id).expiresAt).getTime(), new Date(at).getTime());
    assert.equal(json(await h.as(k.token).get("/public/organization")).apiKey.role, "read_only");
    const past = await h.as(owner).post("/public/api-keys", { name: "x", role: "admin", expiresAt: "2020-01-01T00:00:00Z" }, inOrg(owner));
    assert.equal(past.statusCode, 400);
    assert.equal(json(past).error.field, "expiresAt");
  });

  test("bad bodies: role, name and unknown fields are refused", async () => {
    for (const [body, field] of [[{ name: "x", role: "owner" }, "role"], [{ name: "", role: "admin" }, "name"], [{ name: "x", role: "admin", scopes: ["*"] }, "scopes"]] as const) {
      const r = await h.as(owner).post("/public/api-keys", body, inOrg(owner));
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(json(r).error.field, field);
    }
  });

  test("an admin key can make read_only keys; a member's session cannot; a dashboard fnx_ key cannot", async () => {
    const k = await makeKey(adminToken, "read_only");
    assert.equal((await h.admin.query("select created_by_type from public.public_api_keys where id = $1", [k.key.id])).rows[0].created_by_type, "api_key");
    const member = await h.addMember(owner.workspaceId, "Mia", "member");
    assert.equal((await h.as(member).post("/public/api-keys", { name: "m", role: "admin" }, inOrg(member))).statusCode, 403);
    assert.equal((await h.as(member).get("/public/api-keys", inOrg(member))).statusCode, 403);
    const fnx = await h.apiKey(owner.workspaceId);
    assert.equal((await h.as(fnx).post("/public/api-keys", { name: "m", role: "admin" })).statusCode, 403);
  });
});

describe("authentication", () => {
  test("no key, a malformed key, an unknown key and a dashboard key: 401 in the usual error format, with a request id", async () => {
    const unknown = `fvx_${randomBytes(32).toString("base64url")}`;
    for (const headers of [{}, { authorization: "Bearer fvx_short" }, { authorization: `Bearer ${unknown}` }, { authorization: `Bearer ${await h.apiKey(owner.workspaceId)}` }]) {
      const r = await h.app.fastify.inject({ method: "GET", url: "/v1/public/databases", headers });
      assert.equal(r.statusCode, 401, JSON.stringify(headers));
      assert.equal(json(r).error.code, "unauthenticated");
      assert.equal(typeof json(r).error.message, "string");
      assert.ok(r.headers["x-request-id"]);
    }
    assert.ok(!h.logs.text().includes(unknown), "the key is never logged");
  });

  test("a public key does not open the dashboard routes", async () => {
    for (const url of ["/databases", "/overview", "/api-keys", "/settings"]) assert.equal((await h.as(adminToken).get(url)).statusCode, 401, url);
  });

  test("a key cannot name another organization", async () => {
    const other = await h.user("Other");
    const r = await h.as(adminToken).get("/public/databases", { "x-fenvix-workspace": other.workspaceId });
    assert.equal(r.statusCode, 404);
  });

  test("every answer carries X-Request-Id, and a valid one sent by the client is kept", async () => {
    const r = await h.as(adminToken).get("/public/organization", { "x-request-id": "client-req-12345" });
    assert.equal(r.headers["x-request-id"], "client-req-12345");
    assert.ok((await h.as(adminToken).get(`/public/databases/${randomUUID()}`)).headers["x-request-id"]);
    assert.ok((await h.app.fastify.inject({ method: "GET", url: "/v1/public/nothing-here" })).headers["x-request-id"]);
  });

  test("no key and no part of a key is ever logged", async () => {
    const k = await makeKey(owner, "admin");
    await h.as(k.token).get("/public/organization");
    await h.as(adminToken).del(`/public/api-keys/${k.key.id}`);
    await h.as(k.token).get("/public/organization");
    const text = h.logs.text();
    assert.ok(!text.includes(k.token));
    assert.ok(!text.includes(k.token.slice(4)));
    assert.ok(!text.includes(sha(k.token)));
    assert.ok(text.includes("public API key refused"));
  });
});

describe("read-only keys", () => {
  test("can read, cannot change anything (403), and the refusal is audited", async () => {
    const ro = (await makeKey(owner, "read_only")).token;
    const dbId = json(await h.as(adminToken).post("/public/databases", { name: "ro-target", region: "eu-central-1" })).id;
    const before = JSON.stringify((await h.admin.query("select id, name, engine_state from public.databases where workspace_id = $1 order by id", [owner.workspaceId])).rows);
    for (const url of ["/public/databases", `/public/databases/${dbId}`, `/public/databases/${dbId}/users`, `/public/databases/${dbId}/ip-allowlist`, "/public/organization"]) {
      assert.equal((await h.as(ro).get(url)).statusCode, 200, url);
    }
    const tries = [
      () => h.as(ro).post("/public/databases", { name: "ro-new", region: "eu-central-1" }),
      () => h.as(ro).del(`/public/databases/${dbId}`),
      () => h.as(ro).post(`/public/databases/${dbId}/users`, { username: "sneaky" }),
      () => h.as(ro).del(`/public/databases/${dbId}/users/app`),
      () => h.as(ro).put(`/public/databases/${dbId}/ip-allowlist`, { entries: ["10.0.0.0/8"] }),
      () => h.as(ro).post("/public/api-keys", { name: "escalate", role: "admin" }),
      () => h.as(ro).del(`/public/api-keys/${randomUUID()}`),
      () => h.as(ro).get("/public/api-keys"),
    ];
    for (const t of tries) {
      const r = await t();
      assert.equal(r.statusCode, 403, r.body);
      assert.equal(json(r).error.code, "forbidden");
    }
    assert.equal(JSON.stringify((await h.admin.query("select id, name, engine_state from public.databases where workspace_id = $1 order by id", [owner.workspaceId])).rows), before);
    assert.equal(json(await h.as(ro).get(`/public/databases/${dbId}/users`)).items.length, 1);
    assert.deepEqual(json(await h.as(ro).get(`/public/databases/${dbId}/ip-allowlist`)).entries, []);
    // One audit row a minute per key, however many refusals (the rest are counted into the next row).
    const roId = json(await h.as(ro).get("/public/organization")).apiKey.id;
    const denied = (await h.admin.query("select metadata from public.audit_log where workspace_id = $1 and action = 'api_key.public.denied' and target_id = $2", [owner.workspaceId, roId])).rows;
    assert.equal(denied.length, 1);
    assert.equal(denied[0].metadata.suppressed, 0);
  });
});

describe("endpoints", () => {
  test("databases: create (password once), get (status, no password), list with cursors, delete", async () => {
    const created = await h.as(adminToken).post("/public/databases", { name: "pub-one", region: "eu-central-1", tags: ["env:prod"] });
    assert.equal(created.statusCode, 201, created.body);
    const db = json(created);
    assert.equal(db.status, "ready");
    assert.equal(db.initialUser.username, "app");
    assert.equal(typeof db.initialUser.password, "string");
    assert.ok(db.initialUser.connectionString.includes(db.initialUser.password));
    assert.ok(created.headers["operation-id"]);

    const got = json(await h.as(adminToken).get(`/public/databases/${db.id}`));
    assert.equal(got.status, "ready");
    assert.ok(got.connectionString.includes("<password>"));
    assert.ok(!JSON.stringify(got).includes(db.initialUser.password));
    assert.ok(["awake", "asleep"].includes(got.state));

    for (const n of ["pub-two", "pub-three"]) assert.equal((await h.as(adminToken).post("/public/databases", { name: n, region: "eu-central-1" })).statusCode, 201);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await h.as(adminToken).get(`/public/databases?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(r.statusCode, 200, r.body);
      ids.push(...json(r).items.map((x: { id: string }) => x.id));
      cursor = json(r).nextCursor;
    } while (cursor);
    const total = (await h.admin.query("select count(*)::int as n from public.databases where workspace_id = $1", [owner.workspaceId])).rows[0].n;
    assert.equal(ids.length, total);
    assert.equal(new Set(ids).size, ids.length);

    assert.equal((await h.as(adminToken).get("/public/databases?cursor=bm9wZQ")).statusCode, 400);
    assert.equal((await h.as(adminToken).get("/public/databases?limit=0")).statusCode, 400);
    assert.equal((await h.as(adminToken).post("/public/databases", { name: "Bad Name!", region: "eu-central-1" })).statusCode, 400);

    const del = await h.as(adminToken).del(`/public/databases/${db.id}`);
    assert.equal(del.statusCode, 200, del.body);
    assert.deepEqual(json(del), { id: db.id, deleted: true });
    assert.equal((await h.as(adminToken).get(`/public/databases/${db.id}`)).statusCode, 404);
    assert.equal((await h.as(adminToken).del(`/public/databases/${db.id}`)).statusCode, 404);
    const op = json(await h.as(adminToken).get(`/public/operations/${del.headers["operation-id"]}`));
    assert.equal(op.status, "succeeded");
    assert.deepEqual(op.result, { id: db.id, deleted: true });
  });

  test("database users: create (password once), list with cursors, delete", async () => {
    const db = json(await h.as(adminToken).post("/public/databases", { name: "pub-users", region: "eu-central-1" })).id;
    const made = await h.as(adminToken).post(`/public/databases/${db}/users`, { username: "reporting", role: "read" });
    assert.equal(made.statusCode, 201, made.body);
    assert.equal(typeof json(made).password, "string");
    await h.as(adminToken).post(`/public/databases/${db}/users`, { username: "worker" });
    const p1 = json(await h.as(adminToken).get(`/public/databases/${db}/users?limit=2`));
    assert.deepEqual(p1.items.map((u: { username: string }) => u.username), ["app", "reporting"]);
    assert.ok(!JSON.stringify(p1).includes(json(made).password));
    const p2 = json(await h.as(adminToken).get(`/public/databases/${db}/users?limit=2&cursor=${p1.nextCursor}`));
    assert.deepEqual(p2.items.map((u: { username: string }) => u.username), ["worker"]);
    assert.equal(p2.nextCursor, null);
    const del = await h.as(adminToken).del(`/public/databases/${db}/users/worker`);
    assert.deepEqual(json(del), { username: "worker", deleted: true });
    assert.equal((await h.as(adminToken).del(`/public/databases/${db}/users/worker`)).statusCode, 404);
  });

  test("network allowlist: get and set", async () => {
    const db = json(await h.as(adminToken).post("/public/databases", { name: "pub-net", region: "eu-central-1" })).id;
    const set = await h.as(adminToken).put(`/public/databases/${db}/ip-allowlist`, { entries: ["203.0.113.7", "10.0.0.0/8"] });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(json(await h.as(adminToken).get(`/public/databases/${db}/ip-allowlist`)).entries.sort(), ["10.0.0.0/8", "203.0.113.7/32"]);
    const bad = await h.as(adminToken).put(`/public/databases/${db}/ip-allowlist`, { entries: ["not-an-ip"] });
    assert.equal(bad.statusCode, 400);
    assert.equal(json(bad).error.field, "entries[0]");
  });

  test("organization", async () => {
    const o = json(await h.as(adminToken).get("/public/organization"));
    assert.equal(o.id, owner.workspaceId);
    assert.equal(o.apiKey.role, "admin");
    assert.equal(typeof o.name, "string");
  });
});

describe("idempotency", () => {
  test("a create repeated with the same key: the same database, Idempotent-Replay, the password not shown again", async () => {
    const hdr = { "idempotency-key": `idem-${randomUUID()}` };
    const a = await h.as(adminToken).post("/public/databases", { name: "idem-db", region: "eu-central-1" }, hdr);
    const b = await h.as(adminToken).post("/public/databases", { name: "idem-db", region: "eu-central-1" }, hdr);
    assert.equal(a.statusCode, 201, a.body);
    assert.equal(b.statusCode, 201, b.body);
    assert.equal(json(a).id, json(b).id);
    assert.equal(b.headers["idempotent-replay"], "true");
    assert.equal(typeof json(a).initialUser.password, "string");
    assert.equal(json(b).initialUser.password, null);
    const other = await h.as(adminToken).post("/public/databases", { name: "idem-db-2", region: "eu-central-1" }, hdr);
    assert.equal(other.statusCode, 409);
    assert.equal((await h.admin.query("select count(*)::int as n from public.databases where workspace_id = $1 and name like 'idem-db%'", [owner.workspaceId])).rows[0].n, 1);
  });

  test("API key and database user creation never replay their secret: 409, nothing made twice", async () => {
    const hdr = { "idempotency-key": `idem-${randomUUID()}` };
    const first = await h.as(adminToken).post("/public/api-keys", { name: "once", role: "read_only" }, hdr);
    const again = await h.as(adminToken).post("/public/api-keys", { name: "once", role: "read_only" }, hdr);
    assert.equal(first.statusCode, 201);
    assert.equal(again.statusCode, 409);
    assert.ok(!again.body.includes(json(first).token));
    assert.equal((await h.admin.query("select count(*)::int as n from public.public_api_keys where workspace_id = $1 and name = 'once'", [owner.workspaceId])).rows[0].n, 1);

    const db = json(await h.as(adminToken).post("/public/databases", { name: "idem-users", region: "eu-central-1" })).id;
    const u = { "idempotency-key": `idem-${randomUUID()}` };
    assert.equal((await h.as(adminToken).post(`/public/databases/${db}/users`, { username: "batch" }, u)).statusCode, 201);
    const u2 = await h.as(adminToken).post(`/public/databases/${db}/users`, { username: "batch" }, u);
    assert.equal(u2.statusCode, 409);
    assert.ok(!/"password"/.test(u2.body));
  });

  test("a refused request is replayed as refused; a malformed key is a 400", async () => {
    const hdr = { "idempotency-key": `idem-${randomUUID()}` };
    const a = await h.as(adminToken).del(`/public/databases/${randomUUID()}`, hdr);
    const b = await h.as(adminToken).del(`/public/databases/${randomUUID()}`, hdr);
    assert.equal(a.statusCode, 404);
    assert.equal(b.statusCode, 409, "same key, different request");
    assert.equal((await h.as(adminToken).post("/public/databases", {}, { "idempotency-key": "bad key with spaces" })).statusCode, 400);
  });
});

describe("rate limits", () => {
  test("per key: the key over its limit gets 429 with Retry-After, another key of the same organization does not", async () => {
    const k1 = (await makeKey(owner, "read_only")).token;
    const k2 = (await makeKey(owner, "read_only")).token;
    for (let i = 0; i < PER_KEY; i++) assert.equal((await h.as(k1).get("/public/organization")).statusCode, 200, `request ${i}`);
    const over = await h.as(k1).get("/public/organization");
    assert.equal(over.statusCode, 429);
    assert.equal(json(over).error.code, "rate_limited");
    assert.ok(Number(over.headers["retry-after"]) >= 1);
    assert.equal((await h.as(k2).get("/public/organization")).statusCode, 200);
  });
});

describe("keys do not outlive their creator", () => {
  const revokedFor = async (id: string) => (await h.admin.query(
    "select k.revoked_at, a.actor_type, a.metadata from public.public_api_keys k left join public.audit_log a on a.target_id = k.id::text and a.action = 'api_key.public.revoke' where k.id = $1", [id])).rows[0];

  test("demoted below admin: their admin keys are revoked (and keys those keys made); their read-only keys stay", async () => {
    const pat = await h.addMember(owner.workspaceId, "Pat", "admin");
    const adminKey = await makeKey(pat, "admin");
    const roKey = await makeKey(pat, "read_only");
    const child = await makeKey(adminKey.token, "read_only");
    const r = await h.as(owner).put(`/organization/members/${pat.userId}`, { role: "member" }, inOrg(owner));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await h.as(adminKey.token).get("/public/organization")).statusCode, 401);
    assert.equal((await h.as(child.token).get("/public/organization")).statusCode, 401);
    assert.equal((await h.as(roKey.token).get("/public/organization")).statusCode, 200);
    const a = await revokedFor(adminKey.key.id);
    assert.ok(a.revoked_at);
    assert.equal(a.actor_type, "system");
    assert.deepEqual(a.metadata, { reason: "creator_demoted", creator: pat.userId });
    assert.deepEqual((await revokedFor(child.key.id)).metadata, { reason: "creator_revoked", creator: adminKey.key.id });
  });

  test("an owner demoted to admin keeps their keys", async () => {
    const olga = await h.addMember(owner.workspaceId, "Olga", "owner");
    const k = await makeKey(olga, "admin");
    assert.equal((await h.as(owner).put(`/organization/members/${olga.userId}`, { role: "admin" }, inOrg(owner))).statusCode, 200);
    assert.equal((await h.as(k.token).get("/public/organization")).statusCode, 200);
  });

  test("removed from the organization, or leaving it: their admin keys are revoked", async () => {
    const quinn = await h.addMember(owner.workspaceId, "Quinn", "admin");
    const qk = await makeKey(quinn, "admin");
    assert.equal((await h.as(owner).del(`/organization/members/${quinn.userId}`, inOrg(owner))).statusCode, 200);
    assert.equal((await h.as(qk.token).get("/public/organization")).statusCode, 401);
    assert.deepEqual((await revokedFor(qk.key.id)).metadata, { reason: "creator_removed", creator: quinn.userId });

    const rae = await h.addMember(owner.workspaceId, "Rae", "admin");
    const rk = await makeKey(rae, "admin");
    assert.equal((await h.as(rae).post("/organization/leave", {}, inOrg(rae))).statusCode, 200);
    assert.equal((await h.as(rk.token).get("/public/organization")).statusCode, 401);
    assert.equal((await revokedFor(rk.key.id)).metadata.reason, "creator_removed");
  });

  test("revoking a key revokes the keys it made", async () => {
    const parent = await makeKey(owner, "admin");
    const child = await makeKey(parent.token, "read_only");
    assert.equal((await h.as(adminToken).del(`/public/api-keys/${parent.key.id}`)).statusCode, 200);
    assert.equal((await h.as(child.token).get("/public/organization")).statusCode, 401);
    assert.equal(json(await h.as(adminToken).get("/public/api-keys?limit=100")).items.find((k: { id: string }) => k.id === child.key.id).status, "revoked");
  });
});

describe("key limits", () => {
  test("at most 100 active keys per organization; revoked and expired ones do not count", async () => {
    const boss = await h.user("Boss");
    await h.admin.query(
      `insert into public.public_api_keys (workspace_id, name, role, key_hash, prefix, created_by_type, created_by)
       select $1, 'filler', 'read_only', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'fvx_aaaaaaaa', 'user', $2 from generate_series(1, 99)`, [boss.workspaceId, boss.userId]);
    await h.admin.query(
      `insert into public.public_api_keys (workspace_id, name, role, key_hash, prefix, created_by_type, created_by, created_at, expires_at, revoked_at) values
       ($1::uuid, 'gone', 'read_only', encode(sha256(convert_to('r1' || $1::text, 'UTF8')), 'hex'), 'fvx_aaaaaaaa', 'user', $2, now(), null, now()),
       ($1::uuid, 'old', 'read_only', encode(sha256(convert_to('e1' || $1::text, 'UTF8')), 'hex'), 'fvx_aaaaaaaa', 'user', $2, now() - interval '2 days', now() - interval '1 day', null)`,
      [boss.workspaceId, boss.userId]);
    const hundredth = await makeKey(boss, "admin");
    const over = await h.as(boss).post("/public/api-keys", { name: "101", role: "read_only" }, inOrg(boss));
    assert.equal(over.statusCode, 409, over.body);
    assert.equal(json(over).error.code, "conflict");
    assert.equal((await h.as(hundredth.token).del(`/public/api-keys/${hundredth.key.id}`)).statusCode, 200);
    assert.equal((await h.as(boss).post("/public/api-keys", { name: "again", role: "read_only" }, inOrg(boss))).statusCode, 201);
  });

  test("only a dashboard session creates admin keys", async () => {
    const r = await h.as(adminToken).post("/public/api-keys", { name: "escalate", role: "admin" });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(json(r).error.code, "forbidden");
    assert.equal((await h.admin.query("select count(*)::int as n from public.public_api_keys where name = 'escalate'")).rows[0].n, 0);
  });

  test("a key made by an expiring key must expire, and no later than it", async () => {
    const at = new Date(Date.now() + 10 * 86_400_000);
    const parent = await makeKey(owner, "admin", { expiresAt: at.toISOString() });
    const never = await h.as(parent.token).post("/public/api-keys", { name: "forever", role: "read_only" });
    assert.equal(never.statusCode, 400, never.body);
    assert.equal(json(never).error.field, "expiresAt");
    const later = await h.as(parent.token).post("/public/api-keys", { name: "later", role: "read_only", expiresAt: new Date(at.getTime() + 86_400_000).toISOString() });
    assert.equal(later.statusCode, 400);
    assert.equal(json(later).error.field, "expiresAt");
    const ok = await h.as(parent.token).post("/public/api-keys", { name: "same", role: "read_only", expiresAt: at.toISOString() });
    assert.equal(ok.statusCode, 201, ok.body);
    // A key that never expires may make keys with any allowed expiry, or none.
    assert.equal((await h.as(adminToken).post("/public/api-keys", { name: "free", role: "read_only" })).statusCode, 201);
  });

  test("a session must name the organization (X-Fenvix-Workspace), with no fallback", async () => {
    for (const r of [await h.as(owner).post("/public/api-keys", { name: "nohdr", role: "admin" }), await h.as(owner).get("/public/api-keys"), await h.as(owner).del(`/public/api-keys/${randomUUID()}`)]) {
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(json(r).error.field, "X-Fenvix-Workspace");
    }
    assert.equal((await h.admin.query("select count(*)::int as n from public.public_api_keys where name = 'nohdr'")).rows[0].n, 0);
  });
});

describe("smaller fixes", () => {
  test("DELETE on a database that is already being erased is a 409", async () => {
    const id = json(await h.as(adminToken).post("/public/databases", { name: "erasing-db", region: "eu-central-1" })).id;
    await h.admin.query("update public.databases set engine_state = 'erasing' where id = $1", [id]);
    try {
      const r = await h.as(adminToken).del(`/public/databases/${id}`);
      assert.equal(r.statusCode, 409, r.body);
      assert.equal(json(r).error.code, "conflict");
    } finally { await h.admin.query("update public.databases set engine_state = 'ready' where id = $1", [id]); }
  });

  test("if the Idempotency-Key record fails after a key or a user was made, the key is revoked and the user dropped", async () => {
    await h.admin.query(`create or replace function public.test_fail_finish() returns trigger language plpgsql as $$
      begin if new.key like 'fail-finish-%' and new.status = 'done' then raise exception 'simulated failure'; end if; return new; end $$`);
    await h.admin.query("drop trigger if exists test_fail_finish on public.idempotency_keys");
    await h.admin.query("create trigger test_fail_finish before update on public.idempotency_keys for each row execute function public.test_fail_finish()");
    try {
      const r = await h.as(adminToken).post("/public/api-keys", { name: "undelivered", role: "read_only" }, { "idempotency-key": `fail-finish-${randomUUID()}` });
      assert.equal(r.statusCode, 500, r.body);
      assert.ok(!r.body.includes("fvx_"));
      const rows = (await h.admin.query("select id, revoked_at from public.public_api_keys where workspace_id = $1 and name = 'undelivered'", [owner.workspaceId])).rows;
      assert.equal(rows.length, 1);
      assert.ok(rows[0].revoked_at, "the key nobody received is revoked");
      const a = (await h.admin.query("select metadata from public.audit_log where action = 'api_key.public.revoke' and target_id = $1", [rows[0].id])).rows;
      assert.equal(a[0].metadata.reason, "not_delivered");

      const db = json(await h.as(adminToken).post("/public/databases", { name: "undelivered-db", region: "eu-central-1" })).id;
      const u = await h.as(adminToken).post(`/public/databases/${db}/users`, { username: "ghost" }, { "idempotency-key": `fail-finish-${randomUUID()}` });
      assert.equal(u.statusCode, 500, u.body);
      assert.deepEqual(json(await h.as(adminToken).get(`/public/databases/${db}/users`)).items.map((x: { username: string }) => x.username), ["app"]);
    } finally {
      await h.admin.query("drop trigger if exists test_fail_finish on public.idempotency_keys");
      await h.admin.query("drop function if exists public.test_fail_finish()");
    }
  });

  test("network: the author of a change made with a public key is shown with the key's name", async () => {
    const k = await makeKey(owner, "admin", { name: "netbot" });
    const db = json(await h.as(k.token).post("/public/databases", { name: "netbot-db", region: "eu-central-1" })).id;
    assert.equal((await h.as(k.token).put(`/public/databases/${db}/ip-allowlist`, { entries: ["192.0.2.1"] })).statusCode, 200);
    assert.deepEqual(json(await h.as(adminToken).get(`/public/databases/${db}/ip-allowlist`)).updatedBy, { type: "api_key", id: k.key.id, name: "netbot" });
  });

  test("audit: a key that goes quiet still gets its held-back refusals written, in a summary row", async () => {
    const k = await makeKey(owner, "read_only");
    await h.as(adminToken).del(`/public/api-keys/${k.key.id}`);
    for (let i = 0; i < 6; i++) assert.equal((await h.as(k.token).get("/public/organization")).statusCode, 401);
    const rows = async () => (await h.admin.query("select metadata from public.audit_log where action = 'api_key.public.auth_failed' and target_id = $1 order by id", [k.key.id])).rows.map((r) => r.metadata);
    assert.equal((await rows()).length, 1);
    // What the timer does once the window has ended (forced here, as on shutdown).
    await auditThrottle(h.app.deps.s).flushDue(true);
    const all = await rows();
    assert.equal(all.length, 2);
    assert.deepEqual(all[1], { summary: true, reason: "revoked", suppressed: 5 });
  });

  test("revokeUndelivered leaves an already revoked key (and the audit log) alone", async () => {
    const k = await makeKey(owner, "read_only");
    assert.equal((await h.as(adminToken).del(`/public/api-keys/${k.key.id}`)).statusCode, 200);
    const caller = { workspaceId: owner.workspaceId, actor: { type: "user" as const, id: owner.userId }, role: "owner" as const, requestId: "test-undelivered", ip: "127.0.0.1" };
    await revokeUndelivered(h.app.deps.s, caller, k.key.id);
    const reasons = (await h.admin.query("select metadata->>'reason' as r from public.audit_log where action = 'api_key.public.revoke' and target_id = $1", [k.key.id])).rows.map((r) => r.r);
    assert.deepEqual(reasons, [null], "only the person's revoke, no not_delivered row");
  });

  test("unknown query parameters are refused", async () => {
    const r = await h.as(adminToken).get("/public/databases?page=2");
    assert.equal(r.statusCode, 400);
    assert.equal(json(r).error.field, "page");
    assert.equal((await h.as(adminToken).get("/public/organization?x=1")).statusCode, 400);
  });
});
