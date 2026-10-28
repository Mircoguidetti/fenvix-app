-- FENVIX control plane, part 3: close the dashboard's direct write path.
-- Safe to run more than once. Run it in the Supabase SQL editor AFTER 0001_init.sql and 0002_control_plane.sql,
-- and ONLY WHEN the dashboard has switched to the control-plane API (see control-plane/README.md, "Cutover").
--
-- Until now a signed-in dashboard user could change `databases`, `database_tags`, `api_keys` and
-- `workspace_settings` straight through Supabase (their own `authenticated` role, under row level security,
-- and through the dashboard's `fenvix_*` functions). That path never tells the engine: a row could be erased or
-- forked in Postgres while the data stays (or does not exist) in the engine. After this file the only writer of
-- those tables is the control-plane service (`fenvix_control_plane`, 0002), which does the engine call and
-- the Postgres change as one operation. The dashboard keeps reading: select, the read functions and the
-- usage/billing functions are untouched.
--
-- 0001_init.sql ends by granting everything to `authenticated` again. If it is ever run again, run this file again.

-- ---------------------------------------------------------------- tables: read only for signed-in users

revoke insert, update, delete, truncate on public.databases, public.database_tags, public.api_keys, public.workspace_settings from authenticated;
revoke insert, update, delete, truncate on public.databases, public.database_tags, public.api_keys, public.workspace_settings from anon;

-- Row level security as a second lock: with the write policies gone, even a grant put back by mistake writes nothing.
do $$
declare t text;
begin
  foreach t in array array['databases', 'database_tags', 'api_keys', 'workspace_settings']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_member_write', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- functions: the ones that change data

do $$
declare f text;
begin
  foreach f in array array[
    'fenvix_create_database(text,text,text[])', 'fenvix_fork_database(uuid,text)', 'fenvix_restore_database(uuid,timestamptz)',
    'fenvix_erase_databases(uuid[])', 'fenvix_set_keep_awake(uuid[],boolean)', 'fenvix_set_tags(uuid,text[])',
    'fenvix_add_tags(uuid[],text[])', 'fenvix_remove_tags(uuid[],text[])', 'fenvix_save_settings(text,int,boolean)',
    'fenvix_create_api_key(text,text,text)', 'fenvix_revoke_api_key(uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- hostnames are unique

-- A database is reached at <name>-<workspace code>.<region>.db.<domain> (HOST_TEMPLATE). The code is the first 8
-- hex digits of the workspace id, so two workspaces could in theory share it. Names are unique per workspace;
-- this makes (code, name) unique across all of them, so two hostnames can never be the same. If it ever refuses a
-- create, the person gets "name already exists" and picks another name.
do $$ begin
  create unique index if not exists databases_host_unique on public.databases (left(replace(workspace_id::text, '-', ''), 8), name);
exception when unique_violation then
  raise exception 'Two workspaces whose ids start with the same 8 characters have a database of the same name. Rename one of them, then run this file again.';
end $$;

notify pgrst, 'reload schema';
