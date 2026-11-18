-- Row level security for the dashboard API (0014_dashboard_api.sql): the role fenvix_api, which names in each
-- transaction the signed-in user (app.user_id) and the organization (app.workspace_id). Run AFTER 0001 to 0014. One
-- transaction, rolled back; a failed assertion stops the script naming the check; a clean run ends with "API RLS OK".
--
--   owner O, admin A and member M share organization W; outsider X owns organization XW. Each organization has a
--   project, a run with a receipt, a test result and an audit rerun, a defect, an exploration, an installation with a
--   repository, a usage event and a pending invitation.

begin;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('3aaaaaaa-0000-4000-8000-000000000001', 'api.owner@fenvix.invalid', '{"full_name":"API Owner"}', now()),
  ('3bbbbbbb-0000-4000-8000-000000000002', 'api.admin@fenvix.invalid', '{}', now()),
  ('3ccccccc-0000-4000-8000-000000000003', 'api.member@fenvix.invalid', '{}', now()),
  ('3ddddddd-0000-4000-8000-000000000004', 'api.outsider@fenvix.invalid', '{}', now()),
  ('3eeeeeee-0000-4000-8000-000000000005', 'api.invited@fenvix.invalid', '{}', now());

create temporary table api_ids on commit drop as
select
  (select workspace_id from public.workspace_members where user_id = '3aaaaaaa-0000-4000-8000-000000000001') as w,
  (select workspace_id from public.workspace_members where user_id = '3ddddddd-0000-4000-8000-000000000004') as xw,
  null::uuid as p, null::uuid as xp;
grant select on api_ids to anon, authenticated, fenvix_api;

-- ---------------------------------------------------------------- the old product is gone; the browser has no right left

do $$
declare t text; f text; r record;
begin
  foreach t in array array['databases', 'database_tags', 'usage_daily', 'usage_hourly', 'wake_events', 'invoices', 'api_keys', 'operations',
                           'idempotency_keys', 'audit_log', 'data_audit_log', 'database_ip_allowlists', 'public_api_keys', 'workspace_settings']
  loop
    assert to_regclass('public.' || t) is null, format('the old table %s is still there', t);
  end loop;
  assert not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'fenvix\_%' or p.proname = 'current_workspace')),
    'a function of the old product is still there';
  assert not exists (select 1 from pg_roles where rolname = 'fenvix_control_plane'), 'the control plane''s role is still there';
  assert (select not rolsuper and not rolbypassrls from pg_roles where rolname = 'fenvix_api'), 'fenvix_api may bypass row level security';

  -- No table, view or sequence of public grants anything to the browser's roles, and every table has row level security on.
  for r in select c.relname, c.relkind, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S', 'p') loop
    foreach f in array array['anon', 'authenticated'] loop
      if r.relkind = 'S' then
        assert not has_sequence_privilege(f, 'public.' || quote_ident(r.relname), 'USAGE,SELECT,UPDATE'), format('%s has a right on the sequence %s', f, r.relname);
      else
        assert not has_table_privilege(f, 'public.' || quote_ident(r.relname), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), format('%s has a right on %s', f, r.relname);
        assert not has_any_column_privilege(f, 'public.' || quote_ident(r.relname), 'SELECT,INSERT,UPDATE,REFERENCES'), format('%s has a column right on %s', f, r.relname);
      end if;
    end loop;
    if r.relkind in ('r', 'p') then assert r.relrowsecurity, format('row level security is off on %s', r.relname); end if;
  end loop;
  -- Nor may they call the API's functions or the membership helpers.
  foreach f in array array['api_user()', 'api_workspace()', 'api_admin_workspace()', 'api_my_workspace_ids()', 'api_me()', 'api_members()',
                           'api_create_organization(text, integer)', 'api_accept_invitation(text, integer)', 'my_workspace_ids()', 'my_admin_workspace_ids()',
                           'is_workspace_member(uuid)', 'ensure_workspace(uuid, text, text)', 'gh_link_installation(bigint, uuid, uuid)']
  loop
    assert not has_function_privilege('anon', 'public.' || f, 'EXECUTE'), format('anon may call %s', f);
    assert not has_function_privilege('authenticated', 'public.' || f, 'EXECUTE'), format('authenticated may call %s', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- the data (as the database owner: the App and the runner)

do $$
declare r api_ids%rowtype; v_p uuid; v_xp uuid; run uuid; xrun uuid; rc uuid; xrc uuid;
begin
  select * into r from api_ids;
  -- The admin and the member joined W (their own organizations from sign-up are removed).
  delete from public.workspaces where id in (select workspace_id from public.workspace_members where user_id in ('3bbbbbbb-0000-4000-8000-000000000002', '3ccccccc-0000-4000-8000-000000000003', '3eeeeeee-0000-4000-8000-000000000005'));
  insert into public.workspace_members (workspace_id, user_id, role) values (r.w, '3bbbbbbb-0000-4000-8000-000000000002', 'admin'), (r.w, '3ccccccc-0000-4000-8000-000000000003', 'member');
  insert into public.ci_subscriptions (workspace_id, plan_id, trial_started_at, trial_ends_at) values (r.w, 'team', now(), now() + interval '30 days'), (r.xw, 'starter', null, null);
  insert into public.gh_installations (installation_id, workspace_id, account_id, account_login, account_type) values (31, r.w, 310, 'northwind', 'Organization'), (32, r.xw, 320, 'outsider', 'User');
  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.w, 'northwind/app', 'python', 'pytest', 31) returning id into v_p;
  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.xw, 'outsider/secret', 'python', 'pytest', 32) returning id into v_xp;
  update api_ids set p = v_p, xp = v_xp;
  insert into public.gh_repositories (repository_id, installation_id, full_name, project_id) values (3101, 31, 'northwind/app', v_p), (3201, 32, 'outsider/secret', v_xp);
  insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at, tests_total, tests_ran, tests_skipped)
    values (v_p, 1, repeat('a', 40), 'main', 'push', 'passed', now(), now(), 2, 1, 1) returning id into run;
  insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at, tests_total, tests_ran, tests_skipped)
    values (v_xp, 1, repeat('b', 40), 'main', 'push', 'passed', now(), now(), 2, 1, 1) returning id into xrun;
  insert into public.ci_skip_receipts (run_id, test_id, cache_key, reused_engine_run_id, fingerprint) values (run, 't::a', repeat('e', 32), 'e1', repeat('f', 32)) returning id into rc;
  insert into public.ci_skip_receipts (run_id, test_id, cache_key, reused_engine_run_id, fingerprint) values (xrun, 't::x', repeat('e', 32), 'e2', repeat('f', 32)) returning id into xrc;
  insert into public.ci_test_results (run_id, test_id, outcome, receipt_id) values (run, 't::a', 'skipped_with_proof', rc), (xrun, 't::x', 'skipped_with_proof', xrc);
  insert into public.ci_audit_reruns (run_id, test_id, cache_key, outcome) values (run, 't::a', repeat('1', 32), 'confirmed'), (xrun, 't::x', repeat('2', 32), 'wrong_skip');
  -- The organization of a child row comes from its parent, whatever the writer says.
  assert (select workspace_id from public.ci_audit_reruns where run_id = run) = r.w, 'an audit rerun did not take its run''s organization';
  insert into public.ci_defects (project_id, test_id, status, cause, minimal_order, fingerprint, family_key, first_seen_at, last_seen_at, language)
    values (v_p, 't::d', 'reproduced', 'fails_alone', array['t::d'], repeat('c', 32), '<none>', now(), now(), 'python'),
           (v_xp, 't::xd', 'reproduced', 'fails_alone', array['t::xd'], repeat('d', 32), '<none>', now(), now(), 'python');
  insert into public.ci_explorations (project_id, started_at, finished_at, commit_sha, seeds, runs) values (v_p, now(), now(), repeat('a', 40), 5, 5), (v_xp, now(), now(), repeat('b', 40), 5, 5);
  insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at, test_minutes_ran, minutes_saved, other_step_minutes)
    values (31, 3101, 'northwind/app', 31001, 1, true, 'completed', now(), 2, 7, 1), (32, 3201, 'outsider/secret', 32001, 1, true, 'completed', now(), 1, 1, 1);
  assert (select units from public.ci_usage_events where github_job_id = 31001) = 1.00, 'units: 10 baseline minutes are 1 unit';
  insert into public.workspace_invites (workspace_id, email, role, token_hash, expires_at) values
    (r.w, 'api.invited@fenvix.invalid', 'member', encode(sha256('w-token'), 'hex'), now() + interval '7 days'),
    (r.xw, 'someone@fenvix.invalid', 'admin', encode(sha256('xw-token'), 'hex'), now() + interval '7 days');
end $$;

-- ---------------------------------------------------------------- signed out and signed in (PostgREST roles): nothing at all
set local role anon;
do $$
declare n int; t text;
begin
  foreach t in array array['workspaces', 'workspace_members', 'workspace_invites', 'ci_plans', 'ci_projects', 'ci_runs', 'ci_audit_reruns', 'gh_installations', 'gh_run_results']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('anon can read %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"3aaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare n int; t text;
begin
  foreach t in array array['workspaces', 'workspace_members', 'workspace_invites', 'ci_plans', 'ci_reference_rates', 'ci_subscriptions', 'ci_projects', 'ci_runs',
                           'ci_defects', 'ci_skip_receipts', 'ci_test_results', 'ci_explorations', 'ci_audit_reruns', 'ci_usage_events', 'gh_installations', 'gh_repositories']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('a signed-in browser can still read %s: the dashboard must go through the API', t);
    exception when insufficient_privilege then null; end;
  end loop;
  begin
    update public.workspaces set name = 'Browser rename';
    assert false, 'a signed-in browser can rename an organization';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- fenvix_api as the member: reads W, nothing of XW, changes nothing
set local role fenvix_api;
do $$
declare r api_ids%rowtype; n int; t text;
begin
  select * into r from api_ids;
  -- Nobody named: nothing (the API always names the person).
  perform set_config('app.user_id', '', true), set_config('app.workspace_id', '', true);
  assert (select count(*) from public.workspaces) = 0, 'workspaces visible with no user named';
  assert (select count(*) from public.ci_runs) = 0, 'runs visible with no user named';

  perform set_config('app.user_id', '3ccccccc-0000-4000-8000-000000000003', true), set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.ci_plans) = 5, 'the plans and the add-on are not readable';
  assert (select count(*) from public.ci_reference_rates) >= 1, 'the reference rates are not readable';
  foreach t in array array['ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results', 'ci_explorations',
                           'ci_audit_reruns', 'ci_usage_events', 'gh_installations', 'gh_repositories']
  loop
    execute format('select count(*) from public.%I where workspace_id = $1', t) into n using r.w;
    assert n >= 1, format('the member cannot read W''s %s', t);
    execute format('select count(*) from public.%I where workspace_id = $1', t) into n using r.xw;
    assert n = 0, format('READ LEAK: the member sees XW''s %s', t);
  end loop;
  assert (select count(*) from public.workspaces) = 1, 'the member does not see exactly their organization';
  assert (select count(*) from public.workspace_members) = 3, 'the member does not see W''s three members';
  assert (select count(*) from public.api_members()) = 3, 'api_members() does not list W''s members';
  assert (select email from public.api_me()) = 'api.member@fenvix.invalid', 'api_me() is not the member';
  assert (select count(*) from public.workspace_invites) = 0, 'a member reads the invitations';
  foreach t in array array['gh_jobs', 'gh_pull_requests', 'gh_pushes', 'gh_run_summaries', 'gh_webhook_deliveries', 'gh_run_results']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('the API can read the App''s table %s', t);
    exception when insufficient_privilege then null; end;
  end loop;

  -- No setting, region, project setting, role, member or invitation changes as a member.
  update public.workspaces set name = 'Member rename', region = 'eu', email_notices = false where id = r.w;
  get diagnostics n = row_count;
  assert n = 0, 'ROLE LEAK: a member changed the organization''s settings or region';
  update public.ci_projects set skip_with_proof = false, test_command = 'x' where workspace_id = r.w;
  get diagnostics n = row_count;
  assert n = 0, 'ROLE LEAK: a member changed a project''s settings';
  update public.workspace_members set role = 'owner' where workspace_id = r.w;
  get diagnostics n = row_count;
  assert n = 0, 'ROLE LEAK: a member changed a role';
  delete from public.workspace_members where workspace_id = r.w and user_id <> '3ccccccc-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  assert n = 0, 'ROLE LEAK: a member removed someone';
  update public.workspace_invites set revoked_at = now() where workspace_id = r.w;
  get diagnostics n = row_count;
  assert n = 0, 'ROLE LEAK: a member revoked an invitation';
  begin
    insert into public.workspace_invites (workspace_id, email, role, token_hash, expires_at) values (r.w, 'x@fenvix.invalid', 'member', repeat('0', 64), now() + interval '1 day');
    assert false, 'ROLE LEAK: a member created an invitation';
  exception when insufficient_privilege then null; end;

  -- Leaving is allowed (rolled back right after).
  begin
    delete from public.workspace_members where workspace_id = r.w and user_id = '3ccccccc-0000-4000-8000-000000000003';
    get diagnostics n = row_count;
    assert n = 1, 'a member cannot leave';
    raise exception 'undo' using errcode = 'P0001';
  exception when raise_exception then null; end;

  -- Naming an organization they are not in: nothing of it.
  perform set_config('app.workspace_id', r.xw::text, true);
  foreach t in array array['ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_usage_events', 'gh_installations', 'gh_repositories', 'ci_audit_reruns']
  loop
    execute format('select count(*) from public.%I', t) into n;
    assert n = 0, format('READ LEAK: naming XW shows its %s to a non-member', t);
  end loop;
  assert (select count(*) from public.api_members()) = 0, 'api_members() lists another organization''s members';
  assert (select count(*) from public.workspaces where id = r.xw) = 0, 'a non-member sees XW';
end $$;
reset role;

-- ---------------------------------------------------------------- the admin: settings, region, project settings, members, invitations of W only
set local role fenvix_api;
do $$
declare r api_ids%rowtype; n int;
begin
  select * into r from api_ids;
  perform set_config('app.user_id', '3bbbbbbb-0000-4000-8000-000000000002', true), set_config('app.workspace_id', r.w::text, true);
  update public.workspaces set name = 'Northwind', region = 'eu', email_notices = false, name_confirmed = true where id = r.w;
  get diagnostics n = row_count;
  assert n = 1, 'the admin cannot change the settings and the region';
  update public.ci_projects set skip_with_proof = false, comment_on_pull_requests = false, nightly_exploration = true, test_command = 'pytest -x' where workspace_id = r.w;
  get diagnostics n = row_count;
  assert n = 1, 'the admin cannot change a project''s settings';
  begin
    update public.ci_projects set full_name = 'northwind/renamed' where workspace_id = r.w;
    assert false, 'the admin changed a project column outside its four settings';
  exception when insufficient_privilege then null; end;
  begin
    update public.workspaces set created_at = now() where id = r.w;
    assert false, 'the admin changed an organization column outside its settings';
  exception when insufficient_privilege then null; end;
  update public.workspace_members set role = 'admin' where workspace_id = r.w and user_id = '3ccccccc-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  assert n = 1, 'the admin cannot change a role';
  insert into public.workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
    values (r.w, 'new@fenvix.invalid', 'member', repeat('1', 64), '3bbbbbbb-0000-4000-8000-000000000002', now() + interval '7 days');
  assert (select count(*) from public.workspace_invites) = 2, 'the admin does not read exactly W''s invitations';
  update public.workspace_invites set revoked_at = now(), revoked_by = '3bbbbbbb-0000-4000-8000-000000000002' where token_hash = repeat('1', 64);
  get diagnostics n = row_count;
  assert n = 1, 'the admin cannot revoke an invitation';
  begin
    update public.workspace_invites set role = 'admin' where workspace_id = r.w;
    assert false, 'the admin changed an invitation''s role';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.workspace_members where workspace_id = r.w and user_id = '3ccccccc-0000-4000-8000-000000000003';
    get diagnostics n = row_count;
    assert n = 1, 'the admin cannot remove a member';
    raise exception 'undo' using errcode = 'P0001';
  exception when raise_exception then null; end;
  -- Nothing of XW, even when it is named.
  update public.workspaces set name = 'Taken' where id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: the admin renamed another organization';
  update public.ci_projects set skip_with_proof = false where workspace_id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: the admin changed another organization''s project';
  begin
    insert into public.workspace_invites (workspace_id, email, role, token_hash, expires_at) values (r.xw, 'y@fenvix.invalid', 'admin', repeat('2', 64), now() + interval '1 day');
    assert false, 'WRITE LEAK: an invitation into another organization';
  exception when insufficient_privilege then null; end;
  perform set_config('app.workspace_id', r.xw::text, true);
  update public.workspaces set name = 'Taken' where id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: naming XW let the admin of W rename it';
  -- The API writes nothing the App and the runner write.
  perform set_config('app.workspace_id', r.w::text, true);
  begin
    insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at) values (r.p, 9, repeat('9', 40), 'main', 'push', 'passed', now(), now());
    assert false, 'the API can insert runs';
  exception when insufficient_privilege then null; end;
  begin
    update public.ci_runs set status = 'failed';
    assert false, 'the API can change runs';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.ci_projects;
    assert false, 'the API can delete projects';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.workspace_members (workspace_id, user_id, role) values (r.w, '3ddddddd-0000-4000-8000-000000000004', 'owner');
    assert false, 'the API can add members directly';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.workspaces (name) values ('direct');
    assert false, 'the API can create organizations directly';
  exception when insufficient_privilege then null; end;
  begin
    update public.ci_plans set price_usd_month = 1;
    assert false, 'the API can set a price';
  exception when insufficient_privilege then null; end;
  begin
    update public.ci_subscriptions set plan_id = 'scale';
    assert false, 'the API can change the plan';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- the owner: the last owner never leaves; the functions
set local role fenvix_api;
do $$
declare r api_ids%rowtype; ws uuid;
begin
  select * into r from api_ids;
  perform set_config('app.user_id', '3aaaaaaa-0000-4000-8000-000000000001', true), set_config('app.workspace_id', r.w::text, true);
  begin
    delete from public.workspace_members where workspace_id = r.w and user_id = '3aaaaaaa-0000-4000-8000-000000000001';
    assert false, 'the last owner left';
  exception when check_violation then null; end;
  begin
    update public.workspace_members set role = 'member' where workspace_id = r.w and user_id = '3aaaaaaa-0000-4000-8000-000000000001';
    assert false, 'the last owner was demoted';
  exception when check_violation then null; end;

  -- A new organization: its creator is its owner; at most p_max memberships.
  ws := public.api_create_organization('Second', 50);
  assert (select role from public.workspace_members where workspace_id = ws and user_id = '3aaaaaaa-0000-4000-8000-000000000001') = 'owner', 'the creator is not the owner';
  begin
    perform public.api_create_organization('Third', 2);
    assert false, 'more organizations than allowed';
  exception when check_violation then null; end;

  -- Invitations: only the invited, verified address; once.
  perform set_config('app.user_id', '3ddddddd-0000-4000-8000-000000000004', true), set_config('app.workspace_id', '', true);
  assert (select count(*) from public.api_accept_invitation(encode(sha256('w-token'), 'hex'), 50)) = 0, 'another address accepted an invitation';
  perform set_config('app.user_id', '3eeeeeee-0000-4000-8000-000000000005', true);
  assert (select count(*) from public.api_accept_invitation(encode(sha256('unknown'), 'hex'), 50)) = 0, 'an unknown token was accepted';
  -- W has 3 members: with a limit of 3 the new member is refused, with a message a person can read.
  begin
    perform public.api_accept_invitation(encode(sha256('w-token'), 'hex'), 3);
    assert false, 'a full organization took a new member';
  exception when check_violation then null; end;
end $$;
reset role;

set local role fenvix_api;
do $$
declare r api_ids%rowtype; acc record;
begin
  select * into r from api_ids;
  perform set_config('app.user_id', '3eeeeeee-0000-4000-8000-000000000005', true), set_config('app.workspace_id', '', true);
  select * into acc from public.api_accept_invitation(encode(sha256('w-token'), 'hex'), 50);
  assert acc.workspace_id = r.w and acc.role = 'member' and not acc.already_member, 'the invited person could not join';
  assert (select count(*) from public.api_accept_invitation(encode(sha256('w-token'), 'hex'), 50)) = 0, 'an invitation was used twice';
  assert (select count(*) from public.workspaces) = 1, 'the new member does not see their new organization';
end $$;
reset role;

select 'API RLS OK' as result;
rollback;
