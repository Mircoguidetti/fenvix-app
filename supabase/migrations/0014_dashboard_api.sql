-- fenvix: the dashboard API (github-app/src/api/, openapi/fenvix-api.yaml) and the removal of the earlier database
-- product. Safe to run more than once. Run it AFTER 0001 to 0013.
--
-- 1. The earlier product (serverless databases) is removed: its tables, functions, types, policies and the control
--    plane's database role. What the CI product still uses is kept and, where it lived in a table of the old product,
--    moved: organizations (workspaces), members, invitations, the sign-up trigger, the membership helpers. The e-mail
--    notice setting moves from workspace_settings to workspaces.
-- 2. The browser never reaches the database. anon and authenticated lose every right on our tables: the dashboard
--    talks to the API only (founder decision, 2026-11-18). The API connects as the restricted role fenvix_api (login,
--    no BYPASSRLS, through the Supabase pooler) and names, in every transaction, the signed-in user (app.user_id,
--    from the verified Supabase token) and the organization (app.workspace_id, from X-Fenvix-Workspace). The API
--    checks membership and role first; row level security checks them again (second barrier): a row is visible only
--    when that user is a member of that organization, and changeable only when they are an owner or admin there.
-- 3. New data for the CI product: region per organization (us | eu), the 30-day shadow trial, run units (1 unit = 10
--    baseline minutes, billable usage events only), plans with prices, the nightly exploration add-on, live run
--    progress, shadow-mode numbers, audit reruns, the runner's per-test results staged until the run exists, and the
--    GitHub App's grants to write them (docs/data-contract.md).

-- ================================================================ 1. the earlier product goes

-- Triggers of the old product on tables that stay.
drop trigger if exists workspace_members_revoke_public_keys on public.workspace_members;

-- Its tables (children first). CASCADE takes their policies, triggers, indexes and sequences with them.
drop table if exists public.public_api_keys cascade;
drop table if exists public.database_ip_allowlists cascade;
drop table if exists public.data_audit_log cascade;
drop table if exists public.database_tags cascade;
drop table if exists public.usage_hourly cascade;
drop table if exists public.usage_daily cascade;
drop table if exists public.wake_events cascade;
drop table if exists public.invoices cascade;
drop table if exists public.operations cascade;
drop table if exists public.idempotency_keys cascade;
drop table if exists public.audit_log cascade;
drop table if exists public.api_keys cascade;
drop table if exists public.databases cascade;

-- workspace_settings: the e-mail notice setting moves to workspaces; idle minutes, plan and payment card were the old
-- product's.
alter table public.workspaces add column if not exists email_notices boolean not null default true;
do $$ begin
  if to_regclass('public.workspace_settings') is not null then
    update public.workspaces w set email_notices = s.email_notices from public.workspace_settings s where s.workspace_id = w.id;
  end if;
end $$;
drop table if exists public.workspace_settings cascade;

drop type if exists public.database_state;

-- Its functions: every fenvix_* (the dashboard's database functions and the control plane's fenvix_cp_*), the public
-- API key triggers, the database tag trigger and current_workspace() (PostgREST's organization header).
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'fenvix\_%' or p.proname like 'public\_api\_keys\_%'
      or p.proname in ('set_workspace_from_database', 'current_workspace'))
  loop
    execute format('drop function if exists %s cascade', f.sig);
  end loop;
end $$;

-- The control plane's role: its policies on the tables that stay, its grants, then the role itself.
do $$
declare r record;
begin
  if exists (select 1 from pg_roles where rolname = 'fenvix_control_plane') then
    for r in select schemaname, tablename, policyname from pg_policies where 'fenvix_control_plane' = any (roles) loop
      execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    end loop;
    execute 'revoke all on all tables in schema public from fenvix_control_plane';
    execute 'revoke all on all sequences in schema public from fenvix_control_plane';
    execute 'revoke all on all functions in schema public from fenvix_control_plane';
    execute 'revoke all on schema public from fenvix_control_plane';
    begin
      execute 'drop role fenvix_control_plane';
    exception when others then
      raise notice 'fenvix_control_plane still owns objects or has grants elsewhere (%); it has no rights in public any more. Drop it by hand: drop owned by fenvix_control_plane; drop role fenvix_control_plane;', sqlerrm;
    end;
  end if;
end $$;

-- ================================================================ 2. the browser reaches nothing

-- Every policy for anon or authenticated on our tables goes, and every right with it.
do $$
declare r record; t text;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and (roles && array['authenticated', 'anon', 'public']::name[]) loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
  foreach t in array array['workspaces', 'workspace_members', 'workspace_invites', 'ci_plans', 'ci_reference_rates',
    'ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results', 'ci_explorations',
    'gh_installations', 'gh_repositories', 'gh_pull_requests', 'gh_pushes', 'gh_jobs', 'gh_run_summaries',
    'gh_webhook_deliveries', 'ci_usage_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
-- The membership helpers read auth.uid(), which only a PostgREST caller has; nobody else calls them now.
revoke execute on function public.my_workspace_ids() from authenticated;
revoke execute on function public.my_admin_workspace_ids() from authenticated;
revoke execute on function public.is_workspace_member(uuid) from authenticated;

-- ================================================================ 3. organizations: region and sign-up

alter table public.workspaces add column if not exists region text not null default 'us';
alter table public.workspaces drop constraint if exists workspaces_region_check;
alter table public.workspaces add constraint workspaces_region_check check (region in ('us', 'eu'));

-- The sign-up trigger: an organization of one's own, as before, without the old settings table.
create or replace function public.ensure_workspace(p_user uuid, p_email text, p_name text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ws uuid;
  label text;
begin
  select m.workspace_id into ws from public.workspace_members m where m.user_id = p_user limit 1;
  if ws is not null then
    return ws;
  end if;
  label := nullif(btrim(coalesce(p_name, '')), '');
  if label is null then
    label := initcap(replace(split_part(coalesce(p_email, 'workspace'), '@', 1), '.', ' '));
  end if;
  insert into public.workspaces (name) values (left(label, 60)) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, p_user, 'owner');
  return ws;
end $$;
revoke all on function public.ensure_workspace(uuid, text, text) from public, anon, authenticated;

-- ================================================================ 4. plans, add-on, trial, run units

-- Plans by run units: 1 unit = 10 baseline minutes (the job's minutes without fenvix: tests run + tests skipped with
-- proof + other steps), counted on billable usage events only. Prices set by the founder on 2026-11-18. How many
-- units each plan includes is not set yet (null): the screens say so instead of guessing.
alter table public.ci_plans add column if not exists units_included int check (units_included is null or units_included > 0);
alter table public.ci_plans add column if not exists kind text not null default 'plan';
alter table public.ci_plans drop constraint if exists ci_plans_kind_check;
alter table public.ci_plans add constraint ci_plans_kind_check check (kind in ('plan', 'addon'));
alter table public.ci_plans drop column if exists runs_per_month;

insert into public.ci_plans (id, name, description, max_projects, price_usd_month, features, sort, kind) values
  ('starter', 'Starter', 'One team, a steady flow of pull requests.', null, 129, array['Skip with proof', 'Audit reruns (5% of skipped tests)', 'Flaky tests turned into defects', 'Pull request comments'], 1, 'plan'),
  ('team', 'Team', 'A few projects, a team pushing every day.', null, 479, array['Everything in Starter', 'Members and roles', 'Region: US or EU'], 2, 'plan'),
  ('scale', 'Scale', 'Many projects, many teams.', null, 1350, array['Everything in Team', 'Priority machines'], 3, 'plan'),
  ('monorepo', 'Monorepo', 'One large monorepo with a long suite.', null, 4200, array['Everything in Scale', 'Sized for one large suite'], 4, 'plan'),
  ('nightly-exploration', 'Nightly exploration', 'Every night, the suite in many seeded orders: flaky tests found before they fail a pull request.', null, null, array['Seeded orders every night', 'New defects with replay commands'], 10, 'addon')
on conflict (id) do update set name = excluded.name, description = excluded.description, max_projects = excluded.max_projects,
  price_usd_month = excluded.price_usd_month, features = excluded.features, sort = excluded.sort, kind = excluded.kind;

-- The enterprise plan of the first draft is gone; anyone on it moves to Scale.
update public.ci_subscriptions set plan_id = 'scale' where plan_id = 'enterprise';
update public.ci_usage_events set plan_id = 'scale' where plan_id = 'enterprise';
delete from public.ci_plans where id = 'enterprise';

alter table public.ci_subscriptions add column if not exists nightly_exploration_addon boolean not null default false;
-- The 30-day shadow trial: starts when the organization links its first GitHub installation. While it runs, jobs run
-- in shadow mode (every test runs; the engine records what it would have skipped).
alter table public.ci_subscriptions add column if not exists trial_started_at timestamptz;
alter table public.ci_subscriptions add column if not exists trial_ends_at timestamptz;
alter table public.ci_subscriptions drop constraint if exists ci_subscriptions_trial_check;
alter table public.ci_subscriptions add constraint ci_subscriptions_trial_check check (trial_ends_at is null or trial_ends_at > trial_started_at);

-- Units per usage event (numeric, two decimals); a month's units are the sum, rounded up.
alter table public.ci_usage_events add column if not exists baseline_minutes numeric generated always as (test_minutes_ran + minutes_saved + other_step_minutes) stored;
alter table public.ci_usage_events add column if not exists units numeric generated always as (round((test_minutes_ran + minutes_saved + other_step_minutes) / 10.0, 2)) stored;

-- ================================================================ 5. runs: mode, live progress, audit, region

-- shadow: the trial; every test ran, would_* say what fenvix would have skipped. enforce: skipped with proof.
alter table public.ci_runs add column if not exists mode text not null default 'enforce';
alter table public.ci_runs drop constraint if exists ci_runs_mode_check;
alter table public.ci_runs add constraint ci_runs_mode_check check (mode in ('enforce', 'shadow'));
alter table public.ci_runs add column if not exists would_skip_tests int not null default 0 check (would_skip_tests >= 0);
alter table public.ci_runs add column if not exists would_save_ms bigint not null default 0 check (would_save_ms >= 0);
-- While the run is running: the runner's latest progress record (docs/data-contract.md "Run progress").
alter table public.ci_runs add column if not exists progress jsonb;
alter table public.ci_runs add column if not exists progress_at timestamptz;
-- Changes whenever the row changes: the API's ETag.
alter table public.ci_runs add column if not exists updated_at timestamptz not null default now();
-- Audit reruns: skipped tests the engine ran anyway (5%), and how many of them failed (a wrong skip; expected 0).
alter table public.ci_runs add column if not exists audit_rerun int not null default 0 check (audit_rerun >= 0);
alter table public.ci_runs add column if not exists audit_wrong_skips int not null default 0 check (audit_wrong_skips >= 0);
-- Where the job ran (the organization's region when the machine was placed).
alter table public.ci_runs add column if not exists region text check (region is null or region in ('us', 'eu'));

create or replace function public.ci_touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ci_runs_touch on public.ci_runs;
create trigger ci_runs_touch before update on public.ci_runs for each row execute function public.ci_touch_updated_at();

-- One row per audited test: which skip was checked by running the test anyway, and what it showed.
create table if not exists public.ci_audit_reruns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.ci_runs (id) on delete cascade,
  test_id text not null,
  cache_key text not null check (cache_key ~ '^[0-9a-f]{32}$'),
  -- confirmed: it passed, as the receipt said it would. wrong_skip: it failed although it would have been skipped.
  outcome text not null check (outcome in ('confirmed', 'wrong_skip')),
  -- The engine stopped trusting this cache key (a wrong skip, or the key's inputs could not be re-proven).
  untrusted boolean not null default false,
  detail text not null default '' check (char_length(detail) <= 2000),
  at timestamptz not null default now(),
  unique (run_id, test_id)
);
create index if not exists ci_audit_reruns_ws_at on public.ci_audit_reruns (workspace_id, at desc);

-- ci_workspace_from_parent() knows ci_audit_reruns (a child of a run).
drop trigger if exists ci_audit_reruns_workspace on public.ci_audit_reruns;
create trigger ci_audit_reruns_workspace before insert or update on public.ci_audit_reruns
  for each row execute function public.ci_workspace_from_parent();
alter table public.ci_audit_reruns enable row level security;
revoke all on public.ci_audit_reruns from public, anon, authenticated;

-- The replay command the runner sent with a defect bundle (the engine's own); null: the dashboard builds it.
alter table public.ci_defects add column if not exists replay_command text check (replay_command is null or char_length(replay_command) <= 4000);

-- gh_jobs: the region the machine was placed in.
alter table public.gh_jobs add column if not exists region text check (region is null or region in ('us', 'eu'));

-- The runner's per-test results, receipts, defects and audit reruns of one job, in chunks, until the App applies them
-- to the run (the run row exists once the job is linked to a project).
create table if not exists public.gh_run_results (
  id bigint generated always as identity primary key,
  repository_id bigint not null,
  run_id bigint not null,
  run_attempt int not null default 1,
  runner_name text not null,
  chunk int not null check (chunk >= 0 and chunk < 10000),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  apply_error text,
  unique (repository_id, run_id, run_attempt, runner_name, chunk)
);
alter table public.gh_run_results enable row level security;
revoke all on public.gh_run_results from public, anon, authenticated;

-- ================================================================ 6. the API's role

do $$ begin
  create role fenvix_api login;
exception when duplicate_object then null; end $$;
do $$ begin
  alter role fenvix_api nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception when insufficient_privilege then
  raise notice 'Could not reset the attributes of fenvix_api. Check: select rolsuper, rolbypassrls from pg_roles where rolname = ''fenvix_api'' (both false).';
end $$;
grant usage on schema public to fenvix_api;

-- Who the API acts for in this transaction. Set by the API with set_config(..., true) after it verified the token.
create or replace function public.api_user() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- The organization of this transaction, only if the user is a member of it (else null: no row matches).
create or replace function public.api_workspace() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = public.api_user() and m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

-- The same, only if the user is an owner or admin there.
create or replace function public.api_admin_workspace() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = public.api_user() and m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    and m.role in ('owner', 'admin')
$$;

-- The organizations of the user (any role).
create or replace function public.api_my_workspace_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m where m.user_id = public.api_user()
$$;

do $$
declare f text;
begin
  foreach f in array array['api_user()', 'api_workspace()', 'api_admin_workspace()', 'api_my_workspace_ids()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_api', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- organizations, members, invitations

grant select on public.workspaces to fenvix_api;
grant update (name, name_confirmed, region, email_notices) on public.workspaces to fenvix_api;
drop policy if exists workspaces_api_read on public.workspaces;
create policy workspaces_api_read on public.workspaces for select to fenvix_api using (id in (select public.api_my_workspace_ids()));
drop policy if exists workspaces_api_admin on public.workspaces;
create policy workspaces_api_admin on public.workspaces for update to fenvix_api
  using (id = public.api_admin_workspace()) with check (id = public.api_admin_workspace());

grant select, delete on public.workspace_members to fenvix_api;
grant update (role) on public.workspace_members to fenvix_api;
drop policy if exists workspace_members_api_read on public.workspace_members;
create policy workspace_members_api_read on public.workspace_members for select to fenvix_api
  using (user_id = public.api_user() or workspace_id = public.api_workspace());
drop policy if exists workspace_members_api_admin_update on public.workspace_members;
create policy workspace_members_api_admin_update on public.workspace_members for update to fenvix_api
  using (workspace_id = public.api_admin_workspace()) with check (workspace_id = public.api_admin_workspace());
-- An owner or admin removes someone; anyone leaves (removes themselves). The last owner never goes (trigger).
drop policy if exists workspace_members_api_delete on public.workspace_members;
create policy workspace_members_api_delete on public.workspace_members for delete to fenvix_api
  using (workspace_id = public.api_admin_workspace() or (user_id = public.api_user() and workspace_id = public.api_workspace()));

grant select, insert on public.workspace_invites to fenvix_api;
grant update (revoked_at, revoked_by) on public.workspace_invites to fenvix_api;
drop policy if exists workspace_invites_api_read on public.workspace_invites;
create policy workspace_invites_api_read on public.workspace_invites for select to fenvix_api using (workspace_id = public.api_admin_workspace());
drop policy if exists workspace_invites_api_admin on public.workspace_invites;
create policy workspace_invites_api_admin on public.workspace_invites for insert to fenvix_api with check (workspace_id = public.api_admin_workspace());
drop policy if exists workspace_invites_api_revoke on public.workspace_invites;
create policy workspace_invites_api_revoke on public.workspace_invites for update to fenvix_api
  using (workspace_id = public.api_admin_workspace()) with check (workspace_id = public.api_admin_workspace());

-- The members of the API's organization with their e-mail and display name (auth.users is not readable otherwise).
create or replace function public.api_members()
returns table (user_id uuid, role text, joined_at timestamptz, email text, name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id, m.role, m.created_at, lower(u.email),
         coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(u.raw_user_meta_data ->> 'name'), ''), split_part(coalesce(u.email, ''), '@', 1))
  from public.workspace_members m join auth.users u on u.id = m.user_id
  where m.workspace_id = public.api_workspace()
  order by m.created_at, m.user_id
$$;

-- A new organization of the signed-in user, who becomes its owner. At most `p_max` memberships per user.
create or replace function public.api_create_organization(p_name text, p_max int)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid := public.api_user(); v_ws uuid;
begin
  if v_user is null then raise exception 'No user.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('api_create_organization:' || v_user::text));
  if (select count(*) from public.workspace_members where user_id = v_user) >= p_max then
    raise exception 'You are a member of % organizations, the most there can be. Leave one before creating another.', p_max using errcode = '23514';
  end if;
  insert into public.workspaces (name, name_confirmed) values (p_name, true) returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_user, 'owner');
  return v_ws;
end $$;

-- Accepts an invitation by its token hash for the signed-in user. Returns the organization and the role they have
-- there, or no row for every refusal (unknown, revoked, used, expired, another or an unverified e-mail): the API
-- answers all of them the same way.
create or replace function public.api_accept_invitation(p_hash text, p_max_members int)
returns table (workspace_id uuid, role text, already_member boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid := public.api_user(); v_inv record; v_email text; v_verified boolean; v_role text;
begin
  if v_user is null then return; end if;
  select i.* into v_inv from public.workspace_invites i where i.token_hash = p_hash for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.accepted_at is not null or v_inv.expires_at <= now() then return; end if;
  select lower(u.email), u.email_confirmed_at is not null into v_email, v_verified from auth.users u where u.id = v_user;
  if v_email is null or v_email <> v_inv.email or not v_verified then return; end if;
  perform 1 from public.workspaces w where w.id = v_inv.workspace_id for update;
  select m.role into v_role from public.workspace_members m where m.workspace_id = v_inv.workspace_id and m.user_id = v_user;
  if v_role is null then
    if (select count(*) from public.workspace_members m where m.workspace_id = v_inv.workspace_id) >= p_max_members then
      raise exception 'This organization already has % members. Ask an owner to make room.', p_max_members using errcode = '23514';
    end if;
    insert into public.workspace_members (workspace_id, user_id, role) values (v_inv.workspace_id, v_user, v_inv.role);
    update public.workspace_invites set accepted_at = now(), accepted_by = v_user where id = v_inv.id;
    return query select v_inv.workspace_id, v_inv.role::text, false;
  else
    update public.workspace_invites set accepted_at = now(), accepted_by = v_user where id = v_inv.id;
    return query select v_inv.workspace_id, v_role, true;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['api_members()', 'api_create_organization(text, int)', 'api_accept_invitation(text, int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_api', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- the CI and GitHub tables: members read

grant select on public.ci_plans, public.ci_reference_rates to fenvix_api;
drop policy if exists ci_plans_api on public.ci_plans;
create policy ci_plans_api on public.ci_plans for select to fenvix_api using (true);
drop policy if exists ci_reference_rates_api on public.ci_reference_rates;
create policy ci_reference_rates_api on public.ci_reference_rates for select to fenvix_api using (true);

do $$
declare t text;
begin
  foreach t in array array['ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results',
                           'ci_explorations', 'ci_audit_reruns', 'ci_usage_events', 'gh_installations', 'gh_repositories']
  loop
    execute format('grant select on public.%I to fenvix_api', t);
    execute format('drop policy if exists %I on public.%I', t || '_api_read', t);
    execute format('create policy %I on public.%I for select to fenvix_api using (workspace_id = public.api_workspace())', t || '_api_read', t);
  end loop;
end $$;

-- A project's settings: owner or admin, four columns only.
grant update (skip_with_proof, comment_on_pull_requests, nightly_exploration, test_command) on public.ci_projects to fenvix_api;
drop policy if exists ci_projects_api_admin on public.ci_projects;
create policy ci_projects_api_admin on public.ci_projects for update to fenvix_api
  using (workspace_id = public.api_admin_workspace()) with check (workspace_id = public.api_admin_workspace());

-- ================================================================ 7. the GitHub App writes the new data

grant select, insert, update on public.ci_defects, public.ci_explorations, public.ci_audit_reruns to fenvix_github_app;
grant select, insert, update on public.ci_test_results, public.ci_skip_receipts to fenvix_github_app;
grant select, insert, update on public.ci_subscriptions to fenvix_github_app;
grant select, insert, update on public.gh_run_results to fenvix_github_app;
do $$
declare t text;
begin
  foreach t in array array['ci_defects', 'ci_explorations', 'ci_audit_reruns', 'ci_test_results', 'ci_skip_receipts', 'ci_subscriptions']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_github_app', t);
    execute format('create policy %I on public.%I for all to fenvix_github_app using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace())', t || '_github_app', t);
  end loop;
end $$;
drop policy if exists gh_run_results_github_app on public.gh_run_results;
create policy gh_run_results_github_app on public.gh_run_results for all to fenvix_github_app using (true) with check (true);

-- The organization's region (placement of its machines) and whether it is in its trial: read for the organization of
-- the transaction only.
grant select (id, region) on public.workspaces to fenvix_github_app;
drop policy if exists workspaces_github_app on public.workspaces;
create policy workspaces_github_app on public.workspaces for select to fenvix_github_app using (id = public.cp_workspace());

-- Linking an installation (0013) now also starts the organization's 30-day shadow trial, once.
create or replace function public.gh_link_installation(p_installation bigint, p_workspace uuid, p_user uuid)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role text; v_current uuid; v_login text; v_deleted timestamptz;
begin
  select role into v_role from public.workspace_members where workspace_id = p_workspace and user_id = p_user;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin of the organization can connect a GitHub installation.' using errcode = '42501';
  end if;
  select workspace_id, account_login, deleted_at into v_current, v_login, v_deleted
    from public.gh_installations where installation_id = p_installation for update;
  if v_login is null then
    raise exception 'GitHub has not told us about installation % yet.', p_installation using errcode = 'P0002';
  end if;
  if v_deleted is not null then
    raise exception 'Installation % was removed on GitHub.', p_installation using errcode = '55000';
  end if;
  if v_current is not null and v_current <> p_workspace then
    raise exception 'Installation % is connected to another organization.', p_installation using errcode = '23505';
  end if;
  update public.gh_installations set workspace_id = p_workspace, linked_by = p_user, linked_at = now(), updated_at = now()
    where installation_id = p_installation;
  update public.gh_repositories set updated_at = now() where installation_id = p_installation;
  update public.ci_usage_events set workspace_id = p_workspace where installation_id = p_installation and workspace_id is null;
  insert into public.ci_subscriptions (workspace_id, plan_id, github_account, trial_started_at, trial_ends_at)
    values (p_workspace, 'starter', v_login, now(), now() + interval '30 days')
  on conflict (workspace_id) do update set
    github_account = coalesce(public.ci_subscriptions.github_account, excluded.github_account),
    trial_started_at = coalesce(public.ci_subscriptions.trial_started_at, excluded.trial_started_at),
    trial_ends_at = coalesce(public.ci_subscriptions.trial_ends_at, excluded.trial_ends_at),
    updated_at = now();
  return v_login;
end $$;
revoke all on function public.gh_link_installation(bigint, uuid, uuid) from public, anon, authenticated;
grant execute on function public.gh_link_installation(bigint, uuid, uuid) to fenvix_github_app;

-- ci_workspace_from_parent() reads the run for ci_audit_reruns (as for receipts and test results): nothing to change.

notify pgrst, 'reload schema';
