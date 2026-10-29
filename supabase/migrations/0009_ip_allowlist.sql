-- FENVIX control plane, part 9: the IP allowlist of each database (control-plane/docs/network-allowlist.md).
-- Safe to run more than once. Run it AFTER 0002_control_plane.sql (0003, 0004, 0005, 0007 and 0008 may or may not be
-- there; 0006 is on another branch and is not needed). It stores no secret: network addresses only.
--
--   * public.database_ip_allowlists: one row per database that has, or had, a list. The networks are in the engine's
--     own form (10.0.0.0/8, 203.0.113.7/32, 2001:db8::/32), at most 100, no two the same. An empty list (or no row)
--     means every address is allowed. With the date and the author (person or API key) of the last change.
--     The engine holds the list that is actually checked (in the database's metadata); this table is the control
--     plane's copy, written only after the engine said yes, and compared with the engine's on every read.
--   * The row goes when its database row goes (an erase), and it is never copied by a fork.
--   * For the service only, under its policy "workspace = the one this transaction acts for", like 0002 and 0004.
--     Not the dashboard (it reads the list through the control plane), not anon.
--
-- Every change is recorded in public.audit_log (0002): database.ip_allowlist.set / .reapply with the entries before
-- and after, database.network.unblock with the address. Nothing else is stored about blocks: they live in the engine's
-- memory only.

-- The pair (id, workspace_id) of a database, so a list can only be filed under the workspace of its own database.
create unique index if not exists databases_id_workspace on public.databases (id, workspace_id);

create table if not exists public.database_ip_allowlists (
  database_id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  entries text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by_type text not null default 'system' check (updated_by_type in ('user', 'api_key', 'system')),
  -- A user id or an API key id (as text, like public.audit_log.actor_id). Null for the system.
  updated_by text,
  constraint database_ip_allowlists_database foreign key (database_id, workspace_id)
    references public.databases (id, workspace_id) on delete cascade,
  constraint database_ip_allowlists_max check (cardinality(entries) <= 100),
  -- The characters the engine accepts, and a prefix length on every entry (the engine's form always has one).
  -- The full rules (address syntax, no bits after the prefix, no duplicates) are checked by the control plane and the engine.
  constraint database_ip_allowlists_form check (
    array_to_string(entries, ',') ~ '^([0-9a-f.:]{1,45}/[0-9]{1,3}(,[0-9a-f.:]{1,45}/[0-9]{1,3})*)?$'
  )
);
create index if not exists database_ip_allowlists_ws on public.database_ip_allowlists (workspace_id);

alter table public.database_ip_allowlists enable row level security;
revoke all on public.database_ip_allowlists from public, anon, authenticated;

grant select, insert, update, delete on public.database_ip_allowlists to fenvix_control_plane;

drop policy if exists database_ip_allowlists_control_plane on public.database_ip_allowlists;
create policy database_ip_allowlists_control_plane on public.database_ip_allowlists for all to fenvix_control_plane
  using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace());

notify pgrst, 'reload schema';
