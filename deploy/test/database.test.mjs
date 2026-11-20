// The migration runner and the role passwords against real Postgres: a scratch server (Postgres 16, empty databases
// made per test, with supabase/tests/local-stub.sql) and the local Supabase of scripts/local-supabase/up.sh (the real
// Supabase Postgres image, where up.sh applied every migration by hand, like the founder's project).
//   FENVIX_DEPLOY_TEST_DB    admin URL of the scratch server   (default postgresql://postgres@localhost:54329/postgres)
//   LOCAL_DB_URL             the local Supabase's admin URL     (default: from up.sh's env.sh; skipped if absent)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { migrate, MIGRATIONS_DIR, readMigrations } from "../lib/migrate.mjs";
import { ensureRoles, tryLogin } from "../lib/roles.mjs";
import { parseAdminUrl } from "../lib/supabase.mjs";
import { captured, MemorySsm } from "./helpers.mjs";

const SERVER = process.env.FENVIX_DEPLOY_TEST_DB ?? "postgresql://postgres@localhost:54329/postgres";
const STUB = new URL("../../supabase/tests/local-stub.sql", import.meta.url).pathname;
const urlOf = (db) => { const u = new URL(SERVER); u.pathname = `/${db}`; return u.toString(); };
const psqlFile = (db, file) => execFileSync("psql", [urlOf(db), "-v", "ON_ERROR_STOP=1", "-q", "-f", file], { stdio: ["ignore", "ignore", "pipe"] });
// The founder's database was migrated by hand up to 0017 (2026-11-19); later migrations reach it through this pipeline.
const ALL = readMigrations();
const files = ALL.filter((m) => m.version <= "0017");
const LATER = ALL.filter((m) => m.version > "0017").map((m) => m.version);
const upTo = (v) => files.filter((m) => m.version <= v);

let server;
const made = [];
async function freshDb(tag) {
  const name = `deploy_${tag}_${process.pid}`;
  await server.query(`drop database if exists ${name}`);
  await server.query(`create database ${name}`);
  made.push(name);
  psqlFile(name, STUB);
  return name;
}
async function connect(db) { const c = new pg.Client(urlOf(db)); await c.connect(); return c; }
const tracked = async (c) => (await c.query("select version, how from fenvix_deploy.schema_migrations order by version")).rows.map((r) => `${r.version}:${r.how}`);

before(async () => { server = new pg.Client(SERVER); await server.connect(); });
after(async () => { for (const d of made) await server.query(`drop database if exists ${d} with (force)`).catch(() => undefined); await server.end(); });

describe("migrations: the founder's database (0001-0010 by the earlier product, 0011-0017 pasted as one file in the SQL editor)", () => {
  it("the first run records 0001-0017 as already applied and runs none of them; the second run does nothing", async () => {
    const db = await freshDb("founder");
    for (const m of upTo("0010")) psqlFile(db, join(MIGRATIONS_DIR, m.name));
    // As on 2026-11-19: 0011 to 0017 concatenated and run once.
    const one = join(mkdtempSync(join(tmpdir(), "fenvix-")), "all.sql");
    writeFileSync(one, files.filter((m) => m.version >= "0011").map((m) => m.sql).join("\n;\n"));
    psqlFile(db, one);

    const c = await connect(db);
    try {
      // Nothing may run again: every statement the runner sends is seen here.
      const sent = [];
      const spy = { query: (sql, p) => { sent.push(String(sql)); return c.query(sql, p); } };
      const [r, out] = await captured(() => migrate(spy, files));
      for (const m of files) assert.ok(!sent.includes(m.sql), `${m.name} was run again`);
      assert.deepEqual(r.applied, []);
      assert.deepEqual(r.found, files.map((m) => m.version));
      assert.match(out, /found by their objects: 0011 yes, 0012 yes, 0013 yes, 0014 yes, 0015 yes, 0016 yes, 0017 yes/);
      assert.match(out, /recorded as already applied \(not run again\): 0001 to 0017/);
      assert.deepEqual(await tracked(c), files.map((m) => `${m.version}:found`));
      const [r2, out2] = await captured(() => migrate(c, files));
      assert.deepEqual([r2.found, r2.applied], [[], []]);
      assert.match(out2, /database up to date/);
      // The deploy after this one: the migrations written since (0019, the service back-end) run once, in order.
      const [r3] = await captured(() => migrate(c, ALL));
      assert.deepEqual([r3.found, r3.applied], [[], LATER]);
      assert.notEqual((await c.query("select to_regclass('public.ci_api_keys') as t")).rows[0].t, null);
      const [r4] = await captured(() => migrate(c, ALL));
      assert.deepEqual(r4.applied, [], "once");
    } finally { await c.end(); }
  });

  it("a new migration after that runs once, in a transaction, and is recorded", async () => {
    const db = await freshDb("next");
    for (const m of files) psqlFile(db, join(MIGRATIONS_DIR, m.name));
    const dir = mkdtempSync(join(tmpdir(), "fenvix-mig-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    writeFileSync(join(dir, "0099_next.sql"), "create table public.next_thing (id int primary key);\ninsert into public.next_thing values (1);\n");
    const c = await connect(db);
    try {
      await captured(() => migrate(c, files));
      const [r] = await captured(() => migrate(c, readMigrations(dir)));
      assert.deepEqual(r.applied, [...LATER, "0099"]);
      assert.equal((await c.query("select count(*)::int as n from public.next_thing")).rows[0].n, 1);
      assert.equal((await tracked(c)).at(-1), "0099:applied");
      const [r2] = await captured(() => migrate(c, readMigrations(dir)));
      assert.deepEqual(r2.applied, [], "once");
    } finally { await c.end(); }
  });

  it("a failing migration is rolled back whole and not recorded; the ones after it do not run", async () => {
    const db = await freshDb("fail");
    for (const m of files) psqlFile(db, join(MIGRATIONS_DIR, m.name));
    const dir = mkdtempSync(join(tmpdir(), "fenvix-mig-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    writeFileSync(join(dir, "0098_half.sql"), "create table public.half_done (id int);\nselect 1/0;\n");
    writeFileSync(join(dir, "0099_after.sql"), "create table public.after_it (id int);\n");
    const c = await connect(db);
    try {
      await captured(() => migrate(c, files));
      await assert.rejects(captured(() => migrate(c, readMigrations(dir))), /0098_half\.sql failed and was rolled back .*division by zero .*SQLSTATE 22012.*Later migrations were not run/);
      assert.equal((await c.query("select to_regclass('public.half_done') as t")).rows[0].t, null);
      assert.equal((await c.query("select to_regclass('public.after_it') as t")).rows[0].t, null);
      // The real migrations before the failing one were applied; nothing at or after it.
      assert.equal((await tracked(c)).at(-1), LATER.length ? `${LATER.at(-1)}:applied` : "0017:found");
    } finally { await c.end(); }
  });

  it("an applied migration whose file changed stops the deploy (and so does a new one numbered below an applied one)", async () => {
    const db = await freshDb("changed");
    for (const m of files) psqlFile(db, join(MIGRATIONS_DIR, m.name));
    const c = await connect(db);
    try {
      await captured(() => migrate(c, files));
      const dir = mkdtempSync(join(tmpdir(), "fenvix-mig-"));
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      writeFileSync(join(dir, "0016_review_r016b.sql"), `${readFileSync(join(dir, "0016_review_r016b.sql"), "utf8")}\n-- edited\n`);
      await assert.rejects(captured(() => migrate(c, readMigrations(dir))), /0016_review_r016b\.sql was changed after it was applied/);
      const dir2 = mkdtempSync(join(tmpdir(), "fenvix-mig-"));
      cpSync(MIGRATIONS_DIR, dir2, { recursive: true });
      writeFileSync(join(dir2, "0099_ok.sql"), "select 1;\n");
      await captured(() => migrate(c, readMigrations(dir2)));
      writeFileSync(join(dir2, "0017a.sql"), "select 1;\n");
      await assert.rejects(async () => readMigrations(dir2), /NNNN_lowercase_name/);
    } finally { await c.end(); }
  });
});

describe("migrations: other starting points", () => {
  it("an empty database: every migration runs, in order, each recorded as applied", async () => {
    const db = await freshDb("empty");
    const c = await connect(db);
    try {
      const [r] = await captured(() => migrate(c, ALL));
      assert.deepEqual(r.applied, ALL.map((m) => m.version));
      assert.deepEqual(await tracked(c), ALL.map((m) => `${m.version}:applied`));
      assert.notEqual((await c.query("select to_regclass('public.gh_warmups') as t")).rows[0].t, null);
    } finally { await c.end(); }
  });

  it("applied by hand up to 0013 only: 0001-0013 recorded, 0014-0017 run", async () => {
    const db = await freshDb("to13");
    for (const m of upTo("0013")) psqlFile(db, join(MIGRATIONS_DIR, m.name));
    const c = await connect(db);
    try {
      const [r] = await captured(() => migrate(c, files));
      assert.deepEqual(r.found, upTo("0013").map((m) => m.version));
      assert.deepEqual(r.applied, ["0014", "0015", "0016", "0017"]);
    } finally { await c.end(); }
  });

  it("half-applied (0017's objects without 0016's) stops, changes nothing", async () => {
    const db = await freshDb("half");
    for (const m of files) psqlFile(db, join(MIGRATIONS_DIR, m.name));
    const c = await connect(db);
    try {
      await c.query("alter table public.ci_explorations drop column received_at cascade");
      await assert.rejects(captured(() => migrate(c, files)), /has migration 0017 but not 0016 .*Nothing was changed/);
      assert.equal((await c.query("select count(*)::int as n from fenvix_deploy.schema_migrations")).rows[0].n, 0);
    } finally { await c.end(); }
  });

  it("a database that is not ours (tables in public, none of 0011's) stops, changes nothing", async () => {
    const db = await freshDb("foreign");
    const c = await connect(db);
    try {
      await c.query("create table public.someone_elses (id int)");
      await assert.rejects(captured(() => migrate(c, files)), /not a fenvix database/);
    } finally { await c.end(); }
  });
});

describe("migrations on the local Supabase (real Supabase Postgres image; up.sh applied every migration by hand)", () => {
  const envFile = `${process.env.LOCAL_SUPABASE_STATE ?? `${process.env.TMPDIR ?? "/tmp"}/fenvix-local-supabase`}/env.sh`;
  const local = process.env.LOCAL_DB_URL ?? (existsSync(envFile) ? /LOCAL_DB_URL=(\S+)/.exec(readFileSync(envFile, "utf8"))?.[1] : undefined);
  it("detects 0017, records 0001-0017, runs nothing", { skip: !local && "no local Supabase (bash scripts/local-supabase/up.sh)" }, async () => {
    const c = new pg.Client(local);
    await c.connect();
    try {
      await c.query("drop schema if exists fenvix_deploy cascade");
      const [r] = await captured(() => migrate(c, files));
      assert.deepEqual([r.found.at(-1), r.applied], ["0017", []]);
      const [r2] = await captured(() => migrate(c, files));
      assert.deepEqual([r2.found, r2.applied], [[], []]);
    } finally { await c.end(); }
  });
});

describe("role passwords (SCRAM verifier; the connection string in SSM only)", () => {
  const roles = [
    { role: "fenvix_deploytest_app", parameter: "database-url", poolerPort: 5432, mode: "session" },
    { role: "fenvix_deploytest_api", parameter: "api-database-url", poolerPort: 6543, mode: "transaction" },
  ];
  before(async () => {
    for (const r of roles) await server.query(`do $$ begin create role ${r.role} login; exception when duplicate_object then alter role ${r.role} login password null; end $$`);
    // The scratch server trusts every local login; logins must check passwords for this test.
  });
  after(async () => { for (const r of roles) await server.query(`drop role if exists ${r.role}`).catch(() => undefined); });

  it("first deploy: a new password per role, set as a verifier, the connection string stored, never printed; later deploys keep it", async () => {
    const a = parseAdminUrl(SERVER.replace("postgresql://postgres@", "postgresql://postgres:unused@"), { local: true });
    const ssm = new MemorySsm();
    const logins = [];
    const login = async (url) => { logins.push(url); return "ok"; };
    const statements = [];
    const spy = { query: (sql, p) => { statements.push(String(sql)); return server.query(sql, p); } };
    process.env.GITHUB_ACTIONS = "true";
    const [r, out] = await captured(() => ensureRoles(spy, a, ssm, { roles, login }));
    delete process.env.GITHUB_ACTIONS;
    assert.deepEqual(r, { fenvix_deploytest_app: "set", fenvix_deploytest_api: "set" });
    for (const x of roles) {
      const url = ssm.params.get(`/fenvix/prod/github-app/${x.parameter}`).Value;
      assert.equal(ssm.params.get(`/fenvix/prod/github-app/${x.parameter}`).Type, "SecureString");
      const pw = new URL(url).password;
      assert.match(pw, /^[A-Za-z0-9_-]{43}$/);
      const visible = out.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
      assert.ok(!visible.includes(pw), "the password was printed");
      assert.ok(!statements.some((s) => s.includes(pw)), "the password reached the database in a statement");
      const stored = (await server.query("select rolpassword from pg_authid where rolname = $1", [x.role])).rows[0].rolpassword;
      assert.match(stored, /^SCRAM-SHA-256\$4096:/);
    }
    assert.equal(logins.length, 2, "each new string is checked by logging in");
    const [r2] = await captured(() => ensureRoles(server, a, ssm, { roles, login }));
    assert.deepEqual(r2, { fenvix_deploytest_app: "kept", fenvix_deploytest_api: "kept" });
  });

  it("the real login check: the stored password logs in (SCRAM, over TCP with password authentication)", async () => {
    // Through the local Supabase (it checks passwords, unlike the trust-mode scratch server).
    const envFile = `${process.env.TMPDIR ?? "/tmp"}/fenvix-local-supabase/env.sh`;
    const local = process.env.LOCAL_DB_URL ?? (existsSync(envFile) ? /LOCAL_DB_URL=(\S+)/.exec(readFileSync(envFile, "utf8"))?.[1] : undefined);
    if (!local) return;
    const c = new pg.Client(local); await c.connect();
    try {
      await c.query("do $$ begin create role fenvix_deploytest_login login; exception when duplicate_object then null; end $$");
      const a = parseAdminUrl(local, { local: true });
      const ssm = new MemorySsm();
      const one = [{ role: "fenvix_deploytest_login", parameter: "database-url", poolerPort: 5432, mode: "session" }];
      const [r] = await captured(() => ensureRoles(c, a, ssm, { roles: one, verifyAttempts: 1, checkAttempts: 1 }));
      assert.deepEqual(r, { fenvix_deploytest_login: "set" });
      const url = ssm.params.get("/fenvix/prod/github-app/database-url").Value;
      assert.equal(await tryLogin(url), "ok");
      // A wrong password is "refused" (and the next deploy sets a new one); it is never confused with a network error.
      const bad = new URL(url); bad.password = "B".repeat(43);
      assert.equal(await tryLogin(bad.toString()), "refused");
      await c.query("alter role fenvix_deploytest_login password null");
      const [r2] = await captured(() => ensureRoles(c, a, ssm, { roles: one, verifyAttempts: 1, checkAttempts: 1 }));
      assert.deepEqual(r2, { fenvix_deploytest_login: "set" }, "refused → a new password");
      assert.equal(await tryLogin(ssm.params.get("/fenvix/prod/github-app/database-url").Value), "ok");
      await assert.rejects(tryLogin(url.replace(/@127\.0\.0\.1:\d+/, "@127.0.0.1:1")), /could not reach the database/);
    } finally {
      await c.query("drop role if exists fenvix_deploytest_login").catch(() => undefined);
      await c.end();
    }
  });
});
