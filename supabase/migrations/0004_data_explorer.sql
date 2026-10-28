-- FENVIX control plane, part 4: the Data Explorer (control-plane/docs/data-explorer-security.md).
-- Safe to run more than once. Run it AFTER 0002_control_plane.sql. It does not depend on 0003 and does not run it.
--
--   * public.data_audit_log: one row per insert, save or delete the Data Explorer attempted, did, refused or lost to a
--     concurrent change. Who, which workspace, database, collection, operation, document _id, outcome, when.
--     Never the content of a document.
--   * public.api_keys.data_access: what an API key may do with documents. 'read' (the default, and what every key
--     that exists today becomes) or 'read_write'.

-- ---------------------------------------------------------------- API keys: data access

alter table public.api_keys add column if not exists data_access text not null default 'read';
alter table public.api_keys drop constraint if exists api_keys_data_access_check;
alter table public.api_keys add constraint api_keys_data_access_check check (data_access in ('read', 'read_write'));

-- ---------------------------------------------------------------- the audit log

create table if not exists public.data_audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'api_key')),
  actor_id text not null,
  -- No foreign key: the record stays when the database is erased.
  database_id uuid,
  collection text check (collection is null or char_length(collection) between 1 and 255),
  operation text not null check (operation in ('insert', 'replace', 'delete')),
  -- Canonical Extended JSON of the document's _id, at most 1024 characters. Never the document.
  document_id text check (document_id is null or char_length(document_id) <= 1024),
  outcome text not null check (outcome in ('attempted', 'ok', 'failed', 'conflict', 'denied')),
  request_id text
);
create index if not exists data_audit_log_ws_at on public.data_audit_log (workspace_id, at desc);
create index if not exists data_audit_log_db on public.data_audit_log (workspace_id, database_id, at desc);

-- For the service only: not the dashboard, not anon.
alter table public.data_audit_log enable row level security;
revoke all on public.data_audit_log from public, anon, authenticated;

-- The service can add rows and read them; it cannot change or delete them.
grant select, insert on public.data_audit_log to fenvix_control_plane;
revoke update, delete, truncate on public.data_audit_log from fenvix_control_plane;
grant usage on sequence public.data_audit_log_id_seq to fenvix_control_plane;

drop policy if exists data_audit_log_control_plane on public.data_audit_log;
create policy data_audit_log_control_plane on public.data_audit_log for all to fenvix_control_plane
  using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace());

notify pgrst, 'reload schema';
