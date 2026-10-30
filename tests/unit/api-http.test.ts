// Unit tests for the dashboard's DataClient on the control plane (src/data/api-http.ts over src/data/http.ts), against a
// fake control plane behind a fake fetch: npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createHttpDataClient } from "../../src/data/api-http.ts";
import { type HttpConfig, httpRequest, normalizeApiUrl } from "../../src/data/http.ts";
import { ExplorerError } from "../../src/data/explorer.ts";
import type { Database, OperationProgress } from "../../src/data/types.ts";

const API = "https://api.example.test/v1";
const ORG = "11111111-2222-4333-8444-555555555555";
const DB_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | "network-error";

/** A fake control plane: `route` answers each request; every request is recorded. */
function fakeServer(route: (req: Seen, n: number) => Reply) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: Seen = { method: init?.method ?? "GET", url: new URL(String(input)), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const r = route(req, seen.length);
    if (r === "network-error") throw new TypeError("Failed to fetch");
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text || null, { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  }) as typeof fetch;
  const cfg: HttpConfig = { baseUrl: API, token: async () => "session-token", headers: () => ({ "X-Fenvix-Workspace": ORG }), fetch: fetchFn };
  let keys = 0;
  const client = createHttpDataClient({
    request: (m, p, o) => httpRequest(cfg, m, p, o),
    newKey: () => `key-${++keys}`,
    sleep: async () => {},
    pollMs: 0,
  });
  return { client, seen };
}

const database = (over: Partial<Database> = {}): Database => ({
  id: DB_ID, name: "acme-prod-01", state: "asleep", storageMb: 0, requests24h: 0, lastActiveAt: "2026-10-29T10:00:00Z", createdAt: "2026-10-29T10:00:00Z",
  region: "eu-west", host: "acme-prod-01.db.fenvix.cloud", connectionString: "mongodb://app:<password>@acme-prod-01.db.fenvix.cloud:27017/acme_prod_01?tls=true",
  tags: [], keepAwake: false, forkedFrom: null, restoredTo: null, ...over,
});

const op = (status: string, extra: Record<string, unknown> = {}) => ({ id: "op-1", kind: "create", status, databaseId: DB_ID, createdAt: "", updatedAt: "", finishedAt: null, result: null, error: null, ...extra });

async function rejects(p: Promise<unknown>, check: (e: ExplorerError) => void) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ExplorerError, `not an ExplorerError: ${String(e)}`);
    check(e);
    return;
  }
  assert.fail("did not reject");
}

// ---------------------------------------------------------------- reading

test("the list goes to GET /databases with the filter, sort and paging in the query, the session token and the organization", async () => {
  const page = { items: [database()], total: 1, page: 2, pageSize: 50 };
  const { client, seen } = fakeServer(() => ({ status: 200, body: page }));
  const got = await client.listDatabases({ search: " acme ", state: "asleep", keepAwake: false, tags: ["Customer:Acme", "!env"], sort: "name", dir: "asc", page: 2, pageSize: 50 });
  assert.deepEqual(got, page);
  const r = seen[0];
  assert.equal(r.method, "GET");
  assert.equal(`${r.url.origin}${r.url.pathname}`, `${API}/databases`);
  assert.equal(r.url.searchParams.get("search"), "acme");
  assert.equal(r.url.searchParams.get("state"), "asleep");
  assert.equal(r.url.searchParams.get("keepAwake"), "false");
  assert.deepEqual(r.url.searchParams.getAll("tag"), ["customer:acme", "!env"]);
  assert.equal(r.url.searchParams.get("sort"), "name");
  assert.equal(r.url.searchParams.get("page"), "2");
  assert.equal(r.headers.authorization, "Bearer session-token");
  assert.equal(r.headers["x-fenvix-workspace"], ORG);
  assert.equal(r.headers["idempotency-key"], undefined, "a read carries no Idempotency-Key");
});

test("an empty filter sends no query at all", async () => {
  const { client, seen } = fakeServer(() => ({ status: 200, body: { items: [], total: 0, page: 1, pageSize: 50 } }));
  await client.listDatabases();
  assert.equal(seen[0].url.search, "");
});

test("lists that come wrapped in { items } or { ids } are unwrapped", async () => {
  const { client } = fakeServer((r) => {
    const p = r.url.pathname.replace("/v1", "");
    if (p === "/databases/ids") return { status: 200, body: { ids: [DB_ID] } };
    if (p === "/regions") return { status: 200, body: { items: ["eu-west", "us-east"] } };
    if (p === "/tags") return { status: 200, body: { items: [{ key: "env", value: "prod", count: 2 }] } };
    if (p === "/plans") return { status: 200, body: { items: [{ id: "managed", current: true }] } };
    if (p === "/public/api-keys") return { status: 200, body: { items: [], nextCursor: null } };
    if (p === "/usage/months") return { status: 200, body: { items: ["2026-10"] } };
    if (p === "/usage/history") return { status: 200, body: { items: [] } };
    if (p === "/tags/breakdown") return { status: 200, body: { items: [{ value: "a", databases: 1, storageGb: 0, requests: 3 }] } };
    if (p === `/databases/${DB_ID}/usage`) return { status: 200, body: { items: [{ at: "x", requests: 1, storageMb: 1, awake: true }] } };
    return { status: 404 };
  });
  assert.deepEqual(await client.listDatabaseIds({ state: "awake" }), [DB_ID]);
  assert.deepEqual(await client.listRegions(), ["eu-west", "us-east"]);
  assert.equal((await client.listTags())[0].count, 2);
  assert.equal((await client.listPlans())[0].current, true);
  assert.deepEqual(await client.listPublicApiKeys(), { items: [], nextCursor: null });
  assert.deepEqual(await client.listUsageMonths(), ["2026-10"]);
  assert.deepEqual(await client.getUsageHistory(), []);
  assert.equal((await client.getTagBreakdown("customer"))[0].requests, 3);
  assert.equal((await client.getUsage(DB_ID, "24h")).length, 1);
});

test("a missing database is null: 404 from the server, or an id that cannot exist (no request at all)", async () => {
  const { client, seen } = fakeServer(() => ({ status: 404, body: { error: { code: "not_found", message: "That database does not exist." } } }));
  assert.equal(await client.getDatabase(DB_ID), null);
  assert.equal(await client.getDatabase("db_0001"), null);
  assert.deepEqual(await client.getUsage("not-an-id", "7d"), []);
  assert.equal(seen.length, 1);
});

test("usage report and its export: tagKey only with by=tag, no paging on the export", async () => {
  const { client, seen } = fakeServer((r) =>
    r.url.pathname.endsWith("/export") ? { status: 200, body: { filename: "u.csv", mimeType: "text/csv", downloadUrl: "https://api.example.test/v1/downloads/t" } } : { status: 200, body: { items: [], total: 0, page: 1, pageSize: 50, month: "2026-10", totals: {} } });
  await client.getUsageReport({ month: "2026-10", by: "database", tagKey: "customer", page: 1 });
  assert.equal(seen[0].url.searchParams.get("tagKey"), null);
  const file = await client.exportUsageReport({ month: "2026-10", by: "tag", tagKey: "customer", page: 3 });
  assert.equal(seen[1].url.searchParams.get("tagKey"), "customer");
  assert.equal(seen[1].url.searchParams.get("page"), null);
  assert.equal(file.downloadUrl, "https://api.example.test/v1/downloads/t");
});

// ---------------------------------------------------------------- create: the answer, the password, polling

test("create: POST /databases with an Idempotency-Key; the first answer shows the password once", async () => {
  const created = database({ initialUser: { username: "app", role: "readWrite", password: "s3cret-once", connectionString: "mongodb://app:s3cret-once@h/db" } });
  const { client, seen } = fakeServer(() => ({ status: 201, body: created, headers: { "operation-id": "op-1" } }));
  const progress: OperationProgress[] = [];
  const db = await client.createDatabase({ name: "acme-prod-01", region: "eu-west", tags: ["env:prod"], appUser: "app" }, { onProgress: (p) => progress.push(p) });
  assert.equal(db.initialUser?.password, "s3cret-once");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url.pathname, "/v1/databases");
  assert.deepEqual(seen[0].body, { name: "acme-prod-01", region: "eu-west", tags: ["env:prod"], appUser: "app" });
  assert.equal(seen[0].headers["idempotency-key"], "key-1");
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.deepEqual(progress.map((p) => p.status), ["submitting", "succeeded"]);
});

test("create that takes longer: 202, then polling GET /operations/{id} until it succeeds; the password is null then", async () => {
  const done = database({ initialUser: { username: "app", role: "readWrite", password: null, connectionString: null } });
  const { client, seen } = fakeServer((r, n) => {
    if (r.method === "POST") return { status: 202, body: { operation: op("queued") }, headers: { location: `${API}/operations/op-1`, "retry-after": "2" } };
    return n < 4 ? { status: 200, body: op("running") } : { status: 200, body: op("succeeded", { result: done }) };
  });
  const progress: OperationProgress[] = [];
  const db = await client.createDatabase({ name: "acme-prod-01", region: "eu-west", tags: [] }, { onProgress: (p) => progress.push(p) });
  assert.equal(db.id, DB_ID);
  assert.equal(db.initialUser?.password, null);
  assert.deepEqual(progress.map((p) => p.status), ["submitting", "queued", "running", "succeeded"]);
  assert.equal(progress[1].operationId, "op-1");
  const polls = seen.filter((r) => r.method === "GET");
  assert.ok(polls.length >= 2);
  assert.ok(polls.every((r) => r.url.pathname === "/v1/operations/op-1" && r.headers["idempotency-key"] === undefined));
  assert.equal(seen.filter((r) => r.method === "POST").length, 1, "the create is sent once");
});

test("create that fails in the engine: rejects with the operation's reason, and the progress says failed", async () => {
  const { client } = fakeServer((r) =>
    r.method === "POST"
      ? { status: 202, body: { operation: op("running") } }
      : { status: 200, body: op("failed", { error: { code: "internal", message: "The engine could not create the database. Try again." } }) });
  const progress: OperationProgress[] = [];
  await rejects(client.createDatabase({ name: "acme-prod-01", region: "eu-west", tags: [] }, { onProgress: (p) => progress.push(p) }), (e) => {
    assert.equal(e.message, "The engine could not create the database. Try again.");
    assert.equal(e.status, 500);
  });
  const last = progress[progress.length - 1];
  assert.equal(last.status, "failed");
  assert.equal(last.error, "The engine could not create the database. Try again.");
});

test("a lost answer is sent again with the SAME Idempotency-Key (the server replays: same database, password null)", async () => {
  const replay = database({ initialUser: { username: "app", role: "readWrite", password: null, connectionString: null } });
  const { client, seen } = fakeServer((_r, n) => (n === 1 ? "network-error" : { status: 201, body: replay, headers: { "idempotent-replay": "true" } }));
  const db = await client.createDatabase({ name: "acme-prod-01", region: "eu-west", tags: [] });
  assert.equal(db.initialUser?.password, null);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers["idempotency-key"], seen[1].headers["idempotency-key"]);
});

test("each action gets its own Idempotency-Key", async () => {
  const { client, seen } = fakeServer(() => ({ status: 201, body: database() }));
  await client.createDatabase({ name: "one-one", region: "eu-west", tags: [] });
  await client.createDatabase({ name: "two-two", region: "eu-west", tags: [] });
  assert.notEqual(seen[0].headers["idempotency-key"], seen[1].headers["idempotency-key"]);
});

test("polling survives a blip, and stops waiting when asked", async () => {
  const { client } = fakeServer((r, n) => {
    if (r.method === "POST") return { status: 202, body: { operation: op("running") } };
    if (n === 2) return "network-error";
    return { status: 200, body: op("succeeded", { result: database() }) };
  });
  assert.equal((await client.createDatabase({ name: "acme-prod-01", region: "eu-west", tags: [] })).id, DB_ID);

  const stop = new AbortController();
  stop.abort();
  const slow = fakeServer((r) => (r.method === "POST" ? { status: 202, body: { operation: op("running") } } : { status: 200, body: op("running") }));
  await rejects(slow.client.createDatabase({ name: "acme-prod-01", region: "eu-west", tags: [] }, { signal: stop.signal }), (e) => assert.match(e.message, /goes on in the background/));
});

// ---------------------------------------------------------------- fork, restore, export, erase and the bulk changes

test("fork, restore, export and erase go to their routes with an Idempotency-Key each", async () => {
  const { client, seen } = fakeServer((r) => {
    const p = r.url.pathname.replace("/v1", "");
    if (p.endsWith("/fork")) return { status: 201, body: database({ id: "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee", forkedFrom: DB_ID }) };
    if (p.endsWith("/restore")) return { status: 200, body: database({ restoredTo: "2026-10-28T10:00:00Z" }) };
    if (p === "/databases/export") return { status: 200, body: { filename: "x.json", mimeType: "application/json", downloadUrl: "https://files.example.test/x" } };
    if (p === "/databases/erase") return { status: 200, body: { affected: 1 } };
    return { status: 404 };
  });
  assert.equal((await client.forkDatabase(DB_ID, "acme-prod-01-fork")).forkedFrom, DB_ID);
  assert.equal((await client.restoreDatabase(DB_ID, "2026-10-28T10:00:00Z")).restoredTo, "2026-10-28T10:00:00Z");
  assert.equal((await client.exportDatabases([DB_ID])).downloadUrl, "https://files.example.test/x");
  assert.deepEqual(await client.eraseDatabases([DB_ID]), { affected: 1 });
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url.pathname}`), [
    `POST /v1/databases/${DB_ID}/fork`, `POST /v1/databases/${DB_ID}/restore`, "POST /v1/databases/export", "POST /v1/databases/erase",
  ]);
  assert.deepEqual(seen.map((r) => r.body), [{ name: "acme-prod-01-fork" }, { at: "2026-10-28T10:00:00Z" }, { ids: [DB_ID] }, { ids: [DB_ID] }]);
  assert.ok(seen.every((r) => r.headers["idempotency-key"]));
});

test("erase that is still running when the request returns: polled until it reports how many were erased", async () => {
  const { client } = fakeServer((r) =>
    r.method === "POST" ? { status: 202, body: { operation: op("running", { kind: "erase" }) } } : { status: 200, body: op("succeeded", { kind: "erase", result: { affected: 3 } }) });
  assert.deepEqual(await client.eraseDatabases([DB_ID]), { affected: 3 });
});

test("keep awake, tags and settings are writes with an Idempotency-Key", async () => {
  const { client, seen } = fakeServer((r) => {
    const p = r.url.pathname.replace("/v1", "");
    if (p === `/databases/${DB_ID}/tags`) return { status: 200, body: database({ tags: ["env:prod"] }) };
    if (p === "/settings") return { status: 200, body: { workspaceName: "Acme", idleMinutes: 5, emailNotices: true } };
    return { status: 200, body: { affected: 1 } };
  });
  await client.setKeepAwake([DB_ID], true);
  await client.setTags(DB_ID, ["env:prod"]);
  await client.addTags([DB_ID], ["env:prod"]);
  await client.removeTags([DB_ID], ["env"]);
  await client.saveSettings({ workspaceName: "Acme", idleMinutes: 5, emailNotices: true });
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url.pathname}`), [
    "POST /v1/databases/keep-awake", `PUT /v1/databases/${DB_ID}/tags`, "POST /v1/databases/tags/add", "POST /v1/databases/tags/remove", "PUT /v1/settings",
  ]);
  assert.ok(seen.every((r) => r.headers["idempotency-key"]), "every write has a key");
  assert.deepEqual(seen[0].body, { ids: [DB_ID], enabled: true });
});

// ---------------------------------------------------------------- public API keys (fvx_), /v1/public/api-keys

const KEY_ID = "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b01";
const TOKEN = `fvx_${"Ab3_-".repeat(8)}xyz`;
const wireKey = (over: Record<string, unknown> = {}) => ({
  id: KEY_ID, name: "ci deploys", role: "read_only", prefix: TOKEN.slice(0, 12), status: "active",
  createdAt: "2026-10-01T09:00:00.000Z", lastUsedAt: null, expiresAt: null, revokedAt: null, ...over,
});

test("public keys: list, create and revoke on /v1/public/api-keys, with the session and the organization header", async () => {
  const { client, seen } = fakeServer((r) => {
    if (r.method === "GET") return { status: 200, body: { items: [wireKey({ lastUsedAt: "2026-10-29T08:00:00.000Z" })], nextCursor: "next-1" } };
    if (r.method === "POST") return { status: 201, body: { key: wireKey({ role: "admin", expiresAt: "2027-01-28T12:00:00.000Z" }), token: TOKEN } };
    return { status: 200, body: wireKey({ status: "revoked", revokedAt: "2026-10-30T12:00:00.000Z" }) };
  });
  const page = await client.listPublicApiKeys();
  assert.equal(page.nextCursor, "next-1");
  assert.equal(page.items[0].lastUsedAt, "2026-10-29T08:00:00.000Z");
  assert.equal(page.items[0].prefix, "fvx_Ab3_-Ab3");
  await client.listPublicApiKeys("next-1");
  const made = await client.createPublicApiKey({ name: "ci deploys", role: "admin", expiresAt: "2027-01-28T12:00:00.000Z" });
  assert.equal(made.token, TOKEN);
  assert.equal(made.key.role, "admin");
  await client.createPublicApiKey({ name: "forever", role: "read_only", expiresAt: null });
  const gone = await client.revokePublicApiKey(KEY_ID);
  assert.equal(gone.status, "revoked");
  assert.equal(gone.revokedAt, "2026-10-30T12:00:00.000Z");

  assert.deepEqual(seen.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`), [
    "GET /v1/public/api-keys?limit=100", "GET /v1/public/api-keys?limit=100&cursor=next-1", "POST /v1/public/api-keys", "POST /v1/public/api-keys", `DELETE /v1/public/api-keys/${KEY_ID}`,
  ]);
  assert.deepEqual(seen[2].body, { name: "ci deploys", role: "admin", expiresAt: "2027-01-28T12:00:00.000Z" });
  assert.deepEqual(seen[3].body, { name: "forever", role: "read_only" }, "no expiresAt for a key that does not expire");
  for (const r of seen) {
    assert.equal(r.headers.authorization, "Bearer session-token");
    assert.equal(r.headers["x-fenvix-workspace"], ORG);
  }
  assert.ok(seen.slice(2).every((r) => r.headers["idempotency-key"]), "every change has an Idempotency-Key");
});

test("public keys: a create whose answer is lost is not sent again (a resend could never show the key)", async () => {
  const { client, seen } = fakeServer(() => "network-error");
  await rejects(client.createPublicApiKey({ name: "ci", role: "read_only", expiresAt: null }), (e) => assert.equal(e.code, "network"));
  assert.equal(seen.length, 1);
});

test("public keys: a revoke whose answer is lost is sent again with the same Idempotency-Key", async () => {
  const { client, seen } = fakeServer((_r, n) => (n === 1 ? "network-error" : { status: 200, body: wireKey({ status: "revoked", revokedAt: "2026-10-30T12:00:00.000Z" }) }));
  assert.equal((await client.revokePublicApiKey(KEY_ID)).status, "revoked");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers["idempotency-key"], seen[1].headers["idempotency-key"]);
});

test("public keys: the API's errors keep their code, status, field and message", async () => {
  const cases: [number, unknown, string, string | undefined][] = [
    [409, { error: { code: "conflict", message: "An organization can have up to 100 active API keys. Revoke one first." } }, "conflict", undefined],
    [403, { error: { code: "forbidden", message: "Only an owner or admin of this organization can create API keys." } }, "forbidden", undefined],
    [400, { error: { code: "validation_failed", message: "expiresAt must be at least a minute from now.", field: "expiresAt" } }, "validation_failed", "expiresAt"],
  ];
  for (const [status, body, code, field] of cases) {
    const { client } = fakeServer(() => ({ status, body }));
    await rejects(client.createPublicApiKey({ name: "ci", role: "read_only", expiresAt: null }), (e) => {
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      assert.equal(e.field, field);
      assert.equal(e.message, (body as { error: { message: string } }).error.message);
    });
  }
  const { client } = fakeServer(() => ({ status: 404, body: { error: { code: "not_found", message: "That API key does not exist." } } }));
  await rejects(client.revokePublicApiKey("nope"), (e) => assert.equal(e.status, 404));
});

// ---------------------------------------------------------------- errors a person can read

test("401, 403, 409 and 422: the server's message as is, with its code and status, and no resend", async () => {
  const cases: [number, unknown, string, string][] = [
    [401, { error: { code: "unauthenticated", message: "Sign in to continue." } }, "unauthenticated", "Sign in to continue."],
    [403, { error: { code: "forbidden", message: "Your role in this organization is read only. Ask an owner or admin to do this." } }, "forbidden", "Your role in this organization is read only. Ask an owner or admin to do this."],
    [409, { error: { code: "conflict", message: "A database named acme-prod-01 already exists.", field: "name" } }, "conflict", "A database named acme-prod-01 already exists."],
    [422, { error: { code: "validation_failed", message: "Choose a region.", field: "region" } }, "validation_failed", "Choose a region."],
  ];
  for (const [status, body, code, message] of cases) {
    const { client, seen } = fakeServer(() => ({ status, body }));
    const progress: OperationProgress[] = [];
    await rejects(client.createDatabase({ name: "acme-prod-01", region: "eu-west", tags: [] }, { onProgress: (p) => progress.push(p) }), (e) => {
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      assert.equal(e.message, message);
    });
    assert.equal(seen.length, 1, `${status} is not sent again`);
    assert.equal(progress[progress.length - 1].error, message);
  }
});

test("errors without a usable body still read as sentences (no HTML, no status codes)", async () => {
  const cases: [number, Reply][] = [
    [401, { status: 401 }],
    [403, { status: 403, text: "<html>Forbidden</html>" }],
    [409, { status: 409, body: { error: {} } }],
    [422, { status: 422, text: "Unprocessable Entity" }],
  ];
  for (const [status, reply] of cases) {
    const { client } = fakeServer(() => reply);
    await rejects(client.eraseDatabases([DB_ID]), (e) => {
      assert.equal(e.status, status);
      assert.doesNotMatch(e.message, /<|html|Unprocessable|^\d/);
      assert.match(e.message, /\.$/);
    });
  }
  const { client } = fakeServer(() => ({ status: 401 }));
  await rejects(client.listDatabases(), (e) => assert.equal(e.message, "Your session has ended. Sign in again."));
});

test("a gateway error is resent with the same key, at most twice, then shown", async () => {
  const { client, seen } = fakeServer(() => ({ status: 502, text: "<html>Bad gateway</html>" }));
  await rejects(client.setKeepAwake([DB_ID], true), (e) => assert.equal(e.status, 502));
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map((r) => r.headers["idempotency-key"])).size, 1);
});

test("no VITE_API_URL: a clear message, no request", async () => {
  await rejects(httpRequest({ baseUrl: "", token: async () => "t", headers: () => ({}) }, "GET", "/databases"), (e) => assert.equal(e.code, "not_configured"));
});

test("the HTTP client never calls Supabase", () => {
  for (const f of ["../../src/data/api-http.ts", "../../src/data/http.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /getSupabase|\.rpc\(|fenvix_|supabase-js/, f);
  }
});

test("VITE_API_URL: a bare host gets /v1, a full base stays as written", () => {
  assert.equal(normalizeApiUrl("https://api.fenvix.dev"), "https://api.fenvix.dev/v1");
  assert.equal(normalizeApiUrl(" https://api.fenvix.dev/ "), "https://api.fenvix.dev/v1");
  assert.equal(normalizeApiUrl("https://api.fenvix.dev/v1/"), "https://api.fenvix.dev/v1");
  assert.equal(normalizeApiUrl("http://127.0.0.1:54400/v1"), "http://127.0.0.1:54400/v1");
  assert.equal(normalizeApiUrl(""), "");
});
