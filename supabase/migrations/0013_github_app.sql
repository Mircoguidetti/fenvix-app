-- fenvix GitHub App (github-app/, docs/GITHUB-APP.md): installations stored per organization, the repositories they
-- give access to and their onboarding pull request, the fenvix jobs seen on GitHub, the run summaries the runner sends,
-- and one usage event per run for per-run billing. Safe to run more than once. Run it AFTER 0001, 0002, 0008, 0011 and
-- 0012: it reuses their organizations (public.workspaces, workspace_members, my_workspace_ids()), cp_workspace() and the
-- CI tables (ci_projects, ci_runs, ci_subscriptions).
--
-- Who may do what:
--   * the GitHub App backend connects as the restricted role fenvix_github_app (created below, no password here, no
--     BYPASSRLS). Its own tables (gh_*) hold what GitHub told it, keyed by GitHub ids; it reads and writes them all.
--     The CI tables it writes (ci_projects, ci_runs, ci_usage_events) are reached only for the one organization it acts
--     for in the transaction (app.workspace_id), like the control plane;
--   * an installation becomes an organization's only through gh_link_installation(), which checks that the signed-in
--     user is an owner or admin of that organization; the backend calls it after GitHub confirmed (OAuth) that the
--     same person can see the installation;
--   * members of an organization read its installations, repositories and usage events; nobody else does. The
--     dashboard writes none of them.

-- ---------------------------------------------------------------- the role

do $$ begin
  create role fenvix_github_app login;
exception when duplicate_object then null; end $$;

do $$ begin
  alter role fenvix_github_app nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception when insufficient_privilege then
  raise notice 'Could not reset the attributes of fenvix_github_app. Check with: select rolsuper, rolbypassrls from pg_roles where rolname = ''fenvix_github_app'' (both must be false).';
end $$;

grant usage on schema public to fenvix_github_app;
grant execute on function public.cp_workspace() to fenvix_github_app;

-- ---------------------------------------------------------------- what GitHub told us

-- One installation of the App on a GitHub user or organization account. workspace_id stays null until a signed-in
-- owner or admin links it (gh_link_installation).
create table if not exists public.gh_installations (
  installation_id bigint primary key check (installation_id > 0),
  workspace_id uuid references public.workspaces (id) on delete set null,
  account_id bigint not null,
  account_login text not null check (account_login ~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$'),
  account_type text not null check (account_type in ('User', 'Organization', 'Enterprise')),
  repository_selection text not null default 'selected' check (repository_selection in ('all', 'selected')),
  permissions jsonb not null default '{}'::jsonb,
  events text[] not null default '{}',
  suspended_at timestamptz,
  deleted_at timestamptz,
  linked_by uuid,
  linked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists gh_installations_ws on public.gh_installations (workspace_id);

-- A repository an installation gives access to, with the state of its onboarding pull request.
create table if not exists public.gh_repositories (
  repository_id bigint primary key check (repository_id > 0),
  installation_id bigint not null references public.gh_installations (installation_id) on delete cascade,
  -- Always the installation's organization (trigger below), whatever the writer says.
  workspace_id uuid references public.workspaces (id) on delete set null,
  full_name text not null check (full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  private boolean not null default true,
  default_branch text,
  removed_at timestamptz,
  project_id uuid references public.ci_projects (id) on delete set null,
  -- pending: not tried yet; pr_open / merged / closed: the onboarding pull request; the others say why none was opened.
  onboarding_state text not null default 'pending' check (onboarding_state in
    ('pending', 'pr_open', 'merged', 'closed', 'no_workflow', 'no_test_job', 'already_fenvix', 'unsupported', 'failed')),
  onboarding_detail text not null default '' check (char_length(onboarding_detail) <= 1000),
  onboarding_workflow_path text,
  onboarding_job text,
  setup_pr_number int,
  setup_pr_url text check (setup_pr_url is null or setup_pr_url ~ '^https://'),
  detected_language text check (detected_language is null or detected_language in ('python', 'node', 'go')),
  detected_test_runner text check (detected_test_runner is null or detected_test_runner in ('pytest', 'vitest', 'jest', 'go test')),
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists gh_repositories_installation on public.gh_repositories (installation_id);
create index if not exists gh_repositories_ws on public.gh_repositories (workspace_id);

-- Pull requests the App saw (pull_request events), so a run finds its pull request without an API call, and the id of
-- the one fenvix comment on each pull request (updated in place on every run).
create table if not exists public.gh_pull_requests (
  repository_id bigint not null references public.gh_repositories (repository_id) on delete cascade,
  number int not null check (number > 0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  head_ref text not null,
  base_ref text not null,
  state text not null check (state in ('open', 'closed', 'merged')),
  fenvix_comment_id bigint,
  updated_at timestamptz not null default now(),
  primary key (repository_id, number)
);
create index if not exists gh_pull_requests_head on public.gh_pull_requests (repository_id, head_sha);

-- When a commit reached GitHub (push events): a run's pushed_at, for time to green.
create table if not exists public.gh_pushes (
  repository_id bigint not null references public.gh_repositories (repository_id) on delete cascade,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  ref text not null,
  pushed_at timestamptz not null,
  primary key (repository_id, sha)
);

-- Every GitHub Actions job that asked for a fenvix machine (workflow_job events whose labels include fenvix).
create table if not exists public.gh_jobs (
  job_id bigint primary key check (job_id > 0),
  repository_id bigint not null references public.gh_repositories (repository_id) on delete cascade,
  installation_id bigint not null references public.gh_installations (installation_id) on delete cascade,
  run_id bigint not null,
  run_attempt int not null default 1,
  workflow_name text not null default '',
  job_name text not null default '',
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  head_branch text,
  labels text[] not null default '{}',
  runner_name text,
  status text not null check (status in ('queued', 'waiting', 'in_progress', 'completed')),
  conclusion text,
  created_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  check_run_id bigint,
  ci_run_id uuid references public.ci_runs (id) on delete set null,
  published_at timestamptz,
  publish_attempts int not null default 0,
  publish_error text,
  updated_at timestamptz not null default now()
);
create index if not exists gh_jobs_match on public.gh_jobs (repository_id, run_id, run_attempt, runner_name);

-- The summary the runner wrote for a job (runner/fenvix-run summary.json), sent by our machine when the job's test step
-- ends. A runner runs one job at a time, so (repository, run, attempt, runner) names one job.
create table if not exists public.gh_run_summaries (
  id bigint generated always as identity primary key,
  repository_id bigint not null,
  run_id bigint not null,
  run_attempt int not null default 1,
  runner_name text not null,
  summary jsonb not null,
  receipts_url text check (receipts_url is null or receipts_url ~ '^https://'),
  received_at timestamptz not null default now(),
  unique (repository_id, run_id, run_attempt, runner_name)
);

-- Every webhook delivery, once: GitHub may deliver the same one again (X-GitHub-Delivery).
create table if not exists public.gh_webhook_deliveries (
  delivery_id text primary key check (char_length(delivery_id) between 1 and 100),
  event text not null,
  action text,
  installation_id bigint,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

-- ---------------------------------------------------------------- usage events (per-run billing)

-- One event per fenvix job that ran on our machines. Written by the GitHub App when the job ends; billing counts the
-- billable events of a month. Unique per GitHub job, so a webhook delivered twice is never billed twice. workspace_id
-- is the installation's organization (trigger), null while the installation is not linked; linking fills it.
create table if not exists public.ci_usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,
  installation_id bigint not null references public.gh_installations (installation_id),
  repository_id bigint not null,
  repository_full_name text not null,
  project_id uuid references public.ci_projects (id) on delete set null,
  ci_run_id uuid references public.ci_runs (id) on delete set null,
  github_job_id bigint not null unique,
  github_run_id bigint not null,
  github_run_attempt int not null default 1,
  kind text not null default 'ci_run' check (kind in ('ci_run')),
  quantity int not null default 1 check (quantity >= 0),
  billable boolean not null,
  -- Why the event is (not) billable: completed, failed, cancelled_after_start, cancelled_before_tests, no_summary.
  reason text not null,
  plan_id text references public.ci_plans (id),
  conclusion text,
  test_minutes_ran numeric(12, 2) not null default 0 check (test_minutes_ran >= 0),
  minutes_saved numeric(12, 2) not null default 0 check (minutes_saved >= 0),
  other_step_minutes numeric(12, 2) not null default 0 check (other_step_minutes >= 0),
  occurred_at timestamptz not null,
  month date generated always as (date_trunc('month', occurred_at at time zone 'UTC')::date) stored,
  created_at timestamptz not null default now()
);
create index if not exists ci_usage_events_ws_month on public.ci_usage_events (workspace_id, month);
create index if not exists ci_usage_events_installation on public.ci_usage_events (installation_id) where workspace_id is null;

-- ---------------------------------------------------------------- a row carries its installation's organization

create or replace function public.gh_workspace_from_installation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid; v_found boolean;
begin
  select workspace_id, true into v_ws, v_found from public.gh_installations where installation_id = new.installation_id;
  if v_found is null then
    raise exception 'The installation of this % does not exist.', tg_table_name using errcode = '23503';
  end if;
  new.workspace_id := v_ws;
  return new;
end $$;
revoke all on function public.gh_workspace_from_installation() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['gh_repositories', 'ci_usage_events']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_workspace', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.gh_workspace_from_installation()', t || '_workspace', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- linking an installation to an organization

-- The one way an installation becomes an organization's. Called by the GitHub App backend after GitHub confirmed (user
-- OAuth, GET /user/installations) that the person can see the installation. Checks here: the person is an owner or
-- admin of the organization, and the installation is not already another organization's. Then the installation, its
-- repositories and its usage events so far take the organization, and the organization's subscription (if any) records
-- the GitHub account. Returns the account login.
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
  -- The triggers copy the installation's (new) organization.
  update public.gh_repositories set updated_at = now() where installation_id = p_installation;
  update public.ci_usage_events set workspace_id = p_workspace where installation_id = p_installation and workspace_id is null;
  update public.ci_subscriptions set github_account = v_login, updated_at = now() where workspace_id = p_workspace;
  return v_login;
end $$;
revoke all on function public.gh_link_installation(bigint, uuid, uuid) from public, anon, authenticated;
grant execute on function public.gh_link_installation(bigint, uuid, uuid) to fenvix_github_app;

-- Whether a person is an owner or admin of an organization: the App asks before it opens an onboarding pull request
-- on a dashboard user's request. Nothing else about the organization is visible to the App.
create or replace function public.gh_is_admin(p_workspace uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.workspace_members where workspace_id = p_workspace and user_id = p_user and role in ('owner', 'admin'))
$$;
revoke all on function public.gh_is_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gh_is_admin(uuid, uuid) to fenvix_github_app;

-- ---------------------------------------------------------------- row level security

do $$
declare t text;
begin
  foreach t in array array['gh_installations', 'gh_repositories', 'gh_pull_requests', 'gh_pushes', 'gh_jobs',
                           'gh_run_summaries', 'gh_webhook_deliveries', 'ci_usage_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Members read their organization's installations, repositories and usage events.
do $$
declare t text;
begin
  foreach t in array array['gh_installations', 'gh_repositories', 'ci_usage_events']
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (workspace_id in (select public.my_workspace_ids()))', t || '_member_read', t);
  end loop;
end $$;

-- The GitHub App: its own tables, every row (they are keyed by GitHub ids from verified webhooks).
grant select, insert, update on public.gh_installations, public.gh_repositories, public.gh_pull_requests, public.gh_pushes,
  public.gh_jobs, public.gh_run_summaries, public.gh_webhook_deliveries to fenvix_github_app;
grant delete on public.gh_webhook_deliveries to fenvix_github_app;
do $$
declare t text;
begin
  foreach t in array array['gh_installations', 'gh_repositories', 'gh_pull_requests', 'gh_pushes', 'gh_jobs',
                           'gh_run_summaries', 'gh_webhook_deliveries']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_github_app', t);
    execute format('create policy %I on public.%I for all to fenvix_github_app using (true) with check (true)', t || '_github_app', t);
  end loop;
end $$;

-- The GitHub App on the CI tables: only the organization of the transaction. Usage events of a not-yet-linked
-- installation (workspace_id null) are written in a transaction with no organization.
grant select on public.ci_plans to fenvix_github_app;
drop policy if exists ci_plans_github_app on public.ci_plans;
create policy ci_plans_github_app on public.ci_plans for select to fenvix_github_app using (true);

grant select on public.ci_subscriptions to fenvix_github_app;
grant select, insert, update on public.ci_projects, public.ci_runs to fenvix_github_app;
grant select, insert, update on public.ci_usage_events to fenvix_github_app;
do $$
declare t text;
begin
  foreach t in array array['ci_subscriptions', 'ci_projects', 'ci_runs']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_github_app', t);
    execute format('create policy %I on public.%I for all to fenvix_github_app using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace())', t || '_github_app', t);
  end loop;
end $$;
drop policy if exists ci_usage_events_github_app on public.ci_usage_events;
create policy ci_usage_events_github_app on public.ci_usage_events for all to fenvix_github_app
  using (workspace_id is not distinct from public.cp_workspace()) with check (workspace_id is not distinct from public.cp_workspace());

notify pgrst, 'reload schema';
