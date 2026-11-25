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

const pol = (table, name) => `exists (select 1 from pg_policies where schemaname = 'public' and tablename = '${table}' and policyname = '${name}')`;
const rls = (table) => `coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.${table}')), false)`;
/** 0014 drops every policy of fenvix_control_plane (the last effects of 0011 and 0012); it creates ci_audit_reruns after that. */
const AFTER_0014_DROP = `to_regclass('public.ci_audit_reruns') is not null`;

/**
 * How to recognise each migration that may have been applied by hand, from what it leaves behind: its FIRST effects
 * (it started) and its LAST (it finished). First true and last false is a migration that ran only partly (statement by
 * statement, a cut paste): the deploy stops, as for any half-applied database (R-024 F5). Where a later migration
 * removes a last effect on purpose, that later migration's own evidence stands in for it. 0001 to 0010 (the earlier
 * product) are not probed: 0014 removed their tables, and 0011 needs them, so "0011 applied" implies them. A database
 * with tracked migrations is never probed again.
 */
export const PROBES = {
  "0011": {
    first: `to_regclass('public.ci_runs') is not null and to_regclass('public.ci_test_results') is not null and to_regclass('public.ci_projects') is not null`,
    last: `${rls("ci_test_results")} and (${pol("ci_test_results", "ci_test_results_control_plane")} or ${AFTER_0014_DROP})`,
  },
  "0012": {
    first: `to_regclass('public.ci_explorations') is not null
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_runs' and column_name = 'skip_misses')`,
    last: `${rls("ci_explorations")} and (${pol("ci_explorations", "ci_explorations_control_plane")} or ${AFTER_0014_DROP})`,
  },
  "0013": {
    first: `to_regclass('public.gh_installations') is not null and to_regclass('public.gh_jobs') is not null
             and exists (select 1 from pg_roles where rolname = 'fenvix_github_app')`,
    last: pol("ci_usage_events", "ci_usage_events_github_app"),
  },
  "0014": {
    first: `to_regclass('public.ci_audit_reruns') is not null and to_regclass('public.databases') is null
             and exists (select 1 from pg_roles where rolname = 'fenvix_api')
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_runs' and column_name = 'audit_rerun')`,
    // Its last statements re-create gh_link_installation right after the policy workspaces_github_app, which only 0014
    // creates. The grants are 0013's (kept by create or replace: not distinctive), so the probe also requires the
    // function's source to mention trial_ends_at, which only 0014's version does (linking starts the trial); and
    // execute on that function stays off for anon.
    last: `${pol("workspaces", "workspaces_github_app")} and case when to_regprocedure('public.gh_link_installation(bigint,uuid,uuid)') is not null
                   and exists (select 1 from pg_roles where rolname = 'fenvix_github_app') and exists (select 1 from pg_roles where rolname = 'anon')
             then has_function_privilege('fenvix_github_app', 'public.gh_link_installation(bigint,uuid,uuid)', 'execute')
                  and not has_function_privilege('anon', 'public.gh_link_installation(bigint,uuid,uuid)', 'execute')
             else false end
             and coalesce((select prosrc like '%trial_ends_at%' from pg_proc
                           where oid = to_regprocedure('public.gh_link_installation(bigint,uuid,uuid)')), false)`,
  },
  "0015": {
    first: `to_regclass('public.gh_install_completions') is not null and to_regclass('public.ci_trial_accounts') is not null
             and to_regprocedure('public.api_complete_github_link(text)') is not null`,
    // 0014 created this policy already; 0015's last statement re-creates it on api_owner_workspace() (new in 0015).
    last: `exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_invites' and policyname = 'workspace_invites_api_revoke' and qual like '%api_owner_workspace()%')`,
  },
  "0016": {
    first: `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_explorations' and column_name = 'received_at')`,
    last: `to_regclass('public.gh_run_summaries_received') is not null`,
  },
  "0017": {
    first: `to_regclass('public.gh_warmups') is not null
             and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_repositories' and column_name = 'cache_warm_sha')`,
    last: `${rls("gh_warmups")} and ${pol("gh_warmups", "gh_warmups_api_read")}`,
  },
  // 0018 re-creates the runner CHECK constraints with node:test and mocha: ci_projects first, gh_repositories last.
  "0018": {
    first: `exists (select 1 from pg_constraint where conname = 'ci_projects_test_runner_check'
                     and conrelid = to_regclass('public.ci_projects') and pg_get_constraintdef(oid) like '%''mocha''%')`,
    last: `exists (select 1 from pg_constraint where conname = 'gh_repositories_detected_test_runner_check'
                    and conrelid = to_regclass('public.gh_repositories') and pg_get_constraintdef(oid) like '%''mocha''%')`,
  },
  // 0019 (parallel with proof) adds ci_runs.proof first and re-creates ci_test_results' outcome CHECK with not_proven last.
  "0019": {
    first: `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_runs' and column_name = 'proof')`,
    last: `exists (select 1 from pg_constraint where conname = 'ci_test_results_outcome_check'
                    and conrelid = to_regclass('public.ci_test_results') and pg_get_constraintdef(oid) like '%''not_proven''%')`,
  },
  // 0020 (summaries refused at intake) adds gh_run_summaries.rejected_at first and makes `summary` nullable last.
  "0020": {
    first: `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_run_summaries' and column_name = 'rejected_at')`,
    last: `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_run_summaries' and column_name = 'summary'
                    and is_nullable = 'YES')`,
  },
  // 0021 (failure detail for idea 3) adds ci_test_results.fail_seq first and the rerun_alone_outcome CHECK last.
  "0021": {
    first: `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_test_results' and column_name = 'fail_seq')`,
    last: `exists (select 1 from pg_constraint where conname = 'ci_test_results_rerun_alone_outcome_check'
                    and conrelid = to_regclass('public.ci_test_results'))`,
  },
  // 0022 (machine identity for idea 3) adds gh_jobs.image_id first and grants gh_machine_kind to the App last (the
  // function exists, the App may execute it and the browser roles may not: true only once the final grant ran).
  "0022": {
    first: `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_jobs' and column_name = 'image_id')`,
    last: `case when to_regprocedure('public.gh_machine_kind(bigint,text,text)') is null
                  or not exists (select 1 from pg_roles where rolname = 'fenvix_github_app')
                  or not exists (select 1 from pg_roles where rolname = 'anon') then false
                else has_function_privilege('fenvix_github_app', 'public.gh_machine_kind(bigint,text,text)', 'execute')
                     and not has_function_privilege('anon', 'public.gh_machine_kind(bigint,text,text)', 'execute') end`,
  },
};
/** The first migration with a probe: a database without it is either empty or not one of ours. */
const FIRST_PROBED = "0011";

/**
 * What the database already has, from the probes: the highest probed migration found (all of it), every probed one
 * below it found too, none half-applied (anything else is a database a person must look at), or null for an empty
 * database.
 */
export async function detectApplied(client, migrations) {
  const results = {};
  const half = [];
  for (const v of Object.keys(PROBES).sort()) {
    const { rows } = await client.query(`select (${PROBES[v].first}) as first, (${PROBES[v].last}) as last`);
    const first = rows[0].first === true, last = rows[0].last === true;
    if (first && !last) half.push(v);
    results[v] = first && last;
  }
  if (half.length) {
    throw new Stop(`Migration ${half.join(", ")} looks half-applied: its first objects exist but its last effects do not (it ran only partly). Nothing was changed; a person must look at it (docs/DEPLOY-AWS.md, "When something fails").`);
  }
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
