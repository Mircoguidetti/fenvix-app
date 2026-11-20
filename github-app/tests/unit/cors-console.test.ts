// The dashboard on Vercel (docs/DEPLOY-VERCEL.md) calls the AWS API from https://console.fenvix.dev. The API's CORS
// origins come from the deployed settings (infra/github-app/cdk.json: dashboardUrl, apiCorsOrigins), so this test reads
// them from there, builds the API with exactly what the stack gives its function, and checks that the production origin
// is accepted and Vercel's own hosts (the *.vercel.app production alias and preview URLs) are not: previews build with
// VITE_DATA_BACKEND=mock and never call the API.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SessionVerifier } from "../../src/auth.ts";
import { loadApiConfig } from "../../src/api/config.ts";
import type { ApiDb } from "../../src/api/db.ts";
import { buildApi, CORS } from "../../src/api/server.ts";

const CDK = (JSON.parse(readFileSync(new URL("../../../infra/github-app/cdk.json", import.meta.url), "utf8")) as { context: Record<string, string> }).context;
const PROD = "https://console.fenvix.dev";

/** What infra/github-app/lib/stack.ts gives the DashboardApi function, with the deployed cdk.json values. */
const ENV: Record<string, string> = {
  NODE_ENV: "production", API_DATABASE_URL: "postgresql://fenvix_api:x@127.0.0.1:6543/postgres", SUPABASE_URL: "https://project.supabase.co",
  STATE_SIGNING_KEY: "s".repeat(40), DASHBOARD_URL: CDK.dashboardUrl ?? "", GITHUB_APP_SLUG: "fenvix", LOG_LEVEL: "silent",
  ...(CDK.apiCorsOrigins ? { API_CORS_ORIGINS: CDK.apiCorsOrigins } : {}),
};

describe("CORS for the dashboard's production origin (console.fenvix.dev, on Vercel)", () => {
  const cfg = loadApiConfig(ENV);
  const api = buildApi({
    cfg, db: { tx: async () => { throw new Error("no database in this test"); }, close: async () => {} } as unknown as ApiDb,
    sessions: new SessionVerifier(cfg.supabaseUrl, "https://project.supabase.co/auth/v1/.well-known/jwks.json"),
    queue: { enqueue: async () => {} }, logger: false,
  });
  const preflight = (origin: string, method = "GET") =>
    api.fastify.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin, "access-control-request-method": method } });

  it("the deployed settings allow exactly https://console.fenvix.dev", () => {
    assert.equal(CDK.dashboardUrl, PROD);
    assert.equal(CDK.dashboardDomain, "console.fenvix.dev");
    assert.deepEqual(cfg.corsOrigins, [PROD]);
  });

  it("a preflight from https://console.fenvix.dev is allowed, for every method the dashboard uses", async () => {
    for (const m of ["GET", "POST", "PUT", "DELETE"]) {
      const r = await preflight(PROD, m);
      assert.equal(r.statusCode, 204, m);
      assert.equal(r.headers["access-control-allow-origin"], PROD, m);
      assert.equal(r.headers["access-control-allow-methods"], CORS.methods);
      assert.match(String(r.headers["access-control-allow-headers"]), /authorization/);
      assert.match(String(r.headers["access-control-allow-headers"]), /x-fenvix-workspace/);
    }
  });

  it("an actual request from https://console.fenvix.dev carries its origin back (401 without a session, still readable)", async () => {
    const r = await api.fastify.inject({ method: "GET", url: "/v1/me", headers: { origin: PROD } });
    assert.equal(r.statusCode, 401);
    assert.equal(r.headers["access-control-allow-origin"], PROD);
    assert.match(String(r.headers.vary), /Origin/);
    // No cookies: the session travels in the Authorization header, so no credentials mode is needed.
    assert.equal(r.headers["access-control-allow-credentials"], undefined);
  });

  it("Vercel's own hosts and look-alikes are refused (no wildcard, no preview origins)", async () => {
    for (const o of ["https://fenvix-app.vercel.app", "https://fenvix-app-git-main-team.vercel.app", "http://console.fenvix.dev", "https://console.fenvix.dev.evil.example", "https://evilconsole.fenvix.dev"]) {
      const r = await preflight(o);
      assert.equal(r.statusCode, 403, o);
      assert.equal(r.headers["access-control-allow-origin"], undefined, o);
      const g = await api.fastify.inject({ method: "GET", url: "/v1/me", headers: { origin: o } });
      assert.equal(g.headers["access-control-allow-origin"], undefined, o);
    }
  });
});
