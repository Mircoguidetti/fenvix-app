// The dashboard API without a database: the contract compiled in, the route and role tables, the ETag, the session
// check, request validation (before any database access), CORS, the settings and the Lambda entry's secrets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { SessionVerifier } from "../../src/auth.ts";
import { loadApiConfig } from "../../src/api/config.ts";
import { allowed, mayAdminister, type Role } from "../../src/api/context.ts";
import { etagMatches, runEtag } from "../../src/api/data.ts";
import type { ApiDb, Tx } from "../../src/api/db.ts";
import { GEN_PATH, generated, YAML_PATH } from "../../src/api/gen-openapi.ts";
import { hashToken, parseEmail, parseOrgName } from "../../src/api/orgs.ts";
import { buildApi, CORS, HANDLERS } from "../../src/api/server.ts";
import * as shared from "../../src/api/shared.js";
import { dashboardOperations, operations } from "../../src/api/spec.ts";
import { apiConfig, cached, makeApiHandler } from "../../src/lambda/api.ts";
import { parameterNames } from "../../src/lambda/secrets.ts";

const ENV = {
  NODE_ENV: "test", API_DATABASE_URL: "postgresql://fenvix_api:x@127.0.0.1:6543/postgres", SUPABASE_URL: "https://project.supabase.invalid",
  STATE_SIGNING_KEY: "s".repeat(40), DASHBOARD_URL: "https://console.fenvix.dev", GITHUB_APP_SLUG: "fenvix", LOG_LEVEL: "silent",
};
const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

describe("the contract inside the bundle", () => {
  it("src/api/openapi.gen.ts is openapi/fenvix-api.yaml (run `node src/api/gen-openapi.ts` after changing the YAML)", () => {
    assert.equal(readFileSync(GEN_PATH, "utf8"), generated(readFileSync(YAML_PATH, "utf8")));
  });

  it("a handler for every dashboard operation, none for anything else; runner operations are not served here", () => {
    const dash = dashboardOperations().map((o) => o.operationId).sort();
    assert.deepEqual(Object.keys(HANDLERS).sort(), dash);
    assert.ok(operations().some((o) => o.tags.includes("runner")));
    assert.ok(dashboardOperations().every((o) => !o.route.startsWith("/v1/runner/")));
  });

  it("shared.js exports every function shared.d.ts declares (the dashboard's own calculations and mappers)", () => {
    const declared = [...readFileSync(new URL("../../src/api/shared.d.ts", import.meta.url), "utf8").matchAll(/^export function (\w+)/gm)].map((m) => m[1]!);
    assert.ok(declared.length > 20);
    for (const name of declared) assert.equal(typeof (shared as Record<string, unknown>)[name], "function", name);
  });

  it("request schemas: the organization header on every organization operation, references inlined", () => {
    for (const o of dashboardOperations()) {
      if (o.workspace) assert.deepEqual((o.headers?.required as string[]).includes("x-fenvix-workspace"), true, o.operationId);
      assert.doesNotMatch(JSON.stringify([o.params, o.querystring, o.headers, o.body, o.responses]), /\$ref/, o.operationId);
    }
    const noOrg = dashboardOperations().filter((o) => !o.workspace).map((o) => o.operationId).sort();
    // completeGitHubInstall: the organization comes from the completion (the install link's signed state), and the
    // database links only for the person that state names (review R-016 F2).
    assert.deepEqual(noOrg, ["acceptInvitation", "completeGitHubInstall", "createOrganization", "getMe", "listOrganizations"]);
  });
});

describe("the role table", () => {
  const ADMIN_OPS = ["changeMemberRole", "createInstallLink", "createInvitation", "listInvitations", "openSetupPullRequest", "removeMember", "renameOrganization", "revokeInvitation", "saveProjectSettings", "saveSettings"];

  it("x-fenvix-role: admin marks exactly the owner-or-admin operations", () => {
    assert.deepEqual(dashboardOperations().filter((o) => o.admin).map((o) => o.operationId).sort(), ADMIN_OPS);
  });

  it("owner and admin may call every operation; a member every one but those", () => {
    for (const o of dashboardOperations()) {
      for (const role of ["owner", "admin", "member"] as Role[]) assert.equal(allowed(o, role), role !== "member" || !o.admin, `${o.operationId} ${role}`);
    }
    assert.deepEqual((["owner", "admin", "member"] as Role[]).map(mayAdminister), [true, true, false]);
  });
});

describe("the live run view's ETag", () => {
  it("changes with updated_at, with progress_at and with the project as shown; stable otherwise", () => {
    const p = { id: "p", settings: { testCommand: "" } };
    const e = runEtag("2026-11-18 10:00:00.123456+00", null, p);
    assert.match(e, /^"r[\w-]{27}"$/);
    assert.equal(runEtag("2026-11-18 10:00:00.123456+00", null, p), e);
    assert.notEqual(runEtag("2026-11-18 10:00:00.123457+00", null, p), e, "a microsecond later");
    assert.notEqual(runEtag("2026-11-18 10:00:00.123456+00", "2026-11-18 10:00:03+00", p), e);
    assert.notEqual(runEtag("2026-11-18 10:00:00.123456+00", null, { ...p, settings: { testCommand: "pytest" } }), e);
  });

  it("If-None-Match: the tag, its weak form, a list, *; nothing else", () => {
    const e = '"rabc"';
    assert.equal(etagMatches(e, e), true);
    assert.equal(etagMatches(`W/${e}`, e), true);
    assert.equal(etagMatches(`"x", ${e}`, e), true);
    assert.equal(etagMatches("*", e), true);
    assert.equal(etagMatches('"rabd"', e), false);
    assert.equal(etagMatches("", e), false);
    assert.equal(etagMatches(undefined, e), false);
  });
});

describe("organization rules", () => {
  it("names: trimmed, 2 to 64 characters, one line", () => {
    assert.equal(parseOrgName("  Acme  "), "Acme");
    assert.throws(() => parseOrgName("A"), /2 to 64/);
    assert.throws(() => parseOrgName("x".repeat(65)), /2 to 64/);
    assert.equal(parseOrgName("é".repeat(64)).length, 64);
    assert.throws(() => parseOrgName("two\nlines"), /one line/);
    assert.throws(() => parseOrgName("evil‮flip"), /one line/);
  });

  it("e-mails lower-cased; an invitation token is stored as its sha256 only", () => {
    assert.equal(parseEmail(" Ada@Example.COM "), "ada@example.com");
    assert.throws(() => parseEmail("not-an-email"), /valid e-mail/);
    assert.match(hashToken("t"), /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------- the HTTP layer with a database that must not be reached

class FakeDb {
  calls: { userId: string; ws: string | null }[] = [];
  rows: Record<string, unknown[]> = {};
  async tx<T>(userId: string, ws: string | null, fn: (t: Tx) => Promise<T>): Promise<T> {
    this.calls.push({ userId, ws });
    const pick = (sql: string) => Object.entries(this.rows).find(([k]) => sql.includes(k))?.[1] ?? [];
    return fn({ q: async (sql: string) => pick(sql) as never, one: async (sql: string) => pick(sql)[0] as never });
  }
  async close() {}
}

async function harness(env: Record<string, string> = ENV) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] });
  const db = new FakeDb();
  const cfg = loadApiConfig(env);
  const api = buildApi({ cfg, db: db as unknown as ApiDb, sessions: new SessionVerifier(cfg.supabaseUrl, "", jwks), queue: { enqueue: async () => {} }, logger: false });
  const sign = (o: { key?: CryptoKey; alg?: string; iss?: string; aud?: string; sub?: string; exp?: string } = {}) =>
    new SignJWT({}).setProtectedHeader({ alg: o.alg ?? "ES256", kid: "k1" }).setIssuer(o.iss ?? `${cfg.supabaseUrl}/auth/v1`).setAudience(o.aud ?? "authenticated")
      .setSubject(o.sub ?? USER.toUpperCase()).setIssuedAt().setExpirationTime(o.exp ?? "1h").sign(o.key ?? privateKey);
  return { api, db, sign };
}

describe("the session check (Authorization: Bearer <Supabase access token>)", async () => {
  const { api, db, sign } = await harness();
  const me = (authorization?: string) => api.fastify.inject({ method: "GET", url: "/v1/me", headers: authorization ? { authorization } : {} });

  it("401 for no header, another scheme, an empty token, a symmetric (HS256) token, another issuer or audience, an expired token", async () => {
    const other = await generateKeyPair("ES256");
    const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("https://project.supabase.invalid/auth/v1").setAudience("authenticated").setSubject(USER).setExpirationTime("1h").sign(new TextEncoder().encode("x".repeat(32)));
    const cases = [undefined, "Basic abc", "Bearer", `Bearer ${hs}`, `Bearer ${await sign({ iss: "https://evil.invalid/auth/v1" })}`,
      `Bearer ${await sign({ aud: "anon" })}`, `Bearer ${await sign({ exp: "-1m" })}`, `Bearer ${await sign({ key: other.privateKey })}`, `Bearer ${await sign({ sub: "service_role" })}`];
    for (const h of cases) {
      const r = await me(h);
      assert.equal(r.statusCode, 401, String(h).slice(0, 30));
      assert.equal(r.json().error.code, "unauthenticated");
    }
    assert.equal(db.calls.length, 0, "no database access without a verified session");
  });

  it("a valid token: one transaction for that user (id lower-cased); no organization for /me", async () => {
    db.rows = { "api_me()": [{ user_id: USER, email: "a@b.co", name: "A" }], "from public.workspace_members m join public.workspaces w": [] };
    const r = await me(`Bearer ${await sign()}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { user: { id: USER, email: "a@b.co", name: "A" }, organizations: [] });
    assert.deepEqual(db.calls.at(-1), { userId: USER, ws: null });
  });

  it("requests are checked against the contract before the database: 400 with the field", async () => {
    const before = db.calls.length;
    const token = `Bearer ${await sign()}`;
    const put = (body: string, ct = "application/json") => api.fastify.inject({ method: "PUT", url: "/v1/settings", headers: { authorization: token, "x-fenvix-workspace": WS, "content-type": ct }, payload: body });
    let r = await put(JSON.stringify({ workspaceName: "Acme", emailNotices: "yes", region: "us" }));
    assert.deepEqual([r.statusCode, r.json().error], [400, { code: "validation_failed", message: r.json().error.message, field: "emailNotices" }]);
    r = await put(JSON.stringify({ workspaceName: "Acme", emailNotices: true }));
    assert.deepEqual([r.statusCode, r.json().error.field], [400, "region"]);
    r = await put("{not json");
    assert.deepEqual([r.statusCode, r.json().error.code], [400, "validation_failed"]);
    r = await put("<x/>", "text/xml");
    assert.equal(r.statusCode, 415);
    r = await api.fastify.inject({ method: "GET", url: "/v1/projects/x/runs?page=0", headers: { authorization: token, "x-fenvix-workspace": WS } });
    assert.equal(r.statusCode, 400);
    r = await api.fastify.inject({ method: "GET", url: "/v1/overview", headers: { authorization: token, "x-fenvix-workspace": "nope" } });
    assert.deepEqual([r.statusCode, r.json().error.field], [400, "X-Fenvix-Workspace"]);
    assert.equal(db.calls.length, before);
  });

  it("a member is refused an admin operation (403) and an organization they are not in is a 404, both before the handler", async () => {
    const token = `Bearer ${await sign()}`;
    db.rows = { "from public.workspace_members m join public.workspaces w": [{ role: "member", id: WS, name: "Acme", name_confirmed: true, region: "us", email_notices: true }] };
    let r = await api.fastify.inject({ method: "POST", url: "/v1/github/install-link", headers: { authorization: token, "x-fenvix-workspace": WS } });
    assert.deepEqual([r.statusCode, r.json().error.code], [403, "forbidden"]);
    db.rows = {};
    r = await api.fastify.inject({ method: "GET", url: "/v1/settings", headers: { authorization: token, "x-fenvix-workspace": WS } });
    assert.deepEqual([r.statusCode, r.json().error.code], [404, "not_found"]);
    assert.deepEqual(db.calls.at(-1), { userId: USER, ws: WS });
  });

  it("CORS: preflight for the dashboard's origin only; unknown routes are a 404 in the contract's shape", async () => {
    const ok = await api.fastify.inject({ method: "OPTIONS", url: "/v1/organization/members/x", headers: { origin: "https://console.fenvix.dev", "access-control-request-method": "PUT" } });
    assert.equal(ok.statusCode, 204);
    assert.equal(ok.headers["access-control-allow-headers"], CORS.allowHeaders);
    assert.equal(ok.headers["access-control-allow-methods"], CORS.methods);
    const bad = await api.fastify.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "https://console.fenvix.dev.evil.example", "access-control-request-method": "GET" } });
    assert.equal(bad.statusCode, 403);
    const nf = await api.fastify.inject({ method: "GET", url: "/v1/nothing-here" });
    assert.deepEqual([nf.statusCode, nf.json().error.code], [404, "not_found"]);
  });
});

describe("settings and the Lambda entry", () => {
  it("the API's settings: its database URL and the state key are required; CORS origins are origins", () => {
    const c = loadApiConfig(ENV);
    assert.deepEqual(c.corsOrigins, ["https://console.fenvix.dev"]);
    assert.equal(c.webUrl, "https://github.com");
    assert.throws(() => loadApiConfig({ ...ENV, API_DATABASE_URL: "" }), /API_DATABASE_URL/);
    assert.throws(() => loadApiConfig({ ...ENV, STATE_SIGNING_KEY: "short" }), /STATE_SIGNING_KEY/);
    assert.throws(() => loadApiConfig({ ...ENV, API_CORS_ORIGINS: "https://a.example/path" }), /origin/);
    assert.deepEqual(loadApiConfig({ ...ENV, API_CORS_ORIGINS: "https://preview.fenvix.dev, https://console.fenvix.dev" }).corsOrigins, ["https://console.fenvix.dev", "https://preview.fenvix.dev"]);
    assert.throws(() => loadApiConfig({ ...ENV, NODE_ENV: "production", DASHBOARD_URL: "http://console.fenvix.dev" }), /https/);
  });

  it("the API's SSM parameters: its database URL and the state signing key, nothing of the App's", async () => {
    const prefix = "/fenvix/prod/github-app";
    assert.deepEqual(parameterNames(prefix, "api"), [`${prefix}/state-signing-key`, `${prefix}/api-database-url`]);
    assert.ok(!parameterNames(prefix, "all").includes(`${prefix}/api-database-url`), "the App's functions never get the API's database URL");
    const asked: string[][] = [];
    const ssm = { send: async (cmd: { input: { Names: string[] } }) => {
      asked.push(cmd.input.Names);
      return { Parameters: [{ Name: `${prefix}/state-signing-key`, Value: "k".repeat(40) }, { Name: `${prefix}/api-database-url`, Value: "postgresql://fenvix_api:x@db:6543/postgres" }] };
    } };
    const cfg = await apiConfig({ ...ENV, API_DATABASE_URL: undefined, STATE_SIGNING_KEY: undefined, SSM_PREFIX: prefix }, ssm as never);
    assert.deepEqual(asked, [[`${prefix}/state-signing-key`, `${prefix}/api-database-url`]]);
    assert.equal(cfg.databaseUrl, "postgresql://fenvix_api:x@db:6543/postgres");
    assert.equal(cfg.dbPoolMax, 1, "one connection per Lambda container");
    await assert.rejects(apiConfig({ ...ENV }, ssm as never), /SSM_PREFIX/);
  });

  it("the handler: API Gateway's event through Fastify; made once, again after the TTL, and again after a failure", async () => {
    let made = 0;
    let t = 0;
    const { api } = await harness();
    const get = cached(async () => { made++; if (made === 1) throw new Error("cold start failed"); return api; }, 1000, () => t);
    await assert.rejects(get(), /cold start failed/);
    const handler = makeApiHandler(get);
    const res = await handler({ rawPath: "/v1/me", requestContext: { http: { method: "OPTIONS" } }, headers: { origin: "https://console.fenvix.dev", "access-control-request-method": "GET" } });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["access-control-allow-origin"], "https://console.fenvix.dev");
    await get();
    assert.equal(made, 2);
    t = 5000;
    await get();
    assert.equal(made, 3);
  });
});

describe("the GitHub App not configured yet (GITHUB_APP_SLUG empty: docs/DEPLOY-AWS.md)", async () => {
  const { api, db, sign } = await harness({ ...ENV, GITHUB_APP_SLUG: "" });
  const admin = [{ role: "owner", id: WS, name: "Acme", name_confirmed: true, region: "us", email_notices: true }];

  it("the settings accept an empty slug and say so; a wrong one is still refused", () => {
    assert.equal(loadApiConfig({ ...ENV, GITHUB_APP_SLUG: "" }).githubConfigured, false);
    assert.equal(loadApiConfig(ENV).githubConfigured, true);
    assert.throws(() => loadApiConfig({ ...ENV, GITHUB_APP_SLUG: "Not A Slug" }), /GITHUB_APP_SLUG/);
  });

  it("the operations that need the App answer 503 github_not_configured, before anything is queued or linked", async () => {
    const token = `Bearer ${await sign()}`;
    db.rows = { "from public.workspace_members m join public.workspaces w": admin, "from public.gh_repositories r": [{ repository_id: 5 }] };
    for (const [url, body, ws] of [
      ["/v1/github/install-link", undefined, true],
      ["/v1/github/repositories/5/setup-pull-request", undefined, true],
      ["/v1/github/installations/complete", { completion: "abc" }, false],
    ] as const) {
      const r = await api.fastify.inject({ method: "POST", url, payload: body, headers: { authorization: token, ...(ws ? { "x-fenvix-workspace": WS } : {}) } });
      assert.equal(r.statusCode, 503, url);
      assert.equal(r.json().error.code, "github_not_configured", url);
      assert.match(r.json().error.message, /not been configured/);
    }
  });

  it("everything else works: the organization's GitHub page lists no installation", async () => {
    const token = `Bearer ${await sign()}`;
    db.rows = { "from public.workspace_members m join public.workspaces w": admin };
    const r = await api.fastify.inject({ method: "GET", url: "/v1/github", headers: { authorization: token, "x-fenvix-workspace": WS } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().installations, []);
  });
});
