// The connection strings, the GitHub App's values and Cloudflare, without a network.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { Cloudflare } from "../lib/cloudflare.mjs";
import { waitForCname } from "../lib/dns-check.mjs";
import { syncGitHubApp } from "../lib/github-app.mjs";
import { adminClientConfig, parseAdminUrl, roleUrl, ROLES } from "../lib/supabase.mjs";
import { captured, MemorySsm } from "./helpers.mjs";

const REF = "abcdefghijklmnopqrst";
const POOLER = `postgresql://postgres.${REF}:p%40ss@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;

describe("SUPABASE_DB_URL and the roles' connection strings", () => {
  it("the session pooler string: project, host, password (URL-decoded), the Supabase URL", () => {
    const a = parseAdminUrl(POOLER);
    assert.deepEqual([a.kind, a.ref, a.host, a.port, a.password, a.supabaseUrl], ["supabase", REF, "aws-0-eu-west-1.pooler.supabase.com", 5432, "p@ss", `https://${REF}.supabase.co`]);
    assert.equal(adminClientConfig(a).ssl.rejectUnauthorized, false);
    // The transaction-mode string given by mistake: the admin works in session mode anyway (advisory lock, DDL).
    assert.equal(parseAdminUrl(POOLER.replace(":5432", ":6543")).port, 5432);
  });

  it("refuses what cannot work, saying what to do (and never echoing the password)", () => {
    const cases = [
      ["", /SUPABASE_DB_URL is missing/],
      [`postgresql://postgres:secretpw@db.${REF}.supabase.co:5432/postgres`, /direct connection .*Session pooler/],
      [`postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`, /\[YOUR-PASSWORD\]/],
      ["postgresql://postgres:secretpw@example.com:5432/postgres", /session pooler/],
      ["postgresql://someone:secretpw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres", /postgres\.<project-ref>/],
      ["mysql://x:secretpw@h/db", /postgresql:\/\//],
    ];
    for (const [url, re] of cases) {
      assert.throws(() => parseAdminUrl(url), (e) => { assert.match(e.message, re, url); assert.ok(!e.message.includes("secretpw")); return true; });
    }
  });

  it("role strings: <role>.<ref> on the pooler, session 5432 for the App, transaction 6543 for the API, TLS required", () => {
    const a = parseAdminUrl(POOLER);
    const pw = "A".repeat(43);
    const [app, api] = ROLES.map((r) => roleUrl(a, r, pw));
    assert.equal(app, `postgresql://fenvix_github_app.${REF}:${pw}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true`);
    assert.equal(api, `postgresql://fenvix_api.${REF}:${pw}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true`);
    assert.throws(() => roleUrl(a, ROLES[0], "short"), /URL-safe/);
    const local = parseAdminUrl("postgresql://postgres:pw@127.0.0.1:54329/scratch", { local: true });
    assert.equal(roleUrl(local, ROLES[1], pw), `postgresql://fenvix_api:${pw}@127.0.0.1:54329/scratch`);
  });
});

describe("the GitHub App's values (configured last)", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const secret = "0123456789abcdef0123456789abcdef01234567";
  const vars = { FENVIX_GITHUB_APP_ID: "123456", FENVIX_GITHUB_APP_SLUG: "fenvix", FENVIX_GITHUB_APP_CLIENT_ID: "Iv23liExample" };

  it("none set: not configured, nothing stored", async () => {
    const ssm = new MemorySsm();
    const [r] = await captured(() => syncGitHubApp(ssm, {}));
    assert.deepEqual(r, { configured: false, id: "", slug: "", clientId: "" });
    assert.equal(ssm.params.size, 0);
  });

  it("secrets given as environment variables (a local run): they go to SSM once (compared, never printed)", async () => {
    const ssm = new MemorySsm();
    process.env.GITHUB_ACTIONS = "true";
    const [r, out] = await captured(() => syncGitHubApp(ssm, { ...vars, FENVIX_GITHUB_APP_PRIVATE_KEY: pem, FENVIX_GITHUB_APP_CLIENT_SECRET: secret }));
    assert.equal(r.configured, true);
    assert.equal(ssm.params.get("/fenvix/prod/github-app/private-key").Value, pem.trim());
    assert.equal(ssm.params.get("/fenvix/prod/github-app/client-secret").Type, "SecureString");
    // Only inside ::add-mask:: lines (GitHub hides those lines and the value everywhere after).
    const visible = out.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
    assert.ok(!visible.includes(secret) && !visible.includes(pem.split("\n")[1]));
    ssm.calls = [];
    await captured(() => syncGitHubApp(ssm, { ...vars, FENVIX_GITHUB_APP_PRIVATE_KEY: pem, FENVIX_GITHUB_APP_CLIENT_SECRET: secret }));
    assert.equal(ssm.calls.filter((c) => c.name === "PutParameterCommand").length, 0, "unchanged: no new version");
    delete process.env.GITHUB_ACTIONS;
  });

  it("the workflow's way: secrets typed into SSM in the console, read back only to check their shape (masked first)", async () => {
    const ssm = new MemorySsm({ "/fenvix/prod/github-app/private-key": pem, "/fenvix/prod/github-app/client-secret": secret });
    const [r] = await captured(() => syncGitHubApp(ssm, vars));
    assert.equal(r.configured, true);
  });

  it("half configured stops the deploy, naming what is missing; a malformed secret is refused without echo", async () => {
    await assert.rejects(captured(() => syncGitHubApp(new MemorySsm(), { FENVIX_GITHUB_APP_ID: "1" })), /half configured: missing the SSM parameter \/fenvix\/prod\/bootstrap\/github-app-slug \(FENVIX_GITHUB_APP_SLUG\), the SSM parameter \/fenvix\/prod\/bootstrap\/github-app-client-id \(FENVIX_GITHUB_APP_CLIENT_ID\), the SSM parameter \/fenvix\/prod\/github-app\/private-key/);
    await assert.rejects(captured(() => syncGitHubApp(new MemorySsm(), { ...vars, FENVIX_GITHUB_APP_PRIVATE_KEY: "not-a-key-zzz" })), (e) => /not a PEM private key/.test(e.message) && !e.message.includes("zzz"));
  });
});

describe("Cloudflare records", () => {
  function fakeApi(records = []) {
    const calls = [];
    let next = 100;
    const fetch = async (url, init) => {
      const u = new URL(url), method = init.method;
      calls.push(`${method} ${u.pathname}`);
      assert.equal(init.headers.authorization, "Bearer tok");
      const ok = (result) => ({ ok: true, status: 200, json: async () => ({ success: true, result }) });
      if (u.pathname === "/client/v4/zones") return ok([{ id: "z1", name: "fenvix.dev" }]);
      if (method === "GET") return ok(records.filter((r) => r.name === u.searchParams.get("name")));
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === "POST") { records.push({ ...body, id: `r${next++}` }); return ok({}); }
      const id = u.pathname.split("/").at(-1);
      if (method === "PUT") { Object.assign(records.find((r) => r.id === id), body); return ok({}); }
      if (method === "DELETE") { records.splice(records.findIndex((r) => r.id === id), 1); return ok({}); }
      throw new Error(method);
    };
    return { fetch, calls, records };
  }

  it("creates, keeps, updates; replaces A/AAAA at that exact name only; DNS only; never another name", async () => {
    const api = fakeApi([
      { id: "a1", type: "A", name: "console.fenvix.dev", content: "76.76.21.21", proxied: true },
      { id: "o1", type: "CNAME", name: "www.fenvix.dev", content: "elsewhere.example", proxied: true },
    ]);
    const cf = new Cloudflare({ token: "tok", zone: "fenvix.dev", fetch: api.fetch });
    const [r1] = await captured(() => cf.upsertCname("api.fenvix.dev", "d-abc.execute-api.eu-west-1.amazonaws.com."));
    assert.equal(r1, "created");
    const [r2] = await captured(() => cf.upsertCname("api.fenvix.dev", "d-abc.execute-api.eu-west-1.amazonaws.com"));
    assert.equal(r2, "kept");
    const [r3] = await captured(() => cf.upsertCname("api.fenvix.dev", "d-new.execute-api.eu-west-1.amazonaws.com"));
    assert.equal(r3, "updated");
    const [r4] = await captured(() => cf.upsertCname("console.fenvix.dev", "d123.cloudfront.net"));
    assert.equal(r4, "created");
    assert.deepEqual(api.records.filter((r) => r.name === "console.fenvix.dev").map((r) => [r.type, r.content, r.proxied]), [["CNAME", "d123.cloudfront.net", false]]);
    assert.ok(api.records.some((r) => r.name === "www.fenvix.dev"), "another name is never touched");
    await assert.rejects(cf.upsertCname("github.example.com", "x"), /not in the zone/);
  });

  it("a TXT/MX (or any non-address record) at the name stops with what to remove; nothing is changed", async () => {
    const api = fakeApi([{ id: "t1", type: "TXT", name: "api.fenvix.dev", content: "\"verify=1\"", proxied: false }]);
    const cf = new Cloudflare({ token: "tok", zone: "fenvix.dev", fetch: api.fetch });
    await assert.rejects(cf.upsertCname("api.fenvix.dev", "d-abc.execute-api.eu-west-1.amazonaws.com"), /TXT "verify=1" already exists at this name, and a CNAME cannot sit beside it\. Nothing was changed/);
    assert.deepEqual(api.records.map((r) => r.id), ["t1"]);
  });

  it("removeCnameTo: removes the retired name only while it is a CNAME to API Gateway", async () => {
    const GW = /\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/;
    const api = fakeApi([
      { id: "g1", type: "CNAME", name: "github.fenvix.dev", content: "d-h3eqk8udlf.execute-api.eu-west-1.amazonaws.com", proxied: false },
      { id: "o1", type: "CNAME", name: "other.fenvix.dev", content: "somewhere.example", proxied: false },
    ]);
    const cf = new Cloudflare({ token: "tok", zone: "fenvix.dev", fetch: api.fetch });
    assert.equal((await captured(() => cf.removeCnameTo("github.fenvix.dev", GW)))[0], "removed");
    assert.equal((await captured(() => cf.removeCnameTo("github.fenvix.dev", GW)))[0], "absent");
    assert.match((await captured(() => cf.removeCnameTo("other.fenvix.dev", GW)))[0], /^kept/);
    assert.deepEqual(api.records.map((r) => r.id), ["o1"]);
    await assert.rejects(cf.removeCnameTo("github.example.com", GW), /not in the zone/);
  });

  it("waitForCname: true once public DNS shows the target (case and trailing dot ignored), false when time is up", async () => {
    let n = 0;
    const lookup = async () => (++n < 3 ? null : "D-ABC.execute-api.eu-west-1.amazonaws.com");
    assert.equal(await waitForCname("api.fenvix.dev", "d-abc.execute-api.eu-west-1.amazonaws.com.", { timeoutMs: 1000, everyMs: 1, lookup }), true);
    assert.equal(await waitForCname("api.fenvix.dev", "d-abc.execute-api.eu-west-1.amazonaws.com", { timeoutMs: 5, everyMs: 1, lookup: async () => "old.example" }), false);
    assert.equal(await waitForCname("api.fenvix.dev", "x", { timeoutMs: 0, everyMs: 1, lookup: async () => { throw new Error("SERVFAIL"); } }), false);
  });

  it("a refused token says which permissions it needs", async () => {
    const cf = new Cloudflare({ token: "tok", zone: "fenvix.dev", fetch: async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }) }) });
    await assert.rejects(cf.upsertCname("api.fenvix.dev", "x.example"), /HTTP 403 .*Zone · DNS · Edit/);
  });
});
