// Tests merge_accounts.sql and undo_merge.sql on a SCRATCH Postgres with made-up people.
//
//   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/merge_scratch node supabase/account-merge/test-merge.mjs
//
// The database must be empty and disposable: this applies the local Supabase stand-ins and the
// migrations 0001, 0002 and 0006 to it. Refuses anything that looks like a hosted Supabase project.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.error("Set TEST_DATABASE_URL to an empty scratch database."); process.exit(2); }
if (/supabase\.(co|com|in)|pooler/.test(url)) { console.error("Refusing to run against what looks like a hosted Supabase project."); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const MERGE = join(here, "merge_accounts.sql");
const UNDO = join(here, "undo_merge.sql");

const psqlFile = (file) => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", file], { stdio: "pipe" });
const run = (statement) => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-tAq", "-c", statement], { encoding: "utf8" }).trim();
const rows = (query) => JSON.parse(run(`select coalesce(json_agg(r_), '[]') from (${query}) r_`));
const one = (query) => rows(query)[0];
function script(file, vars) {
  const args = [url, ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", file];
  const r = spawnSync("psql", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

let passed = 0;
let failed = 0;
function check(cond, what, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? `\n${detail}` : ""}`); }
}

/** A fingerprint of everything the merge may touch, to prove "nothing changed" and "all put back". */
function fingerprint() {
  const tables = rows(`select format('%I.%I', table_schema, table_name) as t from information_schema.tables
                       where table_type = 'BASE TABLE' and (table_schema = 'public' or (table_schema = 'auth' and table_name in ('users', 'identities')))
                       order by 1`).map((r) => r.t);
  return Object.fromEntries(tables.map((t) => [t, run(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from ${t} x`)]));
}
const sameAs = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

// ---------------------------------------------------------------- set-up
console.log("setting up: stand-ins, migrations 0001, 0002, 0006");
if (run("select count(*) from pg_namespace where nspname = 'auth'") !== "0") { console.error("The database is not empty."); process.exit(2); }
psqlFile(join(root, "supabase/tests/local-stub.sql"));
psqlFile(join(root, "supabase/migrations/0001_init.sql"));
psqlFile(join(root, "supabase/migrations/0002_control_plane.sql"));
psqlFile(join(root, "supabase/migrations/0006_account_linking.sql"));

const ids = {};
const uuid = () => run("select gen_random_uuid()");
for (const k of ["A", "B", "C", "D", "S", "X", "Y"]) ids[k] = uuid();

/** The legacy state, made the way Supabase Auth made it before 0006 (so the rules stand aside). */
function seed() {
  run(`begin;
    set local fenvix.account_merge = 'on';
    -- A: the person, signed up with Google.
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, last_sign_in_at)
      values ('${ids.A}', 'pat@example.com', now() - interval '30 days', '{"full_name":"Pat Doe"}', '{"providers":["google"]}', now());
    insert into auth.identities (provider_id, user_id, identity_data, provider)
      values ('g-pat', '${ids.A}', '{"email":"pat@example.com","email_verified":true,"sub":"g-pat"}', 'google');
    -- B: the same person through GitHub: a shadow that became a second account (no address, confirmed).
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, last_sign_in_at)
      values ('${ids.B}', null, now() - interval '20 days', '{"full_name":"Pat D."}', '{"providers":["github"]}', now());
    insert into auth.identities (provider_id, user_id, identity_data, provider)
      values ('gh-4242', '${ids.B}', '{"email":"pat@example.com","email_verified":true,"sub":"4242"}', 'github');
    -- an old unverified identity on B, which must not reach A
    insert into auth.identities (provider_id, user_id, identity_data, provider)
      values ('kc-old', '${ids.B}', '{"email":"pat@example.com","email_verified":false,"sub":"kc-old"}', 'keycloak');
    -- C: a colleague B invited; D: someone whose workspace B is a member of.
    insert into auth.users (id, email, email_confirmed_at) values ('${ids.C}', 'chris@example.com', now()), ('${ids.D}', 'dana@example.com', now());
    commit;`);
  // Their workspaces, as the sign-up trigger made them (it stands aside while the rules do).
  run(`select public.ensure_workspace('${ids.A}', 'pat@example.com', 'Pat Doe'), public.ensure_workspace('${ids.B}', 'pat@example.com', 'Pat GitHub'),
              public.ensure_workspace('${ids.C}', 'chris@example.com'), public.ensure_workspace('${ids.D}', 'dana@example.com')`);
  const wa = run(`select workspace_id from public.workspace_members where user_id = '${ids.A}'`);
  const wb = run(`select workspace_id from public.workspace_members where user_id = '${ids.B}'`);
  const wd = run(`select workspace_id from public.workspace_members where user_id = '${ids.D}'`);
  run(`update public.workspace_members set created_at = now() - interval '30 days' where user_id = '${ids.A}';
       insert into public.workspace_members (workspace_id, user_id, role) values ('${wb}', '${ids.C}', 'admin'), ('${wd}', '${ids.B}', 'member');
       update public.workspace_settings set plan = 'pro', idle_minutes = 15, billing_email = 'pat@example.com' where workspace_id = '${wb}';
       insert into public.databases (workspace_id, name, region) values
         ('${wa}', 'api', 'eu-west'), ('${wa}', 'shared', 'eu-west'), ('${wa}', 'shared-2', 'eu-west'),
         ('${wb}', 'shared', 'us-east'), ('${wb}', 'jobs', 'us-east'), ('${wb}', '${"x".repeat(48)}', 'us-east'), ('${wa}', '${"x".repeat(48)}', 'eu-west');
       insert into public.database_tags (database_id, key, value) select id, 'env', 'prod' from public.databases where workspace_id = '${wb}';
       insert into public.usage_daily (database_id, day, requests, storage_bytes)
         select d.id, current_date - g, 100, 1000 from public.databases d, generate_series(0, 9) g where d.workspace_id in ('${wa}', '${wb}');
       insert into public.usage_hourly (database_id, hour, requests) select id, date_trunc('hour', now()), 5 from public.databases where workspace_id = '${wb}';
       insert into public.wake_events (database_id, first_request_ms) select id, 120 from public.databases where workspace_id = '${wb}';
       insert into public.api_keys (workspace_id, name, key_hash, last4) values
         ('${wa}', 'ci', repeat('a', 64), 'aaaa'), ('${wb}', 'deploy', repeat('b', 64), 'bbbb');
       insert into public.invoices (workspace_id, number, month, issued_at, amount_cents) values
         ('${wa}', 'INV-A-1', date_trunc('month', now())::date, now(), 1000), ('${wb}', 'INV-B-1', date_trunc('month', now())::date, now(), 2000);
       insert into public.operations (workspace_id, kind, status, actor_type) values ('${wb}', 'create', 'succeeded', 'user');
       insert into public.idempotency_keys (workspace_id, key, method, path, request_hash) values
         ('${wa}', 'k1', 'POST', '/v1/databases', 'h'), ('${wb}', 'k1', 'POST', '/v1/databases', 'h'), ('${wb}', 'k2', 'POST', '/v1/databases', 'h');
       insert into public.audit_log (workspace_id, actor_type, action) values ('${wb}', 'user', 'database.created');`);
  return { wa, wb, wd };
}

const { wa, wb, wd } = seed();
const before = fingerprint();

console.log("\n0. find_duplicates.sql lists the pair and suggests keeping the account with the confirmed address");
{
  const out = execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-tA", "-F", "|", "-f", join(here, "find_duplicates.sql")], { encoding: "utf8" }).trim().split("\n");
  const hit = out.find((l) => l.startsWith("duplicate|pat@example.com|"));
  check(out.length === 1 && hit && hit.split("|")[2] === ids.A, "one duplicate, keep A", out.join("\n"));
  check(sameAs(before, fingerprint()).length === 0, "read only");
}

console.log("\n1. dry run, default policy: the same database name in both workspaces stops it");
let r = script(MERGE, { keep_user: ids.A, drop_user: ids.B });
check(!r.ok && /databases with the same name in both workspaces: shared, x{48}/.test(r.out), "refused, naming the databases", r.out);
check(sameAs(before, fingerprint()).length === 0, "nothing changed");

console.log("\n2. dry run with -v on_name_conflict=rename: prints the plan, changes nothing");
r = script(MERGE, { keep_user: ids.A, drop_user: ids.B, on_name_conflict: "rename" });
check(r.ok && /DRY RUN/.test(r.out), "ran and rolled back", r.out);
check(/renamed: shared -> shared-3/.test(r.out) && /settings removed: plan pro/.test(r.out), "says what it would rename and shows both settings", r.out);
check(sameAs(before, fingerprint()).length === 0, `nothing changed (${sameAs(before, fingerprint()).join(", ")})`);
check(run("select count(*) from pg_namespace where nspname = 'fenvix_account_merge'") === "0", "not even the backup schema is left behind");

console.log("\n3. for real");
r = script(MERGE, { keep_user: ids.A, drop_user: ids.B, on_name_conflict: "rename", execute: 1 });
check(r.ok && /COMMITTED/.test(r.out), "committed", r.out);
const mergeId = run("select max(id) from fenvix_account_merge.merges");
check(run(`select count(*) from auth.users where id = '${ids.B}'`) === "0", "the duplicate user is gone");
check(run(`select count(*) from public.workspaces where id = '${wb}'`) === "0", "its workspace is gone");
check(one(`select array_agg(provider order by provider) as p from auth.identities where user_id = '${ids.A}'`).p.join() === "github,google", "GitHub now signs in to the kept account");
check(run("select count(*) from auth.identities where provider_id = 'kc-old'") === "0", "the unverified identity was not moved");
check(rows(`select name from public.databases where workspace_id = '${wa}' order by name`).map((x) => x.name).join() ===
  ["api", "jobs", "shared", "shared-2", "shared-3", "x".repeat(46) + "-2", "x".repeat(48)].sort().join(), "databases moved; the clashing ones renamed by the rule");
check(run(`select count(*) from public.usage_daily where workspace_id = '${wa}'`) === "70" && run(`select count(*) from public.database_tags where workspace_id = '${wa}'`) === "3",
  "usage and tags followed their databases");
check(run(`select count(*) from public.api_keys where workspace_id = '${wa}'`) === "2" && run(`select count(*) from public.invoices where workspace_id = '${wa}'`) === "2", "API keys and invoices moved");
check(run(`select string_agg(key, ',' order by key) from public.idempotency_keys where workspace_id = '${wa}'`) === "k1,k2", "idempotency keys: the clash dropped, the rest moved");
check(run(`select role from public.workspace_members where workspace_id = '${wa}' and user_id = '${ids.C}'`) === "admin", "the colleague is in the kept workspace with their role");
check(run(`select role from public.workspace_members where workspace_id = '${wd}' and user_id = '${ids.A}'`) === "member", "the kept account took over the other membership");
check(run(`select plan from public.workspace_settings where workspace_id = '${wa}'`) === "managed", "the kept workspace's settings stay");
check(run(`select count(*) from public.audit_log where workspace_id = '${wa}' and action = 'account.merged'`) === "1", "an audit entry records the merge");
check(run(`select workspace_id from public.workspace_members where user_id = '${ids.A}' order by created_at limit 1`) === wa, "the person opens the kept workspace");
const afterMerge = fingerprint();

console.log("\n4. undo, dry run, then for real");
r = script(UNDO, { merge_id: mergeId });
check(r.ok && /DRY RUN/.test(r.out) && sameAs(afterMerge, fingerprint()).length === 0, "dry run changes nothing", r.out);
r = script(UNDO, { merge_id: mergeId, execute: 1 });
check(r.ok && /COMMITTED/.test(r.out), "committed", r.out);
const diff = sameAs(before, fingerprint());
check(diff.length === 0, `every table is exactly as before the merge${diff.length ? ` (differs: ${diff.join(", ")})` : ""}`);
r = script(UNDO, { merge_id: mergeId, execute: 1 });
check(!r.ok && /already undone/.test(r.out), "cannot be undone twice");

console.log("\n5. keep the GitHub account's workspace instead (-v keep_workspace)");
r = script(MERGE, { keep_user: ids.A, drop_user: ids.B, keep_workspace: wb, on_name_conflict: "rename", execute: 1 });
check(r.ok, "committed", r.out);
check(run(`select count(*) from public.workspaces where id = '${wa}'`) === "0" && run(`select role from public.workspace_members where workspace_id = '${wb}' and user_id = '${ids.A}'`) === "owner",
  "the kept account owns the GitHub workspace; the Google one is gone");
check(run(`select name from public.databases where workspace_id = '${wb}' and region = 'eu-west' and name like 'shared%' order by name limit 1`) === "shared-2"
  && run(`select count(*) from public.databases where workspace_id = '${wb}' and name = 'shared' and region = 'us-east'`) === "1", "this time the incoming databases are the ones renamed");
r = script(UNDO, { merge_id: run("select max(id) from fenvix_account_merge.merges"), execute: 1 });
check(r.ok && sameAs(before, fingerprint()).length === 0, "and undone exactly", r.out);

console.log("\n6. an unconfirmed shadow that never signed in");
run(`begin; set local fenvix.account_merge = 'on';
     insert into auth.users (id, email, email_confirmed_at) values ('${ids.S}', null, null);
     insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('gh-shadow', '${ids.S}', '{"email":"pat@example.com","email_verified":false}', 'github');
     commit;`);
run(`select public.ensure_workspace('${ids.S}', null, 'Shadow')`);
check(execFileSync("psql", [url, "-tA", "-F", "|", "-f", join(here, "find_duplicates.sql")], { encoding: "utf8" }).includes(`shadow|pat@example.com|${ids.A}`), "find_duplicates.sql lists it as a shadow");
r = script(MERGE, { keep_user: ids.A, drop_user: ids.S, execute: 1 });
check(r.ok && run(`select count(*) from auth.users where id = '${ids.S}'`) === "0", "removed with its empty workspace", r.out);
check(run("select count(*) from auth.identities where provider_id = 'gh-shadow'") === "0", "its unverified identity went with it, not to the kept account");

console.log("\n7. refusals");
run(`insert into auth.users (id, email, email_confirmed_at) values ('${ids.X}', 'someone@example.com', now()), ('${ids.Y}', 'else@example.com', now())`);
r = script(MERGE, { keep_user: ids.X, drop_user: ids.Y, execute: 1 });
check(!r.ok && /share no verified address/.test(r.out), "two people who share no verified address are never merged", r.out);
const snap = fingerprint();
run(`create table public.extra (workspace_id uuid references public.workspaces (id))`);
r = script(MERGE, { keep_user: ids.A, drop_user: ids.B, on_name_conflict: "rename", execute: 1 });
check(!r.ok && /tables this file does not know .*public\.extra/.test(r.out), "a table it does not know stops it", r.out);
run("drop table public.extra");
run(`insert into public.operations (workspace_id, kind, status, actor_type) values ('${wb}', 'export', 'running', 'user')`);
r = script(MERGE, { keep_user: ids.A, drop_user: ids.B, on_name_conflict: "rename", execute: 1 });
check(!r.ok && /queued or running/.test(r.out), "an operation in progress stops it", r.out);
run(`delete from public.operations where status = 'running'`);
check(sameAs(snap, fingerprint()).length === 0, "refusals change nothing");

console.log("\n8. the data explorer's audit table (branch data-browser), when present, moves too");
run(`create table public.data_audit_log (id bigint generated always as identity primary key,
       workspace_id uuid not null references public.workspaces (id) on delete cascade, at timestamptz not null default now(), action text);
     insert into public.data_audit_log (workspace_id, action) values ('${wb}', 'query')`);
r = script(MERGE, { keep_user: ids.A, drop_user: ids.B, on_name_conflict: "rename", execute: 1 });
check(r.ok && run(`select count(*) from public.data_audit_log where workspace_id = '${wa}'`) === "1", "moved", r.out);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
