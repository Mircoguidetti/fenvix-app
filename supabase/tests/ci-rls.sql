-- Row level security of the CI dashboard tables (0011_ci_runs.sql, as 0014 leaves them). Run AFTER 0001 to 0014. Like
-- the other tests it works in one transaction and rolls everything back; a failed assertion stops the script with a
-- message naming the check; a clean run ends with "CI RLS OK". The browser reads nothing (0014): members read through
-- the dashboard API (role fenvix_api, naming the user and the organization); the GitHub App (fenvix_github_app) writes.
--
--   owner O and member M share workspace W. Outsider X owns workspace XW. Each workspace has one project with one run,
--   one failed test that is a defect, one test skipped with proof and its receipt.

begin;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('1aaaaaaa-0000-4000-8000-000000000001', 'ci.owner@fenvix.invalid', '{"full_name":"CI Owner"}', now()),
  ('1bbbbbbb-0000-4000-8000-000000000002', 'ci.member@fenvix.invalid', '{"full_name":"CI Member"}', now()),
  ('1ddddddd-0000-4000-8000-000000000004', 'ci.outsider@fenvix.invalid', '{"full_name":"CI Outsider"}', now());

create temporary table ci_ids on commit drop as
select
  (select workspace_id from public.workspace_members where user_id = '1aaaaaaa-0000-4000-8000-000000000001') as w,
  (select workspace_id from public.workspace_members where user_id = '1ddddddd-0000-4000-8000-000000000004') as xw;
grant select on ci_ids to authenticated, anon, fenvix_api, fenvix_github_app;

do $$
declare r ci_ids%rowtype; p uuid; xp uuid; run uuid; xrun uuid; d uuid; xd uuid; rc uuid; xrc uuid;
begin
  select * into r from ci_ids;
  delete from public.workspaces where id = (select workspace_id from public.workspace_members where user_id = '1bbbbbbb-0000-4000-8000-000000000002');
  insert into public.workspace_members (workspace_id, user_id, role) values (r.w, '1bbbbbbb-0000-4000-8000-000000000002', 'member');
  insert into public.ci_subscriptions (workspace_id, plan_id, github_account) values (r.w, 'team', 'northwind'), (r.xw, 'starter', 'outsider');

  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.w, 'northwind/homehub', 'python', 'pytest', 101) returning id into p;
  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.xw, 'outsider/secret', 'python', 'pytest', 202) returning id into xp;

  -- workspace_id is taken from the project, whatever the writer says: here the outsider's id is given on purpose.
  insert into public.ci_runs (workspace_id, project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at, tests_total, tests_ran, tests_failed, tests_flaky_defects, tests_skipped)
    values (r.xw, p, 1, repeat('a', 40), 'main', 'push', 'failed', now(), now(), 2, 1, 1, 1, 1) returning id into run;
  insert into public.ci_runs (workspace_id, project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at)
    values (r.xw, xp, 1, repeat('b', 40), 'main', 'push', 'passed', now(), now()) returning id into xrun;
  assert (select workspace_id from public.ci_runs where id = run) = r.w, 'a run did not take its project''s organization';

  insert into public.ci_defects (project_id, workspace_id, test_id, status, cause, cause_tests, minimal_order, seed, fingerprint, family_key, first_seen_at, last_seen_at, language)
    values (p, r.w, 'tests/test_b.py::test_b', 'reproduced', 'polluter', array['tests/test_a.py::test_a'], array['tests/test_a.py::test_a', 'tests/test_b.py::test_b'], 3, repeat('c', 32), 'tests/test_a.py::test_a', now(), now(), 'python') returning id into d;
  insert into public.ci_defects (project_id, workspace_id, test_id, status, cause, minimal_order, fingerprint, family_key, first_seen_at, last_seen_at, language)
    values (xp, r.xw, 'tests/x.py::test_x', 'reproduced', 'fails_alone', array['tests/x.py::test_x'], repeat('d', 32), '<none>', now(), now(), 'python') returning id into xd;

  insert into public.ci_skip_receipts (run_id, workspace_id, test_id, cache_key, reused_engine_run_id, fingerprint) values (run, r.w, 'tests/test_c.py::test_c', repeat('e', 32), '20261117T101502-4412', repeat('f', 32)) returning id into rc;
  insert into public.ci_skip_receipts (run_id, workspace_id, test_id, cache_key, reused_engine_run_id, fingerprint) values (xrun, r.xw, 'tests/x.py::test_y', repeat('e', 32), '20261117T101502-4413', repeat('f', 32)) returning id into xrc;

  insert into public.ci_test_results (run_id, workspace_id, test_id, outcome, failure_kind, defect_id) values (run, r.w, 'tests/test_b.py::test_b', 'failed', 'flaky_defect', d);
  insert into public.ci_test_results (run_id, workspace_id, test_id, outcome, receipt_id) values (run, r.w, 'tests/test_c.py::test_c', 'skipped_with_proof', rc);
  insert into public.ci_test_results (run_id, workspace_id, test_id, outcome, receipt_id) values (xrun, r.xw, 'tests/x.py::test_y', 'skipped_with_proof', xrc);

  -- A failed test must say what kind of failure; a skipped test must have its receipt.
  begin
    insert into public.ci_test_results (run_id, test_id, outcome) values (run, 'tests/bad.py::test_bad', 'failed');
    assert false, 'a failed test was stored without its failure kind';
  exception when check_violation then null; end;
  begin
    insert into public.ci_test_results (run_id, test_id, outcome) values (run, 'tests/bad.py::test_skip', 'skipped_with_proof');
    assert false, 'a test skipped with proof was stored without a receipt';
  exception when check_violation then null; end;
end $$;

-- ---------------------------------------------------------------- signed out: nothing
set local role anon;
do $$
declare n int; t text;
begin
  foreach t in array array['ci_plans', 'ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('anon can read %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------- signed in, in the browser: nothing either (0014)
set local role authenticated;
set local request.jwt.claims = '{"sub":"1bbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare n int; t text;
begin
  foreach t in array array['ci_plans', 'ci_reference_rates', 'ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('a signed-in browser can read %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------- the member, through the API: reads W, never XW, writes nothing
set local role fenvix_api;
do $$
declare r ci_ids%rowtype; n int; t text;
begin
  select * into r from ci_ids;
  perform set_config('app.user_id', '1bbbbbbb-0000-4000-8000-000000000002', true), set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.ci_plans where kind = 'plan') = 4, 'the plans are not readable';
  assert (select count(*) from public.ci_plans where kind = 'plan' and price_usd_month is null) = 0, 'a plan has no price (prices set on 2026-11-18)';
  assert (select count(*) from public.ci_plans where units_included is not null) = 0, 'a plan has included units: they are not set yet';
  assert (select count(*) from public.ci_reference_rates) >= 1, 'the reference rates are not readable';
  foreach t in array array['ci_subscriptions', 'ci_projects', 'ci_runs', 'ci_defects', 'ci_skip_receipts', 'ci_test_results']
  loop
    execute format('select count(*) from public.%I where workspace_id = $1', t) into n using r.w;
    assert n >= 1, format('the member cannot read W''s %s', t);
    execute format('select count(*) from public.%I where workspace_id = $1', t) into n using r.xw;
    assert n = 0, format('READ LEAK: the member sees the outsider''s %s', t);
  end loop;

  update public.ci_projects set nightly_exploration = true where workspace_id = r.w;
  get diagnostics n = row_count;
  assert n = 0, 'ROLE LEAK: a member changed a project''s settings';

  begin
    insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at)
      select id, 99, repeat('9', 40), 'main', 'push', 'passed', now(), now() from public.ci_projects where workspace_id = r.w;
    assert false, 'the API can insert runs';
  exception when insufficient_privilege then null; end;
  -- A member may fix, mute or reopen a defect of W (0019), nothing else of it, and nothing of another organization.
  begin
    update public.ci_defects set test_id = 'renamed';
    assert false, 'the API can change a defect beyond its state';
  exception when insufficient_privilege then null; end;
  update public.ci_defects set state = 'fixed' where workspace_id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: a member changed the outsider''s defect';
  begin
    update public.ci_plans set price_usd_month = 1;
    assert false, 'the API can set a price';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.ci_projects;
    assert false, 'the API can delete projects';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- the owner, through the API: settings of W only, four columns only
set local role fenvix_api;
do $$
declare r ci_ids%rowtype; n int;
begin
  select * into r from ci_ids;
  perform set_config('app.user_id', '1aaaaaaa-0000-4000-8000-000000000001', true), set_config('app.workspace_id', r.w::text, true);
  update public.ci_projects set nightly_exploration = true, test_command = 'pytest -x tests' where workspace_id = r.w;
  get diagnostics n = row_count;
  assert n = 1, 'the owner cannot change a project''s settings';
  update public.ci_projects set nightly_exploration = true where workspace_id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: the owner changed the outsider''s project';
  -- Naming the outsider's organization does not help.
  perform set_config('app.workspace_id', r.xw::text, true);
  update public.ci_projects set nightly_exploration = true where workspace_id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: naming another organization let the owner change its project';
  perform set_config('app.workspace_id', r.w::text, true);
  begin
    update public.ci_projects set full_name = 'northwind/renamed' where workspace_id = r.w;
    assert false, 'the owner can rename a project (only the App may)';
  exception when insufficient_privilege then null; end;
  begin
    update public.ci_projects set setup_state = 'active' where workspace_id = r.w;
    assert false, 'the owner can change a project''s setup state';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- the GitHub App: one organization per transaction
set local role fenvix_github_app;
do $$
declare r ci_ids%rowtype; n int; p uuid;
begin
  select * into r from ci_ids;
  perform set_config('app.workspace_id', '', true);
  assert (select count(*) from public.ci_runs) = 0, 'the App reads runs without naming an organization';
  perform set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.ci_runs) = 1, 'the App cannot read the runs of the organization it acts for';
  assert (select count(*) from public.ci_projects where workspace_id = r.xw) = 0, 'READ LEAK: the App sees another organization';
  select id into p from public.ci_projects limit 1;
  insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at, tests_total, tests_ran)
    values (p, 2, repeat('1', 40), 'main', 'push', 'passed', now(), now(), 1, 1);
  assert (select count(*) from public.ci_runs) = 2, 'the App cannot add a run';
  begin
    insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.xw, 'outsider/planted', 'python', 'pytest', 1);
    assert false, 'WRITE LEAK: the App planted a project in another organization';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- A run of another organization's project cannot be planted either: the trigger takes the project's organization, and
-- the App acting for W cannot see XW's project at all.
set local role fenvix_github_app;
do $$
declare r ci_ids%rowtype;
begin
  select * into r from ci_ids;
  perform set_config('app.workspace_id', r.w::text, true);
  begin
    insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at)
      values ((select id from public.ci_projects where full_name = 'outsider/secret'), 3, repeat('2', 40), 'main', 'push', 'passed', now(), now());
    assert false, 'WRITE LEAK: a run was planted in another organization';
  exception when not_null_violation or foreign_key_violation or insufficient_privilege then null; end;
end $$;
reset role;

select 'CI RLS OK' as result;
rollback;
