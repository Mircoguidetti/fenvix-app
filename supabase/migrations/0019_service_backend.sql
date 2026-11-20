-- fenvix: the service back-end of Passo 3 (P-048, docs/REPORT-service-backend.md). Safe to run more than once. Run it
-- AFTER 0017 (and 0018, P-047's machines, where it exists).
--
--  1. Defects: ONE defect per flaky test of a project (G-1701, G-1808), whatever its fingerprint, the engine version or
--     the order; every sighting is kept in ci_defect_occurrences (run, commit, branch, pull request, fingerprint, first
--     divergent event: G-1702, G-0611, G-0626). A flaky test the summary reports without a bundle is a defect too
--     (status 'reported', G-0184). More causes than order dependence (G-0633). A defect can be fixed, muted or reopened
--     (G-1625, G-1809).
--  2. Replay bundles in Postgres, under row level security (G-0622, G-0627, G-1777).
--  3. Replays on our machines (ci_replays), live run control (cancel), API keys per organization (G-0569, G-0628).
--  4. Exploration jobs and the project's exploration settings (G-0597, G-0630, G-1720, G-1721, G-1722).
--  5. Tenant anchoring on the writer path (G-1814): a project always belongs to the organization its installation is
--     linked to; a child row always to its parent's organization.
--  6. Deleting: an organization (G-0634), a project (G-1810), one's own account (G-1626), an orphan organization goes
--     with its last member (G-1811), unlinking an installation (G-1700), the purge after an uninstall and the retention
--     of customer-facing tables (G-1699, G-1812, G-1816, G-2309, G-2337); usage events survive both (G-1813).
--  7. Smaller ones: no empty organization for an invited sign-up (G-2340), foreign keys to auth.users (G-2339), indexes
--     (G-2338), default privileges of anon/authenticated (G-2342), the 'other' trigger (G-2343), the skip pause after a
--     wrong skip (G-1757).

-- ================================================================ 1. defects

-- More causes than order dependence (the divergent event's kind), and 'unknown' for a flaky test the summary reported
-- before any bundle (it failed in the suite and passed alone; nothing says why yet).
alter table public.ci_defects drop constraint if exists ci_defects_cause_check;
alter table public.ci_defects add constraint ci_defects_cause_check check (cause in
  ('polluter', 'state_setter', 'fails_alone', 'async_order', 'thread', 'clock', 'random', 'network', 'filesystem', 'environment', 'unknown'));
alter table public.ci_defects drop constraint if exists ci_defects_status_check;
alter table public.ci_defects add constraint ci_defects_status_check check (status in ('reproduced', 'replay_unstable', 'reported'));
alter table public.ci_defects drop constraint if exists ci_defects_state_check;
alter table public.ci_defects add constraint ci_defects_state_check check (state in ('open', 'fixed', 'muted'));
-- A reported defect has no bundle yet, so no fingerprint.
alter table public.ci_defects alter column fingerprint drop not null;
alter table public.ci_defects drop constraint if exists ci_defects_fingerprint_check;
alter table public.ci_defects add constraint ci_defects_fingerprint_check check (fingerprint is null or fingerprint ~ '^[0-9a-f]{32}$');
alter table public.ci_defects add column if not exists state_changed_at timestamptz;
alter table public.ci_defects add column if not exists state_changed_by uuid references auth.users (id) on delete set null;
alter table public.ci_defects add column if not exists state_reason text check (state_reason is null or char_length(state_reason) <= 500);
alter table public.ci_defects add column if not exists fixed_commit_sha text check (fixed_commit_sha is null or fixed_commit_sha ~ '^[0-9a-f]{40}$');
-- The newest bundle the runner uploaded, and the newest replay on our machines.
alter table public.ci_defects add column if not exists bundle_id uuid;
alter table public.ci_defects add column if not exists last_replay_id uuid;
-- Set by Passo 3's culprit and dependency verdicts when the engine delivers them; the comment and the API show them.
alter table public.ci_defects add column if not exists culprit jsonb;
alter table public.ci_defects add column if not exists dependency_verdict jsonb;

-- One defect per test of a project: duplicates of the old key (test, fingerprint) are merged into the newest row.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'ci_defects_project_id_test_id_fingerprint_key') then
    with ranked as (
      select id, project_id, test_id, row_number() over (partition by project_id, test_id order by last_seen_at desc, id) as rk,
             sum(occurrences) over (partition by project_id, test_id) as occ, min(first_seen_at) over (partition by project_id, test_id) as first
        from public.ci_defects)
    update public.ci_defects d set occurrences = r.occ, first_seen_at = r.first from ranked r where r.id = d.id and r.rk = 1;
    update public.ci_test_results t set defect_id = keep.id
      from public.ci_defects old, public.ci_defects keep
     where t.defect_id = old.id and keep.project_id = old.project_id and keep.test_id = old.test_id and keep.id <> old.id
       and keep.id = (select k.id from public.ci_defects k where k.project_id = old.project_id and k.test_id = old.test_id order by k.last_seen_at desc, k.id limit 1);
    delete from public.ci_defects d where d.id <> (select k.id from public.ci_defects k where k.project_id = d.project_id and k.test_id = d.test_id order by k.last_seen_at desc, k.id limit 1);
    alter table public.ci_defects drop constraint ci_defects_project_id_test_id_fingerprint_key;
  end if;
end $$;
create unique index if not exists ci_defects_project_test on public.ci_defects (project_id, test_id);
create index if not exists ci_defects_project_family on public.ci_defects (project_id, family_key);

-- Every sighting of a defect: a run (with its commit, branch and pull request) or an exploration, with the fingerprint
-- and the first divergent event the engine named that time. "The same failure seen in many pull requests" is a query
-- over this table; a changed fingerprint is kept, not a new defect.
create table if not exists public.ci_defect_occurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  defect_id uuid not null references public.ci_defects (id) on delete cascade,
  run_id uuid references public.ci_runs (id) on delete cascade,
  exploration_id uuid references public.ci_explorations (id) on delete cascade,
  source text not null check (source in ('run', 'exploration')),
  commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
  branch text,
  pull_request int,
  fingerprint text check (fingerprint is null or fingerprint ~ '^[0-9a-f]{32}$'),
  -- The fingerprint differs from the defect's previous sighting with one (the service compares them, G-1749).
  fingerprint_changed boolean not null default false,
  divergence jsonb,
  seed bigint,
  engine_version text not null default '',
  status text not null check (status in ('reproduced', 'replay_unstable', 'reported')),
  seen_at timestamptz not null,
  check ((source = 'run') = (run_id is not null) and (source = 'exploration') = (exploration_id is not null))
);
create unique index if not exists ci_defect_occurrences_run on public.ci_defect_occurrences (defect_id, run_id) where run_id is not null;
create unique index if not exists ci_defect_occurrences_exploration on public.ci_defect_occurrences (defect_id, exploration_id) where exploration_id is not null;
create index if not exists ci_defect_occurrences_defect_seen on public.ci_defect_occurrences (defect_id, seen_at desc);
create index if not exists ci_defect_occurrences_ws on public.ci_defect_occurrences (workspace_id);
create index if not exists ci_defect_occurrences_run_id on public.ci_defect_occurrences (run_id);

-- ================================================================ 2. replay bundles

-- The engine's bundle of a defect (bundle.json, order.txt, cassettes: a .tar.gz the runner uploads), kept in Postgres
-- under row level security, at most 8 MB each, at most one per defect and digest. Served to members and API keys.
create table if not exists public.ci_defect_bundles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  defect_id uuid not null references public.ci_defects (id) on delete cascade,
  run_id uuid references public.ci_runs (id) on delete set null,
  fingerprint text check (fingerprint is null or fingerprint ~ '^[0-9a-f]{32}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes int not null check (size_bytes between 1 and 8388608),
  content bytea not null,
  received_at timestamptz not null default now(),
  check (octet_length(content) = size_bytes),
  unique (defect_id, sha256)
);
create index if not exists ci_defect_bundles_defect on public.ci_defect_bundles (defect_id, received_at desc);
create index if not exists ci_defect_bundles_ws on public.ci_defect_bundles (workspace_id);
do $$ begin
  alter table public.ci_defects add constraint ci_defects_bundle_fk foreign key (bundle_id) references public.ci_defect_bundles (id) on delete set null;
exception when duplicate_object then null; end $$;

-- ================================================================ 3. replays, run control, API keys

-- A replay of one defect (or one test of a run) on our machines: `fenvix replay` of its bundle at a commit, dispatched by
-- the App's worker to the machine fleet; the machine reports the result (POST /v1/runner/replays).
create table if not exists public.ci_replays (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.ci_projects (id) on delete cascade,
  defect_id uuid references public.ci_defects (id) on delete cascade,
  run_id uuid references public.ci_runs (id) on delete set null,
  test_id text not null check (char_length(test_id) between 1 and 2000),
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  requested_via text not null check (requested_via in ('dashboard', 'api_key', 'mcp', 'pull_request')),
  requested_by uuid references auth.users (id) on delete set null,
  api_key_id uuid,
  status text not null default 'requested' check (status in ('requested', 'dispatched', 'running', 'passed', 'failed', 'error', 'cancelled')),
  detail text not null default '' check (char_length(detail) <= 2000),
  runs int check (runs is null or runs >= 0),
  fails int check (fails is null or fails >= 0),
  fingerprint text check (fingerprint is null or fingerprint ~ '^[0-9a-f]{32}$'),
  identical_fingerprint boolean,
  command text check (command is null or char_length(command) <= 4000),
  runner_name text,
  region text check (region is null or region in ('us', 'eu')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
);
-- One replay in flight per defect (or per run and test).
create unique index if not exists ci_replays_one_active_defect on public.ci_replays (defect_id)
  where defect_id is not null and status in ('requested', 'dispatched', 'running');
create unique index if not exists ci_replays_one_active_test on public.ci_replays (run_id, test_id)
  where defect_id is null and status in ('requested', 'dispatched', 'running');
create index if not exists ci_replays_pending on public.ci_replays (status, created_at) where status in ('requested', 'dispatched', 'running');
create index if not exists ci_replays_defect on public.ci_replays (defect_id, created_at desc);
create index if not exists ci_replays_ws on public.ci_replays (workspace_id);
do $$ begin
  alter table public.ci_defects add constraint ci_defects_last_replay_fk foreign key (last_replay_id) references public.ci_replays (id) on delete set null;
exception when duplicate_object then null; end $$;

-- Stopping a running run from the dashboard (the App's worker cancels the GitHub job and ends our machine).
-- POST /v1/runs/{id}/stop (P-049's live view): now, or armed until the first failed test; requested once sent to the
-- machines; done when GitHub reports the job cancelled; failed with why.
alter table public.ci_runs add column if not exists stop_when text check (stop_when is null or stop_when in ('now', 'first_failure'));
alter table public.ci_runs add column if not exists stop_state text check (stop_state is null or stop_state in ('armed', 'requested', 'done', 'failed'));
alter table public.ci_runs add column if not exists stop_requested_at timestamptz;
-- When the App last sent the stop (GitHub cancel, machine ended): the sweep sends it again only 2 minutes later.
alter table public.ci_runs add column if not exists stop_sent_at timestamptz;
alter table public.ci_runs add column if not exists stop_requested_by uuid references auth.users (id) on delete set null;
alter table public.ci_runs add column if not exists stop_detail text not null default '' check (char_length(stop_detail) <= 500);
-- The GitHub job behind the run (a matrix or several test jobs give several runs of one commit).
alter table public.ci_runs add column if not exists github_run_id bigint;
alter table public.ci_runs add column if not exists github_job_id bigint;
alter table public.ci_runs add column if not exists job_workflow text;
alter table public.ci_runs add column if not exists job_name text;
update public.ci_runs r set github_run_id = j.run_id, github_job_id = j.job_id, job_workflow = j.workflow_name, job_name = j.job_name
  from public.gh_jobs j where j.ci_run_id = r.id and r.github_job_id is null;
-- The live view's per-test rows (runner progress `finished`): the worker, the order they finished, when; the test's
-- output (the runner's capture, at most 64 KB) for the coding agent's get_test_log.
alter table public.ci_test_results add column if not exists worker text check (worker is null or char_length(worker) <= 100);
alter table public.ci_test_results add column if not exists seq int;
alter table public.ci_test_results add column if not exists finished_at timestamptz;
alter table public.ci_test_results add column if not exists output text check (output is null or octet_length(output) <= 65536);
create index if not exists ci_test_results_run_seq on public.ci_test_results (run_id, seq) where seq is not null;
-- The trigger of a run started by an event outside the five (release, repository_dispatch, ...): 'other', not a manual run.
alter table public.ci_runs drop constraint if exists ci_runs_trigger_check;
alter table public.ci_runs add constraint ci_runs_trigger_check check (trigger in ('push', 'pull_request', 'merge_group', 'schedule', 'workflow_dispatch', 'other'));
create index if not exists ci_runs_project_commit on public.ci_runs (project_id, commit_sha);
create index if not exists ci_runs_project_pr on public.ci_runs (project_id, pull_request) where pull_request is not null;
create index if not exists ci_runs_project_branch on public.ci_runs (project_id, branch, started_at desc);

-- API keys of an organization (scripts, the CLI, the remote MCP server, coding agents). Only the SHA-256 of a key is
-- stored; the key is shown once. Scopes: read (runs, defects, bundles), replay (ask for a replay). Revocable; optional
-- expiry. Owners and admins manage them.
create table if not exists public.ci_api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 64),
  prefix text not null check (prefix ~ '^fxk_[A-Za-z0-9]{6}$'),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{read}' check (cardinality(scopes) between 1 and 2 and scopes <@ array['read', 'replay']::text[]),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  check (expires_at is null or expires_at > created_at)
);
create index if not exists ci_api_keys_ws on public.ci_api_keys (workspace_id, created_at desc);
do $$ begin
  alter table public.ci_replays add constraint ci_replays_api_key_fk foreign key (api_key_id) references public.ci_api_keys (id) on delete set null;
exception when duplicate_object then null; end $$;

-- Requests per key or person per minute (the API's own rate limit, G-1627): one row per subject and minute, pruned.
create table if not exists public.api_rate_counters (
  subject text not null check (char_length(subject) <= 100),
  minute timestamptz not null,
  n int not null default 0,
  primary key (subject, minute)
);

-- ================================================================ 4. exploration jobs

-- The project's exploration settings: the hour (UTC) of the nightly exploration, the time cap and the seed budget, and
-- what to target (all tests, or only tests that were flaky or failed recently).
alter table public.ci_projects add column if not exists exploration_hour_utc int not null default 2 check (exploration_hour_utc between 0 and 23);
alter table public.ci_projects add column if not exists exploration_budget_seconds int not null default 2400 check (exploration_budget_seconds between 60 and 14400);
alter table public.ci_projects add column if not exists exploration_seeds int not null default 20 check (exploration_seeds between 1 and 500);
alter table public.ci_projects add column if not exists exploration_target text not null default 'all' check (exploration_target in ('all', 'unstable'));
-- Skip with proof paused by fenvix (an audit rerun found a wrong skip, G-1757): no cache is given until an owner resumes.
alter table public.ci_projects add column if not exists skip_paused_at timestamptz;
alter table public.ci_projects add column if not exists skip_paused_reason text check (skip_paused_reason is null or char_length(skip_paused_reason) <= 500);

-- One exploration the App scheduled (nightly, or for a pull request), dispatched to our machines; the machine's report
-- (POST /v1/runner/explorations with its explorationJobId) is stored as its ci_explorations row.
create table if not exists public.ci_exploration_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.ci_projects (id) on delete cascade,
  reason text not null check (reason in ('nightly', 'pull_request', 'manual')),
  commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
  branch text,
  budget_seconds int not null check (budget_seconds between 60 and 14400),
  seeds int not null check (seeds between 1 and 500),
  targets jsonb not null default '[]'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'running', 'finished', 'failed', 'cancelled')),
  detail text not null default '' check (char_length(detail) <= 1000),
  not_before timestamptz not null default now(),
  runner_name text,
  region text check (region is null or region in ('us', 'eu')),
  attempts int not null default 0,
  exploration_id uuid references public.ci_explorations (id) on delete set null,
  scheduled_for date,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  finished_at timestamptz
);
create unique index if not exists ci_exploration_jobs_nightly on public.ci_exploration_jobs (project_id, scheduled_for) where reason = 'nightly';
create unique index if not exists ci_exploration_jobs_one_active on public.ci_exploration_jobs (project_id) where status in ('pending', 'dispatched', 'running');
create index if not exists ci_exploration_jobs_due on public.ci_exploration_jobs (status, not_before) where status in ('pending', 'dispatched', 'running');
create index if not exists ci_exploration_jobs_ws on public.ci_exploration_jobs (workspace_id);
alter table public.ci_explorations add column if not exists job_id uuid;
do $$ begin
  alter table public.ci_explorations add constraint ci_explorations_job_fk foreign key (job_id) references public.ci_exploration_jobs (id) on delete set null;
exception when duplicate_object then null; end $$;

-- ================================================================ 5. tenant anchoring on the writer path

-- A child row takes its parent's organization (0011's trigger), now for the new tables too.
create or replace function public.ci_workspace_from_parent() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  if tg_table_name in ('ci_runs', 'ci_defects', 'ci_explorations', 'ci_replays', 'ci_exploration_jobs') then
    select workspace_id into v_ws from public.ci_projects where id = new.project_id;
  elsif tg_table_name in ('ci_defect_occurrences', 'ci_defect_bundles') then
    select workspace_id into v_ws from public.ci_defects where id = new.defect_id;
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
  foreach t in array array['ci_defect_occurrences', 'ci_defect_bundles', 'ci_replays', 'ci_exploration_jobs']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_workspace', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.ci_workspace_from_parent()', t || '_workspace', t);
  end loop;
end $$;

-- A project is the repository's, in the organization its GitHub installation is linked to: a writer (the App) that names
-- another organization in its transaction cannot create or move a project there (review gap G-1814). Together with the
-- child-row trigger above, every runner-fed row is anchored on the installation link, which only gh_link_installation
-- (an owner or admin of that organization) sets.
create or replace function public.ci_project_anchor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid; v_found boolean;
begin
  select true, workspace_id into v_found, v_ws from public.gh_installations where installation_id = new.installation_id;
  if v_found and v_ws is distinct from new.workspace_id then
    raise exception 'Project % belongs to the organization its GitHub installation is linked to.', new.full_name using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.ci_project_anchor() from public, anon, authenticated;
drop trigger if exists ci_projects_anchor on public.ci_projects;
create trigger ci_projects_anchor before insert or update of workspace_id, installation_id on public.ci_projects
  for each row execute function public.ci_project_anchor();

-- ================================================================ row level security of the new tables

do $$
declare t text;
begin
  foreach t in array array['ci_defect_occurrences', 'ci_defect_bundles', 'ci_replays', 'ci_api_keys', 'ci_exploration_jobs', 'api_rate_counters']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- The API reads them for the organization of its transaction (a member, or a valid API key of it: api_workspace()).
do $$
declare t text;
begin
  foreach t in array array['ci_defect_occurrences', 'ci_defect_bundles', 'ci_replays', 'ci_exploration_jobs']
  loop
    execute format('grant select on public.%I to fenvix_api', t);
    execute format('drop policy if exists %I on public.%I', t || '_api_read', t);
    execute format('create policy %I on public.%I for select to fenvix_api using (workspace_id = public.api_workspace())', t || '_api_read', t);
  end loop;
end $$;
-- Members (and keys with the replay scope, checked by the API) ask for replays; the row is checked against the
-- organization again here.
grant insert on public.ci_replays to fenvix_api;
drop policy if exists ci_replays_api_insert on public.ci_replays;
create policy ci_replays_api_insert on public.ci_replays for insert to fenvix_api with check (workspace_id = public.api_workspace());
-- Keys: owners and admins of the organization read, create and revoke them (never through a key).
grant select, insert on public.ci_api_keys to fenvix_api;
grant update (revoked_at, revoked_by, last_used_at) on public.ci_api_keys to fenvix_api;
drop policy if exists ci_api_keys_api_read on public.ci_api_keys;
create policy ci_api_keys_api_read on public.ci_api_keys for select to fenvix_api using (workspace_id = public.api_admin_workspace());
drop policy if exists ci_api_keys_api_insert on public.ci_api_keys;
create policy ci_api_keys_api_insert on public.ci_api_keys for insert to fenvix_api with check (workspace_id = public.api_admin_workspace());
drop policy if exists ci_api_keys_api_revoke on public.ci_api_keys;
create policy ci_api_keys_api_revoke on public.ci_api_keys for update to fenvix_api
  using (workspace_id = public.api_admin_workspace()) with check (workspace_id = public.api_admin_workspace());
-- A defect's state (fix, mute, reopen): any member of its organization; four columns only.
grant update (state, state_changed_at, state_changed_by, state_reason) on public.ci_defects to fenvix_api;
drop policy if exists ci_defects_api_state on public.ci_defects;
create policy ci_defects_api_state on public.ci_defects for update to fenvix_api
  using (workspace_id = public.api_workspace() and public.api_user() is not null) with check (workspace_id = public.api_workspace());
-- A run's stop: owners and admins (not a key).
grant update (stop_when, stop_state, stop_requested_at, stop_requested_by, stop_detail) on public.ci_runs to fenvix_api;
drop policy if exists ci_runs_api_cancel on public.ci_runs;
drop policy if exists ci_runs_api_stop on public.ci_runs;
create policy ci_runs_api_stop on public.ci_runs for update to fenvix_api
  using (workspace_id = public.api_admin_workspace()) with check (workspace_id = public.api_admin_workspace());
-- The project's exploration settings and the skip pause, with the other settings (owner or admin).
grant update (exploration_hour_utc, exploration_budget_seconds, exploration_seeds, exploration_target, skip_paused_at, skip_paused_reason)
  on public.ci_projects to fenvix_api;
-- The rate counters: the API's own bookkeeping, through api_rate_hit() only.

-- The App writes them for the organization of its transaction.
grant select, insert, update on public.ci_defect_occurrences, public.ci_defect_bundles, public.ci_replays, public.ci_exploration_jobs to fenvix_github_app;
grant delete on public.ci_defect_bundles to fenvix_github_app;
grant update (bundle_id, last_replay_id, state, state_changed_at, state_reason, fixed_commit_sha) on public.ci_defects to fenvix_github_app;
grant update (skip_paused_at, skip_paused_reason) on public.ci_projects to fenvix_github_app;
do $$
declare t text;
begin
  foreach t in array array['ci_defect_occurrences', 'ci_defect_bundles', 'ci_replays', 'ci_exploration_jobs']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_github_app', t);
    execute format('create policy %I on public.%I for all to fenvix_github_app using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace())', t || '_github_app', t);
  end loop;
end $$;

-- ================================================================ the API acting for an API key

-- An API key in the transaction (app.api_key_id, set by the API after api_key_lookup) acts for its organization only.
create or replace function public.api_key_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.api_key_id', true), '')::uuid
$$;

-- The organization of this transaction: the user's membership, or a valid (not revoked, not expired) key of it.
create or replace function public.api_workspace() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select m.workspace_id from public.workspace_members m
      where m.user_id = public.api_user() and m.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid),
    (select k.workspace_id from public.ci_api_keys k
      where k.id = public.api_key_id() and k.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
        and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())))
$$;

-- A key by the SHA-256 of its text: its id, organization and scopes, when valid. Marks it used (at most once a minute).
create or replace function public.api_key_lookup(p_hash text)
returns table (key_id uuid, workspace_id uuid, scopes text[])
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.ci_api_keys k set last_used_at = now()
   where k.key_hash = p_hash and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())
     and (k.last_used_at is null or k.last_used_at < now() - interval '1 minute');
  return query select k.id, k.workspace_id, k.scopes from public.ci_api_keys k
   where k.key_hash = p_hash and k.revoked_at is null and (k.expires_at is null or k.expires_at > now());
end $$;

-- One request of a subject (a key or a person) this minute: true while under p_limit.
create or replace function public.api_rate_hit(p_subject text, p_limit int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  insert into public.api_rate_counters (subject, minute, n) values (p_subject, date_trunc('minute', now()), 1)
  on conflict (subject, minute) do update set n = public.api_rate_counters.n + 1
  returning n into v_n;
  if random() < 0.01 then delete from public.api_rate_counters where minute < now() - interval '10 minutes'; end if;
  return v_n <= p_limit;
end $$;

do $$
declare f text;
begin
  foreach f in array array['api_key_id()', 'api_workspace()', 'api_key_lookup(text)', 'api_rate_hit(text, int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_api', f);
  end loop;
end $$;

-- ================================================================ 6. deleting

-- Usage events are billing records: they survive the organization and the installation they came from (G-1813).
alter table public.ci_usage_events drop constraint if exists ci_usage_events_workspace_id_fkey;
do $$ begin
  alter table public.ci_usage_events add constraint ci_usage_events_workspace_id_fkey foreign key (workspace_id) references public.workspaces (id) on delete set null;
exception when duplicate_object then null; end $$;
alter table public.ci_usage_events alter column installation_id drop not null;
alter table public.ci_usage_events drop constraint if exists ci_usage_events_installation_id_fkey;
do $$ begin
  alter table public.ci_usage_events add constraint ci_usage_events_installation_id_fkey foreign key (installation_id)
    references public.gh_installations (installation_id) on delete set null;
exception when duplicate_object then null; end $$;

-- A repository whose project an owner disconnected: no project is made again for it, and no machine starts for it.
alter table public.gh_repositories add column if not exists disconnected_at timestamptz;

-- The person and the organization named by a deleted account are gone (G-2339).
do $$ begin
  alter table public.gh_installations add constraint gh_installations_linked_by_fkey foreign key (linked_by) references auth.users (id) on delete set null;
exception when duplicate_object or foreign_key_violation then null; end $$;
do $$ begin
  alter table public.gh_install_completions add constraint gh_install_completions_user_fkey foreign key (user_id) references auth.users (id) on delete cascade;
exception when duplicate_object or foreign_key_violation then null; end $$;

-- An organization without members is deleted with everything in it (its last member's account was deleted, G-1811).
create or replace function public.workspace_drop_orphan() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = old.workspace_id) then
    delete from public.workspaces w where w.id = old.workspace_id;
  end if;
  return null;
end $$;
revoke all on function public.workspace_drop_orphan() from public, anon, authenticated;
drop trigger if exists workspace_members_drop_orphan on public.workspace_members;
create trigger workspace_members_drop_orphan after delete on public.workspace_members
  for each row execute function public.workspace_drop_orphan();

-- The organization of the transaction, deleted by its owner who typed its name (G-0634): projects, runs, results,
-- defects, bundles, keys, members and invitations go (cascade); installations are unlinked; usage events stay.
create or replace function public.api_delete_organization(p_confirm_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid; v_name text;
begin
  if public.api_user() is null or not exists (select 1 from public.workspace_members m
      where m.workspace_id = v_ws and m.user_id = public.api_user() and m.role = 'owner') then
    raise exception 'Only an owner can delete the organization.' using errcode = '42501';
  end if;
  select name into v_name from public.workspaces where id = v_ws for update;
  if v_name is distinct from p_confirm_name then
    raise exception 'Type the organization''s name exactly to delete it.' using errcode = '23514';
  end if;
  update public.gh_installations set workspace_id = null, linked_by = null, linked_at = null, updated_at = now() where workspace_id = v_ws;
  delete from public.workspaces where id = v_ws;
end $$;

-- A project of the transaction's organization, deleted by an owner or admin (G-1810): its runs, results, receipts,
-- defects, bundles, replays and explorations go; the repository is marked disconnected, so the App neither makes the
-- project again nor starts machines for it until the setup is asked for again.
create or replace function public.api_delete_project(p_project uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid := public.api_admin_workspace();
begin
  if v_ws is null then raise exception 'Only an owner or admin can disconnect a project.' using errcode = '42501'; end if;
  -- Only a project they see (G-1631; api_visible_projects() is in section 13).
  if not exists (select 1 from public.api_visible_projects() v where v = p_project) then return false; end if;
  update public.gh_repositories set disconnected_at = now(), updated_at = now() where project_id = p_project and workspace_id = v_ws;
  delete from public.ci_projects where id = p_project and workspace_id = v_ws;
  return found;
end $$;

-- The signed-in person's own account (G-1626). Refused while they are the only owner of an organization that has other
-- members (they make someone else an owner first); organizations where they are the only member go with them.
create or replace function public.api_delete_me()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid := public.api_user(); v_blocking text;
begin
  if v_user is null then raise exception 'No user.' using errcode = '42501'; end if;
  select w.name into v_blocking from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
   where m.user_id = v_user and m.role = 'owner'
     and not exists (select 1 from public.workspace_members o where o.workspace_id = m.workspace_id and o.role = 'owner' and o.user_id <> v_user)
     and exists (select 1 from public.workspace_members o where o.workspace_id = m.workspace_id and o.user_id <> v_user)
   limit 1;
  if v_blocking is not null then
    raise exception 'You are the only owner of %. Make someone else an owner first, or delete it.', v_blocking using errcode = '23514';
  end if;
  update public.gh_installations i set workspace_id = null, linked_by = null, linked_at = null, updated_at = now()
   where i.workspace_id in (select m.workspace_id from public.workspace_members m where m.user_id = v_user)
     and not exists (select 1 from public.workspace_members o where o.workspace_id = i.workspace_id and o.user_id <> v_user);
  delete from auth.users where id = v_user;
end $$;

-- Unlinking a GitHub installation from the organization (G-1700): an owner or admin. The installation's projects and
-- their data go (they belong to the organization it was linked to); usage events stay (their organization is kept).
create or replace function public.api_unlink_installation(p_installation bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid := public.api_admin_workspace();
begin
  if v_ws is null then raise exception 'Only an owner or admin can disconnect a GitHub account.' using errcode = '42501'; end if;
  perform 1 from public.gh_installations where installation_id = p_installation and workspace_id = v_ws for update;
  if not found then return false; end if;
  delete from public.ci_projects p where p.workspace_id = v_ws and p.installation_id = p_installation;
  update public.gh_repositories set project_id = null, updated_at = now() where installation_id = p_installation;
  update public.gh_installations set workspace_id = null, linked_by = null, linked_at = null, updated_at = now() where installation_id = p_installation;
  return true;
end $$;

do $$
declare f text;
begin
  foreach f in array array['api_delete_organization(text)', 'api_delete_project(uuid)', 'api_delete_me()', 'api_unlink_installation(bigint)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_api', f);
  end loop;
end $$;

-- Retention (G-1699, G-1812, G-1816, G-2309, G-2337), run by the App's sweep. DECLARED by this migration:
--   - an installation uninstalled on GitHub 30 days ago: its projects and all their data go, the installation is
--     unlinked and its repositories and jobs go;
--   - per-test results, skip receipts and audit reruns of runs that finished more than 180 days ago go (the run row and
--     its totals stay);
--   - runs older than 400 days go (with everything under them);
--   - webhook delivery records older than 30 days, rate counters older than a day.
-- Returns what it deleted, by kind. At most p_batch rows of each kind per call.
create or replace function public.gh_retention_sweep(p_batch int default 5000)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare out jsonb := '{}'::jsonb; n int; v_inst record;
begin
  for v_inst in select installation_id, workspace_id from public.gh_installations
                 where deleted_at is not null and deleted_at < now() - interval '30 days' limit 20 loop
    if v_inst.workspace_id is not null then
      delete from public.ci_projects where workspace_id = v_inst.workspace_id and installation_id = v_inst.installation_id;
    end if;
    delete from public.gh_jobs where installation_id = v_inst.installation_id;
    delete from public.gh_repositories where installation_id = v_inst.installation_id;
    update public.gh_installations set workspace_id = null, updated_at = now() where installation_id = v_inst.installation_id;
    out := out || jsonb_build_object('purged_installations', coalesce((out->>'purged_installations')::int, 0) + 1);
  end loop;
  delete from public.ci_test_results t where t.ctid in (select t2.ctid from public.ci_test_results t2 join public.ci_runs r on r.id = t2.run_id
    where r.finished_at < now() - interval '180 days' limit p_batch);
  get diagnostics n = row_count; out := out || jsonb_build_object('test_results', n);
  delete from public.ci_skip_receipts s where s.id in (select s2.id from public.ci_skip_receipts s2 join public.ci_runs r on r.id = s2.run_id
    where r.finished_at < now() - interval '180 days' limit p_batch);
  get diagnostics n = row_count; out := out || jsonb_build_object('receipts', n);
  delete from public.ci_audit_reruns a where a.ctid in (select a2.ctid from public.ci_audit_reruns a2 join public.ci_runs r on r.id = a2.run_id
    where r.finished_at < now() - interval '180 days' limit p_batch);
  get diagnostics n = row_count; out := out || jsonb_build_object('audit_reruns', n);
  delete from public.ci_runs r where r.id in (select id from public.ci_runs where started_at < now() - interval '400 days' limit p_batch);
  get diagnostics n = row_count; out := out || jsonb_build_object('runs', n);
  delete from public.gh_webhook_deliveries d where d.delivery_id in
    (select delivery_id from public.gh_webhook_deliveries where received_at < now() - interval '30 days' limit p_batch);
  get diagnostics n = row_count; out := out || jsonb_build_object('webhook_deliveries', n);
  delete from public.api_rate_counters where minute < now() - interval '1 day';
  return out;
end $$;
revoke all on function public.gh_retention_sweep(int) from public, anon, authenticated;
grant execute on function public.gh_retention_sweep(int) to fenvix_github_app;
create index if not exists gh_webhook_deliveries_received on public.gh_webhook_deliveries (received_at);

-- ================================================================ 7. smaller ones

-- An invited person who signs up gets no empty organization of their own: they join the inviting one (G-2340). A person
-- with no organization can still create one.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.email is not null and exists (select 1 from public.workspace_invites i where i.email = lower(new.email)
      and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) then
    return new;
  end if;
  perform public.ensure_workspace(
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '')
  );
  return new;
end $$;

-- Indexes the sweep and the cascades need (G-2338).
create index if not exists gh_jobs_unpublished on public.gh_jobs (completed_at) where status = 'completed' and published_at is null;
create index if not exists gh_jobs_installation on public.gh_jobs (installation_id);
create index if not exists gh_jobs_ci_run on public.gh_jobs (ci_run_id) where ci_run_id is not null;
create index if not exists ci_test_results_ws on public.ci_test_results (workspace_id);
create index if not exists ci_skip_receipts_ws on public.ci_skip_receipts (workspace_id);
create index if not exists ci_skip_receipts_run on public.ci_skip_receipts (run_id);
create index if not exists ci_usage_events_project on public.ci_usage_events (project_id);
create index if not exists ci_test_results_defect on public.ci_test_results (defect_id) where defect_id is not null;

-- Tables a later migration creates are not readable by the browser's roles unless it grants them (G-2342). Supabase
-- grants anon and authenticated every right on new tables of the postgres role by default; that default goes.
do $$ begin
  alter default privileges in schema public revoke all on tables from anon, authenticated;
  alter default privileges in schema public revoke all on sequences from anon, authenticated;
  alter default privileges in schema public revoke all on functions from anon, authenticated;
exception when undefined_object or insufficient_privilege then
  raise notice 'Default privileges of anon/authenticated not changed here (roles missing or not ours).';
end $$;

notify pgrst, 'reload schema';

-- ================================================================ 8. the App's job records for the combined comment

-- The job's check run page (the comment links it) and why no machine will come (the comment and the check say it, G-1648).
alter table public.gh_jobs add column if not exists check_run_url text check (check_run_url is null or check_run_url ~ '^https://');
alter table public.gh_jobs add column if not exists no_machine text check (no_machine is null or char_length(no_machine) <= 500);
create index if not exists gh_jobs_head on public.gh_jobs (repository_id, head_sha);

-- ================================================================ 9. the task scheduler (replays, explorations)

-- The nightly explorations of the day: one per project that has nightly exploration on, in a linked installation, once
-- its hour (UTC) has come. 'unstable' targets the tests of its open defects and the tests that failed in the last 14
-- days. Returns how many it created.
create or replace function public.gh_schedule_explorations(p_now timestamptz)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into public.ci_exploration_jobs (workspace_id, project_id, reason, branch, budget_seconds, seeds, targets, scheduled_for, not_before)
  select p.workspace_id, p.id, 'nightly', p.default_branch, p.exploration_budget_seconds, p.exploration_seeds,
         case when p.exploration_target = 'unstable' then coalesce((
           select jsonb_agg(distinct x.test_id) from (
             select d.test_id from public.ci_defects d where d.project_id = p.id and d.state = 'open'
             union select t.test_id from public.ci_test_results t join public.ci_runs r on r.id = t.run_id
              where r.project_id = p.id and t.outcome = 'failed' and r.started_at > p_now - interval '14 days') x), '[]'::jsonb)
         else '[]'::jsonb end,
         (p_now at time zone 'UTC')::date, p_now
    from public.ci_projects p
    join public.gh_installations i on i.installation_id = p.installation_id and i.workspace_id = p.workspace_id
   where p.nightly_exploration and i.suspended_at is null and i.deleted_at is null
     and extract(hour from p_now at time zone 'UTC') >= p.exploration_hour_utc
     and exists (select 1 from public.gh_repositories g where g.project_id = p.id and g.removed_at is null and g.disconnected_at is null)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Tasks that need a machine now: requested replays, pending explorations whose time came, and dispatched ones whose
-- machine never reported within p_timeout seconds (tried again). Ids and organizations only.
create or replace function public.gh_due_tasks(p_now timestamptz, p_timeout int)
returns table (kind text, id uuid, workspace_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select 'replay', r.id, r.workspace_id from public.ci_replays r
   where r.status = 'requested' or (r.status = 'dispatched' and r.dispatched_at < p_now - make_interval(secs => p_timeout))
  union all
  select 'exploration', j.id, j.workspace_id from public.ci_exploration_jobs j
   where (j.status = 'pending' and j.not_before <= p_now) or (j.status = 'dispatched' and j.dispatched_at < p_now - make_interval(secs => p_timeout))
  order by 1, 2 limit 50
$$;

-- The organization of one task (a machine's report names the task; the App then works in that organization only).
create or replace function public.gh_task_workspace(p_kind text, p_id uuid)
returns table (workspace_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.workspace_id from public.ci_replays r where p_kind = 'replay' and r.id = p_id
  union all
  select j.workspace_id from public.ci_exploration_jobs j where p_kind = 'exploration' and j.id = p_id
$$;

-- Runs whose stop was asked for and that are still running (the sweep ends them): ids and organizations only.
create or replace function public.gh_cancel_requests()
returns table (run_id uuid, workspace_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.workspace_id from public.ci_runs r where r.status = 'running' and r.stop_state = 'requested'
   and r.stop_requested_at > now() - interval '1 day'
   and (r.stop_sent_at is null or r.stop_sent_at < now() - interval '2 minutes') limit 50
$$;

do $$
declare f text;
begin
  foreach f in array array['gh_schedule_explorations(timestamptz)', 'gh_due_tasks(timestamptz, int)', 'gh_task_workspace(text, uuid)', 'gh_cancel_requests()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_github_app', f);
  end loop;
end $$;

-- ================================================================ 10. a signed-out session stops working at once (G-2234)

-- Whether a Supabase session still exists (signed out, or the account deleted: no). Where the auth schema has no
-- sessions table (a plain Postgres for the tests), every session counts as alive.
create or replace function public.api_session_alive(p_session uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v boolean;
begin
  if to_regclass('auth.sessions') is null then return true; end if;
  execute 'select exists (select 1 from auth.sessions s where s.id = $1 and (s.not_after is null or s.not_after > now()))' into v using p_session;
  return v;
exception when undefined_column then
  execute 'select exists (select 1 from auth.sessions s where s.id = $1)' into v using p_session;
  return v;
end $$;
revoke all on function public.api_session_alive(uuid) from public, anon, authenticated;
grant execute on function public.api_session_alive(uuid) to fenvix_api;

-- An API key reads its own organization's row (its name and region), nothing else of the organizations' tables.
drop policy if exists workspaces_api_key_read on public.workspaces;
create policy workspaces_api_key_read on public.workspaces for select to fenvix_api
  using (public.api_key_id() is not null and id = public.api_workspace());

-- ================================================================ 11. the audit log (G-1632, G-1805)

-- Who changed what in an organization: members and roles, invitations, the organization's name and region, GitHub
-- installations linked or unlinked, project settings, API keys, defects' states, projects disconnected. Written by
-- triggers (whoever writes: the API as a person or a key, the App, a function), read by owners and admins.
create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  at timestamptz not null default now(),
  actor_user uuid,
  actor_key uuid,
  actor_role text not null default current_user,
  action text not null check (char_length(action) <= 100),
  target text not null default '' check (char_length(target) <= 300),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists audit_events_ws_at on public.audit_events (workspace_id, at desc);
alter table public.audit_events enable row level security;
revoke all on public.audit_events from public, anon, authenticated;
grant select on public.audit_events to fenvix_api;
drop policy if exists audit_events_api_read on public.audit_events;
create policy audit_events_api_read on public.audit_events for select to fenvix_api using (workspace_id = public.api_admin_workspace());

create or replace function public.audit_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws uuid; v_action text; v_target text := ''; v_detail jsonb := '{}'::jsonb; o jsonb; n jsonb;
begin
  o := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  n := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_ws := coalesce((n ->> 'workspace_id')::uuid, (o ->> 'workspace_id')::uuid, (n ->> 'id')::uuid);
  if tg_table_name = 'workspaces' then
    if tg_op <> 'UPDATE' or (o ->> 'name' is not distinct from n ->> 'name' and o ->> 'region' is not distinct from n ->> 'region') then return null; end if;
    v_action := 'organization.changed';
    v_detail := jsonb_build_object('name', jsonb_build_array(o ->> 'name', n ->> 'name'), 'region', jsonb_build_array(o ->> 'region', n ->> 'region'));
  elsif tg_table_name = 'workspace_members' then
    if tg_op = 'UPDATE' and o ->> 'role' is not distinct from n ->> 'role' then return null; end if;
    v_action := 'member.' || lower(tg_op);
    v_target := coalesce(n ->> 'user_id', o ->> 'user_id');
    v_detail := jsonb_build_object('role', jsonb_build_array(o ->> 'role', n ->> 'role'));
  elsif tg_table_name = 'workspace_invites' then
    if tg_op = 'INSERT' then v_action := 'invitation.created';
    elsif n ->> 'revoked_at' is not null and o ->> 'revoked_at' is null then v_action := 'invitation.revoked';
    elsif n ->> 'accepted_at' is not null and o ->> 'accepted_at' is null then v_action := 'invitation.accepted';
    else return null; end if;
    v_target := coalesce(n ->> 'email', '');
    v_detail := jsonb_build_object('role', n ->> 'role');
  elsif tg_table_name = 'gh_installations' then
    if o ->> 'workspace_id' is not distinct from n ->> 'workspace_id' then return null; end if;
    v_ws := coalesce((n ->> 'workspace_id')::uuid, (o ->> 'workspace_id')::uuid);
    v_action := case when n ->> 'workspace_id' is null then 'github.unlinked' else 'github.linked' end;
    v_target := coalesce(n ->> 'account_login', '') || ' (installation ' || (n ->> 'installation_id') || ')';
    if v_action = 'github.unlinked' and o ->> 'workspace_id' is not null then
      -- Unlinked because the organization itself is being deleted: nothing left to log into.
      if not exists (select 1 from public.workspaces w where w.id = (o ->> 'workspace_id')::uuid) then return null; end if;
      insert into public.audit_events (workspace_id, actor_user, actor_key, action, target, detail)
        values ((o ->> 'workspace_id')::uuid, public.api_user(), public.api_key_id(), v_action, v_target, '{}'::jsonb);
      return null;
    end if;
  elsif tg_table_name = 'ci_projects' then
    if tg_op = 'DELETE' then v_action := 'project.disconnected';
    elsif tg_op = 'UPDATE' and (o - 'setup_state' - 'setup_pr_number' - 'setup_pr_url' - 'setup_pr_state' - 'default_branch' - 'full_name' - 'installation_id'
                               - 'baseline_median_ttg_s' - 'baseline_median_job_minutes' - 'baseline_runs_sampled' - 'baseline_from' - 'baseline_to')
                             is distinct from (n - 'setup_state' - 'setup_pr_number' - 'setup_pr_url' - 'setup_pr_state' - 'default_branch' - 'full_name' - 'installation_id'
                               - 'baseline_median_ttg_s' - 'baseline_median_job_minutes' - 'baseline_runs_sampled' - 'baseline_from' - 'baseline_to') then
      v_action := 'project.settings_changed';
      select jsonb_object_agg(k, jsonb_build_array(o -> k, n -> k)) into v_detail from jsonb_object_keys(n) k where o -> k is distinct from n -> k;
    else return null; end if;
    v_target := coalesce(n ->> 'full_name', o ->> 'full_name');
  elsif tg_table_name = 'ci_api_keys' then
    if tg_op = 'INSERT' then v_action := 'api_key.created';
    elsif n ->> 'revoked_at' is not null and o ->> 'revoked_at' is null then v_action := 'api_key.revoked';
    else return null; end if;
    v_target := (n ->> 'name') || ' (' || (n ->> 'prefix') || ')';
    v_detail := jsonb_build_object('scopes', n -> 'scopes');
  elsif tg_table_name = 'ci_defects' then
    if tg_op <> 'UPDATE' or o ->> 'state' is not distinct from n ->> 'state' then return null; end if;
    v_action := 'defect.' || (n ->> 'state');
    v_target := n ->> 'test_id';
    v_detail := jsonb_build_object('reason', n ->> 'state_reason');
  else
    return null;
  end if;
  if v_ws is null or not exists (select 1 from public.workspaces w where w.id = v_ws) then return null; end if;
  insert into public.audit_events (workspace_id, actor_user, actor_key, action, target, detail)
    values (v_ws, public.api_user(), public.api_key_id(), v_action, v_target, coalesce(v_detail, '{}'::jsonb));
  return null;
end $$;
revoke all on function public.audit_write() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['workspaces', 'workspace_members', 'workspace_invites', 'gh_installations', 'ci_projects', 'ci_api_keys', 'ci_defects']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_write()', t || '_audit', t);
  end loop;
end $$;

-- Owners and admins ask for an exploration now (POST /v1/projects/{id}/exploration-jobs), in their organization only.
grant insert on public.ci_exploration_jobs to fenvix_api;
drop policy if exists ci_exploration_jobs_api_insert on public.ci_exploration_jobs;
create policy ci_exploration_jobs_api_insert on public.ci_exploration_jobs for insert to fenvix_api with check (workspace_id = public.api_admin_workspace());

-- ================================================================ 12. the defect bundle's signed link (P-049)

-- The bytes behind a signed, short-lived link the API made for a member or a key (GET /v1/defects/{id}/bundle answers
-- the link; GET /v1/bundles/{token} serves it). The API checks the signature and the expiry first; this only returns
-- the bundle of that defect in that organization.
create or replace function public.api_signed_bundle(p_workspace uuid, p_defect uuid, p_bundle uuid)
returns table (content bytea, sha256 text)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.content, b.sha256 from public.ci_defect_bundles b
   where b.id = p_bundle and b.defect_id = p_defect and b.workspace_id = p_workspace
$$;
revoke all on function public.api_signed_bundle(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_signed_bundle(uuid, uuid, uuid) to fenvix_api;

-- ================================================================ 13. a project only for those who can see its repository on GitHub (G-1631)

-- A member (or an API key, which acts as the member who made it) sees a project only while GitHub says that person can
-- see the project's repository: a public repository, or a fresh answer from GitHub that their GitHub identity has at
-- least read access. The App asks GitHub (GET /repos/{owner}/{repo}/collaborators/{login}/permission, with the
-- installation's token) and keeps the answer here for 10 minutes at most; it asks again after 4. No answer, an old
-- answer, no GitHub identity (a person who signed in with Google or an email link only): no project. Every table
-- the API reads that carries a project's data (runs, tests, defects, bundles, replays, receipts, explorations,
-- warm-ups, usage) follows the project.
create table if not exists public.gh_repo_access (
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid not null references public.ci_projects (id) on delete cascade,
  can_see boolean not null,
  -- What GitHub said: the permission (admin, write, read, none), or no_github_identity, not_found.
  basis text not null check (basis ~ '^[a-z_]{1,40}$'),
  github_user_id bigint,
  checked_at timestamptz not null default now(),
  primary key (user_id, project_id)
);
create index if not exists gh_repo_access_project on public.gh_repo_access (project_id);
create index if not exists gh_repo_access_github_user on public.gh_repo_access (github_user_id);
alter table public.gh_repo_access enable row level security;
revoke all on public.gh_repo_access from public, anon, authenticated;
grant select, insert, update, delete on public.gh_repo_access to fenvix_github_app;
drop policy if exists gh_repo_access_github_app on public.gh_repo_access;
create policy gh_repo_access_github_app on public.gh_repo_access for all to fenvix_github_app using (true) with check (true);

-- A person's GitHub identity: the GitHub sign-in Supabase Auth verified (auth.identities), else the GitHub user who
-- completed an installation link for them (checked by OAuth at /github/setup). Never what a person typed.
create or replace function public.gh_github_identity(p_user uuid)
returns table (github_user_id bigint, github_login text)
language sql stable security definer set search_path = public, pg_temp as $$
  select x.id, x.login from (
    select i.provider_id::bigint as id, coalesce(i.identity_data ->> 'user_name', i.identity_data ->> 'preferred_username') as login, 0 as pref, i.updated_at as at
      from auth.identities i
     where i.user_id = p_user and i.provider = 'github' and i.provider_id ~ '^[0-9]{1,18}$'
    union all
    select c.github_user_id, c.github_login, 1, c.completed_at
      from public.gh_install_completions c
     where c.user_id = p_user and c.completed_at is not null
  ) x
  where x.login is not null and x.login <> ''
  order by x.pref, x.at desc nulls last
  limit 1
$$;
revoke all on function public.gh_github_identity(uuid) from public, anon, authenticated;
grant execute on function public.gh_github_identity(uuid) to fenvix_github_app;

-- Who looks: the signed-in person, or the member who made the API key of this transaction (while still a member).
create or replace function public.api_viewer() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.api_user(),
    (select k.created_by from public.ci_api_keys k
      where k.id = public.api_key_id() and k.workspace_id = public.api_workspace()
        and exists (select 1 from public.workspace_members m where m.workspace_id = k.workspace_id and m.user_id = k.created_by)))
$$;

-- The projects of this transaction's organization the viewer may see.
create or replace function public.api_visible_projects() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id from public.ci_projects p
   where p.workspace_id = public.api_workspace()
     and (exists (select 1 from public.gh_repositories r
                   where r.project_id = p.id and r.workspace_id = p.workspace_id and r.private = false and r.removed_at is null)
          or exists (select 1 from public.gh_repo_access a
                      where a.project_id = p.id and a.user_id = public.api_viewer() and a.can_see
                        and a.checked_at > now() - interval '10 minutes'))
$$;
do $$
declare f text;
begin
  foreach f in array array['api_viewer()', 'api_visible_projects()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_api', f);
  end loop;
end $$;

-- The reads: a project's rows only for those who see the project.
do $$
declare t text;
begin
  foreach t in array array['ci_runs', 'ci_defects', 'ci_explorations', 'ci_replays', 'ci_exploration_jobs']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_api_read', t);
    execute format('create policy %I on public.%I for select to fenvix_api using (workspace_id = public.api_workspace() and project_id in (select public.api_visible_projects()))', t || '_api_read', t);
  end loop;
  -- Through their run (ci_runs' own policy applies inside).
  foreach t in array array['ci_test_results', 'ci_skip_receipts', 'ci_audit_reruns']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_api_read', t);
    execute format('create policy %I on public.%I for select to fenvix_api using (workspace_id = public.api_workspace() and exists (select 1 from public.ci_runs r where r.id = run_id))', t || '_api_read', t);
  end loop;
  -- Through their defect.
  foreach t in array array['ci_defect_occurrences', 'ci_defect_bundles']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_api_read', t);
    execute format('create policy %I on public.%I for select to fenvix_api using (workspace_id = public.api_workspace() and exists (select 1 from public.ci_defects d where d.id = defect_id))', t || '_api_read', t);
  end loop;
end $$;
drop policy if exists ci_projects_api_read on public.ci_projects;
create policy ci_projects_api_read on public.ci_projects for select to fenvix_api
  using (workspace_id = public.api_workspace() and id in (select public.api_visible_projects()));
drop policy if exists ci_usage_events_api_read on public.ci_usage_events;
create policy ci_usage_events_api_read on public.ci_usage_events for select to fenvix_api
  using (workspace_id = public.api_workspace() and (project_id is null or project_id in (select public.api_visible_projects())));
-- A repository not yet a project shows its name only (the organization's owners connect it); one of a project follows it.
drop policy if exists gh_repositories_api_read on public.gh_repositories;
create policy gh_repositories_api_read on public.gh_repositories for select to fenvix_api
  using (workspace_id = public.api_workspace() and (project_id is null or project_id in (select public.api_visible_projects())));
drop policy if exists gh_warmups_api_read on public.gh_warmups;
create policy gh_warmups_api_read on public.gh_warmups for select to fenvix_api
  using (workspace_id = public.api_workspace() and exists (select 1 from public.gh_repositories r where r.repository_id = gh_warmups.repository_id));

-- The writes: only on a project the person sees.
drop policy if exists ci_projects_api_admin on public.ci_projects;
create policy ci_projects_api_admin on public.ci_projects for update to fenvix_api
  using (workspace_id = public.api_admin_workspace() and id in (select public.api_visible_projects()))
  with check (workspace_id = public.api_admin_workspace());
drop policy if exists ci_defects_api_state on public.ci_defects;
create policy ci_defects_api_state on public.ci_defects for update to fenvix_api
  using (workspace_id = public.api_workspace() and public.api_user() is not null and project_id in (select public.api_visible_projects()))
  with check (workspace_id = public.api_workspace());
drop policy if exists ci_runs_api_stop on public.ci_runs;
create policy ci_runs_api_stop on public.ci_runs for update to fenvix_api
  using (workspace_id = public.api_admin_workspace() and project_id in (select public.api_visible_projects()))
  with check (workspace_id = public.api_admin_workspace());
drop policy if exists ci_replays_api_insert on public.ci_replays;
create policy ci_replays_api_insert on public.ci_replays for insert to fenvix_api
  with check (workspace_id = public.api_workspace() and project_id in (select public.api_visible_projects()));
drop policy if exists ci_exploration_jobs_api_insert on public.ci_exploration_jobs;
create policy ci_exploration_jobs_api_insert on public.ci_exploration_jobs for insert to fenvix_api
  with check (workspace_id = public.api_admin_workspace() and project_id in (select public.api_visible_projects()));

-- What the App asks GitHub next: members' private projects never checked first, then the oldest answers (older than
-- 4 minutes). Public repositories need no answer.
create or replace function public.gh_repo_access_due(p_limit int)
returns table (user_id uuid, project_id uuid, installation_id bigint, full_name text, github_user_id bigint, github_login text)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id, p.id, p.installation_id, p.full_name, g.github_user_id, g.github_login
    from public.workspace_members m
    join public.ci_projects p on p.workspace_id = m.workspace_id
    left join public.gh_repo_access a on a.user_id = m.user_id and a.project_id = p.id
    left join lateral public.gh_github_identity(m.user_id) g on true
   where not exists (select 1 from public.gh_repositories r where r.project_id = p.id and r.private = false and r.removed_at is null)
     and (a.checked_at is null or a.checked_at < now() - interval '4 minutes')
   order by a.checked_at nulls first, m.user_id
   limit greatest(p_limit, 0)
$$;
revoke all on function public.gh_repo_access_due(int) from public, anon, authenticated;
grant execute on function public.gh_repo_access_due(int) to fenvix_github_app;

-- A change GitHub reported (a collaborator or member removed, a team changed, a repository made private): the answers
-- it may have made wrong go at once, so the project is hidden until GitHub is asked again. Null matches everything.
create or replace function public.gh_repo_access_forget(p_installation bigint, p_repository bigint, p_github_user bigint)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  delete from public.gh_repo_access a using public.ci_projects p
   where a.project_id = p.id
     and (p_installation is null or p.installation_id = p_installation)
     and (p_repository is null or p.id in (select r.project_id from public.gh_repositories r where r.repository_id = p_repository))
     and (p_github_user is null or a.github_user_id = p_github_user);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.gh_repo_access_forget(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.gh_repo_access_forget(bigint, bigint, bigint) to fenvix_github_app;

-- ================================================================ 14. replays on our machines (with P-047's 0018)

-- A replay the API asked for (ci_replays) runs on our machines as gh_replays (0018) leases: the link, and the commit
-- the replay names (a defect's replay may be on a later commit than the run's). Only where 0018 made gh_replays.
do $$ begin
  if to_regclass('public.gh_replays') is not null then
    alter table public.gh_replays add column if not exists ci_replay_id uuid references public.ci_replays (id) on delete cascade;
    alter table public.gh_replays add column if not exists commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$');
    create index if not exists gh_replays_ci_replay on public.gh_replays (ci_replay_id) where ci_replay_id is not null;
  end if;
end $$;
