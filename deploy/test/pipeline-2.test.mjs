// Deploy pipeline, second pass (docs/REPORT-deploy-pipeline-2.md): the R-024 fixes beyond the reviewer's own tests, the
// pooler's TLS verified with a CA, the environment's branch rule, the dashboard on console.fenvix.dev.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { migrate, MIGRATIONS_DIR, readMigrations } from "../lib/migrate.mjs";
import { ensureRoles } from "../lib/roles.mjs";
import { adminClientConfig, checkAnonKey, parseAdminUrl, parseCaCert } from "../lib/supabase.mjs";
import { captured, MemorySsm } from "./helpers.mjs";

const CLI = new URL("../cli.mjs", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;
const SERVER = process.env.FENVIX_DEPLOY_TEST_DB ?? "postgresql://postgres@localhost:54329/postgres";
const STUB = new URL("../../supabase/tests/local-stub.sql", import.meta.url).pathname;
const REF = "abcdefghijklmnopqrst";
const DB_URL = `postgresql://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", iat: 1700000000, exp: 2000000000, ...claims })}.c2lnbmF0dXJl`;

describe("F4: SUPABASE_ANON_KEY", () => {
  it("accepts the anon JWT of the same project and a publishable key", () => {
    assert.equal(checkAnonKey(jwt({ ref: REF, role: "anon" }), REF), "anon JWT");
    assert.equal(checkAnonKey("sb_publishable_AbC123_xyz-0", REF), "publishable");
  });
  it("refuses a key of another project, a secret key, a service_role JWT, garbage: naming the variable, never the value", () => {
    const cases = [
      [jwt({ ref: "zzzzzzzzzzzzzzzzzzzz", role: "anon" }), /another Supabase project/],
      ["sb_secret_0123456789abcdefghijklmnopqrstuv", /SECRET key/],
      [jwt({ ref: REF, role: "service_role" }), /service_role/],
      [jwt({ ref: REF, role: "authenticated" }), /role is not anon/],
      ["not-a-key-at-all", /neither a publishable key/],
    ];
    for (const [key, re] of cases) {
      assert.throws(() => checkAnonKey(key, REF), (e) => re.test(e.message) && /SUPABASE_ANON_KEY/.test(e.message) && !e.message.includes(key));
    }
  });
  it("preflight stops on a key of another project (exit 1), without printing it", () => {
    const key = jwt({ ref: "zzzzzzzzzzzzzzzzzzzz", role: "anon" });
    const r = spawnSync(process.execPath, [CLI, "preflight"], { encoding: "utf8", env: { PATH: process.env.PATH, SUPABASE_DB_URL: DB_URL, SUPABASE_ANON_KEY: key } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /another Supabase project/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(key));
  });
});

describe("the workflow: concurrency, the Cloudflare token, the dashboard's host", () => {
  const wf = readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
  it("only a run that deploys (push or dispatch on main) joins the deploy group; nothing cancels it", () => {
    // REPORT-deploy-pipeline-4: deploy.yml has no pull_request trigger any more (test.yml runs the pull requests), so
    // the event no longer needs to be in the expression: a run on main is a deploy, any other ref is a dispatch elsewhere.
    assert.match(wf, /group: \$\{\{ github\.ref == 'refs\/heads\/main' && 'deploy-production' \|\| format\('not-main-\{0\}', github\.ref\) \}\}/);
    assert.match(wf, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/);
  });
  it("the Cloudflare token is in no step's environment: the steps that call Cloudflare read it from SSM themselves", () => {
    // REPORT-deploy-pipeline-4: was "CLOUDFLARE_API_TOKEN only in steps 6, 8 (watcher) and 9". Now no GitHub secret
    // exists; cli.mjs reads /fenvix/prod/bootstrap/cloudflare-api-token in dashboard-certificate, watch-certificate and
    // dns only, and preflight exports only whether it is set.
    assert.doesNotMatch(wf, /CLOUDFLARE_API_TOKEN|FENVIX_CF_TOKEN|secrets\./);
    const cdk = wf.split(/\n      - name: /).slice(1).find((s) => s.startsWith("8. "));
    assert.match(cdk, /node \.\.\/\.\.\/deploy\/cli\.mjs watch-certificate --timeout-minutes 90 &/);
    const cli = readFileSync(join(ROOT, "deploy/cli.mjs"), "utf8");
    const users = cli.split(/\n  (?:async )?(?="?[a-z-]+"?\(\))/).filter((x) => /await cloudflare\(\)/.test(x)).map((x) => /^"?([a-z-]+)/.exec(x)[1]);
    assert.deepEqual(users, ["dashboard-certificate", "watch-certificate", "dns"]);
  });
  it("the dashboard is console.fenvix.dev everywhere (app.fenvix.dev nowhere)", () => {
    const cdk = JSON.parse(readFileSync(join(ROOT, "infra/github-app/cdk.json"), "utf8")).context;
    assert.equal(cdk.dashboardDomain, "console.fenvix.dev");
    assert.equal(cdk.dashboardUrl, "https://console.fenvix.dev");
    const r = spawnSync("git", ["grep", "-l", "--untracked", "app\\.fenvix\\.dev", "--", ".", ":!docs/REPORT-*", ":!docs/REVIEW-*", ":!deploy/test/pipeline-2.test.mjs"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 1, `app.fenvix.dev still in: ${r.stdout}`);
  });
});

describe("TLS to the pooler, verified with a CA (SUPABASE_CA_CERT)", () => {
  let dir, server, port;
  const sh = (args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  const pem = (f) => readFileSync(join(dir, f), "utf8");
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "fenvix-tls-"));
    for (const n of ["ca", "other"]) sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${n} root`, "-keyout", `${n}.key`, "-out", `${n}.crt`]);
    writeFileSync(join(dir, "ext"), "subjectAltName=DNS:localhost\n");
    sh(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "srv.key", "-out", "srv.csr"]);
    sh(["x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext", "-out", "srv.crt"]);
    // A stand-in pooler: answers Postgres's SSLRequest with "S", then TLS with a certificate for "localhost" from ca.
    server = createServer((sock) => {
      sock.once("data", () => {
        sock.write("S");
        const t = new TLSSocket(sock, { isServer: true, key: pem("srv.key"), cert: pem("srv.crt") });
        t.once("data", () => {
          const f = Buffer.from("SFATAL\0C28P01\0Mpassword authentication failed\0\0");
          const h = Buffer.alloc(5); h.write("E", 0); h.writeInt32BE(f.length + 4, 1);
          t.end(Buffer.concat([h, f]));
        });
        t.on("error", () => sock.destroy());
      });
      sock.on("error", () => undefined);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => server?.close());
  const tryConnect = async (ca, host = "localhost") => {
    const a = { kind: "supabase", host, port, database: "postgres", user: "postgres.x", password: "pw" };
    const c = new pg.Client(adminClientConfig(a, { ca }));
    try { await c.connect(); return "connected"; } catch (e) { return e.code ?? e.message; } finally { await c.end().catch(() => undefined); }
  };
  it("the right CA and host: the TLS handshake succeeds (the stand-in then refuses the password: 28P01)", async () => {
    assert.equal(await tryConnect(pem("ca.crt")), "28P01");
  });
  it("another CA, or a certificate for another host: refused before any password is sent", async () => {
    assert.match(String(await tryConnect(pem("other.crt"))), /SELF_SIGNED|UNABLE_TO|certificate/i);
    assert.match(String(await tryConnect(pem("ca.crt"), "127.0.0.1")), /ERR_TLS_CERT_ALTNAME_INVALID|altnames|IP/i);
  });
  it("without a CA: encrypted, not verified (as before); a malformed SUPABASE_CA_CERT is refused", () => {
    assert.equal(adminClientConfig({ kind: "supabase", host: "h" }).ssl.rejectUnauthorized, false);
    assert.equal(parseCaCert(""), null);
    assert.throws(() => parseCaCert("hello"), /not a PEM certificate/);
    assert.equal(parseCaCert(` ${pem("ca.crt")}\n`), pem("ca.crt").trim());
  });
});

describe("F3: the role password, beyond the reviewer's test (scratch Postgres)", () => {
  let server; const role = "fenvix_p2_role";
  before(async () => { server = new pg.Client(SERVER); await server.connect(); await server.query(`drop role if exists ${role}`); await server.query(`create role ${role} login password 'old-password-0123456789'`); });
  after(async () => { await server.query(`drop role if exists ${role}`).catch(() => undefined); await server.end(); });
  const verifier = async () => (await server.query("select rolpassword from pg_authid where rolname = $1", [role])).rows[0].rolpassword;
  const a = () => parseAdminUrl(SERVER.replace("postgresql://postgres@", "postgresql://postgres:unused@"), { local: true });
  const roles = [{ role, parameter: "p2-url", poolerPort: 5432, mode: "session" }];

  it("the stored string never logs in but is never told 'wrong password' (e.g. XX000 every time): stop, password unchanged", async () => {
    const before = await verifier();
    const ssm = new MemorySsm({ "/fenvix/prod/github-app/p2-url": "postgresql://x:y@h/postgres" });
    const login = async () => { throw new Error("could not reach the database (XX000): Tenant or user not found"); };
    await assert.rejects(captured(() => ensureRoles(server, a(), ssm, { roles, login })), /NOT changed/);
    assert.equal(await verifier(), before);
    assert.ok(!ssm.calls.some((c) => c.name === "PutParameterCommand"));
  });
  it("28P01 → a new password; but if storing it in SSM fails, the change is rolled back (the old password stays)", async () => {
    const before = await verifier();
    const ssm = new MemorySsm({ "/fenvix/prod/github-app/p2-url": "postgresql://x:y@h/postgres" });
    const put = ssm.send.bind(ssm);
    ssm.send = async (cmd) => { if (cmd.constructor.name === "PutParameterCommand") { const e = new Error("throttled"); e.name = "ThrottlingException"; throw e; } return put(cmd); };
    const attempts = [];
    const login = async (url, o) => { attempts.push(o?.attempts); return "refused"; };
    await assert.rejects(captured(() => ensureRoles(server, a(), ssm, { roles, login })), /rolled back/);
    assert.equal(await verifier(), before, "the role's password changed though the new string was not stored");
    assert.deepEqual(attempts, [4], "the stored string is retried 4 times before 'wrong password' counts");
    ssm.send = put;
    const [r] = await captured(() => ensureRoles(server, a(), ssm, { roles, login: async (u, o) => (o.attempts === 4 ? "refused" : "ok") }));
    assert.deepEqual(r, { [role]: "set" });
    assert.notEqual(await verifier(), before);
    assert.match(await verifier(), /^SCRAM-SHA-256\$4096:/);
  });
});

describe("F5: half-applied migrations other than 0017 (scratch Postgres)", () => {
  let server; const name = `deploy_p2_${process.pid}`;
  const url = () => { const u = new URL(SERVER); u.pathname = `/${name}`; return u.toString(); };
  const psqlFile = (file) => execFileSync("psql", [url(), "-v", "ON_ERROR_STOP=1", "-q", "-f", file], { stdio: ["ignore", "ignore", "pipe"] });
  const files = readMigrations();
  const fresh = async () => { await server.query(`drop database if exists ${name} with (force)`); await server.query(`create database ${name}`); psqlFile(STUB); };
  const cutRun = (version, before) => {
    const sql = files.find((x) => x.version === version).sql;
    const i = sql.indexOf(before); assert.ok(i > 0, `${before} in ${version}`);
    const f = join(mkdtempSync(join(tmpdir(), "fenvix-p2-")), `${version}.sql`); writeFileSync(f, sql.slice(0, i)); psqlFile(f);
  };
  before(async () => { server = new pg.Client(SERVER); await server.connect(); });
  after(async () => { await server.query(`drop database if exists ${name} with (force)`).catch(() => undefined); await server.end(); });

  for (const [version, cut] of [["0013", "drop policy if exists ci_usage_events_github_app"], ["0015", "drop policy if exists workspace_invites_api_revoke"], ["0014", "drop policy if exists workspaces_github_app"]]) {
    it(`${version} cut before its last statement: the deploy stops, nothing recorded`, async () => {
      await fresh();
      for (const m of files.filter((x) => x.version < version)) psqlFile(join(MIGRATIONS_DIR, m.name));
      cutRun(version, cut);
      const c = new pg.Client(url()); await c.connect();
      try {
        await assert.rejects(captured(() => migrate(c, files)), new RegExp(`${version} looks half-applied`));
        assert.equal((await c.query("select count(*)::int as n from fenvix_deploy.schema_migrations")).rows[0].n, 0);
      } finally { await c.end(); }
    });
  }
  it("every file applied by hand (0011 and 0012's last effects removed on purpose by 0014): recorded as found, nothing run", async () => {
    await fresh();
    for (const m of files) psqlFile(join(MIGRATIONS_DIR, m.name));
    const c = new pg.Client(url()); await c.connect();
    try {
      const [r] = await captured(() => migrate(c, files));
      assert.equal(r.found.at(-1), files.at(-1).version);
      assert.deepEqual(r.applied, []);
    } finally { await c.end(); }
  });
});
