-- Row level security of the GitHub App tables (0013_github_app.sql, as 0014 leaves them). Run AFTER 0001 to 0014.
-- Members read through the dashboard API (fenvix_api); the browser reads nothing.
-- One transaction, rolled back; a failed assertion stops the script naming the check; a clean run ends with "GH RLS OK".
--
--   owner O and member M share workspace W; outsider X owns workspace XW. Installation 1 is W's (linked), installation 2
--   is XW's, installation 3 is not linked yet. Each linked installation has a repository, a project, a run and a usage
--   event; installation 3 has a usage event with no organization.

begin;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('2aaaaaaa-0000-4000-8000-000000000001', 'gh.owner@fenvix.invalid', '{"full_name":"GH Owner"}', now()),
  ('2bbbbbbb-0000-4000-8000-000000000002', 'gh.member@fenvix.invalid', '{"full_name":"GH Member"}', now()),
  ('2ddddddd-0000-4000-8000-000000000004', 'gh.outsider@fenvix.invalid', '{"full_name":"GH Outsider"}', now());

create temporary table gh_ids on commit drop as
select
  (select workspace_id from public.workspace_members where user_id = '2aaaaaaa-0000-4000-8000-000000000001') as w,
  (select workspace_id from public.workspace_members where user_id = '2ddddddd-0000-4000-8000-000000000004') as xw,
  null::uuid as p, null::uuid as xp;
grant select on gh_ids to authenticated, anon, fenvix_api, fenvix_github_app;

do $$
declare r gh_ids%rowtype; v_p uuid; v_xp uuid; run uuid; xrun uuid;
begin
  select * into r from gh_ids;
  assert (select not rolsuper and not rolbypassrls from pg_roles where rolname = 'fenvix_github_app'), 'fenvix_github_app may bypass row level security';
  delete from public.workspaces where id = (select workspace_id from public.workspace_members where user_id = '2bbbbbbb-0000-4000-8000-000000000002');
  insert into public.workspace_members (workspace_id, user_id, role) values (r.w, '2bbbbbbb-0000-4000-8000-000000000002', 'member');
  insert into public.ci_subscriptions (workspace_id, plan_id) values (r.w, 'team'), (r.xw, 'starter');

  insert into public.gh_installations (installation_id, account_id, account_login, account_type) values
    (1, 11, 'northwind', 'Organization'), (2, 22, 'outsider', 'User'), (3, 33, 'pending-co', 'Organization');
  -- Linking: a member cannot, the owner can, another organization then cannot take it.
  begin
    perform public.gh_link_installation(1, r.w, '2bbbbbbb-0000-4000-8000-000000000002');
    assert false, 'a member linked an installation';
  exception when insufficient_privilege then null; end;
  assert public.gh_link_installation(1, r.w, '2aaaaaaa-0000-4000-8000-000000000001') = 'northwind', 'the owner could not link';
  begin
    perform public.gh_link_installation(1, r.xw, '2ddddddd-0000-4000-8000-000000000004');
    assert false, 'another organization took a linked installation';
  exception when unique_violation then null; end;
  perform public.gh_link_installation(2, r.xw, '2ddddddd-0000-4000-8000-000000000004');
  assert (select github_account from public.ci_subscriptions where workspace_id = r.w) = 'northwind', 'the subscription did not record the GitHub account';
  -- Linking starts the 30-day shadow trial, once.
  assert (select trial_ends_at - trial_started_at from public.ci_subscriptions where workspace_id = r.w) = interval '30 days', 'linking did not start the trial';

  -- A repository takes its installation's organization, whatever the writer says.
  insert into public.gh_repositories (repository_id, installation_id, workspace_id, full_name) values
    (101, 1, r.xw, 'northwind/app'), (202, 2, null, 'outsider/secret'), (303, 3, r.w, 'pending-co/x');
  assert (select workspace_id from public.gh_repositories where repository_id = 101) = r.w, 'a repository did not take its installation''s organization';
  assert (select workspace_id from public.gh_repositories where repository_id = 303) is null, 'an unlinked repository got an organization';

  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.w, 'northwind/app', 'python', 'pytest', 1) returning id into v_p;
  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.xw, 'outsider/secret', 'python', 'pytest', 2) returning id into v_xp;
  update gh_ids set p = v_p, xp = v_xp;
  insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at) values (v_p, 1, repeat('a', 40), 'main', 'push', 'passed', now(), now()) returning id into run;
  insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at) values (v_xp, 1, repeat('b', 40), 'main', 'push', 'passed', now(), now()) returning id into xrun;

  insert into public.ci_usage_events (installation_id, workspace_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at) values
    (1, r.xw, 101, 'northwind/app', 1001, 1, true, 'completed', now()),
    (2, null, 202, 'outsider/secret', 2002, 2, true, 'completed', now()),
    (3, r.w, 303, 'pending-co/x', 3003, 3, true, 'completed', now());
  assert (select workspace_id from public.ci_usage_events where github_job_id = 1001) = r.w, 'a usage event did not take its installation''s organization';
  assert (select workspace_id from public.ci_usage_events where github_job_id = 3003) is null, 'an unlinked usage event got an organization';
  assert (select month from public.ci_usage_events where github_job_id = 1001) = date_trunc('month', now() at time zone 'UTC')::date, 'month is wrong';
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at)
      values (1, 101, 'northwind/app', 1001, 1, true, 'completed', now());
    assert false, 'one GitHub job was billed twice';
  exception when unique_violation then null; end;

  insert into public.gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, status) values (5001, 101, 1, 1, repeat('a', 40), 'completed');
  insert into public.gh_run_summaries (repository_id, run_id, runner_name, summary) values (101, 1, 'fenvix-1', '{"tests": 1}');
  insert into public.gh_webhook_deliveries (delivery_id, event) values ('d-1', 'push');
  insert into public.gh_pull_requests (repository_id, number, head_sha, head_ref, base_ref, state) values (101, 1, repeat('a', 40), 'f', 'main', 'open');
  insert into public.gh_pushes (repository_id, sha, ref, pushed_at) values (101, repeat('a', 40), 'refs/heads/main', now());
end $$;

-- ---------------------------------------------------------------- signed out: nothing
set local role anon;
do $$
declare n int; t text;
begin
  foreach t in array array['gh_installations', 'gh_repositories', 'gh_pull_requests', 'gh_pushes', 'gh_jobs', 'gh_run_summaries', 'gh_webhook_deliveries', 'ci_usage_events']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('anon can read %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------- signed in, in the browser: nothing
set local role authenticated;
set local request.jwt.claims = '{"sub":"2bbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare n int; t text;
begin
  foreach t in array array['gh_installations', 'gh_repositories', 'ci_usage_events']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('a signed-in browser can read %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
end $$;
reset role;

-- ---------------------------------------------------------------- the member, through the API: W's installation, repositories, usage; nothing else
set local role fenvix_api;
do $$
declare r gh_ids%rowtype; n int; t text;
begin
  select * into r from gh_ids;
  perform set_config('app.user_id', '2bbbbbbb-0000-4000-8000-000000000002', true), set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.gh_installations) = 1, 'the member does not see exactly their installation';
  assert (select account_login from public.gh_installations) = 'northwind', 'the member sees another installation';
  assert (select count(*) from public.gh_repositories) = 1, 'the member does not see exactly their repository';
  assert (select count(*) from public.ci_usage_events) = 1, 'the member does not see exactly their usage event';
  assert (select count(*) from public.ci_usage_events where workspace_id is null) = 0, 'the member sees an unlinked usage event';
  foreach t in array array['gh_pull_requests', 'gh_pushes', 'gh_jobs', 'gh_run_summaries', 'gh_webhook_deliveries']
  loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert false, format('a member can read %s', t);
    exception when insufficient_privilege then null; end;
  end loop;
  begin
    update public.gh_installations set workspace_id = r.xw;
    assert false, 'a member changed an installation';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at)
      values (1, 101, 'northwind/app', 9999, 1, false, 'completed', now());
    assert false, 'a member wrote a usage event';
  exception when insufficient_privilege then null; end;
  begin
    perform public.gh_link_installation(3, r.w, '2bbbbbbb-0000-4000-8000-000000000002');
    assert false, 'the API called the link function';
  exception when insufficient_privilege then null; end;
  begin
    perform public.gh_is_admin(r.w, '2bbbbbbb-0000-4000-8000-000000000002');
    assert false, 'the API called gh_is_admin';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- The outsider sees only theirs, and nothing of W when naming it.
set local role fenvix_api;
do $$
declare r gh_ids%rowtype;
begin
  select * into r from gh_ids;
  perform set_config('app.user_id', '2ddddddd-0000-4000-8000-000000000004', true), set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.gh_installations) = 0 and (select count(*) from public.ci_usage_events) = 0, 'READ LEAK: the outsider sees W''s GitHub rows';
  perform set_config('app.workspace_id', r.xw::text, true);
  assert (select count(*) from public.gh_installations) = 1 and (select account_login from public.gh_installations) = 'outsider', 'the outsider sees another installation';
  assert (select count(*) from public.ci_usage_events) = 1, 'the outsider does not see exactly their usage event';
end $$;
reset role;

-- ---------------------------------------------------------------- the GitHub App role
set local role fenvix_github_app;
do $$
declare r gh_ids%rowtype; n int;
begin
  select * into r from gh_ids;
  -- Its own tables: all rows.
  assert (select count(*) from public.gh_installations where installation_id in (1, 2, 3)) = 3, 'the App does not see every installation';
  assert (select count(*) from public.gh_jobs where job_id = 5001) = 1 and (select count(*) from public.gh_run_summaries where repository_id = 101) = 1, 'the App does not see its own tables';
  -- CI tables without an organization in the transaction: nothing.
  perform set_config('app.workspace_id', '', true);
  assert (select count(*) from public.ci_projects) = 0, 'the App sees projects with no organization set';
  assert (select count(*) from public.ci_runs) = 0, 'the App sees runs with no organization set';
  assert (select count(*) from public.ci_usage_events where github_job_id in (1001, 2002, 3003)) = 1, 'the App does not see exactly the unlinked usage event';
  -- A usage event of a linked installation cannot be written without its organization.
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at)
      values (1, 101, 'northwind/app', 7001, 1, true, 'completed', now());
    assert false, 'the App wrote a linked usage event outside its organization';
  exception when insufficient_privilege then null; end;
  -- Acting for W: W's rows only, and nothing written into XW.
  perform set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.ci_projects) = 1, 'the App does not see exactly W''s project';
  assert (select count(*) from public.ci_runs) = 1, 'the App does not see exactly W''s run';
  insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at)
    values (1, 101, 'northwind/app', 7002, 1, true, 'completed', now());
  begin
    insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at) values (r.xp, 2, repeat('c', 40), 'main', 'push', 'passed', now(), now());
    assert false, 'the App wrote a run into another organization';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at)
      values (2, 202, 'outsider/secret', 7003, 1, true, 'completed', now());
    assert false, 'the App wrote a usage event into another organization';
  exception when insufficient_privilege then null; end;
  update public.ci_runs set status = 'failed' where project_id = r.xp;
  get diagnostics n = row_count;
  assert n = 0, 'the App changed another organization''s run';
  -- No delete on runs, usage events or installations.
  begin
    delete from public.ci_usage_events where github_job_id = 3003;
    assert false, 'the App deleted usage events';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.gh_installations where installation_id = 3;
    assert false, 'the App deleted installations';
  exception when insufficient_privilege then null; end;
  -- Linking still checks the person.
  begin
    perform public.gh_link_installation(3, r.w, '2bbbbbbb-0000-4000-8000-000000000002');
    assert false, 'the App linked for a member';
  exception when insufficient_privilege then null; end;
  assert public.gh_is_admin(r.w, '2aaaaaaa-0000-4000-8000-000000000001'), 'gh_is_admin: the owner is not admin';
  assert not public.gh_is_admin(r.w, '2bbbbbbb-0000-4000-8000-000000000002'), 'gh_is_admin: a member is admin';
end $$;
reset role;

-- Linking installation 3 gives its waiting usage event the organization.
do $$
declare r gh_ids%rowtype;
begin
  select * into r from gh_ids;
  perform public.gh_link_installation(3, r.w, '2aaaaaaa-0000-4000-8000-000000000001');
  assert (select workspace_id from public.ci_usage_events where github_job_id = 3003) = r.w, 'linking did not give the waiting usage event its organization';
  assert (select workspace_id from public.gh_repositories where repository_id = 303) = r.w, 'linking did not give the repository its organization';
end $$;

select 'GH RLS OK' as result;
rollback;
