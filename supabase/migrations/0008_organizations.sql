-- FENVIX control plane, part 8: organizations (control-plane/docs/organizations.md).
-- Safe to run more than once. Run it AFTER 0001_init.sql and 0002_control_plane.sql (0003, 0004, 0005 and 0007 may
-- or may not be there; 0006 is on another branch and is not needed). It changes no authentication trigger: the
-- workspace made at sign-up (handle_new_user / ensure_workspace) is made exactly as before.
--
--   * public.workspaces.name_confirmed: false until an owner or admin has chosen the name (the sign-up trigger makes
--     the workspace with a name it guessed). Every workspace that exists today becomes false too.
--   * public.workspace_invites: invitations. Only a SHA-256 hash of the token is kept; the token itself is shown once to
--     the person who invites and is never stored.
--   * Roles in row level security: a signed-in user changes rows only in workspaces where they are owner or admin
--     (member is read only), and only owner or admin can rename a workspace.
--   * The organization the browser picks (header X-Fenvix-Workspace) is honoured by current_workspace() only when the
--     caller is a member of it.
--   * The control plane gets the rights it needs on workspace_members, workspaces and workspace_invites, always under
--     its policy "workspace = the one this transaction acts for", plus four narrow functions.
--   * A workspace can never lose its last owner (trigger), whoever tries.

-- ---------------------------------------------------------------- workspaces

alter table public.workspaces add column if not exists name_confirmed boolean not null default false;

-- Names up to 64 characters (the organization name screen allows 2 to 64; older names of 1 character stay valid).
alter table public.workspaces drop constraint if exists workspaces_name_check;
alter table public.workspaces drop constraint if exists workspaces_name_length;
alter table public.workspaces add constraint workspaces_name_length check (char_length(name) between 1 and 64);

-- ---------------------------------------------------------------- invitations

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  -- Lower case. Only the person whose verified e-mail is exactly this can accept.
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  role text not null check (role in ('admin', 'member')),
  -- SHA-256 of the token, hex. The token is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  check (expires_at > created_at),
  check (accepted_at is null or revoked_at is null)
);
create index if not exists workspace_invites_ws_created on public.workspace_invites (workspace_id, created_at desc);
create index if not exists workspace_invites_ws_email on public.workspace_invites (workspace_id, email);

-- For the service only: not the dashboard, not anon.
alter table public.workspace_invites enable row level security;
revoke all on public.workspace_invites from public, anon, authenticated;

-- ---------------------------------------------------------------- roles in row level security

/** Workspaces where the caller is owner or admin. Like my_workspace_ids(), evaluated once per query. */
create or replace function public.my_admin_workspace_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
$$;
revoke all on function public.my_admin_workspace_ids() from public, anon;
grant execute on function public.my_admin_workspace_ids() to authenticated, service_role;

-- Every write policy for signed-in users (0001 made them for any member; 0003, if applied, dropped some) now needs
-- owner or admin. Reading stays open to every member.
do $$
declare t text;
begin
  foreach t in array array['workspace_settings', 'databases', 'database_tags', 'usage_daily', 'usage_hourly', 'wake_events', 'invoices', 'api_keys']
  loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_member_write') then
      execute format(
        'alter policy %I on public.%I using (workspace_id in (select public.my_admin_workspace_ids())) with check (workspace_id in (select public.my_admin_workspace_ids()))',
        t || '_member_write', t);
    end if;
  end loop;
end $$;

drop policy if exists workspaces_member_update on public.workspaces;
create policy workspaces_member_update on public.workspaces
  for update to authenticated
  using (id in (select public.my_admin_workspace_ids()))
  with check (id in (select public.my_admin_workspace_ids()));

-- A signed-in user cannot flip name_confirmed or anything else but the name through Supabase.
revoke update on public.workspaces from authenticated;
grant update (name) on public.workspaces to authenticated;

-- ---------------------------------------------------------------- the organization the browser picked

/**
 * The workspace of the caller. The dashboard names the organization it shows in the header X-Fenvix-Workspace;
 * it is used only when the caller is a member of it. Otherwise (no header, a malformed one, or one the caller is not
 * a member of) the oldest membership, as before.
 */
create or replace function public.current_workspace() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_pick text;
  v_ws uuid;
begin
  begin
    v_pick := lower(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-fenvix-workspace');
  exception when others then
    v_pick := null;
  end;
  if v_pick ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select m.workspace_id into v_ws from public.workspace_members m
     where m.user_id = (select auth.uid()) and m.workspace_id = v_pick::uuid;
    if v_ws is not null then
      return v_ws;
    end if;
  end if;
  select m.workspace_id into v_ws from public.workspace_members m
   where m.user_id = (select auth.uid()) order by m.created_at, m.workspace_id limit 1;
  return v_ws;
end $$;
revoke all on function public.current_workspace() from public, anon;
grant execute on function public.current_workspace() to authenticated, service_role;

-- ---------------------------------------------------------------- a workspace keeps an owner

create or replace function public.keep_one_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_check boolean := old.role = 'owner';
begin
  if v_check and tg_op = 'UPDATE' and new.role = 'owner' and new.workspace_id = old.workspace_id then
    v_check := false;
  end if;
  -- The workspace or the account itself is going away (on delete cascade): nothing to keep.
  if v_check and (not exists (select 1 from public.workspaces w where w.id = old.workspace_id)
                  or not exists (select 1 from auth.users u where u.id = old.user_id)) then
    v_check := false;
  end if;
  if v_check and not exists (
    select 1 from public.workspace_members m
     where m.workspace_id = old.workspace_id and m.role = 'owner' and m.user_id <> old.user_id
  ) then
    raise exception 'An organization needs at least one owner. Make someone else an owner first.' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
revoke all on function public.keep_one_owner() from public, anon, authenticated;

drop trigger if exists workspace_members_keep_owner on public.workspace_members;
create trigger workspace_members_keep_owner before update or delete on public.workspace_members
  for each row execute function public.keep_one_owner();

-- ---------------------------------------------------------------- the control plane's rights

grant select, insert, delete on public.workspace_members to fenvix_control_plane;
grant update (role) on public.workspace_members to fenvix_control_plane;
grant insert on public.workspaces to fenvix_control_plane;
grant update (name, name_confirmed) on public.workspaces to fenvix_control_plane;
grant insert on public.workspace_settings to fenvix_control_plane;
grant select, insert on public.workspace_invites to fenvix_control_plane;
grant update (accepted_at, accepted_by, revoked_at, revoked_by) on public.workspace_invites to fenvix_control_plane;
revoke delete, truncate on public.workspace_invites from fenvix_control_plane;

do $$
declare t text;
begin
  foreach t in array array['workspace_members', 'workspace_invites']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_control_plane', t);
    execute format(
      'create policy %I on public.%I for all to fenvix_control_plane using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace())',
      t || '_control_plane', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- four narrow functions for the control plane

/** The organizations of one user, oldest membership first: id, name, the user's role, whether the name is confirmed. */
create or replace function public.fenvix_cp_memberships(p_user uuid)
returns table (workspace_id uuid, name text, role text, name_confirmed boolean, joined_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id, w.name, m.role, w.name_confirmed, m.created_at
  from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
  where m.user_id = p_user
  order by m.created_at, m.workspace_id
$$;

/** The e-mail of an account and whether it is verified. Nothing else about the account. */
create or replace function public.fenvix_cp_user_email(p_user uuid)
returns table (email text, verified boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select lower(u.email), u.email_confirmed_at is not null from auth.users u where u.id = p_user
$$;

/** Which workspace an invitation token hash belongs to. Its id and workspace only; the rest is read under RLS. */
create or replace function public.fenvix_cp_find_invite(p_hash text)
returns table (id uuid, workspace_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, i.workspace_id from public.workspace_invites i where i.token_hash = p_hash
$$;

/** The members of the workspace the control plane acts for in this transaction, with e-mail and display name. */
create or replace function public.fenvix_cp_members()
returns table (user_id uuid, role text, joined_at timestamptz, email text, name text)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.user_id, m.role, m.created_at, lower(u.email),
         coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(u.raw_user_meta_data ->> 'name'), ''), split_part(coalesce(u.email, ''), '@', 1))
  from public.workspace_members m join auth.users u on u.id = m.user_id
  where m.workspace_id = public.cp_workspace()
  order by m.created_at, m.user_id
$$;

do $$
declare f text;
begin
  foreach f in array array['fenvix_cp_memberships(uuid)', 'fenvix_cp_user_email(uuid)', 'fenvix_cp_find_invite(text)', 'fenvix_cp_members()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_control_plane', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
