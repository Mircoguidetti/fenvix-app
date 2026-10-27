-- Row level security test: user A must not be able to read or change anything of user B's.
--
-- Run it in the Supabase SQL editor (or with psql). It creates two throw-away users inside one
-- transaction and rolls everything back at the end, so it leaves no trace. A failed assertion
-- stops the script with a message that names the check; a clean run ends with "RLS OK".

begin;

-- ---------------------------------------------------------------- two users and their data
-- (run as the owner, before switching to the signed-in role)
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'rls.a@fenvix.invalid', '{"full_name":"Rls A"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'rls.b@fenvix.invalid', '{"full_name":"Rls B"}');
-- the sign-up trigger has now given each of them a workspace

create temporary table rls_ids on commit drop as
select
  (select workspace_id from public.workspace_members where user_id = 'aaaaaaaa-0000-4000-8000-000000000001') as ws_a,
  (select workspace_id from public.workspace_members where user_id = 'bbbbbbbb-0000-4000-8000-000000000002') as ws_b;
grant select on rls_ids to authenticated;

do $$
declare ws_a uuid; ws_b uuid; db_a uuid; db_b uuid;
begin
  select r.ws_a, r.ws_b into ws_a, ws_b from rls_ids r;
  assert ws_a is not null and ws_b is not null and ws_a <> ws_b, 'the sign-up trigger must give each user their own workspace';

  insert into public.databases (workspace_id, name, region) values (ws_a, 'alpha-prod-01', 'eu-west') returning id into db_a;
  insert into public.databases (workspace_id, name, region) values (ws_b, 'bravo-prod-01', 'eu-west') returning id into db_b;
  insert into public.database_tags (database_id, workspace_id, key, value) values (db_a, ws_a, 'customer', 'alpha'), (db_b, ws_b, 'customer', 'bravo');
  insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes) values (db_a, ws_a, current_date, 10, 100), (db_b, ws_b, current_date, 20, 200);
  insert into public.usage_hourly (database_id, workspace_id, hour, requests, storage_bytes) values (db_a, ws_a, date_trunc('hour', now()), 1, 1), (db_b, ws_b, date_trunc('hour', now()), 2, 2);
  insert into public.wake_events (database_id, workspace_id, first_request_ms) values (db_a, ws_a, 300), (db_b, ws_b, 400);
  insert into public.invoices (workspace_id, number, month, issued_at, amount_cents) values
    (ws_a, 'RLS-A-1', date_trunc('month', current_date), now(), 100), (ws_b, 'RLS-B-1', date_trunc('month', current_date), now(), 200);
  insert into public.api_keys (workspace_id, name, key_hash, last4) values
    (ws_a, 'a key', repeat('a', 64), 'aaaa'), (ws_b, 'b key', repeat('b', 64), 'bbbb');
end $$;

-- ---------------------------------------------------------------- signed out sees nothing
set local role anon;
do $$
declare t text; n int;
begin
  foreach t in array array['workspaces','workspace_members','workspace_settings','databases','database_tags','usage_daily','usage_hourly','wake_events','invoices','api_keys']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert n = 0, format('a signed-out visitor can read %s rows of %s', n, t);
    exception when insufficient_privilege then
      null; -- no access at all is the best outcome
    end;
  end loop;
end $$;
do $$
begin
  begin perform public.fenvix_list_databases(); assert false, 'a signed-out visitor can call fenvix_list_databases';
  exception when insufficient_privilege then null; end;
  begin perform public.fenvix_create_database('anon-made-01', 'eu-west', '{}'); assert false, 'a signed-out visitor can create databases';
  exception when insufficient_privilege then null; end;
  begin perform public.fenvix_overview('7d'); assert false, 'a signed-out visitor can call fenvix_overview';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- user A reads
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';

do $$
declare
  ws_b uuid := (select ws_b from rls_ids);
  ws_a uuid := (select ws_a from rls_ids);
  t text; n int;
begin
  -- A sees exactly their own rows in every table, and none of B's.
  foreach t in array array['workspaces','workspace_members','workspace_settings','databases','database_tags','usage_daily','usage_hourly','wake_events','invoices','api_keys']
  loop
    execute format('select count(*) from public.%I where %s', t,
      case t when 'workspaces' then format('id = %L', ws_b) else format('workspace_id = %L', ws_b) end) into n;
    assert n = 0, format('READ LEAK: user A can read %s of user B''s rows in %s', n, t);
    execute format('select count(*) from public.%I where %s', t,
      case t when 'workspaces' then format('id = %L', ws_a) else format('workspace_id = %L', ws_a) end) into n;
    assert n >= 1, format('user A cannot read their own rows in %s', t);
  end loop;

  assert (select count(*) from public.databases) = 1, 'A sees more than their own database';
  assert (select count(*) from public.workspace_members) = 1, 'A can see other people''s memberships';

  -- The functions the dashboard calls are bound by the same rules.
  assert (select (public.fenvix_list_databases() ->> 'total')::int) = 1, 'fenvix_list_databases leaks rows';
  assert (select jsonb_array_length(public.fenvix_database_ids())) = 1, 'fenvix_database_ids leaks rows';
  assert public.fenvix_get_database((select id from public.databases where workspace_id = ws_a limit 1)) is not null, 'A cannot open their own database';
  assert (select jsonb_array_length(public.fenvix_list_api_keys())) = 1, 'fenvix_list_api_keys leaks keys';
  assert (select (public.fenvix_list_invoices() ->> 'total')::int) = 1, 'fenvix_list_invoices leaks invoices';
  assert (select jsonb_array_length(public.fenvix_list_tags())) = 1, 'fenvix_list_tags leaks tags';
end $$;

-- ---------------------------------------------------------------- user A writes
do $$
declare
  ws_b uuid := (select ws_b from rls_ids);
  db_b uuid;
  key_b uuid;
  n int;
begin
  -- B's ids are looked up as the owner would know them; A must not be able to act on them.
  reset role;
  select d.id into db_b from public.databases d where d.workspace_id = ws_b;
  select k.id into key_b from public.api_keys k where k.workspace_id = ws_b;
  set local role authenticated;

  update public.databases set name = 'hijacked-01' where id = db_b;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A updated B''s database';

  delete from public.databases where id = db_b;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A deleted B''s database';

  update public.workspaces set name = 'hijacked' where id = ws_b;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A renamed B''s workspace';

  update public.workspace_settings set idle_minutes = 60 where workspace_id = ws_b;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A changed B''s settings';

  update public.api_keys set revoked_at = now() where id = key_b;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A revoked B''s key';

  delete from public.invoices where workspace_id = ws_b;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A deleted B''s invoices';

  delete from public.database_tags where workspace_id = ws_b;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A deleted B''s tags';

  -- Inserting into B's workspace must be refused outright.
  begin
    insert into public.databases (workspace_id, name, region) values (ws_b, 'planted-01', 'eu-west');
    assert false, 'WRITE LEAK: A created a database in B''s workspace';
  exception when insufficient_privilege or check_violation then null; end;

  begin
    insert into public.database_tags (database_id, workspace_id, key, value) values (db_b, ws_b, 'customer', 'planted');
    assert false, 'WRITE LEAK: A tagged B''s database';
  exception when insufficient_privilege or check_violation or raise_exception then
    if sqlerrm like 'WRITE LEAK%' then raise; end if;
  end;

  begin
    insert into public.workspace_members (workspace_id, user_id, role) values (ws_b, 'aaaaaaaa-0000-4000-8000-000000000001', 'owner');
    assert false, 'WRITE LEAK: A made themselves a member of B''s workspace';
  exception when insufficient_privilege or check_violation then null; end;

  begin
    insert into public.workspaces (name) values ('free workspace');
    assert false, 'A browser must not be able to create workspaces';
  exception when insufficient_privilege or check_violation then null; end;

  -- The functions refuse too, or change nothing.
  assert (public.fenvix_erase_databases(array[db_b]) ->> 'affected')::int = 0, 'fenvix_erase_databases reached B''s database';
  assert (public.fenvix_set_keep_awake(array[db_b], true) ->> 'affected')::int = 0, 'fenvix_set_keep_awake reached B''s database';
  assert (public.fenvix_add_tags(array[db_b], array['customer:planted']) ->> 'affected')::int = 0, 'fenvix_add_tags reached B''s database';
  assert (public.fenvix_remove_tags(array[db_b], array['customer']) ->> 'affected')::int = 0, 'fenvix_remove_tags reached B''s database';
  assert public.fenvix_get_database(db_b) is null, 'fenvix_get_database opened B''s database';

  begin perform public.fenvix_set_tags(db_b, array['customer:planted']); assert false, 'fenvix_set_tags reached B''s database';
  exception when no_data_found then null; end;
  begin perform public.fenvix_fork_database(db_b, 'stolen-fork'); assert false, 'fenvix_fork_database copied B''s database';
  exception when no_data_found then null; end;
  begin perform public.fenvix_restore_database(db_b, now() - interval '1 minute'); assert false, 'fenvix_restore_database reached B''s database';
  exception when no_data_found then null; end;
  begin perform public.fenvix_revoke_api_key(key_b); assert false, 'fenvix_revoke_api_key reached B''s key';
  exception when no_data_found then null; end;

  -- A cannot run the sign-up helper to mint workspaces for others.
  begin
    perform public.ensure_workspace('bbbbbbbb-0000-4000-8000-000000000002', 'x@x.x', 'x');
    assert false, 'A can call ensure_workspace';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------- A can still do their own work
do $$
declare made jsonb; forked jsonb; n int; key jsonb;
begin
  made := public.fenvix_create_database('alpha-dev-01', 'us-east', array['customer:alpha', 'env:dev']);
  assert made ->> 'name' = 'alpha-dev-01', 'A cannot create a database';
  forked := public.fenvix_fork_database((made ->> 'id')::uuid, 'alpha-dev-01-fork');
  assert forked ->> 'name' = 'alpha-dev-01-fork', 'A cannot fork';
  assert (public.fenvix_set_keep_awake(array[(made ->> 'id')::uuid], true) ->> 'affected')::int = 1, 'A cannot keep a database awake';
  assert (public.fenvix_erase_databases(array[(forked ->> 'id')::uuid]) ->> 'affected')::int = 1, 'A cannot erase their own database';
  key := public.fenvix_create_api_key('ci', repeat('c', 64), 'cccc');
  assert key ->> 'hint' = 'cccc', 'A cannot store a key hash';
  assert not (key::text like '%' || repeat('c', 64) || '%'), 'the key hash must never be sent back';
  assert (select count(*) from public.databases) = 2, 'A should own two databases now';
end $$;

-- ---------------------------------------------------------------- user B is untouched
reset role;
do $$
declare ws_b uuid := (select ws_b from rls_ids);
begin
  assert (select name from public.databases where workspace_id = ws_b) = 'bravo-prod-01', 'B''s database was changed';
  assert (select count(*) from public.database_tags where workspace_id = ws_b) = 1, 'B''s tags were changed';
  assert (select revoked_at from public.api_keys where workspace_id = ws_b) is null, 'B''s key was revoked';
  assert (select count(*) from public.invoices where workspace_id = ws_b) = 1, 'B''s invoices were changed';
  assert (select name from public.workspaces where id = ws_b) = 'Rls B', 'B''s workspace was renamed';
  assert (select count(*) from public.workspace_members where workspace_id = ws_b) = 1, 'B''s membership was changed';
end $$;

select 'RLS OK' as result;

rollback;
