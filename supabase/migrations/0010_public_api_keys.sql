-- FENVIX control plane, part 10: API keys of the public API (control-plane/docs/public-api.md).
-- Safe to run more than once. Run it AFTER 0002_control_plane.sql (and 0008_organizations.sql). It stores no secret.
--
--   * public.public_api_keys: one row per key of the public API (`Authorization: Bearer fvx_...`). A key belongs to one
--     organization (workspace) and has one role: 'admin' (acts like an organization admin) or 'read_only' (acts like a
--     member: reading only). Only the SHA-256 of the whole key (hex) and a short display prefix (`fvx_` and the next
--     8 characters) are stored; the key itself is shown once, in the answer that creates it, and kept by nobody.
--   * Separate from public.api_keys (0001), which holds the dashboard's older `fnx_` keys with their own permissions
--     (data_access, user_access). Those keep working on the dashboard routes exactly as before; this file does not
--     touch them.
--   * Row level security is on. The table is for the control plane's service role (fenvix_control_plane, 0002) only,
--     under its usual policy "workspace = the one this transaction acts for". anon and authenticated (the dashboard's
--     Supabase roles) get nothing: not even a read. Supabase's own service_role keeps what Supabase gives it.
--   * Finding a key by its hash looks across workspaces, so it goes through one narrow function,
--     fenvix_cp_resolve_public_api_key, like fenvix_cp_resolve_api_key in 0002. It returns revoked and expired keys too,
--     so the service can refuse them AND record the refused attempt in that workspace's audit log.
--
--   * Keys do not outlive their creator: triggers at the end revoke a person's admin keys when they leave the
--     organization or drop below admin, and every key made by a key when that key is revoked.
--
-- Every create, revoke and refused sign-in is recorded in public.audit_log (0002): api_key.public.create,
-- api_key.public.revoke, api_key.public.auth_failed.

create table if not exists public.public_api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  role text not null check (role in ('admin', 'read_only')),
  -- SHA-256 of the whole key, hex. The key itself is never stored.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  -- What people see to tell keys apart: 'fvx_' and the next 8 characters of the key.
  prefix text not null check (prefix ~ '^fvx_[A-Za-z0-9_-]{8}$'),
  created_at timestamptz not null default now(),
  -- Who made it: a person (user id) or another key (key id), as text like public.audit_log.actor_id.
  created_by_type text not null check (created_by_type in ('user', 'api_key')),
  created_by text not null,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  check (expires_at is null or expires_at > created_at)
);
create index if not exists public_api_keys_ws_created on public.public_api_keys (workspace_id, created_at desc, id desc);

alter table public.public_api_keys enable row level security;
-- Supabase's default privileges open new tables to anon and authenticated: close it.
revoke all on public.public_api_keys from public, anon, authenticated;

grant select, insert on public.public_api_keys to fenvix_control_plane;
grant update (last_used_at, revoked_at) on public.public_api_keys to fenvix_control_plane;

drop policy if exists public_api_keys_control_plane on public.public_api_keys;
create policy public_api_keys_control_plane on public.public_api_keys for all to fenvix_control_plane
  using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace());

/** Who a public API key belongs to, by its hash. Revoked and expired keys are returned too (the service refuses them). */
create or replace function public.fenvix_cp_resolve_public_api_key(p_hash text)
returns table (key_id uuid, workspace_id uuid, role text, expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select k.id, k.workspace_id, k.role, k.expires_at, k.revoked_at, k.last_used_at
  from public.public_api_keys k
  where k.key_hash = p_hash
$$;

revoke all on function public.fenvix_cp_resolve_public_api_key(text) from public, anon, authenticated;
grant execute on function public.fenvix_cp_resolve_public_api_key(text) to fenvix_control_plane;

-- ---------------------------------------------------------------- keys do not outlive their creator
--
-- In Postgres rather than in the service, so it holds however the change is made (the control plane's routes, an
-- account deletion, the Supabase SQL editor):
--   * a person who leaves or is removed from an organization, or whose role drops below admin: the ADMIN keys they
--     made in that organization are revoked (their read-only keys stay);
--   * a key that is revoked: every key it made is revoked too (and so on down).
-- Each revoke gets an audit row: api_key.public.revoke by 'system', with metadata.reason and metadata.creator.
-- Nothing happens when the whole organization is being deleted (its keys and audit rows go with it).

create or replace function public.public_api_keys_revoke(p_ws uuid, p_ids uuid[], p_reason text, p_creator text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare k uuid;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  if not exists (select 1 from public.workspaces where id = p_ws) then return; end if;
  for k in
    update public.public_api_keys set revoked_at = now()
     where workspace_id = p_ws and id = any(p_ids) and revoked_at is null
    returning id
  loop
    insert into public.audit_log (workspace_id, actor_type, actor_id, action, target_type, target_id, outcome, metadata)
    values (p_ws, 'system', null, 'api_key.public.revoke', 'public_api_key', k::text, 'ok',
            jsonb_build_object('reason', p_reason, 'creator', p_creator));
  end loop;
end $$;
revoke all on function public.public_api_keys_revoke(uuid, uuid[], text, text) from public, anon, authenticated;

create or replace function public.public_api_keys_on_membership() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or (old.role in ('owner', 'admin') and new.role not in ('owner', 'admin')) then
    perform public.public_api_keys_revoke(
      old.workspace_id,
      array(select id from public.public_api_keys
             where workspace_id = old.workspace_id and created_by_type = 'user' and created_by = old.user_id::text
               and role = 'admin' and revoked_at is null),
      case when tg_op = 'DELETE' then 'creator_removed' else 'creator_demoted' end,
      old.user_id::text);
  end if;
  return null;
end $$;
revoke all on function public.public_api_keys_on_membership() from public, anon, authenticated;

drop trigger if exists workspace_members_revoke_public_keys on public.workspace_members;
create trigger workspace_members_revoke_public_keys after update of role or delete on public.workspace_members
  for each row execute function public.public_api_keys_on_membership();

create or replace function public.public_api_keys_on_revoke() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    perform public.public_api_keys_revoke(
      new.workspace_id,
      array(select id from public.public_api_keys
             where workspace_id = new.workspace_id and created_by_type = 'api_key' and created_by = new.id::text and revoked_at is null),
      'creator_revoked',
      new.id::text);
  end if;
  return null;
end $$;
revoke all on function public.public_api_keys_on_revoke() from public, anon, authenticated;

drop trigger if exists public_api_keys_cascade_revoke on public.public_api_keys;
create trigger public_api_keys_cascade_revoke after update of revoked_at on public.public_api_keys
  for each row execute function public.public_api_keys_on_revoke();

notify pgrst, 'reload schema';
