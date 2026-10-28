-- Merges two accounts of ONE person (same verified address) into one: one user, one workspace.
-- NOT A MIGRATION. Nothing runs it automatically. Read docs/account-linking.md first.
--
-- Dry run (the default): does the whole merge inside a transaction, prints every step, then
-- ROLLS BACK. Nothing changes.
--
--   psql "$DATABASE_URL" -v keep_user=<uuid> -v drop_user=<uuid> -f supabase/account-merge/merge_accounts.sql
--
-- For real: the same, with -v execute=1. One transaction: if any step fails, nothing changes.
--
-- Options:
--   -v keep_workspace=<uuid>       which of the two workspaces survives (default: keep_user's own).
--                                  Keep the one whose databases people connect to: databases that
--                                  move get a new workspace, and with HOST_TEMPLATE (engine-adapter
--                                  branch) a new hostname.
--   -v on_name_conflict=rename     when both workspaces have a database with the same name, the
--                                  incoming one is renamed <name>-2 (or -3, ...). The default,
--                                  abort, stops and lists the names so a person can decide.
--
-- What it does, in order (every changed or deleted row is copied first into the schema
-- fenvix_account_merge, so undo_merge.sql can put it all back after a commit):
--   checks   both users exist; keep_user's address is confirmed and drop_user has the same address
--            verified (or drop_user is an unconfirmed shadow that never signed in, whose workspace
--            must then be empty); no operation of the outgoing workspace is queued or running; no
--            two-factor factors on drop_user; no invoice number or API key hash in both
--            workspaces; every table that points at a workspace or a user is one this file knows.
--   1        databases (renamed on a name conflict when asked), their tags, usage, wake events,
--            API keys, invoices, operations, audit log and data audit log move to the kept
--            workspace; idempotency keys that exist in both are dropped from the outgoing one
--            (they only cache answers for 24 hours).
--   2        the outgoing workspace's other members join the kept workspace with their role
--            (a member already there keeps theirs); keep_user is owner of the kept workspace and
--            gets drop_user's memberships elsewhere.
--   3        the outgoing workspace and its settings are deleted (the kept workspace's settings,
--            plan and billing address stay; the dry run prints both so you can compare).
--   4        drop_user's identities whose address the provider verified move to keep_user, so
--            GitHub or Google still signs in, now to the kept account. Unverified identities are
--            deleted with drop_user: an unverified identity must never reach an account.
--   5        drop_user is deleted (their sessions end). An audit entry records the merge.
\set ON_ERROR_STOP on
\set QUIET on
\if :{?keep_user}
\else
  \echo 'Set -v keep_user=<uuid> -v drop_user=<uuid>. See the top of this file.'
  \quit
\endif
\if :{?drop_user}
\else
  \echo 'Set -v drop_user=<uuid>.'
  \quit
\endif
\if :{?keep_workspace}
\else
  \set keep_workspace ''
\endif
\if :{?on_name_conflict}
\else
  \set on_name_conflict abort
\endif
\if :{?execute}
\else
  \set execute 0
\endif

begin;

create schema if not exists fenvix_account_merge;
revoke all on schema fenvix_account_merge from public;
do $$ begin
  execute 'revoke all on schema fenvix_account_merge from anon, authenticated, service_role';
exception when undefined_object then null; end $$;

create table if not exists fenvix_account_merge.merges (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  by_role text not null default current_user,
  keep_user uuid not null,
  drop_user uuid not null,
  keep_workspace uuid,
  drop_workspace uuid,
  plan jsonb not null default '{}'::jsonb,
  undone_at timestamptz
);
-- One row per changed row: its image BEFORE the merge. action: moved | deleted | inserted | updated.
create table if not exists fenvix_account_merge.rows (
  merge_id bigint not null references fenvix_account_merge.merges (id),
  seq bigint generated always as identity,
  tbl text not null,
  action text not null check (action in ('moved', 'deleted', 'inserted', 'updated')),
  image jsonb not null,
  primary key (merge_id, seq)
);

-- The tables this file knows how to move, with what makes a row unique within a workspace.
create or replace function pg_temp.known_tables() returns text[] language sql immutable as $$
  select array['workspaces', 'workspace_members', 'workspace_settings', 'databases', 'database_tags', 'usage_daily',
               'usage_hourly', 'wake_events', 'invoices', 'api_keys', 'operations', 'idempotency_keys', 'audit_log',
               'data_audit_log']
$$;

/** The oldest workspace a user is a member of: the one the dashboard opens (current_workspace()). */
create or replace function pg_temp.own_workspace(p_user uuid) returns uuid language sql stable as $$
  select m.workspace_id from public.workspace_members m where m.user_id = p_user order by m.created_at limit 1
$$;

/** Addresses a user has proved: the confirmed account address and every provider-verified identity address. */
create or replace function pg_temp.verified_addresses(p_user uuid) returns setof text language sql stable as $$
  select lower(u.email) from auth.users u where u.id = p_user and u.email is not null and u.email_confirmed_at is not null
  union
  select i.email from auth.identities i
  where i.user_id = p_user and i.email is not null and coalesce(lower(i.identity_data ->> 'email_verified') = 'true', false)
$$;

create or replace function pg_temp.say(p_msg text) returns void language plpgsql as $$
begin raise notice '%', p_msg; end $$;

/** Copies the rows `where` selects from public.<tbl> into the backup, then runs `change` on them. */
create or replace function pg_temp.backup(p_merge bigint, p_tbl text, p_action text, p_where text) returns bigint
language plpgsql as $$
declare n bigint;
begin
  execute format('insert into fenvix_account_merge.rows (merge_id, tbl, action, image) select $1, $2, $3, to_jsonb(t) from public.%I t where %s',
                 p_tbl, p_where) using p_merge, p_tbl, p_action;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function pg_temp.merge(p_keep uuid, p_drop uuid, p_keep_ws uuid, p_on_conflict text) returns bigint
language plpgsql as $$
declare
  keep_u auth.users%rowtype;
  drop_u auth.users%rowtype;
  shared text;
  shadow boolean;
  ws_k uuid;  -- kept workspace
  ws_d uuid;  -- outgoing workspace
  mid bigint;
  n bigint;
  t text;
  r record;
  unknown text;
  cand text;
  nth int;
  host_index boolean := to_regclass('public.databases_host_unique') is not null;
begin
  -- ------------------------------------------------------------ checks
  if p_keep = p_drop then raise exception 'keep_user and drop_user are the same user'; end if;
  select * into keep_u from auth.users where id = p_keep;
  if not found then raise exception 'keep_user % does not exist', p_keep; end if;
  select * into drop_u from auth.users where id = p_drop;
  if not found then raise exception 'drop_user % does not exist', p_drop; end if;
  if keep_u.email is null or keep_u.email_confirmed_at is null then
    raise exception 'keep_user must have a confirmed address (it is the account the person signs in to)';
  end if;

  shadow := drop_u.email_confirmed_at is null and drop_u.last_sign_in_at is null;
  select a into shared from pg_temp.verified_addresses(p_keep) a
    where a in (select v from pg_temp.verified_addresses(p_drop) v) limit 1;
  if shared is null and shadow then
    -- a shadow carries the address on an identity the provider did not verify
    select i.email into shared from auth.identities i
      where i.user_id = p_drop and i.email in (select a from pg_temp.verified_addresses(p_keep) a) limit 1;
  end if;
  if shared is null then
    raise exception 'the two users share no verified address: they may be two people. Nothing was changed.';
  end if;

  if exists (select 1 from auth.mfa_factors f where f.user_id = p_drop) then
    raise exception 'drop_user has two-factor factors; remove them first';
  end if;

  ws_k := pg_temp.own_workspace(p_keep);
  ws_d := pg_temp.own_workspace(p_drop);
  if p_keep_ws is not null then
    if p_keep_ws = ws_d then ws_d := ws_k; ws_k := p_keep_ws;
    elsif p_keep_ws is distinct from ws_k then raise exception 'keep_workspace must be the workspace of keep_user or of drop_user';
    end if;
  end if;
  if ws_k is null then ws_k := ws_d; ws_d := null; end if;
  if ws_k is null then raise exception 'neither user has a workspace'; end if;
  if ws_d = ws_k then raise exception 'both users open the same workspace; nothing to merge there'; end if;

  -- every table that points at a workspace or a user must be one this file knows
  select string_agg(distinct format('%I.%I', s.nspname, k.relname), ', ') into unknown
  from pg_constraint c join pg_class k on k.oid = c.conrelid join pg_namespace s on s.oid = k.relnamespace
  where c.contype = 'f' and s.nspname = 'public'
    and c.confrelid in ('public.workspaces'::regclass, 'auth.users'::regclass)
    and k.relname <> all (pg_temp.known_tables());
  if unknown is null then
    select string_agg(distinct format('%I.%I', table_schema, table_name), ', ') into unknown
    from information_schema.columns
    where table_schema = 'public' and column_name = 'workspace_id' and table_name <> all (pg_temp.known_tables())
      and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE');
  end if;
  if unknown is not null then
    raise exception 'tables this file does not know point at workspaces or users: %. Teach known_tables() and the moves below about them first.', unknown;
  end if;

  if ws_d is not null then
    if shadow and (exists (select 1 from public.databases where workspace_id = ws_d)
                   or exists (select 1 from public.api_keys where workspace_id = ws_d)
                   or exists (select 1 from public.invoices where workspace_id = ws_d)) then
      raise exception 'drop_user never signed in, yet its workspace has data. Look at it by hand.';
    end if;
    if exists (select 1 from public.operations where workspace_id = ws_d and status in ('queued', 'running')) then
      raise exception 'the outgoing workspace has operations queued or running; wait for them to finish';
    end if;
    select string_agg(x.number, ', ') into unknown from public.invoices x
      where x.workspace_id = ws_d and x.number in (select number from public.invoices where workspace_id = ws_k);
    if unknown is not null then raise exception 'invoice numbers in both workspaces: %. Billing records are not renumbered here.', unknown; end if;
    if exists (select 1 from public.api_keys x where x.workspace_id = ws_d and x.key_hash in (select key_hash from public.api_keys where workspace_id = ws_k)) then
      raise exception 'the same API key is in both workspaces';
    end if;
    select string_agg(x.name, ', ' order by x.name) into unknown from public.databases x
      where x.workspace_id = ws_d and x.name in (select name from public.databases where workspace_id = ws_k);
    if unknown is not null and p_on_conflict <> 'rename' then
      raise exception 'databases with the same name in both workspaces: %. Rename them, or run again with -v on_name_conflict=rename.', unknown;
    end if;
  end if;

  insert into fenvix_account_merge.merges (keep_user, drop_user, keep_workspace, drop_workspace, plan)
  values (p_keep, p_drop, ws_k, ws_d, jsonb_build_object('shared_address', shared, 'drop_user_was_shadow', shadow, 'on_name_conflict', p_on_conflict))
  returning id into mid;

  perform pg_temp.say(format('merge #%s: keep user %s <%s>, drop user %s <%s>%s; shared verified address %s',
    mid, p_keep, keep_u.email, p_drop, coalesce(drop_u.email, 'no address'), case when shadow then ' (unconfirmed shadow)' else '' end, shared));
  perform pg_temp.say(format('workspace kept: %s "%s"; workspace removed: %s "%s"',
    ws_k, (select name from public.workspaces where id = ws_k), coalesce(ws_d::text, '(none)'), coalesce((select name from public.workspaces where id = ws_d), '')));

  if ws_d is not null then
    for r in select 'kept' as which, s.* from public.workspace_settings s where s.workspace_id = ws_k
             union all select 'removed', s.* from public.workspace_settings s where s.workspace_id = ws_d loop
      perform pg_temp.say(format('  settings %s: plan %s, idle %s min, notices %s, billing %s, card %s %s',
        r.which, r.plan, r.idle_minutes, r.email_notices, coalesce(r.billing_email, '-'), r.payment_brand, r.payment_last4));
    end loop;

    -- ---------------------------------------------------------- 1. data
    -- Every row's image before any change, so undo puts back names and workspaces exactly.
    n := pg_temp.backup(mid, 'databases', 'moved', format('workspace_id = %L', ws_d));
    perform pg_temp.say(format('1. databases moving: %s', n));
    for r in select d.id, d.name from public.databases d
             where d.workspace_id = ws_d and d.name in (select name from public.databases where workspace_id = ws_k) order by d.name loop
      nth := 2;
      loop
        cand := rtrim(left(r.name, 48 - length('-' || nth)), '-') || '-' || nth;
        exit when not exists (select 1 from public.databases x where x.name = cand and x.workspace_id in (ws_k, ws_d))
              and (not host_index or not exists (select 1 from public.databases x where x.name = cand
                     and left(replace(x.workspace_id::text, '-', ''), 8) = left(replace(ws_k::text, '-', ''), 8)));
        nth := nth + 1;
      end loop;
      update public.databases set name = cand where id = r.id;
      perform pg_temp.say(format('   renamed: %s -> %s (id %s)', r.name, cand, r.id));
    end loop;
    if host_index then
      perform pg_temp.say('   NOTE: hostnames contain the workspace code; every moved database gets a new hostname. Tell the person before running this for real.');
    end if;
    update public.databases set workspace_id = ws_k where workspace_id = ws_d;

    -- idempotency keys present in both: the outgoing copies go (24 hour caches of answers)
    n := pg_temp.backup(mid, 'idempotency_keys', 'deleted',
           format('workspace_id = %L and key in (select key from public.idempotency_keys where workspace_id = %L)', ws_d, ws_k));
    delete from public.idempotency_keys where workspace_id = ws_d and key in (select key from public.idempotency_keys where workspace_id = ws_k);
    if n > 0 then perform pg_temp.say(format('   idempotency keys in both workspaces, dropped from the outgoing one: %s', n)); end if;

    foreach t in array array['database_tags', 'usage_daily', 'usage_hourly', 'wake_events', 'api_keys', 'invoices',
                             'operations', 'idempotency_keys', 'audit_log', 'data_audit_log'] loop
      if to_regclass('public.' || t) is null then continue; end if;
      n := pg_temp.backup(mid, t, 'moved', format('workspace_id = %L', ws_d));
      execute format('update public.%I set workspace_id = $1 where workspace_id = $2', t) using ws_k, ws_d;
      perform pg_temp.say(format('   %s moving: %s', t, n));
    end loop;

    -- ---------------------------------------------------------- 2. members
    for r in select m.* from public.workspace_members m
             where m.workspace_id = ws_d and m.user_id not in (p_keep, p_drop)
               and not exists (select 1 from public.workspace_members x where x.workspace_id = ws_k and x.user_id = m.user_id) loop
      insert into public.workspace_members (workspace_id, user_id, role, created_at) values (ws_k, r.user_id, r.role, r.created_at);
      insert into fenvix_account_merge.rows (merge_id, tbl, action, image)
        select mid, 'workspace_members', 'inserted', to_jsonb(m) from public.workspace_members m where m.workspace_id = ws_k and m.user_id = r.user_id;
      perform pg_temp.say(format('2. member %s joins the kept workspace as %s', r.user_id, r.role));
    end loop;
  end if;

  if not exists (select 1 from public.workspace_members where workspace_id = ws_k and user_id = p_keep) then
    insert into public.workspace_members (workspace_id, user_id, role, created_at)
      values (ws_k, p_keep, 'owner', coalesce((select min(created_at) from public.workspace_members where user_id in (p_keep, p_drop)), now()));
    insert into fenvix_account_merge.rows (merge_id, tbl, action, image)
      select mid, 'workspace_members', 'inserted', to_jsonb(m) from public.workspace_members m where m.workspace_id = ws_k and m.user_id = p_keep;
    perform pg_temp.say('2. keep_user becomes owner of the kept workspace');
  elsif (select role from public.workspace_members where workspace_id = ws_k and user_id = p_keep) <> 'owner' then
    perform pg_temp.backup(mid, 'workspace_members', 'updated', format('workspace_id = %L and user_id = %L', ws_k, p_keep));
    update public.workspace_members set role = 'owner' where workspace_id = ws_k and user_id = p_keep;
    perform pg_temp.say('2. keep_user becomes owner of the kept workspace');
  end if;
  for r in select m.* from public.workspace_members m
           where m.user_id = p_drop and m.workspace_id not in (ws_k, coalesce(ws_d, ws_k))
             and not exists (select 1 from public.workspace_members x where x.workspace_id = m.workspace_id and x.user_id = p_keep) loop
    insert into public.workspace_members (workspace_id, user_id, role, created_at) values (r.workspace_id, p_keep, r.role, r.created_at);
    insert into fenvix_account_merge.rows (merge_id, tbl, action, image)
      select mid, 'workspace_members', 'inserted', to_jsonb(m) from public.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = p_keep;
    perform pg_temp.say(format('2. keep_user takes over drop_user''s membership of workspace %s as %s', r.workspace_id, r.role));
  end loop;

  -- ------------------------------------------------------------ 3. the outgoing workspace
  if ws_d is not null then
    perform pg_temp.backup(mid, 'workspace_members', 'deleted', format('workspace_id = %L', ws_d));
    perform pg_temp.backup(mid, 'workspace_settings', 'deleted', format('workspace_id = %L', ws_d));
    perform pg_temp.backup(mid, 'workspaces', 'deleted', format('id = %L', ws_d));
    delete from public.workspaces where id = ws_d;
    perform pg_temp.say(format('3. workspace %s deleted with its settings and memberships', ws_d));
  end if;
  -- drop_user's other memberships go with the user (step 5); keep a copy
  perform pg_temp.backup(mid, 'workspace_members', 'deleted', format('user_id = %L', p_drop));

  -- ------------------------------------------------------------ 4. identities
  insert into fenvix_account_merge.rows (merge_id, tbl, action, image)
    select mid, 'auth.identities', case when coalesce(lower(i.identity_data ->> 'email_verified') = 'true', false) then 'moved' else 'deleted' end, to_jsonb(i)
    from auth.identities i where i.user_id = p_drop;
  for r in select i.id, i.provider, i.email, coalesce(lower(i.identity_data ->> 'email_verified') = 'true', false) as verified
           from auth.identities i where i.user_id = p_drop order by i.created_at loop
    if r.verified then
      update auth.identities set user_id = p_keep, updated_at = now() where id = r.id;
      perform pg_temp.say(format('4. identity %s <%s> moves to keep_user', r.provider, r.email));
    else
      perform pg_temp.say(format('4. identity %s <%s> is unverified: deleted with drop_user', r.provider, r.email));
    end if;
  end loop;
  insert into fenvix_account_merge.rows (merge_id, tbl, action, image)
    select mid, 'auth.users.raw_app_meta_data', 'updated', jsonb_build_object('id', u.id, 'raw_app_meta_data', u.raw_app_meta_data) from auth.users u where u.id = p_keep;
  update auth.users u set raw_app_meta_data = jsonb_set(coalesce(u.raw_app_meta_data, '{}'::jsonb), '{providers}',
      coalesce((select jsonb_agg(distinct i.provider) from auth.identities i where i.user_id = p_keep), '[]'::jsonb))
    where u.id = p_keep;

  -- ------------------------------------------------------------ 5. the duplicate user
  insert into fenvix_account_merge.rows (merge_id, tbl, action, image)
    select mid, 'auth.users', 'deleted', to_jsonb(u) from auth.users u where u.id = p_drop;
  delete from auth.users where id = p_drop;
  perform pg_temp.say(format('5. user %s deleted (their sessions end)', p_drop));

  insert into public.audit_log (workspace_id, actor_type, actor_id, action, target_type, target_id, metadata)
    values (ws_k, 'system', 'account-merge', 'account.merged', 'user', p_drop::text,
            jsonb_build_object('merge_id', mid, 'kept_user', p_keep, 'removed_workspace', ws_d));
  insert into fenvix_account_merge.rows (merge_id, tbl, action, image)
    select mid, 'audit_log', 'inserted', to_jsonb(a) from public.audit_log a
    where a.workspace_id = ws_k and a.action = 'account.merged' and a.metadata ->> 'merge_id' = mid::text;

  perform pg_temp.say(format('done: user %s now has %s identities and opens workspace %s with %s databases',
    p_keep, (select count(*) from auth.identities where user_id = p_keep), pg_temp.own_workspace(p_keep),
    (select count(*) from public.databases where workspace_id = ws_k)));
  return mid;
end $$;

select pg_temp.merge(:'keep_user'::uuid, :'drop_user'::uuid, nullif(:'keep_workspace', '')::uuid, :'on_name_conflict') as merge_id \gset

\if :execute
  commit;
  \echo 'COMMITTED. Merge id' :merge_id '- to put it back: psql -v merge_id=' :merge_id ' -v execute=1 -f supabase/account-merge/undo_merge.sql'
\else
  rollback;
  \echo 'DRY RUN: everything above was rolled back, nothing changed. Run again with -v execute=1 to do it.'
\endif
