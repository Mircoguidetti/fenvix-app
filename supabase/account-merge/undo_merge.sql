-- Puts back a merge made by merge_accounts.sql, from the copies it kept in fenvix_account_merge.
-- NOT A MIGRATION. Dry run by default (rolled back); -v execute=1 to do it, in one transaction.
--
--   psql "$DATABASE_URL" -v merge_id=<n> -f supabase/account-merge/undo_merge.sql
--   psql "$DATABASE_URL" -v merge_id=<n> -v execute=1 -f supabase/account-merge/undo_merge.sql
--
-- Restores the removed user and workspace with their original ids, settings and members; moves
-- every row back (databases get their original names); gives the identities back; removes what the
-- merge added. Not restored: the removed user's sessions (they sign in again). Rows created in the
-- kept workspace AFTER the merge stay where they are; the dry run counts them.
\set ON_ERROR_STOP on
\set QUIET on
\if :{?merge_id}
\else
  \echo 'Set -v merge_id=<n> (printed by merge_accounts.sql; also in fenvix_account_merge.merges).'
  \quit
\endif
\if :{?execute}
\else
  \set execute 0
\endif

begin;
-- The account linking rules (0006) and the workspace trigger stand aside for this transaction:
-- these rows existed before and are put back exactly as they were.
set local fenvix.account_merge = 'on';

/** Columns an insert may set: not generated, not dropped. */
create or replace function pg_temp.cols(p_tbl regclass) returns text language sql stable as $$
  select string_agg(quote_ident(attname), ', ' order by attnum) from pg_attribute
  where attrelid = p_tbl and attnum > 0 and not attisdropped and attgenerated = ''
$$;
/** The primary key columns, as "a, b". */
create or replace function pg_temp.pk(p_tbl regclass) returns text language sql stable as $$
  select string_agg(quote_ident(a.attname), ', ' order by array_position(i.indkey::int2[], a.attnum))
  from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
  where i.indrelid = p_tbl and i.indisprimary
$$;
create or replace function pg_temp.reinsert(p_tbl regclass, p_image jsonb) returns void language plpgsql as $$
begin
  execute format('insert into %s (%s) overriding system value select %2$s from jsonb_populate_record(null::%1$s, $1)',
                 p_tbl, pg_temp.cols(p_tbl)) using p_image;
end $$;

create or replace function pg_temp.undo(p_merge bigint) returns void language plpgsql as $$
declare
  m fenvix_account_merge.merges%rowtype;
  r record;
  n bigint;
  later bigint;
begin
  select * into m from fenvix_account_merge.merges where id = p_merge for update;
  if not found then raise exception 'no merge #%', p_merge; end if;
  if m.undone_at is not null then raise exception 'merge #% was already undone at %', p_merge, m.undone_at; end if;
  if exists (select 1 from auth.users where id = m.drop_user) then raise exception 'user % exists again; undo by hand', m.drop_user; end if;
  if m.drop_workspace is not null and exists (select 1 from public.workspaces where id = m.drop_workspace) then
    raise exception 'workspace % exists again; undo by hand', m.drop_workspace;
  end if;
  raise notice 'undoing merge #% of % into % (made %)', p_merge, m.drop_user, m.keep_user, m.at;

  -- what the merge added
  for r in select image from fenvix_account_merge.rows where merge_id = p_merge and action = 'inserted' and tbl = 'audit_log' loop
    delete from public.audit_log where id = (r.image ->> 'id')::bigint;
  end loop;
  for r in select image from fenvix_account_merge.rows where merge_id = p_merge and action = 'inserted' and tbl = 'workspace_members' loop
    delete from public.workspace_members where workspace_id = (r.image ->> 'workspace_id')::uuid and user_id = (r.image ->> 'user_id')::uuid;
  end loop;

  -- the user, then what hangs off it
  for r in select image from fenvix_account_merge.rows where merge_id = p_merge and tbl = 'auth.users' loop
    perform pg_temp.reinsert('auth.users', r.image);
  end loop;
  for r in select image from fenvix_account_merge.rows where merge_id = p_merge and tbl = 'auth.users.raw_app_meta_data' loop
    update auth.users set raw_app_meta_data = r.image -> 'raw_app_meta_data' where id = (r.image ->> 'id')::uuid;
  end loop;
  for r in select action, image from fenvix_account_merge.rows where merge_id = p_merge and tbl = 'auth.identities' loop
    if r.action = 'moved' then
      update auth.identities set user_id = (r.image ->> 'user_id')::uuid, updated_at = (r.image ->> 'updated_at')::timestamptz
        where id = (r.image ->> 'id')::uuid;
    else
      perform pg_temp.reinsert('auth.identities', r.image);
    end if;
  end loop;

  -- the workspace and its settings and members
  for r in select tbl, image from fenvix_account_merge.rows where merge_id = p_merge and action = 'deleted'
           and tbl in ('workspaces', 'workspace_settings', 'workspace_members') order by array_position(array['workspaces', 'workspace_settings', 'workspace_members'], tbl), seq loop
    perform pg_temp.reinsert(('public.' || r.tbl)::regclass, r.image);
  end loop;
  for r in select image from fenvix_account_merge.rows where merge_id = p_merge and action = 'updated' and tbl = 'workspace_members' loop
    update public.workspace_members set role = r.image ->> 'role'
      where workspace_id = (r.image ->> 'workspace_id')::uuid and user_id = (r.image ->> 'user_id')::uuid;
  end loop;

  -- every moved row back to its workspace (databases also get their original names)
  for r in select tbl, count(*) as n from fenvix_account_merge.rows where merge_id = p_merge and action = 'moved' and tbl not like 'auth.%'
           group by tbl order by (tbl <> 'databases'), tbl loop
    execute format(
      'update public.%1$I t set workspace_id = x.workspace_id %2$s
         from (select (jsonb_populate_record(null::public.%1$I, b.image)).* from fenvix_account_merge.rows b
               where b.merge_id = $1 and b.tbl = %3$L and b.action = ''moved'') x
        where %4$s',
      r.tbl, case when r.tbl = 'databases' then ', name = x.name' else '' end, r.tbl,
      -- the row is found by its primary key; where that key includes workspace_id, by the workspace it moved to
      (select string_agg(case when c = 'workspace_id' then 't.workspace_id = $2' else format('t.%s = x.%1$s', c) end, ' and ')
         from unnest(string_to_array(pg_temp.pk(('public.' || r.tbl)::regclass), ', ')) c))
      using p_merge, m.keep_workspace;
    get diagnostics n = row_count;
    raise notice '  % moved back: % of %', r.tbl, n, r.n;
  end loop;
  for r in select tbl, image from fenvix_account_merge.rows where merge_id = p_merge and action = 'deleted' and tbl = 'idempotency_keys' loop
    perform pg_temp.reinsert('public.idempotency_keys', r.image);
  end loop;

  if m.keep_workspace is not null then
    select count(*) into later from public.databases d where d.workspace_id = m.keep_workspace and d.created_at > m.at;
    if later > 0 then raise notice '  % databases were created in the kept workspace after the merge; they stay there', later; end if;
  end if;
  update fenvix_account_merge.merges set undone_at = now() where id = p_merge;
  raise notice 'done: user % and workspace % are back', m.drop_user, m.drop_workspace;
end $$;

select pg_temp.undo(:'merge_id'::bigint);

\if :execute
  commit;
  \echo 'COMMITTED: the merge is undone.'
\else
  rollback;
  \echo 'DRY RUN: rolled back, nothing changed. Run again with -v execute=1 to do it.'
\endif
