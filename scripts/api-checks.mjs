// Behaviour checks of the dashboard on the control plane over HTTP (VITE_API_URL), against a fake control plane.
//
// The app is built for the real (non-mock) backend with VITE_API_URL pointing at a small fake control plane started
// here, and VITE_SUPABASE_URL pointing at a fake Supabase that only holds the session: every request to Supabase is
// recorded, and any database function call (rpc/fenvix_*) fails the run. So this proves that databases are listed,
// created, forked and erased through the control plane's routes, with Idempotency-Key, operation polling, the
// password shown once, and readable 401/403/409/422 errors.
//
// It is NOT the control plane: the routes answer from memory with the shapes of control-plane/src/routes/data.ts, and
// for API keys with those of control-plane/src/routes/public/index.ts and services/apikeys.ts (viewKey).
// Usage: npm run check (builds, serves and runs everything), or on its own: node scripts/api-checks.mjs
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const API_PORT = 54400;
const SB_PORT = 54331;
const APP_PORT = 4176;
const API = `http://127.0.0.1:${API_PORT}/v1`;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const ORG = "0f0f0f0f-1111-4222-8333-444444444444";
const USER = { id: "9e9e9e9e-1111-4222-8333-444444444444", email: "owner@example.com" };

// ------------------------------------------------------------------ fake Supabase: the session only
const supabaseCalls = [];
const cors = (req) => ({
  "access-control-allow-origin": req.headers.origin ?? "*",
  "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": "Retry-After, Location, Operation-Id, Idempotent-Replay",
});
const sb = createServer((req, res) => {
  if (req.method !== "OPTIONS") supabaseCalls.push(`${req.method} ${req.url}`);
  const send = (status, body) => (res.writeHead(status, { ...cors(req), "content-type": "application/json" }), res.end(body === undefined ? "" : JSON.stringify(body)));
  if (req.method === "OPTIONS") return send(204);
  if (req.url.startsWith("/auth/v1/user")) return send(200, { id: USER.id, email: USER.email, aud: "authenticated", role: "authenticated" });
  if (req.url.startsWith("/auth/v1/logout")) return send(204);
  return send(500, { message: "The dashboard must not call Supabase for data when VITE_API_URL is set." });
}).listen(SB_PORT, "127.0.0.1");

// ------------------------------------------------------------------ fake control plane
const now = () => new Date().toISOString();
const dbs = [];
const ops = new Map();
const requests = []; // { method, path, key, auth, org }

function makeDb(name, over = {}) {
  const id = randomUUID();
  const host = `${name}.db.fenvix.cloud`;
  const db = name.replace(/-/g, "_");
  return {
    id, name, state: "asleep", storageMb: 12, requests24h: 3, lastActiveAt: now(), createdAt: "2026-10-01T00:00:00Z", region: "eu-west", host,
    connectionString: `mongodb://app:<password>@${host}:27017/${db}?tls=true&authSource=${db}&authMechanism=SCRAM-SHA-256`,
    tags: ["env:prod"], keepAwake: false, forkedFrom: null, restoredTo: null, ...over,
  };
}
for (const n of ["orders-prod", "orders-staging", "agent-memory"]) dbs.push(makeDb(n));

const withUser = (d, password) => ({
  ...d,
  initialUser: { username: "app", role: "readWrite", password, connectionString: password ? d.connectionString.replace("<password>", password) : null },
});
const err = (status, code, message, field) => ({ status, body: { error: { code, message, ...(field ? { field } : {}) } } });

/** An operation that finishes after `polls` reads of GET /operations/{id}. */
function slowOp(kind, finish, polls = 2) {
  const op = { id: randomUUID(), kind, status: "queued", databaseId: null, createdAt: now(), updatedAt: now(), finishedAt: null, result: null, error: null, polls, finish };
  ops.set(op.id, op);
  return { status: 202, body: { operation: view(op) }, headers: { location: `${API}/operations/${op.id}`, "retry-after": "2", "operation-id": op.id } };
}
// Public API keys (fvx_), newest first, as viewKey shows them.
const publicKeys = [
  { id: randomUUID(), name: "Production backend", role: "admin", prefix: "fvx_7HcR0ZyN", status: "active", createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, expiresAt: null, revokedAt: null },
];
const newToken = () => `fvx_${Buffer.from(randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")).toString("base64url").slice(0, 43)}`;

const view = (op) => ({ id: op.id, kind: op.kind, status: op.status, databaseId: op.databaseId, createdAt: op.createdAt, updatedAt: op.updatedAt, finishedAt: op.finishedAt, result: op.result, error: op.error });

function route(method, path, q, body) {
  let m;
  if (path.startsWith("/public/api-keys")) return publicKeyRoute(method, path, q, body);
  if (method === "GET" && path === "/organizations") return { status: 200, body: { items: [{ id: ORG, name: "Acme", role: "owner", nameConfirmed: true }] } };
  if (method === "GET" && path === "/settings") return { status: 200, body: { workspaceName: "Acme", idleMinutes: 5, emailNotices: true } };
  if (method === "GET" && path === "/regions") return { status: 200, body: { items: ["eu-west", "us-east"] } };
  if (method === "GET" && path === "/tags") return { status: 200, body: { items: [{ key: "env", value: "prod", count: dbs.length }] } };
  if (method === "GET" && path === "/databases") {
    const s = (q.get("search") ?? "").toLowerCase();
    const items = dbs.filter((d) => d.name.includes(s));
    return { status: 200, body: { items, total: items.length, page: 1, pageSize: Number(q.get("pageSize") ?? 50) } };
  }
  if (method === "GET" && path === "/databases/ids") return { status: 200, body: { ids: dbs.map((d) => d.id) } };
  if (method === "GET" && path === "/databases/groups") return { status: 200, body: { groupBy: q.get("groupBy"), total: dbs.length, groups: [] } };
  if (method === "GET" && (m = /^\/databases\/([^/]+)\/usage$/.exec(path))) return { status: 200, body: { items: [] } };
  if (method === "GET" && (m = /^\/databases\/([^/]+)$/.exec(path))) {
    const d = dbs.find((x) => x.id === m[1]);
    return d ? { status: 200, body: d } : err(404, "not_found", "That database does not exist.");
  }
  if (method === "GET" && (m = /^\/operations\/([^/]+)$/.exec(path))) {
    const op = ops.get(m[1]);
    if (!op) return err(404, "not_found", "That operation does not exist.");
    if (op.status !== "succeeded" && op.status !== "failed") {
      op.polls -= 1;
      op.status = "running";
      if (op.polls < 0) op.finish(op);
    }
    return { status: 200, body: view(op) };
  }
  if (method === "POST" && path === "/databases") {
    const name = String(body?.name ?? "");
    // Name prefixes pick the refusal the control plane would give (so each error can be checked on its own).
    if (name.startsWith("expired-")) return err(401, "unauthenticated", "Sign in to continue.");
    if (name.startsWith("member-")) return err(403, "forbidden", "Your role in this organization is read only. Ask an owner or admin to do this.");
    if (name.startsWith("unprocessable-")) return err(422, "validation_failed", "Choose a region.", "region");
    if (dbs.some((d) => d.name === name)) return err(409, "conflict", `A database named ${name} already exists.`, "name");
    if (name.startsWith("broken-")) return slowOp("create", (op) => Object.assign(op, { status: "failed", error: { code: "internal", message: "The engine could not create the database. Nothing was kept: try again." }, finishedAt: now() }));
    const d = makeDb(name, { region: body.region, tags: body.tags ?? [] });
    if (name.startsWith("slow-")) {
      return slowOp("create", (op) => {
        dbs.unshift(d);
        // The answer that shows the password is the first one; a poll never has it.
        Object.assign(op, { status: "succeeded", databaseId: d.id, result: withUser(d, null), finishedAt: now() });
      });
    }
    dbs.unshift(d);
    return { status: 201, body: withUser(d, `Pw${randomUUID().replace(/-/g, "").slice(0, 30)}Once1234`) };
  }
  if (method === "POST" && (m = /^\/databases\/([^/]+)\/fork$/.exec(path))) {
    const src = dbs.find((x) => x.id === m[1]);
    if (!src) return err(404, "not_found", "That database does not exist.");
    if (dbs.some((d) => d.name === body?.name)) return err(409, "conflict", `A database named ${body.name} already exists.`, "name");
    const d = makeDb(body.name, { tags: src.tags, region: src.region, forkedFrom: src.id });
    dbs.unshift(d);
    return { status: 201, body: withUser(d, `Fork${randomUUID().replace(/-/g, "").slice(0, 32)}ab12`) };
  }
  if (method === "POST" && path === "/databases/erase") {
    const ids = body?.ids ?? [];
    return slowOp("erase", (op) => {
      let affected = 0;
      for (const id of ids) {
        const i = dbs.findIndex((d) => d.id === id);
        if (i >= 0) (dbs.splice(i, 1), affected++);
      }
      Object.assign(op, { status: "succeeded", result: { affected }, finishedAt: now() });
    });
  }
  return null;
}

function publicKeyRoute(method, path, q, body) {
  let m;
  if (method === "GET" && path === "/public/api-keys") return { status: 200, body: { items: publicKeys, nextCursor: null } };
  if (method === "POST" && path === "/public/api-keys") {
    const name = String(body?.name ?? "").trim();
    // The name picks the refusal the API would give, so each can be checked on its own.
    if (name.startsWith("limit-")) return err(409, "conflict", "An organization can have up to 100 active API keys. Revoke one first.");
    if (!name || name.length > 60) return err(400, "validation_failed", "Use 1 to 60 characters for the name, on one line.", "name");
    if (!["admin", "read_only"].includes(body?.role)) return err(400, "validation_failed", "Choose a role: admin or read_only.", "role");
    const token = newToken();
    const key = { id: randomUUID(), name, role: body.role, prefix: token.slice(0, 12), status: "active", createdAt: now(), lastUsedAt: null, expiresAt: body.expiresAt ?? null, revokedAt: null };
    publicKeys.unshift(key);
    return { status: 201, body: { key, token } };
  }
  if (method === "DELETE" && (m = /^\/public\/api-keys\/([^/]+)$/.exec(path))) {
    const key = publicKeys.find((k) => k.id === m[1]);
    if (!key) return err(404, "not_found", "That API key does not exist.");
    Object.assign(key, { revokedAt: key.revokedAt ?? now(), status: "revoked" });
    return { status: 200, body: key };
  }
  return null;
}

const api = createServer((req, res) => {
  const send = (r) => {
    res.writeHead(r.status, { ...cors(req), "content-type": "application/json", "cache-control": "no-store", ...(r.headers ?? {}) });
    res.end(r.body === undefined ? "" : JSON.stringify(r.body));
  };
  if (req.method === "OPTIONS") return send({ status: 204 });
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, API);
    const path = url.pathname.replace(/^\/v1/, "");
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path, key: req.headers["idempotency-key"] ?? null, auth: req.headers.authorization ?? null, org: req.headers["x-fenvix-workspace"] ?? null });
    if (!req.headers.authorization?.startsWith("Bearer ")) return send(err(401, "unauthenticated", "Sign in to continue."));
    // As the control plane: a session on the key routes must name the organization.
    if (path.startsWith("/public/") && !req.headers["x-fenvix-workspace"]) {
      return send(err(400, "validation_failed", "Name the organization with the X-Fenvix-Workspace header (its id) to manage its API keys.", "X-Fenvix-Workspace"));
    }
    const r = route(req.method, path, url.searchParams, body);
    send(r ?? { status: 404, body: { error: { code: "not_found", message: `No such route in the fake: ${req.method} ${path}` } } });
  });
}).listen(API_PORT, "127.0.0.1");

// ------------------------------------------------------------------ build and serve the app
const env = { ...process.env, VITE_DATA_BACKEND: "", VITE_API_URL: API, VITE_SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, VITE_SUPABASE_ANON_KEY: "local-anon-key" };
if (spawnSync("npx", ["vite", "build", "--outDir", "dist-api", "--emptyOutDir"], { env, stdio: "ignore" }).status !== 0) {
  console.error("api checks: build failed");
  process.exit(1);
}
const preview = spawn("npx", ["vite", "preview", "--outDir", "dist-api", "--port", String(APP_PORT), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
const stopAll = () => (preview.kill(), api.close(), sb.close());
process.on("exit", stopAll);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(APP)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 250));
}

// ------------------------------------------------------------------ checks
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const browser = await chromium.launch();

/** A page that is already signed in: the session Supabase would keep in the browser, and the chosen organization. */
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: "header.payload.sig", token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "refresh",
    user: { id: USER.id, aud: "authenticated", role: "authenticated", email: USER.email, app_metadata: { provider: "github" }, user_metadata: { full_name: "Owner" }, created_at: "2026-01-01T00:00:00Z" },
  };
  await ctx.addInitScript(([s, org]) => {
    localStorage.setItem("sb-127-auth-token", s);
    localStorage.setItem("fenvix-org", org);
  }, [JSON.stringify(session), ORG]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  page.setDefaultTimeout(15000);
  return { ctx, page };
}

const writes = (path) => requests.filter((r) => r.method !== "GET" && r.path === path);

async function createWith(page, name) {
  await page.goto(`${APP}databases/new`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create database" }).click();
}

const CHECKS = {
  async "list: the databases come from GET /v1/databases, with the session token and the organization"(page) {
    await page.goto(`${APP}databases`);
    for (const n of ["orders-prod", "orders-staging", "agent-memory"]) await page.getByRole("link", { name: n }).first().waitFor();
    const list = requests.filter((r) => r.method === "GET" && r.path === "/databases");
    assert(list.length > 0, "the list was not asked for");
    assert(list.every((r) => r.auth === "Bearer header.payload.sig" && r.org === ORG), "the token or the organization header is missing");
  },

  async "create: POST /v1/databases with an Idempotency-Key; the password is shown once, then never again"(page) {
    await createWith(page, "api-create-01");
    await page.getByRole("heading", { name: "Your database is ready" }).waitFor();
    const password = (await page.getByTestId("once-password").innerText()).trim();
    assert(/^Pw[0-9a-f]{30}Once1234$/.test(password), `the password shown: ${password}`);
    await page.getByText("This is the only time it is shown").waitFor();
    const sent = writes("/databases");
    assert(sent.length === 1 && sent[0].key && sent[0].key.length >= 16, `the create was sent ${sent.length} times, key ${sent[0]?.key}`);
    await page.getByRole("link", { name: "Open database" }).click();
    await page.waitForURL(/\/databases\/[0-9a-f-]{36}$/);
    await page.getByRole("heading", { name: "Your database is ready" }).waitFor({ state: "detached" });
    await page.getByRole("heading", { name: "api-create-01" }).waitFor();
    assert(!(await page.content()).includes(password), "the password is still on the page after leaving the creation screen");
  },

  async "create that takes longer: the screen says it is queued, then in progress, and polls until it is done (password null)"(page) {
    await createWith(page, "slow-create-01");
    const note = page.locator(".op-note");
    await note.filter({ hasText: /queued|in progress/ }).first().waitFor();
    await page.getByRole("heading", { name: "Your database is ready" }).waitFor();
    await page.getByText("The password of this database's first user could not be shown here.").waitFor();
    assert(!(await page.getByTestId("once-password").count()), "a password is shown for a create that answered 202");
    assert(requests.some((r) => r.method === "GET" && r.path.startsWith("/operations/")), "the operation was never polled");
    assert(writes("/databases").filter((r) => r.key).length === writes("/databases").length, "a create went without an Idempotency-Key");
  },

  async "create that fails in the engine: the reason is shown and the form stays"(page) {
    await createWith(page, "broken-create-01");
    const alert = page.getByRole("alert").filter({ hasText: "The engine could not create the database. Nothing was kept: try again." });
    await alert.waitFor();
    await page.getByRole("button", { name: "Create database" }).waitFor();
  },

  async "create refused: 401, 403, 409 and 422 show the control plane's message"(page) {
    const cases = [
      ["expired-db-01", "Sign in to continue."],
      ["member-db-01", "Your role in this organization is read only. Ask an owner or admin to do this."],
      ["orders-prod", "A database named orders-prod already exists."],
      ["unprocessable-db-01", "Choose a region."],
    ];
    for (const [name, message] of cases) {
      await createWith(page, name);
      await page.getByRole("alert").filter({ hasText: message }).waitFor();
      const text = await page.getByRole("alert").first().innerText();
      assert(!/You do not have access to that|<html|\b4\d\d\b/.test(text), `unreadable error for ${name}: ${text}`);
    }
  },

  async "fork: POST /v1/databases/{id}/fork, the fork's password shown once, then the fork opens"(page) {
    const src = dbs.find((d) => d.name === "agent-memory");
    await page.goto(`${APP}databases/${src.id}`);
    await page.getByRole("button", { name: "Fork", exact: true }).click();
    await page.getByLabel("Name of the copy").fill("orders-prod");
    await page.getByRole("button", { name: "Fork and open" }).click();
    await page.getByRole("dialog").getByRole("alert").getByText("already exists").waitFor();
    await page.getByLabel("Name of the copy").fill("api-fork-01");
    await page.getByRole("button", { name: "Fork and open" }).click();
    const shown = page.getByRole("dialog", { name: "Save the fork's database user" });
    await shown.waitFor();
    assert(/^Fork[0-9a-f]{32}ab12$/.test((await shown.getByTestId("once-password").innerText()).trim()), "the fork's password is not shown");
    await shown.getByRole("button", { name: "I have saved it" }).click();
    await page.getByRole("heading", { name: "api-fork-01" }).waitFor();
    const sent = writes(`/databases/${src.id}/fork`);
    assert(sent.length === 2 && sent.every((r) => r.key) && sent[0].key !== sent[1].key, "each fork needs its own Idempotency-Key");
  },

  async "erase: POST /v1/databases/erase, the progress is shown while it runs, then the database is gone"(page) {
    const d = dbs.find((x) => x.name === "orders-staging");
    await page.goto(`${APP}databases/${d.id}`);
    await page.getByRole("button", { name: "Erase", exact: true }).click();
    await page.getByLabel(/^Type orders-staging/).fill("orders-staging");
    await page.getByRole("button", { name: "Erase database" }).click();
    await page.locator(".op-note").filter({ hasText: /Erasing/ }).first().waitFor();
    await page.getByRole("heading", { name: "Databases", exact: true }).waitFor();
    assert(!dbs.some((x) => x.id === d.id), "the database was not erased");
    const sent = writes("/databases/erase");
    assert(sent.length === 1 && sent[0].key, "erase needs an Idempotency-Key");
    await page.goto(`${APP}databases/${d.id}`);
    await page.getByRole("heading", { name: "Database not found" }).waitFor();
  },

  async "API keys: public keys (fvx_) on /v1/public/api-keys; the key shown once with a curl example; revoke with DELETE"(page) {
    await page.goto(`${APP}api-keys`);
    await page.getByRole("row", { name: /Production backend/ }).getByText("fvx_7HcR0ZyN…").waitFor();
    await page.getByLabel("Key name").fill("limit-check");
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByRole("alert").filter({ hasText: "An organization can have up to 100 active API keys. Revoke one first." }).waitFor();

    await page.getByLabel("Key name").fill("CI deploys");
    await page.getByRole("button", { name: "Create key" }).click();
    await page.getByText("Key “CI deploys” created.").waitFor();
    const token = (await page.locator(".secret").innerText()).trim();
    assert(/^fvx_[A-Za-z0-9_-]{43}$/.test(token), `the new key reads ${token}`);
    await page.getByText("It will not be shown again.").waitFor();
    const example = await page.getByLabel("Try it: list your databases").inputValue();
    assert(example.includes(`export FENVIX_API=${API}/public`), `the example does not use the API host: ${example}`);
    assert(!example.includes(token) && /\$FENVIX_KEY/.test(example), "the example holds the key instead of reading $FENVIX_KEY");
    assert((await page.getByRole("link", { name: `${API}/openapi.json` }).count()) === 1, "no link to the OpenAPI document");

    const sent = requests.filter((r) => r.method === "POST" && r.path === "/public/api-keys");
    assert(sent.length === 2 && sent.every((r) => r.key && r.org === ORG && r.auth === "Bearer header.payload.sig"), "a create went without its Idempotency-Key, organization or session");
    const made = publicKeys.find((k) => k.name === "CI deploys");
    assert(made.role === "read_only" && made.expiresAt && Math.abs(new Date(made.expiresAt) - Date.now() - 90 * 86_400_000) < 3_600_000, `defaults: ${made.role} ${made.expiresAt}`);

    await page.getByRole("button", { name: "Revoke key CI deploys" }).click();
    await page.getByRole("dialog").getByText("stops working immediately").waitFor();
    await page.getByRole("button", { name: "Revoke key", exact: true }).click();
    await page.getByRole("row", { name: /CI deploys/ }).getByText("Revoked").waitFor();
    const del = requests.filter((r) => r.method === "DELETE" && r.path === `/public/api-keys/${made.id}`);
    assert(del.length === 1 && del[0].key, "revoke is not one DELETE with an Idempotency-Key");
    assert(!requests.some((r) => r.path === "/api-keys" || r.path.startsWith("/api-keys/")), "the page still calls the dashboard's fnx_ key routes");
  },
};

let failures = 0;
let passes = 0;
for (const [name, check] of Object.entries(CHECKS)) {
  const { ctx, page } = await newPage();
  try {
    await check(page);
    assert(page.errors.length === 0, `page errors: ${page.errors.join(" | ")}`);
    passes++;
    if (process.env.VERBOSE) console.log("ok  ", name);
  } catch (e) {
    failures++;
    console.log("FAIL", name, "-", e instanceof Error ? e.message.split("\n")[0] : e);
  } finally {
    await ctx.close();
  }
}

const rpc = supabaseCalls.filter((c) => /\/rest\/v1\//.test(c));
if (rpc.length) {
  failures++;
  console.log("FAIL", `the dashboard called Supabase for data: ${[...new Set(rpc)].join(", ")}`);
} else passes++;

await browser.close();
stopAll();
console.log(failures ? `api checks: ${failures} of ${passes + failures} failed` : `api checks: all ${passes} passed`);
process.exit(failures ? 1 : 0);
