// Database migrations (supabase/migrations/NNNN_name.sql), each applied once, in order, in a transaction, recorded in
// fenvix_deploy.schema_migrations with its checksum. The first run on a database whose migrations were applied by
// hand (the founder's project: 0001 to 0010 by the earlier product, 0011 to 0017 in the SQL editor on 2026-11-19)
// recognises what is there and records it, without running it again.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { info, Stop, warning } from "./log.mjs";

export const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url).pathname;
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** A migration that cannot run in a transaction (CREATE INDEX CONCURRENTLY, ...) says so on its first line. */
const NO_TRANSACTION = /^--\s*fenvix:no-transaction\b/;
const LOCK = 74_310_191; // pg_advisory_lock key: one migration run at a time

export function readMigrations(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const out = [];
  for (const f of files) {
    const m = FILE.exec(f);
    if (!m) throw new Stop(`supabase/migrations/${f}: migration files are named NNNN_lowercase_name.sql`);
    const sql = readFileSync(join(dir, f), "utf8");
    out.push({ version: m[1], name: f, sql, checksum: createHash("sha256").update(sql).digest("hex"), transaction: !NO_TRANSACTION.test(sql) });
  }
  const seen = new Set();
  for (const m of out) { if (seen.has(m.version)) throw new Stop(`two migrations numbered ${m.version}`); seen.add(m.version); }
  return out;
}

/**
 * How to recognise each migration that may have been applied by hand, from what it leaves behind (objects no later
 * migration removes). 0001 to 0010 (the earlier product) are not probed: 0014 removed their tables, and 0011 needs
 * them, so "0011 applied" implies them. A database with tracked migrations is never probed again.
 */
export const PROBES = {
  "0011": `select to_regclass('public.ci_runs') is not null and to_regclass('public.ci_test_results') is not null and to_regclass('public.ci_projects') is not null`,
  "0012": `select to_regclass('public.ci_explorations') is not null
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_runs' and column_name = 'skip_misses')`,
  "0013": `select to_regclass('public.gh_installations') is not null and to_regclass('public.gh_jobs') is not null
             and exists (select 1 from pg_roles where rolname = 'fenvix_github_app')`,
  "0014": `select to_regclass('public.ci_audit_reruns') is not null and to_regclass('public.databases') is null
             and exists (select 1 from pg_roles where rolname = 'fenvix_api')
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_runs' and column_name = 'audit_rerun')`,
  "0015": `select to_regclass('public.gh_install_completions') is not null and to_regclass('public.ci_trial_accounts') is not null
             and to_regprocedure('public.api_complete_github_link(text)') is not null`,
  "0016": `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_explorations' and column_name = 'received_at')
             and to_regclass('public.gh_run_summaries_received') is not null`,
  "0017": `select to_regclass('public.gh_warmups') is not null
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_repositories' and column_name = 'cache_warm_sha')`,
};
/** The first migration with a probe: a database without it is either empty or not one of ours. */
const FIRST_PROBED = "0011";

/**
 * What the database already has, from the probes: the highest probed migration found, every probed one below it found
 * too (anything else is a half-applied database, which a person must look at), or null for an empty database.
 */
export async function detectApplied(client, migrations) {
  const results = {};
  for (const v of Object.keys(PROBES).sort()) results[v] = (await client.query(`${PROBES[v]} as ok`)).rows[0].ok === true;
  const found = Object.keys(results).filter((v) => results[v]);
  if (!found.length) {
    const { rows } = await client.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
    if (rows[0].n === 0) return { upTo: null, results };
    throw new Stop(`The database has tables in public but none of migration ${FIRST_PROBED}'s: it is not a fenvix database the pipeline recognises. Nothing was changed.`);
  }
  const upTo = found.at(-1);
  const missing = Object.keys(results).filter((v) => v < upTo && !results[v]);
  if (missing.length) {
    throw new Stop(`The database has migration ${upTo} but not ${missing.join(", ")} (checked by the objects each creates): it looks half-applied. Nothing was changed; a person must look at it (docs/DEPLOY-AWS.md, "When something fails").`);
  }
  const known = migrations.map((m) => m.version);
  for (const v of Object.keys(PROBES)) if (!known.includes(v)) throw new Error(`probe for ${v} but no such migration file`);
  return { upTo, results };
}

const SETUP = `
  create schema if not exists fenvix_deploy;
  revoke all on schema fenvix_deploy from public;
  create table if not exists fenvix_deploy.schema_migrations (
    version text primary key,
    name text not null,
    checksum text not null,
    applied_at timestamptz not null default now(),
    how text not null check (how in ('applied', 'found'))
  );
  revoke all on fenvix_deploy.schema_migrations from public;
`;

/**
 * Applies what is missing. Returns { found: [...], applied: [...] } (versions). Throws Stop (nothing half-done: each
 * migration and its record commit together) when a migration fails, when an applied migration's file changed, or when
 * a new migration is numbered below one already applied.
 */
export async function migrate(client, migrations = readMigrations(), { dryRun = false } = {}) {
  await client.query("select pg_advisory_lock($1)", [LOCK]);
  try {
    await client.query(SETUP);
    let { rows } = await client.query("select version, name, checksum, how from fenvix_deploy.schema_migrations order by version");
    const out = { found: [], applied: [] };

    if (rows.length === 0) {
      const { upTo, results } = await detectApplied(client, migrations);
      info(`no migration recorded yet; found by their objects: ${Object.entries(results).map(([v, ok]) => `${v} ${ok ? "yes" : "no"}`).join(", ")}`);
      if (upTo) {
        const done = migrations.filter((m) => m.version <= upTo);
        if (!dryRun) {
          await client.query("begin");
          for (const m of done) {
            await client.query("insert into fenvix_deploy.schema_migrations (version, name, checksum, how) values ($1, $2, $3, 'found')", [m.version, m.name, m.checksum]);
          }
          await client.query("commit");
        }
        out.found = done.map((m) => m.version);
        info(`recorded as already applied (not run again): ${done[0].version} to ${upTo}`);
        rows = done.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum, how: "found" }));
      } else {
        info("an empty database: every migration runs");
      }
    }

    const recorded = new Map(rows.map((r) => [r.version, r]));
    for (const r of rows) {
      const m = migrations.find((x) => x.version === r.version);
      if (!m) { warning(`migration ${r.version} (${r.name}) is recorded as applied but its file is gone`); continue; }
      if (m.checksum !== r.checksum) {
        throw new Stop(`${m.name} was changed after it was applied (${r.how === "found" ? "recorded on the first deploy" : "applied by the pipeline"}). An applied migration never changes: put the change in a new migration file. Nothing was changed.`);
      }
    }
    const pending = migrations.filter((m) => !recorded.has(m.version));
    const highest = rows.map((r) => r.version).sort().at(-1);
    const early = pending.filter((m) => highest && m.version < highest);
    if (early.length) throw new Stop(`${early.map((m) => m.name).join(", ")} is numbered below ${highest}, which is already applied: give it a number after ${highest}. Nothing was changed.`);

    for (const m of pending) {
      if (dryRun) { out.applied.push(m.version); continue; }
      info(`applying ${m.name}${m.transaction ? "" : " (no transaction: fenvix:no-transaction)"}`);
      try {
        if (m.transaction) await client.query("begin");
        await client.query(m.sql);
        await client.query("insert into fenvix_deploy.schema_migrations (version, name, checksum, how) values ($1, $2, $3, 'applied')", [m.version, m.name, m.checksum]);
        if (m.transaction) await client.query("commit");
      } catch (e) {
        if (m.transaction) await client.query("rollback").catch(() => undefined);
        const pg = /** @type {{ message?: string, code?: string, position?: string }} */ (e);
        throw new Stop(`${m.name} failed${m.transaction ? " and was rolled back (nothing of it is applied)" : ""}: ${pg.message ?? e}${pg.code ? ` (SQLSTATE ${pg.code})` : ""}. Later migrations were not run.`);
      }
      out.applied.push(m.version);
    }
    if (!pending.length) info("database up to date");
    return out;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => undefined);
  }
}
