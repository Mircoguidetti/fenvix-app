// The dashboard's API client (src/data/api.ts) over openapi-fetch, with a stub fetch: the paths, query names and
// headers of openapi/fenvix-api.yaml, the live view's 304, and errors turned into sentences a person can read.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiDataClient, createApiOrgsClient, type ApiConfig } from "../../src/data/api.ts";
import { ApiError, normalizeApiUrl } from "../../src/data/api-errors.ts";
import { configProblem } from "../../src/lib/env.ts";

const ORG = "0b6f2c1e-7a4d-4e1b-9c55-1f2e3d4c5b01";
const BASE = "https://github.fenvix.dev/v1";

interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

/** A client whose fetch answers with `reply` and records every request. */
function stub(reply: (req: Seen) => Response | Promise<Response>, cfg: Partial<ApiConfig> = {}) {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const s: Seen = { method: req.method, url: new URL(req.url), headers: req.headers, body: req.body ? await req.text() : "" };
    seen.push(s);
    return reply(s);
  }) as typeof globalThis.fetch;
  const config: ApiConfig = { baseUrl: BASE, token: async () => "token-123", workspace: () => ORG, fetch, blobUrl: (text) => `blob:${text}`, ...cfg };
  return { data: createApiDataClient(config), orgs: createApiOrgsClient(config), seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const RUN_DETAIL = { run: { id: "r1", status: "running" }, project: { id: "p1" } };

test("every request carries the session token and the organization, to the paths and query names of the API", async () => {
  const { data, seen } = stub(() => json({ items: [], total: 0, page: 2, pageSize: 25 }));
  await data.listRuns("p1", { scope: "pr", status: "failed", page: 2, pageSize: 25 });
  await data.listRuns("p1", { since: "2026-10-18T12:00:00.000Z" });
  const [a, b] = seen;
  assert.equal(a.method, "GET");
  assert.equal(`${a.url.origin}${a.url.pathname}`, `${BASE}/projects/p1/runs`);
  assert.deepEqual(Object.fromEntries(a.url.searchParams), { scope: "pr", status: "failed", page: "2", pageSize: "25" });
  assert.equal(a.headers.get("authorization"), "Bearer token-123");
  assert.equal(a.headers.get("x-fenvix-workspace"), ORG);
  assert.equal(b.url.searchParams.get("since"), "2026-10-18T12:00:00.000Z");
  assert.equal(b.url.searchParams.has("page"), false, "no paging with since");
});

test("the paths of the other operations, and the bodies the API expects", async () => {
  const replies: Record<string, unknown> = {
    "GET /projects/p1/audit": { testsRerun: 1 },
    "GET /activity": { items: [] },
    "GET /defects": { items: [] },
    "GET /github": { account: null, installations: [] },
    "GET /github/repositories": { items: [{ repositoryId: 42 }] },
    "POST /github/install-link": { url: "https://github.com/apps/fenvix/installations/new?state=s" },
    "POST /github/repositories/42/setup-pull-request": { repositoryId: 42, onboardingState: "pending" },
    "PUT /settings": { workspaceName: "Acme", emailNotices: true, region: "eu" },
    "PUT /projects/p1/settings": { id: "p1" },
  };
  const { data, seen } = stub((s) => json(replies[`${s.method} ${s.url.pathname.replace("/v1", "")}`] ?? {}, s.method === "POST" && s.url.pathname.endsWith("setup-pull-request") ? 202 : 200));
  await data.getAudit("p1", 30);
  await data.listActivity("p1", 8);
  await data.listDefects({ projectId: "p1", state: "all" });
  assert.equal((await data.getGitHubConnection()).account, null);
  assert.equal((await data.listGitHubRepositories())[0].repositoryId, 42);
  assert.equal(await data.createInstallLink(), "https://github.com/apps/fenvix/installations/new?state=s");
  assert.equal((await data.openSetupPullRequest(42)).onboardingState, "pending", "202 Queued gives the repository as it is now");
  assert.equal((await data.saveSettings({ workspaceName: "Acme", emailNotices: true, region: "eu" })).region, "eu");
  await data.saveProjectSettings("p1", { skipWithProof: true, commentOnPullRequests: false, nightlyExploration: true, testCommand: "" });
  const at = (m: string, p: string) => seen.find((s) => s.method === m && s.url.pathname === `/v1${p}`);
  assert.equal(at("GET", "/projects/p1/audit")?.url.searchParams.get("days"), "30");
  assert.deepEqual(Object.fromEntries(at("GET", "/activity")!.url.searchParams), { projectId: "p1", limit: "8" });
  assert.deepEqual(Object.fromEntries(at("GET", "/defects")!.url.searchParams), { projectId: "p1", state: "all" });
  assert.ok(at("POST", "/github/repositories/42/setup-pull-request"), "the setup pull request goes by GitHub's repository id");
  assert.deepEqual(JSON.parse(at("PUT", "/settings")!.body), { workspaceName: "Acme", emailNotices: true, region: "eu" });
  assert.equal(at("PUT", "/settings")!.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(at("PUT", "/projects/p1/settings")!.body), { skipWithProof: true, commentOnPullRequests: false, nightlyExploration: true, testCommand: "" });
  for (const s of seen) assert.equal(s.headers.get("x-fenvix-workspace"), ORG, `${s.method} ${s.url.pathname} has no organization`);
});

test("the live run view: If-None-Match with the last ETag, 304 means nothing changed", async () => {
  const { data, seen } = stub((s) => (s.headers.get("if-none-match") === 'W/"r1-3"' ? new Response(null, { status: 304 }) : json(RUN_DETAIL, 200, { ETag: 'W/"r1-3"' })));
  const first = await data.getRunLive("r1", null);
  assert.equal(first.notModified, false);
  assert.ok(!first.notModified && first.etag === 'W/"r1-3"' && first.detail.run.id === "r1");
  assert.equal(seen[0].headers.get("if-none-match"), null, "no ETag yet: no If-None-Match");
  assert.equal(`${seen[0].url.pathname}`, "/v1/runs/r1");
  const again = await data.getRunLive("r1", 'W/"r1-3"');
  assert.deepEqual(again, { notModified: true });
  assert.equal(seen[1].headers.get("if-none-match"), 'W/"r1-3"');
});

test("errors read as sentences: the server's message, a sentence for its status, the session, the network", async () => {
  const cases: [Response | (() => never), RegExp, number][] = [
    [json({ error: { code: "forbidden", message: "Only an owner or admin can do this." } }, 403), /^Only an owner or admin can do this\.$/, 403],
    [json({ error: { code: "unauthenticated", message: "jwt expired" } }, 401), /^Your session has ended\. Sign in again\.$/, 401],
    [new Response("<html>Bad gateway</html>", { status: 502 }), /^Something went wrong on fenvix's side/, 502],
    [new Response("", { status: 429 }), /^Too many requests/, 429],
    [json({ error: { code: "validation_failed", message: "Choose a region: us or eu.", field: "region" } }, 400), /^Choose a region/, 400],
    [() => { throw new TypeError("Failed to fetch"); }, /^Could not reach fenvix/, 0],
  ];
  for (const [reply, message, status] of cases) {
    const { data } = stub(() => (typeof reply === "function" ? reply() : reply.clone()));
    await assert.rejects(data.getOverview(), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.match(e.message, message);
      assert.equal(e.status, status);
      return true;
    });
  }
  const field = stub(() => json({ error: { code: "validation_failed", message: "Bad region", field: "region" } }, 400));
  await assert.rejects(field.data.saveSettings({ workspaceName: "a", emailNotices: true, region: "us" }), (e: unknown) => e instanceof ApiError && e.field === "region" && e.code === "validation_failed");
});

test("signed out or no organization: nothing is sent; a lookup of something that is not there is null", async () => {
  const signedOut = stub(() => json({}), { token: async () => null });
  await assert.rejects(signedOut.data.listProjects(), /Your session has ended\. Sign in again\./);
  assert.equal(signedOut.seen.length, 0);
  const noOrg = stub(() => json({}), { workspace: () => null });
  await assert.rejects(noOrg.data.listProjects(), /Choose an organization first/);
  assert.equal(noOrg.seen.length, 0);
  const noUrl = stub(() => json({}), { baseUrl: "" });
  await assert.rejects(noUrl.data.listProjects(), /VITE_API_URL is not set/);
  const missing = stub(() => json({ error: { code: "not_found", message: "Not found" } }, 404));
  assert.equal(await missing.data.getProject("p9"), null);
  assert.equal(await missing.data.getRun("r9"), null);
  assert.equal(await missing.data.getDefect("d9"), null);
  assert.equal(await missing.data.getSkipReceipt("c9"), null);
});

test("the usage CSV comes as text, named by the server", async () => {
  const { data, seen } = stub(() => new Response("project,runs\nacme/api,3\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="fenvix-usage-2026-11.csv"' } }));
  const file = await data.exportUsage("2026-11");
  assert.equal(seen[0].url.pathname, "/v1/usage/2026-11/csv");
  assert.deepEqual(file, { filename: "fenvix-usage-2026-11.csv", mimeType: "text/csv", downloadUrl: "blob:project,runs\nacme/api,3\n" });
});

test("organizations: /me, the organization's members and invitations, accepting an invitation", async () => {
  const replies: Record<string, unknown> = {
    "GET /me": { user: { id: "u", email: "a@b.c", name: "A" }, organizations: [{ id: ORG, name: "Acme", role: "owner", nameConfirmed: true }] },
    "POST /organization/invitations": { invitation: { id: "i1", email: "x@y.z", role: "member", createdAt: null, expiresAt: null }, link: "https://app/invite#token=t" },
    "POST /invitations/accept": { organization: { id: ORG, name: "Acme", role: "member", nameConfirmed: true } },
    "GET /organization/members": { items: [], limit: 50 },
  };
  const { orgs, seen } = stub((s) => (s.method === "DELETE" || s.url.pathname.endsWith("/leave") ? new Response(null, { status: 204 }) : json(replies[`${s.method} ${s.url.pathname.replace("/v1", "")}`] ?? {}, s.method === "POST" && s.url.pathname.endsWith("/invitations") ? 201 : 200)));
  assert.equal(orgs.available, true);
  assert.equal((await orgs.me()).organizations[0].name, "Acme");
  assert.equal((await orgs.createInvitation("x@y.z", "member")).link, "https://app/invite#token=t");
  assert.equal((await orgs.acceptInvitation("t")).role, "member");
  assert.equal((await orgs.listMembers()).limit, 50);
  await orgs.removeMember("u2");
  await orgs.leaveOrganization();
  const at = (m: string, p: string) => seen.find((s) => s.method === m && s.url.pathname === `/v1${p}`)!;
  assert.equal(at("GET", "/me").headers.get("x-fenvix-workspace"), null, "/me is not about one organization");
  assert.equal(at("POST", "/invitations/accept").headers.get("x-fenvix-workspace"), null);
  assert.deepEqual(JSON.parse(at("POST", "/invitations/accept").body), { token: "t" });
  assert.deepEqual(JSON.parse(at("POST", "/organization/invitations").body), { email: "x@y.z", role: "member" });
  assert.equal(at("POST", "/organization/invitations").headers.get("x-fenvix-workspace"), ORG);
  assert.ok(at("DELETE", "/organization/members/u2"));
  assert.equal(createApiOrgsClient({ baseUrl: "", token: async () => "t", workspace: () => ORG }).available, false);
});

test("the API address and what the sign-in page says when the build is missing a setting", () => {
  assert.equal(normalizeApiUrl("https://github.fenvix.dev"), "https://github.fenvix.dev/v1");
  assert.equal(normalizeApiUrl(" https://github.fenvix.dev/v1/ "), "https://github.fenvix.dev/v1");
  assert.equal(normalizeApiUrl("http://localhost:8787/v1"), "http://localhost:8787/v1");
  const ok = { backend: "api" as const, apiUrl: BASE, supabaseUrl: "https://abcd.supabase.co", supabaseAnonKey: "anon" };
  assert.equal(configProblem(ok), null);
  assert.equal(configProblem({ ...ok, backend: "mock", apiUrl: "", supabaseUrl: "", supabaseAnonKey: "" }), null, "the mock needs nothing");
  assert.match(configProblem({ ...ok, apiUrl: "" })!, /missing VITE_API_URL\./);
  assert.match(configProblem({ ...ok, supabaseAnonKey: "" })!, /missing VITE_SUPABASE_ANON_KEY\./);
  assert.match(configProblem({ ...ok, apiUrl: "", supabaseUrl: "", supabaseAnonKey: "" })!, /missing VITE_API_URL, VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY\. Set them/);
  assert.match(configProblem({ ...ok, supabaseUrl: "https://example.com" })!, /does not look like a Supabase project URL/);
});
