// Review R-024 (docs/REVIEW-R-024.md). Each test fails on claude/deploy-pipeline at 7b1bb75.
//   F3  one transient pooler error on the stored string rotates the role's password (the running services lose it)
//   F4  the anon key variable is not checked: a service_role / secret key there is built into the public dashboard
//   F5  a migration whose first objects exist but whose end did not run is recorded as "found" and never finished
// Needs the scratch Postgres (FENVIX_DEPLOY_TEST_DB, trust auth) and the local Supabase (LOCAL_DB_URL, password auth).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { migrate, MIGRATIONS_DIR, readMigrations } from "../lib/migrate.mjs";
import { ensureRoles, tryLogin } from "../lib/roles.mjs";
import { parseAdminUrl } from "../lib/supabase.mjs";
import { captured, MemorySsm } from "./helpers.mjs";

const CLI = new URL("../cli.mjs", import.meta.url).pathname;
const SERVER = process.env.FENVIX_DEPLOY_TEST_DB ?? "postgresql://postgres@localhost:54329/postgres";
const STUB = new URL("../../supabase/tests/local-stub.sql", import.meta.url).pathname;
const envFile = join(process.env.TMPDIR ?? "/tmp", "fenvix-local-supabase", "env.sh");
const LOCAL = process.env.LOCAL_DB_URL ?? (existsSync(envFile) ? /LOCAL_DB_URL=(\S+)/.exec(readFileSync(envFile, "utf8"))?.[1] : undefined);

describe("F3: a transient pooler error never changes a password", { skip: !LOCAL && "no local Supabase (scripts/local-supabase/up.sh)" }, () => {
  let admin, proxy, failNext = 1;
  const role = "fenvix_r024_probe";
  const oldPassword = "the-password-the-running-api-holds-0123456789";
  before(async () => {
    admin = new pg.Client(LOCAL);
    await admin.connect();
    await admin.query(`drop role if exists ${role}`);
    await admin.query(`create role ${role} login password '${oldPassword}'`);
    const real = new URL(LOCAL);
    // The pooler as seen from GitHub's runner: the first connection gets Supavisor's "Tenant or user not found" (an
    // intermittent answer of the pooler, reported by Supabase users), every later one reaches the database.
    proxy = createServer((sock) => {
      if (failNext > 0) {
        failNext--;
        sock.once("data", () => {
          const fields = Buffer.from("SFATAL\0VFATAL\0CXX000\0MTenant or user not found\0\0");
          const head = Buffer.alloc(5); head.write("E", 0); head.writeInt32BE(fields.length + 4, 1);
          sock.end(Buffer.concat([head, fields]));
        });
        return;
      }
      const up = tcpConnect(Number(real.port), real.hostname);
      sock.pipe(up).pipe(sock);
      up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  });
  after(async () => { proxy?.close(); await admin?.query(`drop role if exists ${role}`).catch(() => undefined); await admin?.end(); });

  it("keeps the stored connection string when the pooler fails once (and the running services keep logging in)", async () => {
    const port = proxy.address().port;
    const stored = `postgresql://${role}:${oldPassword}@127.0.0.1:${port}/postgres`;
    const ssm = new MemorySsm({ "/fenvix/prod/github-app/r024-url": stored });
    const a = parseAdminUrl(LOCAL, { local: true });
    const [r] = await captured(() => ensureRoles(admin, a, ssm, { roles: [{ role, parameter: "r024-url", poolerPort: 5432, mode: "session" }], verifyAttempts: 2, verifyDelayMs: 200 }));
    // What the running API and App hold until their next secrets reload (up to 5 minutes, runtime.ts):
    const stillWorks = await tryLogin(`postgresql://${role}:${oldPassword}@127.0.0.1:${port}/postgres`);
    assert.equal(stillWorks, "ok", "the password the running services hold was replaced");
    assert.equal(r[role], "kept");
  });
});

describe("F4: the anon key the dashboard is built with is checked to be public", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = (role) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref: "abcdefghijklmnopqrst", role, iat: 1700000000, exp: 2000000000 })}.c2lnbmF0dXJl`;
  const preflight = (anon) => spawnSync(process.execPath, [CLI, "preflight"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SUPABASE_DB_URL: "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres", SUPABASE_ANON_KEY: anon },
  });
  it("accepts the anon key", () => { assert.equal(preflight(jwt("anon")).status, 0); });
  // Supabase shows the anon key and the service_role key (or the publishable and the secret key) on the same page.
  // SUPABASE_ANON_KEY is an environment *variable* (printed unmasked in the log) and goes into the public bundle
  // (step 10: VITE_SUPABASE_ANON_KEY): a wrong paste publishes a key that bypasses row level security.
  for (const [what, key] of [["a service_role JWT", jwt("service_role")], ["a secret API key", "sb_secret_0123456789abcdefghijklmnopqrstuv"]]) {
    it(`refuses ${what}, without printing it`, () => {
      const r = preflight(key);
      assert.notEqual(r.status, 0, "the deploy went on and would build it into the dashboard");
      assert.ok(!`${r.stdout}${r.stderr}`.includes(key));
    });
  }
});

describe("F5: a migration is recorded as found only if all of it is there", () => {
  let server; const name = `deploy_r024_${process.pid}`;
  const url = () => { const u = new URL(SERVER); u.pathname = `/${name}`; return u.toString(); };
  const psqlFile = (file) => execFileSync("psql", [url(), "-v", "ON_ERROR_STOP=1", "-q", "-f", file], { stdio: ["ignore", "ignore", "pipe"] });
  before(async () => { server = new pg.Client(SERVER); await server.connect(); await server.query(`drop database if exists ${name}`); await server.query(`create database ${name}`); psqlFile(STUB); });
  after(async () => { await server.query(`drop database if exists ${name} with (force)`).catch(() => undefined); await server.end(); });

  it("0017 stopped before its row level security: not recorded as applied", async () => {
    const files = readMigrations();
    for (const m of files.filter((x) => x.version <= "0016")) psqlFile(join(MIGRATIONS_DIR, m.name));
    // 0017 run statement by statement (psql -f, a migration tool, or the SQL editor's "run selected") and stopped at
    // its row level security section: its table and column exist, its RLS, revokes, grants and policies do not.
    const sql = files.find((x) => x.version === "0017").sql;
    const cut = join(mkdtempSync(join(tmpdir(), "fenvix-r024-")), "0017_half.sql");
    writeFileSync(cut, sql.slice(0, sql.indexOf("alter table public.gh_warmups enable row level security")));
    psqlFile(cut);
    const c = new pg.Client(url()); await c.connect();
    try {
      let r = null;
      try { [r] = await captured(() => migrate(c, files)); } catch { /* a stop is the right answer too */ }
      const rls = (await c.query("select relrowsecurity from pg_class where oid = 'public.gh_warmups'::regclass")).rows[0].relrowsecurity;
      assert.ok(!(r && r.found.includes("0017") && !rls), "0017 recorded as found while gh_warmups has no row level security: it is never run again");
    } finally { await c.end(); }
  });
});
