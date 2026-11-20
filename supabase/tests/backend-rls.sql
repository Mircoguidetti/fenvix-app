-- Row level security of the service back-end (0018) and isolation between organizations on EVERY customer table.
-- Run AFTER 0001 to 0018. One transaction, rolled back; a failed assertion stops the script naming the check; a clean
-- run ends with "BACKEND RLS OK".
--
--   Organization A (owner OA) and organization B (owner OB). Each has a linked installation, a project, a run, a test
--   result, a receipt, a defect with an occurrence and a bundle, a replay, an exploration and its job, an audit rerun,
--   a usage event and an API key. Then, for every table of the public schema that has a workspace_id column (found from
--   the catalog, so a table added later is covered without editing this file):
--     - the API as OA's session, and as A's API key, reads A's rows and none of B's;
--     - a revoked or expired key reads nothing;
--     - the GitHub App naming A reads none of B's rows;
--     - the browser's roles (anon, authenticated) read nothing at all.
--   And: the writer path is anchored (the App naming A cannot put a project, a run, an occurrence or a bundle into B);
--   a key cannot change a defect's state, manage keys or stop a run; deleting and unlinking are owner/admin only;
--   an orphan organization goes with its last member; an invited sign-up gets no organization of its own.

begin;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('8aaaaaaa-0000-4000-8000-000000000001', 'be.a@fenvix.invalid', '{"full_name":"BE A"}', now()),
  ('8bbbbbbb-0000-4000-8000-000000000002', 'be.b@fenvix.invalid', '{"full_name":"BE B"}', now()),
  ('8ccccccc-0000-4000-8000-000000000003', 'be.member@fenvix.invalid', '{"full_name":"BE M"}', now());

create temporary table be_ids on commit drop as
select
  (select workspace_id from public.workspace_members where user_id = '8aaaaaaa-0000-4000-8000-000000000001') as a,
  (select workspace_id from public.workspace_members where user_id = '8bbbbbbb-0000-4000-8000-000000000002') as b,
  'aaaaaaaa-1111-4000-8000-000000000001'::uuid as key_a, 'bbbbbbbb-1111-4000-8000-000000000002'::uuid as key_b,
  'cccccccc-1111-4000-8000-000000000003'::uuid as key_revoked;
grant select on be_ids to authenticated, anon, fenvix_api, fenvix_github_app;

do $$
declare r be_ids%rowtype; ws uuid; p uuid; run uuid; d uuid; ex uuid; rc uuid; inst bigint; k uuid;
begin
  select * into r from be_ids;
  -- A member of A (not an owner).
  delete from public.workspaces where id = (select workspace_id from public.workspace_members where user_id = '8ccccccc-0000-4000-8000-000000000003');
  insert into public.workspace_members (workspace_id, user_id, role) values (r.a, '8ccccccc-0000-4000-8000-000000000003', 'member');
  foreach ws in array array[r.a, r.b] loop
    inst := case when ws = r.a then 801 else 802 end;
    k := case when ws = r.a then r.key_a else r.key_b end;
    insert into public.ci_subscriptions (workspace_id, plan_id) values (ws, 'team');
    insert into public.gh_installations (installation_id, account_id, account_login, account_type, workspace_id, linked_at)
      values (inst, inst, 'acct' || inst, 'Organization', ws, now());
    insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (ws, 'acct' || inst || '/repo', 'python', 'pytest', inst) returning id into p;
    insert into public.gh_repositories (repository_id, installation_id, full_name, project_id) values (inst * 10, inst, 'acct' || inst || '/repo', p);
    insert into public.ci_runs (workspace_id, project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at, tests_total, tests_ran, tests_failed, tests_flaky_defects)
      values (ws, p, 1, repeat('a', 40), 'main', 'push', 'running', now(), now(), 1, 1, 1, 1) returning id into run;
    insert into public.ci_defects (workspace_id, project_id, test_id, status, cause, minimal_order, fingerprint, family_key, first_seen_at, last_seen_at, language)
      values (ws, p, 't::flaky', 'reproduced', 'polluter', '{t::p,t::flaky}', repeat('c', 32), 't::p', now(), now(), 'python') returning id into d;
    insert into public.ci_defect_occurrences (workspace_id, defect_id, run_id, source, fingerprint, status, seen_at) values (ws, d, run, 'run', repeat('c', 32), 'reproduced', now());
    insert into public.ci_defect_bundles (workspace_id, defect_id, run_id, sha256, size_bytes, content) values (ws, d, run, repeat('0', 64), 3, '\x010203');
    insert into public.ci_skip_receipts (run_id, workspace_id, test_id, cache_key, reused_engine_run_id, fingerprint) values (run, ws, 't::s', repeat('e', 32), 'x', repeat('f', 32)) returning id into rc;
    insert into public.ci_test_results (run_id, workspace_id, test_id, outcome, failure_kind, defect_id) values (run, ws, 't::flaky', 'failed', 'flaky_defect', d);
    insert into public.ci_audit_reruns (workspace_id, run_id, test_id, cache_key, outcome) values (ws, run, 't::s', repeat('e', 32), 'confirmed');
    insert into public.ci_explorations (workspace_id, project_id, started_at, finished_at, commit_sha, seeds, runs) values (ws, p, now(), now(), repeat('b', 40), 1, 1) returning id into ex;
    insert into public.ci_exploration_jobs (workspace_id, project_id, reason, budget_seconds, seeds, exploration_id) values (ws, p, 'manual', 600, 5, ex);
    insert into public.ci_replays (workspace_id, project_id, defect_id, test_id, commit_sha, requested_via) values (ws, p, d, 't::flaky', repeat('a', 40), 'dashboard');
    insert into public.ci_usage_events (workspace_id, installation_id, repository_id, repository_full_name, project_id, ci_run_id, github_job_id, github_run_id, billable, reason, held_minutes, occurred_at)
      values (ws, inst, inst * 10, 'acct' || inst || '/repo', p, run, inst * 100, inst * 1000, true, 'completed', 1, now());
    insert into public.ci_api_keys (id, workspace_id, name, prefix, key_hash, scopes) values (k, ws, 'key', 'fxk_abcdef', encode(sha256(k::text::bytea), 'hex'), '{read,replay}');
  end loop;
  insert into public.ci_api_keys (id, workspace_id, name, prefix, key_hash, scopes, revoked_at) values (r.key_revoked, r.a, 'old', 'fxk_zzzzzz', repeat('9', 64), '{read}', now());
end $$;

-- The tables to check: every public table with a workspace_id column.
create temporary table be_tables on commit drop as
  select c.relname::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped);
grant select on be_tables to authenticated, anon, fenvix_api, fenvix_github_app;

do $$
begin
  assert (select count(*) from be_tables) >= 20, 'too few customer tables found';
  assert exists (select 1 from be_tables where t = 'ci_defect_bundles') and exists (select 1 from be_tables where t = 'ci_api_keys'), 'the new tables are not checked';
  -- Every one of them has row level security on.
  assert not exists (select 1 from be_tables b join pg_class c on c.relname = b.t join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public' where not c.relrowsecurity),
    'a customer table has no row level security';
end $$;

-- ---------------------------------------------------------------- the browser's roles: nothing, on every table
set local role anon;
do $$
declare t text; n int;
begin
  for t in select be_tables.t from be_tables loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert n = 0, format('READ LEAK: anon reads %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"8aaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare t text; n int;
begin
  for t in select be_tables.t from be_tables where be_tables.t not in ('workspaces') loop
    begin
      execute format('select count(*) from public.%I where workspace_id = (select b from be_ids)', t) into n;
      assert n = 0, format('READ LEAK: the browser reads B''s %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------- the API as A's owner: A's rows, none of B's
set local role fenvix_api;
do $$
declare r be_ids%rowtype; t text; n int; mine int;
begin
  select * into r from be_ids;
  perform set_config('app.user_id', '8aaaaaaa-0000-4000-8000-000000000001', true), set_config('app.workspace_id', r.a::text, true), set_config('app.api_key_id', '', true);
  for t in select be_tables.t from be_tables loop
    begin
      execute format('select count(*) from public.%I where workspace_id = $1', t) into n using r.b;
      assert n = 0, format('READ LEAK: A''s owner reads B''s %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
  foreach t in array array['ci_defect_occurrences', 'ci_defect_bundles', 'ci_replays', 'ci_exploration_jobs', 'ci_api_keys', 'ci_defects', 'ci_runs', 'ci_test_results'] loop
    execute format('select count(*) from public.%I where workspace_id = $1', t) into mine using r.a;
    assert mine >= 1, format('A''s owner cannot read A''s %s', t);
  end loop;
  -- Writes into B are refused (0 rows), state changes only of A's defects.
  update public.ci_defects set state = 'muted' where workspace_id = r.b; get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A changed B''s defect';
  update public.ci_runs set cancel_requested_at = now() where workspace_id = r.b; get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A stopped B''s run';
  update public.ci_api_keys set revoked_at = now() where workspace_id = r.b; get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: A revoked B''s key';
  begin
    insert into public.ci_replays (workspace_id, project_id, test_id, commit_sha, requested_via)
      select r.b, id, 't', repeat('a', 40), 'dashboard' from public.ci_projects where installation_id = 802;
    get diagnostics n = row_count;
    assert n = 0, 'WRITE LEAK: A asked for a replay in B';
  exception when insufficient_privilege or check_violation then null; end;
  -- B's project cannot be deleted from A: the function deletes only in A.
  assert not public.api_delete_project((select id from public.ci_projects where installation_id = 802)), 'DELETE LEAK: A deleted B''s project';
end $$;
reset role;

-- A member of A (not an admin): no keys, no deleting.
set local role fenvix_api;
do $$
declare r be_ids%rowtype; n int;
begin
  select * into r from be_ids;
  perform set_config('app.user_id', '8ccccccc-0000-4000-8000-000000000003', true), set_config('app.workspace_id', r.a::text, true), set_config('app.api_key_id', '', true);
  select count(*) into n from public.ci_api_keys; assert n = 0, 'ROLE LEAK: a member reads the API keys';
  begin
    insert into public.ci_api_keys (workspace_id, name, prefix, key_hash) values (r.a, 'm', 'fxk_mmmmmm', repeat('7', 64));
    assert false, 'ROLE LEAK: a member made an API key';
  exception when insufficient_privilege then null; end;
  begin perform public.api_delete_organization('x'); assert false, 'a member deleted the organization'; exception when insufficient_privilege then null; end;
  begin perform public.api_delete_project(gen_random_uuid()); assert false, 'a member disconnected a project'; exception when insufficient_privilege then null; end;
  begin perform public.api_unlink_installation(801); assert false, 'a member unlinked GitHub'; exception when insufficient_privilege then null; end;
  -- A member may fix, mute or reopen A's defects.
  update public.ci_defects set state = 'muted' where workspace_id = r.a; get diagnostics n = row_count;
  assert n = 1, 'a member cannot mute a defect';
end $$;
reset role;

-- ---------------------------------------------------------------- the API as A's key: A's rows, none of B's; revoked: nothing
set local role fenvix_api;
do $$
declare r be_ids%rowtype; t text; n int;
begin
  select * into r from be_ids;
  perform set_config('app.user_id', '', true), set_config('app.workspace_id', r.a::text, true), set_config('app.api_key_id', r.key_a::text, true);
  assert public.api_workspace() = r.a, 'A''s key does not act for A';
  for t in select be_tables.t from be_tables loop
    begin
      execute format('select count(*) from public.%I where workspace_id = $1', t) into n using r.b;
      assert n = 0, format('READ LEAK: A''s key reads B''s %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
  select count(*) into n from public.ci_defect_bundles where workspace_id = r.a; assert n = 1, 'A''s key cannot read A''s bundle';
  -- A key acts for its own organization only, whatever organization the transaction names.
  perform set_config('app.workspace_id', r.b::text, true);
  assert public.api_workspace() is null, 'A''s key acts for B';
  select count(*) into n from public.ci_defects; assert n = 0, 'READ LEAK: A''s key naming B reads defects';
  perform set_config('app.workspace_id', r.a::text, true);
  -- A key changes no state and manages no keys.
  update public.ci_defects set state = 'fixed' where workspace_id = r.a; get diagnostics n = row_count;
  assert n = 0, 'a key changed a defect''s state';
  update public.ci_runs set cancel_requested_at = now() where workspace_id = r.a; get diagnostics n = row_count;
  assert n = 0, 'a key stopped a run';
  select count(*) into n from public.ci_api_keys; assert n = 0, 'a key reads the API keys';
  -- Revoked: nothing at all.
  perform set_config('app.api_key_id', r.key_revoked::text, true);
  assert public.api_workspace() is null, 'a revoked key still acts';
  select count(*) into n from public.ci_defects; assert n = 0, 'a revoked key reads defects';
  -- Expired: nothing either.
  perform set_config('app.api_key_id', r.key_a::text, true);
end $$;
reset role;
update public.ci_api_keys set expires_at = now() - interval '1 second', created_at = now() - interval '1 day' where id = (select key_a from be_ids);
set local role fenvix_api;
do $$
declare r be_ids%rowtype; n int;
begin
  select * into r from be_ids;
  perform set_config('app.user_id', '', true), set_config('app.workspace_id', r.a::text, true), set_config('app.api_key_id', r.key_a::text, true);
  select count(*) into n from public.ci_defects; assert n = 0, 'an expired key reads defects';
  assert (select count(*) from public.api_key_lookup(encode(sha256(r.key_a::text::bytea), 'hex'))) = 0, 'an expired key is looked up';
  assert (select count(*) from public.api_key_lookup(encode(sha256(r.key_b::text::bytea), 'hex'))) = 1, 'a valid key is not looked up';
end $$;
reset role;

-- ---------------------------------------------------------------- the GitHub App naming A: none of B's rows, and anchored writes
set local role fenvix_github_app;
do $$
declare r be_ids%rowtype; t text; n int; bp uuid; bd uuid; brun uuid;
begin
  select * into r from be_ids;
  perform set_config('app.workspace_id', r.a::text, true);
  for t in select be_tables.t from be_tables loop
    begin
      execute format('select count(*) from public.%I where workspace_id = $1', t) into n using r.b;
      assert n = 0 or t in ('gh_installations', 'gh_repositories', 'ci_usage_events', 'gh_warmups', 'workspaces'),
        format('READ LEAK: the App naming A reads B''s %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
  -- A project of B's installation cannot be made in A (G-1814: anchored on the installation link).
  begin
    insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.a, 'acct802/stolen', 'python', 'pytest', 802);
    assert false, 'ANCHOR: the App put B''s repository into A';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Children of B's rows cannot be written from a transaction naming A (they take B's organization, then the policy refuses).
select id as bp from public.ci_projects where installation_id = 802 \gset
select id as bd from public.ci_defects where project_id = :'bp' \gset
select id as brun from public.ci_runs where project_id = :'bp' \gset
set local be.bp = :'bp';
set local be.bd = :'bd';
set local be.brun = :'brun';
set local role fenvix_github_app;
do $$
begin
  perform set_config('app.workspace_id', (select a from be_ids)::text, true);
  begin
    insert into public.ci_runs (workspace_id, project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at)
      values ((select a from be_ids), current_setting('be.bp')::uuid, 9, repeat('d', 40), 'main', 'push', 'running', now(), now());
    assert false, 'ANCHOR: a run went into B from A';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.ci_defect_occurrences (workspace_id, defect_id, run_id, source, status, seen_at)
      values ((select a from be_ids), current_setting('be.bd')::uuid, current_setting('be.brun')::uuid, 'run', 'reported', now());
    assert false, 'ANCHOR: an occurrence went into B''s defect from A';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.ci_defect_bundles (workspace_id, defect_id, sha256, size_bytes, content) values ((select a from be_ids), current_setting('be.bd')::uuid, repeat('1', 64), 1, '\x01');
    assert false, 'ANCHOR: a bundle went into B''s defect from A';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- deleting
do $$
declare r be_ids%rowtype; n int; v uuid;
begin
  select * into r from be_ids;
  -- Usage events outlive their organization (billing records, G-1813).
  delete from public.workspaces where id = r.b;
  select count(*) into n from public.ci_usage_events where installation_id = 802; assert n = 1, 'B''s usage events went with it';
  select count(*) into n from public.ci_defect_bundles where workspace_id = r.b; assert n = 0, 'B''s bundles stayed';
  select workspace_id into v from public.gh_installations where installation_id = 802; assert v is null, 'B''s installation is still linked';
  -- An orphan organization goes with its last member (G-1811).
  delete from auth.users where id = '8ccccccc-0000-4000-8000-000000000003';
  delete from auth.users where id = '8aaaaaaa-0000-4000-8000-000000000001';
  select count(*) into n from public.workspaces where id = r.a; assert n = 0, 'ORPHAN: A stayed without members';
  select count(*) into n from public.ci_defects where workspace_id = r.a; assert n = 0, 'ORPHAN: A''s defects stayed';
  -- An invited person who signs up gets no empty organization of their own (G-2340).
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ('8ddddddd-0000-4000-8000-000000000004', 'be.inviter@fenvix.invalid', '{}', now());
  insert into public.workspace_invites (workspace_id, email, role, token_hash, expires_at)
    select m.workspace_id, 'be.invited@fenvix.invalid', 'member', repeat('6', 64), now() + interval '7 days' from public.workspace_members m where m.user_id = '8ddddddd-0000-4000-8000-000000000004';
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ('8eeeeeee-0000-4000-8000-000000000005', 'be.invited@fenvix.invalid', '{}', now());
  select count(*) into n from public.workspace_members where user_id = '8eeeeeee-0000-4000-8000-000000000005';
  assert n = 0, 'an invited sign-up got an organization of its own';
end $$;

-- ---------------------------------------------------------------- tables created later are not the browser's (G-2342)
-- Created as the role the migrations run as (postgres), whose default privileges Supabase sets for anon and authenticated.
set local role postgres;
do $$
declare v_can boolean;
begin
  create table public.be_later (id int);
  select has_table_privilege('anon', 'public.be_later', 'select') or has_table_privilege('authenticated', 'public.be_later', 'select') into v_can;
  assert not v_can, 'a new table is readable by the browser''s roles by default';
  drop table public.be_later;
end $$;
reset role;

-- ---------------------------------------------------------------- the API's own rate limit (G-1627)
set local role fenvix_api;
do $$
begin
  assert public.api_rate_hit('test:be', 2) and public.api_rate_hit('test:be', 2), 'the first two requests are refused';
  assert not public.api_rate_hit('test:be', 2), 'the third request this minute is allowed past a limit of 2';
  assert public.api_rate_hit('test:other', 2), 'one subject''s limit holds another back';
end $$;
reset role;

select 'BACKEND RLS OK' as result;
rollback;
