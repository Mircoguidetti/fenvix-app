-- fenvix CI dashboard: projects, runs, per-test outcomes, skip receipts, defects, plans (docs/data-contract.md).
-- Safe to run more than once. Run it AFTER 0001_init.sql, 0002_control_plane.sql and 0008_organizations.sql: it
-- reuses their organizations (public.workspaces, workspace_members, my_workspace_ids(), my_admin_workspace_ids()) and
-- the control plane's role (fenvix_control_plane, cp_workspace()). It changes none of their tables.
--
-- Who may do what:
--   * every member of an organization reads its rows; nobody reads another organization's rows;
--   * a signed-in owner or admin may change a project's settings (four columns), nothing else;
--   * runs, test outcomes, receipts and defects are written only by the control plane (fed by the fenvix runner),
--     always for the one organization it acts for in the transaction (app.workspace_id);
--   * plans and reference rates are public configuration: readable by any signed-in user, written by nobody here.
--   * A child row always carries its parent's organization (triggers), so no row can point across organizations.

-- ---------------------------------------------------------------- configuration

create table if not exists public.ci_plans (
  id text primary key check (id ~ '^[a-z0-9-]{2,32}$'),
  name text not null,
  description text not null default '',
  -- null: no limit.
  runs_per_month int check (runs_per_month is null or runs_per_month > 0),
  max_projects int check (max_projects is null or max_projects > 0),
  -- null: the price is not set yet (the founder sets prices after the pricing study).
  price_usd_month numeric(10, 2) check (price_usd_month is null or price_usd_month >= 0),
  features text[] not null default '{}',
  sort int not null default 0
);

create table if not exists public.ci_reference_rates (
  key text primary key,
  usd_per_minute numeric(10, 5) not null check (usd_per_minute >= 0),
  runner text not null,
  source text not null,
  checked_on date not null
);

-- Plans with no prices (null), like control-plane/config/plans.json. Re-running keeps prices someone has set since.
insert into public.ci_plans (id, name, description, runs_per_month, max_projects, price_usd_month, features, sort) values
  ('starter', 'Starter', 'One project with a steady flow of pull requests.', 500, 1, null, array['Skip with proof', 'Flaky tests turned into defects', 'Pull request comments'], 1),
  ('team', 'Team', 'A few projects, a team pushing every day.', 2000, 5, null, array['Everything in Starter', 'Nightly exploration', 'Members and roles'], 2),
  ('scale', 'Scale', 'Many projects or a large monorepo.', 10000, 25, null, array['Everything in Team', 'Priority machines', 'Audit log'], 3),
  ('enterprise', 'Enterprise', 'Your own limits, agreed with us.', null, null, null, array['Everything in Scale', 'Single sign-on', 'Agreed response time'], 4)
on conflict (id) do update set name = excluded.name, description = excluded.description, runs_per_month = excluded.runs_per_month,
  max_projects = excluded.max_projects, features = excluded.features, sort = excluded.sort;

-- DECLARED by GitHub's Actions pricing page as quoted in fenvix-brain-cli PRODUCT.md (about $8 per 1,000 minutes).
-- To verify before a customer sees it.
insert into public.ci_reference_rates (key, usd_per_minute, runner, source, checked_on) values
  ('github-linux-2core', 0.008, 'GitHub-hosted Linux, 2 cores', 'GitHub Actions pricing page, as quoted in PRODUCT.md (to verify)', date '2026-11-16')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- per organization

create table if not exists public.ci_subscriptions (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  plan_id text not null references public.ci_plans (id),
  github_account text,
  updated_at timestamptz not null default now()
);

create table if not exists public.ci_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  full_name text not null check (full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  language text not null check (language in ('python', 'node', 'go')),
  test_runner text not null check (test_runner in ('pytest', 'vitest', 'jest', 'go test')),
  default_branch text not null default 'main',
  installation_id bigint not null,
  setup_state text not null default 'app_installed' check (setup_state in ('app_installed', 'pr_open', 'active')),
  setup_pr_number int,
  setup_pr_url text check (setup_pr_url is null or setup_pr_url ~ '^https://github\.com/'),
  setup_pr_state text check (setup_pr_state is null or setup_pr_state in ('open', 'merged', 'closed')),
  connected_at timestamptz not null default now(),
  -- "Before fenvix", measured from the repository's GitHub Actions history when it was connected.
  baseline_median_ttg_s numeric(10, 1),
  baseline_median_job_minutes numeric(10, 2),
  baseline_runs_sampled int,
  baseline_from date,
  baseline_to date,
  -- The settings a signed-in owner or admin may change.
  skip_with_proof boolean not null default true,
  comment_on_pull_requests boolean not null default true,
  nightly_exploration boolean not null default false,
  test_command text not null default '' check (char_length(test_command) <= 500),
  unique (workspace_id, full_name)
);

create table if not exists public.ci_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.ci_projects (id) on delete cascade,
  number int not null check (number > 0),
  engine_run_id text,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  commit_message text not null default '',
  branch text not null,
  pull_request int,
  trigger text not null check (trigger in ('push', 'pull_request', 'merge_group', 'schedule', 'workflow_dispatch')),
  status text not null check (status in ('running', 'passed', 'failed', 'cancelled')),
  pushed_at timestamptz not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  tests_total int not null default 0,
  tests_ran int not null default 0,
  tests_passed int not null default 0,
  tests_failed int not null default 0,
  tests_skipped int not null default 0,
  tests_flaky_defects int not null default 0,
  test_time_ran_ms bigint not null default 0 check (test_time_ran_ms >= 0),
  test_time_skipped_ms bigint not null default 0 check (test_time_skipped_ms >= 0),
  -- The job's other steps that still run on fenvix: checkout, dependency install, build.
  other_step_minutes numeric(10, 2) not null default 0 check (other_step_minutes >= 0),
  engine_version text not null default '',
  seed bigint,
  skip_share numeric generated always as (
    case when test_time_ran_ms + test_time_skipped_ms = 0 then 0
         else round(test_time_skipped_ms::numeric / (test_time_ran_ms + test_time_skipped_ms), 4) end) stored,
  -- Test minutes skipped with proof only: fenvix skips no other step.
  minutes_saved numeric generated always as (round(test_time_skipped_ms / 60000.0, 2)) stored,
  -- The same job on a GitHub-hosted runner: tests run + tests skipped with proof + other steps.
  github_equivalent_minutes numeric generated always as (round((test_time_ran_ms + test_time_skipped_ms) / 60000.0 + other_step_minutes, 2)) stored,
  check (tests_ran + tests_skipped = tests_total),
  check (tests_flaky_defects <= tests_failed),
  unique (project_id, number)
);
create index if not exists ci_runs_ws_started on public.ci_runs (workspace_id, started_at desc);
create index if not exists ci_runs_project_started on public.ci_runs (project_id, started_at desc);

create table if not exists public.ci_defects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.ci_projects (id) on delete cascade,
  test_id text not null,
  status text not null check (status in ('reproduced', 'replay_unstable')),
  state text not null default 'open' check (state in ('open', 'fixed')),
  cause text not null check (cause in ('polluter', 'state_setter', 'fails_alone')),
  cause_tests text[] not null default '{}',
  minimal_order text[] not null check (cardinality(minimal_order) >= 1),
  prefix_length int not null default 0,
  seed bigint,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  replay_runs int not null default 10,
  replay_fails int not null default 10,
  identical_fingerprint boolean not null default true,
  outcome text not null default 'failed',
  exception jsonb not null default '{}'::jsonb,
  divergence jsonb,
  family_key text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  first_run_id uuid references public.ci_runs (id) on delete set null,
  last_run_id uuid references public.ci_runs (id) on delete set null,
  occurrences int not null default 1,
  engine_version text not null default '',
  language text not null check (language in ('python', 'node')),
  unique (project_id, test_id, fingerprint)
);
create index if not exists ci_defects_ws_seen on public.ci_defects (workspace_id, last_seen_at desc);

create table if not exists public.ci_skip_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.ci_runs (id) on delete cascade,
  test_id text not null,
  cache_key text not null check (cache_key ~ '^[0-9a-f]{32}$'),
  reused_run_id uuid references public.ci_runs (id) on delete set null,
  reused_engine_run_id text not null,
  reused_outcome text not null default 'passed' check (reused_outcome = 'passed'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  reused_duration_ms bigint not null default 0,
  code jsonb not null default '[]'::jsonb,
  modules jsonb not null default '[]'::jsonb,
  files_read jsonb not null default '[]'::jsonb,
  env_read jsonb not null default '[]'::jsonb,
  runtime jsonb not null default '{}'::jsonb,
  config jsonb not null default '{}'::jsonb,
  changed_files_proven int not null default 0,
  unique (run_id, test_id)
);

create table if not exists public.ci_test_results (
  run_id uuid not null references public.ci_runs (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  test_id text not null,
  outcome text not null check (outcome in ('passed', 'failed', 'skipped_with_proof')),
  duration_ms bigint not null default 0,
  failure_kind text check (failure_kind is null or failure_kind in ('real', 'flaky_defect')),
  failure_phase text,
  exception_type text,
  failure_message text,
  failure_location text,
  defect_id uuid references public.ci_defects (id) on delete set null,
  receipt_id uuid references public.ci_skip_receipts (id) on delete set null,
  primary key (run_id, test_id),
  check ((outcome = 'failed') = (failure_kind is not null)),
  check (outcome <> 'skipped_with_proof' or receipt_id is not null)
);
create index if not exists ci_test_results_run_outcome on public.ci_test_results (run_id, outcome);

-- ---------------------------------------------------------------- a child row carries its parent's organization

create or replace function public.ci_workspace_from_parent() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  if tg_table_name in ('ci_runs', 'ci_defects') then
    select workspace_id into v_ws from public.ci_projects where id = new.project_id;
  else
    select workspace_id into v_ws from public.ci_runs where id = new.run_id;
  end if;
  if v_ws is null then
    raise exception 'The parent row of this % does not exist.', tg_table_name using errcode = '23503';
  end if;
  new.workspace_id := v_ws;
  return new;
end $$;
revoke all on function public.ci_workspace_from_parent() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_workspace', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.ci_workspace_from_parent()', t || '_workspace', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- row level security

do $$
declare t text;
begin
  foreach t in array array['ci_plans', 'ci_reference_rates', 'ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Configuration: any signed-in user reads it.
grant select on public.ci_plans, public.ci_reference_rates to authenticated;
drop policy if exists ci_plans_read on public.ci_plans;
create policy ci_plans_read on public.ci_plans for select to authenticated using (true);
drop policy if exists ci_reference_rates_read on public.ci_reference_rates;
create policy ci_reference_rates_read on public.ci_reference_rates for select to authenticated using (true);

-- Organization data: members read, nobody else.
do $$
declare t text;
begin
  foreach t in array array['ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results']
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (workspace_id in (select public.my_workspace_ids()))', t || '_member_read', t);
  end loop;
end $$;

-- A project's settings: owner or admin, four columns only.
grant update (skip_with_proof, comment_on_pull_requests, nightly_exploration, test_command) on public.ci_projects to authenticated;
drop policy if exists ci_projects_admin_settings on public.ci_projects;
create policy ci_projects_admin_settings on public.ci_projects for update to authenticated
  using (workspace_id in (select public.my_admin_workspace_ids()))
  with check (workspace_id in (select public.my_admin_workspace_ids()));

-- ---------------------------------------------------------------- the control plane (fed by the runner)

grant select on public.ci_plans, public.ci_reference_rates to fenvix_control_plane;
grant select, insert, update on public.ci_subscriptions, public.ci_projects, public.ci_runs, public.ci_defects to fenvix_control_plane;
grant select, insert on public.ci_skip_receipts, public.ci_test_results to fenvix_control_plane;
grant delete on public.ci_projects to fenvix_control_plane;

drop policy if exists ci_plans_control_plane on public.ci_plans;
create policy ci_plans_control_plane on public.ci_plans for select to fenvix_control_plane using (true);
drop policy if exists ci_reference_rates_control_plane on public.ci_reference_rates;
create policy ci_reference_rates_control_plane on public.ci_reference_rates for select to fenvix_control_plane using (true);

do $$
declare t text;
begin
  foreach t in array array['ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_control_plane', t);
    execute format(
      'create policy %I on public.%I for all to fenvix_control_plane using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace())',
      t || '_control_plane', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
