-- FENVIX control plane, part 2: what the control-plane service (control-plane/) needs.
-- Safe to run more than once. Run it in the Supabase SQL editor AFTER 0001_init.sql.
--
-- The service never uses the service_role key. It connects as the restricted role
-- fenvix_control_plane created below. That role:
--   * has no password in this file (you set it yourself, see control-plane/README.md),
--   * cannot bypass row level security (checked at the end of the isolation tests),
--   * only gets the table rights listed here, and every one of its table policies is
--     "workspace_id = the workspace the service says it is acting for in this transaction"
--     (the setting app.workspace_id, set with set_config(..., true) at the start of each
--     transaction),
--   * reaches across workspaces only through the five narrow functions at the end
--     (resolve an API key, find a user's workspace, list due operations, list workspaces for
--     the usage sync, prune old rows).

-- ---------------------------------------------------------------- the role

-- A new role gets Postgres's safe defaults: no superuser, no create-db, no create-role, no
-- replication and no BYPASSRLS, and it is a member of no role. No password is set here: you set
-- it yourself, outside this file (see control-plane/README.md).
do $$ begin
  create role fenvix_control_plane login;
exception when duplicate_object then null; end $$;

-- If an earlier run (or a person) gave the role more, take it back. Where the account running
-- this file may not change an attribute, say so instead of failing.
do $$ begin
  alter role fenvix_control_plane nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception when insufficient_privilege then
  raise notice 'Could not reset the attributes of fenvix_control_plane. Check with: select rolsuper, rolbypassrls from pg_roles where rolname = ''fenvix_control_plane'' (both must be false).';
end $$;

grant usage on schema public to fenvix_control_plane;

-- ---------------------------------------------------------------- changes to existing tables

-- The regions are configuration in the service now (REGIONS), not a list baked into the schema.
-- The dashboard's own function fenvix_create_database still checks the four old names.
alter table public.databases drop constraint if exists databases_region_check;
alter table public.databases drop constraint if exists databases_region_format;
alter table public.databases add constraint databases_region_format check (region ~ '^[a-z0-9][a-z0-9-]{1,30}$');

-- Where the database is in its life with the engine. Existing rows are 'ready'.
alter table public.databases add column if not exists engine_state text not null default 'ready';
alter table public.databases drop constraint if exists databases_engine_state_check;
alter table public.databases add constraint databases_engine_state_check
  check (engine_state in ('provisioning', 'ready', 'restoring', 'erasing'));

-- ---------------------------------------------------------------- new tables

-- A long operation (create, fork, restore, export, erase) the dashboard can poll.
create table if not exists public.operations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('create', 'fork', 'restore', 'export', 'erase')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  -- No foreign key: the row of an erased database goes, the record of the erase stays.
  database_id uuid,
  params jsonb not null default '{}'::jsonb,
  result jsonb,
  error jsonb,
  -- While queued or running, one operation per dedupe_key: a retry finds the first one.
  dedupe_key text,
  attempts int not null default 0,
  retry_at timestamptz not null default now(),
  locked_until timestamptz,
  actor_type text not null check (actor_type in ('user', 'api_key', 'system')),
  actor_id text,
  request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists operations_active_dedupe on public.operations (workspace_id, dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');
create index if not exists operations_ws_created on public.operations (workspace_id, created_at desc);
create index if not exists operations_due on public.operations (retry_at) where status in ('queued', 'running');

-- Remembers the answer to a request that carried an Idempotency-Key, for 24 hours.
create table if not exists public.idempotency_keys (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 255),
  method text not null,
  path text not null,
  request_hash text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'done')),
  response_status int,
  response_body jsonb,
  operation_id uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, key)
);
create index if not exists idempotency_keys_created on public.idempotency_keys (created_at);

-- Who did what. The service can add rows and read them; it cannot change or delete them.
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'api_key', 'system')),
  actor_id text,
  action text not null,
  target_type text,
  target_id text,
  outcome text not null default 'ok' check (outcome in ('ok', 'failed', 'denied')),
  request_id text,
  ip text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_ws_at on public.audit_log (workspace_id, at desc);
create index if not exists audit_log_target on public.audit_log (workspace_id, target_type, target_id);

-- Tables created by Supabase's default privileges are open to anon and authenticated.
-- These three are for the service only.
alter table public.operations enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.operations, public.idempotency_keys, public.audit_log from public, anon, authenticated;

-- ---------------------------------------------------------------- the service's table rights

revoke all on all tables in schema public from fenvix_control_plane;

grant select, insert, update, delete on public.databases, public.database_tags to fenvix_control_plane;
grant select, insert, update, delete on public.usage_daily, public.usage_hourly to fenvix_control_plane;
grant select, insert on public.wake_events to fenvix_control_plane;
grant select on public.invoices, public.workspace_settings, public.workspaces to fenvix_control_plane;
grant update (name) on public.workspaces to fenvix_control_plane;
grant update (idle_minutes, email_notices, updated_at) on public.workspace_settings to fenvix_control_plane;
grant select, insert on public.api_keys to fenvix_control_plane;
grant update (last_used_at, revoked_at) on public.api_keys to fenvix_control_plane;
grant select, insert, update on public.operations to fenvix_control_plane;
grant select, insert, update, delete on public.idempotency_keys to fenvix_control_plane;
grant select, insert on public.audit_log to fenvix_control_plane;
grant usage on sequence public.wake_events_id_seq, public.audit_log_id_seq to fenvix_control_plane;

-- The workspace the service is acting for in the current transaction. Null (no rows) when unset.
create or replace function public.cp_workspace() returns uuid
language sql stable as $$
  select nullif(current_setting('app.workspace_id', true), '')::uuid
$$;
grant execute on function public.cp_workspace() to fenvix_control_plane;
revoke all on function public.cp_workspace() from public, anon, authenticated;

do $$
declare
  t text;
  col text;
begin
  foreach t in array array['databases', 'database_tags', 'usage_daily', 'usage_hourly', 'wake_events', 'invoices',
                           'workspace_settings', 'api_keys', 'operations', 'idempotency_keys', 'audit_log', 'workspaces']
  loop
    col := case when t = 'workspaces' then 'id' else 'workspace_id' end;
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_control_plane', t);
    execute format(
      'create policy %I on public.%I for all to fenvix_control_plane using (%I = public.cp_workspace()) with check (%I = public.cp_workspace())',
      t || '_control_plane', t, col, col);
  end loop;
end $$;

-- ---------------------------------------------------------------- the five cross-workspace functions
--
-- Owned by whoever runs this migration, so they see all rows; each returns only what the
-- service needs to pick a workspace, nothing else.

/** Who an API key belongs to. Revoked or unknown keys give no row. */
create or replace function public.fenvix_cp_resolve_api_key(p_hash text)
returns table (key_id uuid, workspace_id uuid, last_used_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select k.id, k.workspace_id, k.last_used_at
  from public.api_keys k
  where k.key_hash = p_hash and k.revoked_at is null
$$;

/** The workspace a signed-in user acts in (the oldest one, as current_workspace() does) and their role. */
create or replace function public.fenvix_cp_workspace_for_user(p_user uuid)
returns table (workspace_id uuid, role text)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id, m.role
  from public.workspace_members m
  where m.user_id = p_user
  order by m.created_at limit 1
$$;

/** Operations that are waiting to run, or whose runner stopped answering. */
create or replace function public.fenvix_cp_due_operations(p_limit int default 20)
returns table (id uuid, workspace_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select o.id, o.workspace_id
  from public.operations o
  where o.retry_at <= now()
    and (o.status = 'queued' or (o.status = 'running' and coalesce(o.locked_until, '-infinity') < now()))
  order by o.retry_at
  limit least(greatest(coalesce(p_limit, 20), 1), 200)
$$;

/** Workspaces that have databases to sync usage for. */
create or replace function public.fenvix_cp_sync_workspaces()
returns table (workspace_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct d.workspace_id from public.databases d where d.engine_state <> 'provisioning'
$$;

/** Housekeeping: old idempotency keys, hourly usage past its retention, finished operations past theirs. */
create or replace function public.fenvix_cp_prune(p_hourly_days int, p_operation_days int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a int; b int; c int;
begin
  delete from public.idempotency_keys where created_at < now() - interval '24 hours';
  get diagnostics a = row_count;
  delete from public.usage_hourly where hour < now() - make_interval(days => greatest(p_hourly_days, 2));
  get diagnostics b = row_count;
  delete from public.operations
   where status in ('succeeded', 'failed') and finished_at < now() - make_interval(days => greatest(p_operation_days, 1));
  get diagnostics c = row_count;
  return jsonb_build_object('idempotencyKeys', a, 'usageHourly', b, 'operations', c);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'fenvix_cp_resolve_api_key(text)', 'fenvix_cp_workspace_for_user(uuid)', 'fenvix_cp_due_operations(int)',
    'fenvix_cp_sync_workspaces()', 'fenvix_cp_prune(int,int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_control_plane', f);
  end loop;
end $$;

-- Nothing else is callable by the service: 0001 took every fenvix_* function away from PUBLIC, and
-- the service role is not a member of authenticated, so it cannot run the dashboard's functions.

notify pgrst, 'reload schema';
