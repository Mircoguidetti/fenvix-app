// Review R-024b (docs/REVIEW-R-024b.md). Each test fails on claude/deploy-pipeline at 64c4c9a.
//   G1  F5 still open for 0014: a paste cut right before 0014's re-creation of gh_link_installation is recorded "found"
//   G2  F3's commit-after-PutParameter window: SSM holds the new string, the role keeps the old password, and the step
//       says "rolled back, nothing changed"
// Needs the scratch Postgres (FENVIX_DEPLOY_TEST_DB, trust auth), as the authors' tests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { migrate, MIGRATIONS_DIR, readMigrations } from "../lib/migrate.mjs";
import { ensureRoles } from "../lib/roles.mjs";
import { parseAdminUrl } from "../lib/supabase.mjs";
import { captured, MemorySsm } from "./helpers.mjs";

const SERVER = process.env.FENVIX_DEPLOY_TEST_DB ?? "postgresql://postgres@localhost:54329/postgres";
const STUB = new URL("../../supabase/tests/local-stub.sql", import.meta.url).pathname;

describe("G1: 0014 cut before its re-creation of gh_link_installation (the trial is never started)", () => {
  let server; const name = `deploy_r024b_${process.pid}`;
  const url = () => { const u = new URL(SERVER); u.pathname = `/${name}`; return u.toString(); };
  const psqlFile = (file) => execFileSync("psql", [url(), "-v", "ON_ERROR_STOP=1", "-q", "-f", file], { stdio: ["ignore", "ignore", "pipe"] });
  before(async () => { server = new pg.Client(SERVER); await server.connect(); });
  after(async () => { await server.query(`drop database if exists ${name} with (force)`).catch(() => undefined); await server.end(); });

  it("is not recorded as applied", async () => {
    await server.query(`drop database if exists ${name} with (force)`); await server.query(`create database ${name}`); psqlFile(STUB);
    const files = readMigrations();
    for (const m of files.filter((x) => x.version < "0014")) psqlFile(join(MIGRATIONS_DIR, m.name));
    // Everything of 0014 up to and including the policy workspaces_github_app (the probe's "last"), not the function
    // after it: a statement-by-statement run or a paste cut 2 lines later than the authors' test cuts.
    const sql = files.find((x) => x.version === "0014").sql;
    const i = sql.indexOf("-- Linking an installation (0013) now also starts");
    assert.ok(i > 0);
    const f = join(mkdtempSync(join(tmpdir(), "fenvix-r024b-")), "0014-cut.sql"); writeFileSync(f, sql.slice(0, i)); psqlFile(f);
    const c = new pg.Client(url()); await c.connect();
    try {
      // The cut database: 0013's gh_link_installation, which starts no trial (no ci_subscriptions row).
      const src = (await c.query("select prosrc from pg_proc where oid = to_regprocedure('public.gh_link_installation(bigint,uuid,uuid)')")).rows[0].prosrc;
      assert.ok(!src.includes("trial_ends_at"), "the cut left 0014's function in place: test setup is wrong");
      let recorded = [];
      try { const [r] = await captured(() => migrate(c, files)); recorded = r.found; } catch (e) { assert.match(e.message, /0014 looks half-applied/); return; }
      assert.ok(!recorded.includes("0014"), `0014 recorded as found though its last statements never ran (found: ${recorded.join(", ")})`);
    } finally { await c.end(); }
  });
});

describe("G2: the commit fails after PutParameter (connection lost in between)", () => {
  let server; const role = "fenvix_r024b_role";
  const parameter = "/fenvix/prod/github-app/r024b-url";
  const oldString = "postgresql://fenvix_r024b_role:old-password-0123456789@127.0.0.1:54329/postgres";
  before(async () => {
    server = new pg.Client(SERVER); await server.connect();
    await server.query(`drop role if exists ${role}`); await server.query(`create role ${role} login password 'old-password-0123456789'`);
  });
  after(async () => { await server.query(`drop role if exists ${role}`).catch(() => undefined); await server.end(); });
  const verifier = async () => (await server.query("select rolpassword from pg_authid where rolname = $1", [role])).rows[0].rolpassword;

  it("SSM and the role's password never disagree, and the step does not say 'nothing changed' when SSM changed", async () => {
    const before = await verifier();
    const admin = new pg.Client(SERVER); admin.on("error", () => undefined); await admin.connect();
    const pid = (await admin.query("select pg_backend_pid() as p")).rows[0].p;
    const ssm = new MemorySsm({ [parameter]: oldString });
    const put = ssm.send.bind(ssm);
    // The SSM write succeeds; the admin connection is lost before "commit" reaches the database.
    ssm.send = async (cmd) => { const r = await put(cmd); if (cmd.constructor.name === "PutParameterCommand") await server.query("select pg_terminate_backend($1)", [pid]); return r; };
    const a = parseAdminUrl(SERVER.replace("postgresql://postgres@", "postgresql://postgres:unused@"), { local: true });
    let message = "";
    try {
      await captured(() => ensureRoles(admin, a, ssm, { roles: [{ role, parameter: "r024b-url", poolerPort: 5432, mode: "session" }], login: async (u, o) => (o?.attempts === 4 ? "refused" : "ok") }));
    } catch (e) { message = e.message; }
    await admin.end().catch(() => undefined);
    const stored = ssm.params.get(parameter).Value;
    const roleChanged = (await verifier()) !== before;
    assert.ok(stored === oldString || roleChanged,
      `SSM holds a new connection string but the role kept its old password (the API and App load it within 5 minutes and cannot log in); the step said: "${message}"`);
  });
});
