-- Behaviour test of the functions the dashboard calls: results have the shape the client
-- expects, every change is all-or-nothing, and bad input is refused with a readable message.
--
-- Like rls.sql it runs in one transaction that is rolled back, so it leaves no trace.
-- A clean run ends with "FUNCTIONS OK".

begin;

insert into auth.users (id, email, raw_user_meta_data)
values ('cccccccc-0000-4000-8000-000000000003', 'fn.user@fenvix.invalid', '{"full_name":"Fn User"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated"}';

do $$
declare
  a jsonb; b jsonb; c jsonb; r jsonb; ids uuid[]; failed boolean; msg text;
begin
  -- ---------------------------------------------------------------- workspace and settings
  r := public.fenvix_settings();
  assert r ->> 'workspaceName' = 'Fn User', 'the personal workspace is named after the person';
  assert (r ->> 'idleMinutes')::int = 5 and (r ->> 'emailNotices')::boolean, 'default settings';
  r := public.fenvix_save_settings('Fn Cloud', 15, false);
  assert r ->> 'workspaceName' = 'Fn Cloud' and (r ->> 'idleMinutes')::int = 15 and not (r ->> 'emailNotices')::boolean, 'settings are saved';
  begin perform public.fenvix_save_settings('', 5, true); assert false, 'an empty workspace name was accepted';
  exception when invalid_parameter_value then null; end;
  begin perform public.fenvix_save_settings('x', 7, true); assert false, 'an idle time of 7 minutes was accepted';
  exception when invalid_parameter_value then null; end;
  assert public.fenvix_settings() ->> 'workspaceName' = 'Fn Cloud', 'a refused save must change nothing';

  -- ---------------------------------------------------------------- create
  a := public.fenvix_create_database('acme-labs-prod-01', 'eu-west', array['customer:acme-labs', 'env:prod']);
  for msg in select unnest(array['id','name','state','keep_awake','region','storage_mb','requests_24h','created_at','last_active_at','forked_from','restored_to','tags']) loop
    assert a ? msg, format('a database row is missing "%s"', msg);
  end loop;
  assert a ->> 'state' = 'asleep' and a ->> 'region' = 'eu-west', 'a new database starts asleep in its region';
  assert a -> 'tags' = '["customer:acme-labs","env:prod"]'::jsonb, 'tags come back sorted as key:value';

  failed := false;
  begin perform public.fenvix_create_database('acme-labs-prod-01', 'eu-west', '{}'); exception when unique_violation then failed := true; get stacked diagnostics msg = message_text; end;
  assert failed and msg = 'A database named acme-labs-prod-01 already exists.', 'a duplicate name needs a clear message';
  failed := false;
  begin perform public.fenvix_create_database('X', 'eu-west', '{}'); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'a bad name was accepted';
  failed := false;
  begin perform public.fenvix_create_database('good-name-01', 'moon-base', '{}'); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'an unknown region was accepted';
  failed := false;
  begin perform public.fenvix_create_database('good-name-02', 'eu-west', array['customer:a', 'customer:b']); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'two values for one tag key were accepted';
  failed := false;
  begin perform public.fenvix_create_database('good-name-03', 'eu-west', array['not a tag']); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'a malformed tag was accepted';
  assert (select count(*) from public.databases) = 1, 'refused creates must leave no half-made database behind';

  -- ---------------------------------------------------------------- tags
  a := public.fenvix_set_tags((a ->> 'id')::uuid, array['customer:acme-labs', 'env:staging', 'app:orders']);
  assert a -> 'tags' = '["app:orders","customer:acme-labs","env:staging"]'::jsonb, 'set_tags replaces the whole list';
  failed := false;
  begin perform public.fenvix_set_tags((a ->> 'id')::uuid, array['env:prod', 'env:dev']); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'set_tags took two values for one key';
  assert public.fenvix_get_database((a ->> 'id')::uuid) -> 'tags' = '["app:orders","customer:acme-labs","env:staging"]'::jsonb, 'a refused set_tags must keep the old tags';

  -- ---------------------------------------------------------------- fork
  b := public.fenvix_fork_database((a ->> 'id')::uuid, 'acme-labs-prod-01-fork');
  assert b ->> 'forked_from' = a ->> 'id' and b ->> 'state' = 'asleep', 'a fork records where it came from and starts asleep';
  assert b -> 'tags' = a -> 'tags', 'a fork keeps the tags';
  failed := false;
  begin perform public.fenvix_fork_database((a ->> 'id')::uuid, 'acme-labs-prod-01-fork'); exception when unique_violation then failed := true; end;
  assert failed, 'a fork under a taken name was accepted';

  -- ---------------------------------------------------------------- keep awake, tags in bulk
  ids := array[(a ->> 'id')::uuid, (b ->> 'id')::uuid];
  assert (public.fenvix_set_keep_awake(ids, true) ->> 'affected')::int = 2, 'keep awake reaches both';
  assert (public.fenvix_get_database(ids[1]) ->> 'state') = 'awake' and (public.fenvix_get_database(ids[1]) ->> 'keep_awake')::boolean, 'keeping awake also wakes';
  assert (public.fenvix_set_keep_awake(ids, false) ->> 'affected')::int = 2, 'keep awake off reaches both';
  assert (public.fenvix_get_database(ids[1]) ->> 'keep_awake')::boolean = false, 'keep awake switched off';

  assert (public.fenvix_add_tags(ids, array['team:data']) ->> 'affected')::int = 2, 'add_tags reaches both';
  assert (public.fenvix_add_tags(ids, array['env:prod']) ->> 'affected')::int = 2, 'add_tags replaces a value of an existing key';
  assert public.fenvix_get_database(ids[1]) -> 'tags' @> '["env:prod","team:data"]'::jsonb and not (public.fenvix_get_database(ids[1]) -> 'tags' @> '["env:staging"]'::jsonb), 'one value per key after add_tags';
  assert (public.fenvix_remove_tags(ids, array['team:data']) ->> 'affected')::int = 2, 'remove_tags by value';
  assert not (public.fenvix_get_database(ids[1]) -> 'tags' @> '["team:data"]'::jsonb), 'the tag is gone';
  perform public.fenvix_remove_tags(ids, array['env']);
  assert not exists (select 1 from public.database_tags where database_id = any(ids) and key = 'env'), 'remove_tags by key drops the key';
  failed := false;
  begin perform public.fenvix_add_tags(ids, array['bad tag']); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'add_tags took a malformed tag';

  -- ---------------------------------------------------------------- restore
  failed := false;
  begin perform public.fenvix_restore_database(ids[1], now() + interval '1 day'); exception when invalid_parameter_value then failed := true; get stacked diagnostics msg = message_text; end;
  assert failed and msg = 'Choose a time in the past.', 'restoring to the future is refused';
  failed := false;
  begin perform public.fenvix_restore_database(ids[1], now() - interval '10 days'); exception when invalid_parameter_value then failed := true; get stacked diagnostics msg = message_text; end;
  assert failed and msg = 'That is before this database was created.', 'restoring to before it existed is refused';
  -- everything in this script was created "now" (one transaction), so give the database a past
  update public.databases set created_at = now() - interval '30 days' where id = ids[1];
  c := public.fenvix_restore_database(ids[1], now() - interval '1 hour');
  assert (c ->> 'restored_to') is not null, 'a restore is recorded on the database';

  -- ---------------------------------------------------------------- list, filter, group
  perform public.fenvix_create_database('acme-labs-dev-01', 'us-east', array['customer:acme-labs', 'env:dev']);
  perform public.fenvix_create_database('globex-prod-01', 'us-east', array['customer:globex', 'env:prod']);
  perform public.fenvix_create_database('globex-prod-02', 'us-east', array['env:prod']);
  r := public.fenvix_list_databases();
  assert (r ->> 'total')::int = 5 and jsonb_array_length(r -> 'items') = 5, 'list shows all five';
  r := public.fenvix_list_databases(p_tags => array['customer:acme-labs']);
  assert (r ->> 'total')::int = 3, 'filter by tag';
  r := public.fenvix_list_databases(p_tags => array['customer:acme-labs', 'env:dev']);
  assert (r ->> 'total')::int = 1, 'tag filters combine with AND';
  r := public.fenvix_list_databases(p_tags => array['!customer']);
  assert (r ->> 'total')::int = 1 and r -> 'items' -> 0 ->> 'name' = 'globex-prod-02', 'filter for databases without a key';
  r := public.fenvix_list_databases(p_tags => array['app']);
  assert (r ->> 'total')::int = 2, 'bare key filter (the database and its fork carry app)';
  r := public.fenvix_list_databases(p_search => 'GLOBEX');
  assert (r ->> 'total')::int = 2, 'search ignores case';
  r := public.fenvix_list_databases(p_page_size => 2, p_page => 3);
  assert jsonb_array_length(r -> 'items') = 1 and (r ->> 'total')::int = 5 and (r ->> 'page')::int = 3, 'paging';
  r := public.fenvix_list_databases(p_sort => 'name', p_dir => 'desc', p_page_size => 1);
  assert r -> 'items' -> 0 ->> 'name' = 'globex-prod-02', 'sort descending';
  r := public.fenvix_group_databases('customer');
  assert (r ->> 'total')::int = 5, 'group total counts every match';
  assert r -> 'groups' -> 0 ->> 'value' = 'acme-labs' and (r -> 'groups' -> 0 ->> 'count')::int = 3, 'biggest group first';
  assert (r -> 'groups' -> 2 -> 'value') = 'null'::jsonb and (r -> 'groups' -> 2 ->> 'count')::int = 1, 'databases without the key form a last group';
  assert (select count(*) from jsonb_array_elements(public.fenvix_list_tags()) t where t ->> 'key' = 'customer') = 2, 'tag list';
  assert jsonb_array_length(public.fenvix_database_ids(p_tags => array['customer:acme-labs'])) = 3, 'ids for select all matching';

  -- ---------------------------------------------------------------- erase
  ids := array[(b ->> 'id')::uuid];
  assert (public.fenvix_erase_databases(ids) ->> 'affected')::int = 1, 'erase one';
  assert not exists (select 1 from public.database_tags where database_id = ids[1]), 'erasing takes the tags with it';
  assert public.fenvix_get_database(ids[1]) is null, 'an erased database is gone';
  assert (public.fenvix_erase_databases(ids) ->> 'affected')::int = 0, 'erasing twice is harmless';
  assert (select count(*) from public.databases) = 4, 'four left';

  -- ---------------------------------------------------------------- API keys: only a hash is kept
  r := public.fenvix_create_api_key('Deploy pipeline', repeat('d', 64), 'dddd');
  assert r ->> 'hint' = 'dddd' and r ->> 'revokedAt' is null and not (r ? 'key_hash') and not (r::text like '%' || repeat('d', 64) || '%'), 'the hash is never sent back';
  failed := false;
  begin perform public.fenvix_create_api_key('x', 'not-a-hash', 'dddd'); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'a key that is not a SHA-256 hash was accepted';
  failed := false;
  begin perform public.fenvix_create_api_key('', repeat('e', 64), 'eeee'); exception when invalid_parameter_value then failed := true; end;
  assert failed, 'a key without a name was accepted';
  c := public.fenvix_revoke_api_key((r ->> 'id')::uuid);
  assert c ->> 'revokedAt' is not null, 'revoking sets the time';
  assert (public.fenvix_revoke_api_key((r ->> 'id')::uuid) ->> 'revokedAt') = c ->> 'revokedAt', 'revoking twice keeps the first time';
  assert jsonb_array_length(public.fenvix_list_api_keys()) = 1, 'the key is listed';

  -- ---------------------------------------------------------------- nothing to bill yet
  assert (public.fenvix_billing() ->> 'total')::numeric = 0, 'no usage, no cost';
  assert (public.fenvix_list_invoices() ->> 'total')::int = 0, 'no invoices yet';
  assert jsonb_array_length(public.fenvix_usage_months()) = 0, 'no usage months yet';
  r := public.fenvix_overview('7d');
  assert (r -> 'totals' ->> 'databases')::int = 4 and jsonb_array_length(r -> 'awakeSeries') = 7, 'the overview works on an almost empty workspace';
  assert jsonb_array_length(public.fenvix_overview('24h') -> 'awakeSeries') = 24, 'the 24 hour overview has 24 points';
  assert jsonb_array_length(public.fenvix_overview('30d') -> 'awakeSeries') = 30, 'the 30 day overview has 30 points';
  r := public.fenvix_usage_report(date_trunc('month', current_date)::date);
  assert (r ->> 'total')::int = 0 and (r -> 'totals' ->> 'requests')::bigint = 0, 'an empty usage report is empty, not an error';
end $$;

-- ---------------------------------------------------------------- usage on real numbers
reset role;
do $$
declare
  ws uuid := (select workspace_id from public.workspace_members where user_id = 'cccccccc-0000-4000-8000-000000000003');
  a uuid := (select id from public.databases where workspace_id = ws and name = 'acme-labs-prod-01');
  g uuid := (select id from public.databases where workspace_id = ws and name = 'globex-prod-01');
begin
  insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes)
  select a, ws, d::date, 1000000, 2147483648 from generate_series(date_trunc('month', current_date), current_date, interval '1 day') d;
  insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes)
  select g, ws, d::date, 3000000, 1073741824 from generate_series(date_trunc('month', current_date), current_date, interval '1 day') d;
  insert into public.invoices (workspace_id, number, month, issued_at, amount_cents)
  values (ws, 'FNX-TEST-1', date_trunc('month', current_date - 40)::date, now(), 12345);
  insert into public.wake_events (database_id, workspace_id, first_request_ms) values (a, ws, 412);
end $$;

set local role authenticated;
do $$
declare r jsonb; days int := extract(day from current_date)::int;
begin
  r := public.fenvix_usage_report(date_trunc('month', current_date)::date, 'database', null, 'requests', 'desc', 1, 10);
  assert (r ->> 'total')::int = 2, 'two databases have usage';
  assert r -> 'items' -> 0 ->> 'name' = 'globex-prod-01', 'sorted by requests, biggest first';
  assert (r -> 'items' -> 0 ->> 'requests')::bigint = 3000000::bigint * days, 'requests add up over the month';
  assert (r -> 'items' -> 0 ->> 'storage_gb')::numeric = 1.00 and (r -> 'items' -> 1 ->> 'storage_gb')::numeric = 2.00, 'storage is the average over the month, in GB';
  assert (r -> 'totals' ->> 'requests')::bigint = 4000000::bigint * days and (r -> 'totals' ->> 'databases')::int = 2, 'totals cover every database';
  r := public.fenvix_usage_report(date_trunc('month', current_date)::date, 'database', null, 'storageGb', 'asc', 1, 1);
  assert r -> 'items' -> 0 ->> 'name' = 'globex-prod-01' and jsonb_array_length(r -> 'items') = 1 and (r ->> 'total')::int = 2, 'sort by storage and page to one row';
  r := public.fenvix_usage_report(date_trunc('month', current_date)::date, 'tag', 'customer');
  assert (r ->> 'total')::int = 2 and r -> 'items' -> 0 ->> 'name' = 'customer:globex', 'per tag, grouped by one key';
  assert (select count(*) from jsonb_array_elements(r -> 'items') i where i ->> 'name' = 'customer:acme-labs') = 1, 'the other customer is there too';
  r := public.fenvix_usage_report(date_trunc('month', current_date)::date, 'tag', 'env');
  assert (select sum((i ->> 'databases')::int) from jsonb_array_elements(r -> 'items') i) = 2, 'every database is counted once under a single key';
  r := public.fenvix_usage_report(date_trunc('month', current_date)::date, 'tag', null);
  assert (select count(*) from jsonb_array_elements(r -> 'items') i where i ->> 'name' like 'customer:%') = 2, 'per tag without a key lists every tag';

  r := public.fenvix_billing();
  assert (r ->> 'requests')::bigint = 4000000::bigint * days, 'billing counts the same requests';
  assert (r ->> 'requestCost')::numeric = round((4000000::numeric * days / 1000000) * 0.40, 2), 'requests cost 0.40 per million';
  assert (r ->> 'total')::numeric = (r ->> 'storageCost')::numeric + (r ->> 'requestCost')::numeric, 'total is storage plus requests';
  assert r -> 'paymentMethod' ->> 'last4' is not null, 'payment method is there';

  r := public.fenvix_overview('7d');
  assert (r -> 'totals' ->> 'costMtd')::numeric > 0, 'the overview shows a month-to-date cost';
  assert jsonb_array_length(r -> 'recentWakeUps') = 1 and r -> 'recentWakeUps' -> 0 ->> 'name' = 'acme-labs-prod-01', 'the wake-up list names the database';
  assert (r -> 'topDatabases') is not null, 'top databases are listed';
  assert jsonb_array_length(public.fenvix_usage_months()) = 1, 'one month of usage';
  r := public.fenvix_usage_trend(date_trunc('month', current_date)::date, 'customer');
  assert jsonb_array_length(r -> 'days') = days and jsonb_array_length(r -> 'series') = 2, 'the trend has a day per day and a series per customer';
  assert (select bool_and(jsonb_array_length(s -> 'values') = days) from jsonb_array_elements(r -> 'series') s), 'every series has a value for every day';
  r := public.fenvix_list_invoices();
  assert (r ->> 'total')::int = 1 and (r -> 'items' -> 0 ->> 'amount')::numeric = 123.45, 'invoice amounts are in dollars';
  assert (public.fenvix_get_invoice((r -> 'items' -> 0 ->> 'id')::uuid) ->> 'workspace') = 'Fn Cloud', 'an invoice names the workspace';
  r := public.fenvix_export_databases(array[(select id from public.databases where name = 'globex-prod-01')]);
  assert jsonb_array_length(r) = 1 and r -> 0 ->> 'name' = 'globex-prod-01' and jsonb_array_length(r -> 0 -> 'usage') >= 1, 'an export holds the database and its usage';
  r := public.fenvix_usage_series((select id from public.databases where name = 'globex-prod-01'), '7d');
  assert jsonb_array_length(r) between 6 and 8 and (r -> 0 ? 'awake') and (r -> 0 ? 'storage_mb'), 'a database page gets daily points with the awake flag';
end $$;

select 'FUNCTIONS OK' as result;

rollback;
