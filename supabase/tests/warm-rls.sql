-- Row level security of the warm-ups and the repositories' cache state (0017_warm_cache.sql). Run AFTER 0001 to 0017.
-- One transaction, rolled back; a failed assertion stops the script naming the check; a clean run ends with
-- "WARM RLS OK".
--
--   owner O and member M share workspace W; outsider X owns workspace XW. Installation 11 is W's, 12 is XW's. Each has a
--   repository with a warm-up; W's repository is warm since a commit.

begin;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('3aaaaaaa-0000-4000-8000-000000000001', 'warm.owner@fenvix.invalid', '{"full_name":"Warm Owner"}', now()),
  ('3bbbbbbb-0000-4000-8000-000000000002', 'warm.member@fenvix.invalid', '{"full_name":"Warm Member"}', now()),
  ('3ddddddd-0000-4000-8000-000000000004', 'warm.outsider@fenvix.invalid', '{"full_name":"Warm Outsider"}', now());

create temporary table warm_ids on commit drop as
select
  (select workspace_id from public.workspace_members where user_id = '3aaaaaaa-0000-4000-8000-000000000001') as w,
  (select workspace_id from public.workspace_members where user_id = '3ddddddd-0000-4000-8000-000000000004') as xw;
grant select on warm_ids to authenticated, anon, fenvix_api, fenvix_github_app;

do $$
declare r warm_ids%rowtype;
begin
  select * into r from warm_ids;
  delete from public.workspaces where id = (select workspace_id from public.workspace_members where user_id = '3bbbbbbb-0000-4000-8000-000000000002');
  insert into public.workspace_members (workspace_id, user_id, role) values (r.w, '3bbbbbbb-0000-4000-8000-000000000002', 'member');
  insert into public.gh_installations (installation_id, account_id, account_login, account_type) values
    (11, 111, 'northwind', 'Organization'), (12, 122, 'outsider', 'User');
  perform public.gh_link_installation(11, r.w, '3aaaaaaa-0000-4000-8000-000000000001');
  perform public.gh_link_installation(12, r.xw, '3ddddddd-0000-4000-8000-000000000004');
  insert into public.gh_repositories (repository_id, installation_id, full_name, default_branch, onboarding_state) values
    (1101, 11, 'northwind/app', 'main', 'merged'), (1202, 12, 'outsider/secret', 'main', 'merged');
  update public.gh_repositories set cache_warm_sha = repeat('a', 40), cache_warm_at = now(), cache_warm_source = 'warmup', cache_warm_pushed_at = now()
    where repository_id = 1101;

  -- A warm-up takes its installation's organization, whatever the writer says.
  insert into public.gh_warmups (repository_id, installation_id, workspace_id, commit_sha, ref, trigger) values
    (1101, 11, r.xw, repeat('a', 40), 'refs/heads/main', 'onboarded'),
    (1202, 12, null, repeat('b', 40), 'refs/heads/main', 'push');
  assert (select workspace_id from public.gh_warmups where repository_id = 1101) = r.w, 'a warm-up did not take its installation''s organization';
  assert (select workspace_id from public.gh_warmups where repository_id = 1202) = r.xw, 'a warm-up did not take its installation''s organization (2)';

  -- One warm-up in flight per repository; one per commit.
  begin
    insert into public.gh_warmups (repository_id, installation_id, commit_sha, ref, trigger) values (1101, 11, repeat('c', 40), 'refs/heads/main', 'push');
    assert false, 'two warm-ups in flight for one repository';
  exception when unique_violation then null; end;
  update public.gh_warmups set status = 'superseded' where repository_id = 1101;
  insert into public.gh_warmups (repository_id, installation_id, commit_sha, ref, trigger) values (1101, 11, repeat('c', 40), 'refs/heads/main', 'push');
  begin
    insert into public.gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status) values (1101, 11, repeat('c', 40), 'refs/heads/main', 'push', 'failed');
    assert false, 'two warm-ups for one commit';
  exception when unique_violation then null; end;
  begin
    insert into public.gh_warmups (repository_id, installation_id, commit_sha, ref, trigger, status) values (1101, 11, repeat('d', 40), 'refs/heads/main', 'push', 'queued');
    assert false, 'an unknown warm-up status was stored';
  exception when check_violation then null; end;

  -- A warm-up's usage event is never billable, and is recorded once.
  insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, warmup_id, kind, billable, reason, occurred_at)
    values (11, 1101, 'northwind/app', (select id from public.gh_warmups where repository_id = 1101 and commit_sha = repeat('a', 40)), 'warmup', false, 'warm-up', now());
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, warmup_id, kind, billable, reason, occurred_at)
      values (11, 1101, 'northwind/app', (select id from public.gh_warmups where repository_id = 1101 and commit_sha = repeat('c', 40)), 'warmup', true, 'warm-up', now());
    assert false, 'a billable warm-up usage event was stored';
  exception when check_violation then null; end;
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, warmup_id, kind, billable, reason, occurred_at)
      values (11, 1101, 'northwind/app', (select id from public.gh_warmups where repository_id = 1101 and commit_sha = repeat('a', 40)), 'warmup', false, 'warm-up', now());
    assert false, 'one warm-up was recorded twice';
  exception when unique_violation then null; end;
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, kind, billable, reason, occurred_at)
      values (11, 1101, 'northwind/app', 'ci_run', true, 'completed', now());
    assert false, 'a run''s usage event without its GitHub job was stored';
  exception when check_violation then null; end;
end $$;

-- ---------------------------------------------------------------- the browser: nothing
set local role anon;
do $$
declare n int;
begin
  select count(*) into n from public.gh_warmups;
  assert false, 'anon can read gh_warmups';
exception when insufficient_privilege then null;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"3bbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.gh_warmups;
  assert false, 'a signed-in browser can read gh_warmups';
exception when insufficient_privilege then null;
end $$;
reset role;

-- ---------------------------------------------------------------- the member, through the API: W's warm-ups and cache state only
set local role fenvix_api;
do $$
declare r warm_ids%rowtype;
begin
  select * into r from warm_ids;
  perform set_config('app.user_id', '3bbbbbbb-0000-4000-8000-000000000002', true), set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.gh_warmups) = 2, 'the member does not see exactly W''s warm-ups';
  assert (select count(*) from public.gh_warmups where repository_id = 1202) = 0, 'READ LEAK: the member sees XW''s warm-up';
  assert (select cache_warm_sha from public.gh_repositories where repository_id = 1101) = repeat('a', 40), 'the member does not see the cache state';
  assert (select count(*) from public.ci_usage_events where kind = 'warmup') = 1, 'the member does not see the warm-up usage event';
  begin
    update public.gh_warmups set status = 'cancelled';
    assert false, 'the API changed a warm-up';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.gh_warmups (repository_id, installation_id, commit_sha, ref, trigger) values (1101, 11, repeat('e', 40), 'refs/heads/main', 'push');
    assert false, 'the API wrote a warm-up';
  exception when insufficient_privilege then null; end;
  begin
    update public.gh_repositories set cache_warm_sha = repeat('f', 40);
    assert false, 'the API changed the cache state';
  exception when insufficient_privilege then null; end;
  -- Naming the other organization shows nothing (the member is not one of its members).
  perform set_config('app.workspace_id', r.xw::text, true);
  assert (select count(*) from public.gh_warmups) = 0, 'READ LEAK: the member sees XW''s warm-ups when naming XW';
end $$;
reset role;

-- The outsider: only XW's.
set local role fenvix_api;
do $$
declare r warm_ids%rowtype;
begin
  select * into r from warm_ids;
  perform set_config('app.user_id', '3ddddddd-0000-4000-8000-000000000004', true), set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.gh_warmups) = 0, 'READ LEAK: the outsider sees W''s warm-ups';
  perform set_config('app.workspace_id', r.xw::text, true);
  assert (select count(*) from public.gh_warmups) = 1 and (select repository_id from public.gh_warmups) = 1202, 'the outsider does not see exactly their warm-up';
end $$;
reset role;

-- ---------------------------------------------------------------- the GitHub App: every warm-up; usage events for its organization only
set local role fenvix_github_app;
do $$
declare r warm_ids%rowtype; n int;
begin
  select * into r from warm_ids;
  perform set_config('app.workspace_id', '', true);
  assert (select count(*) from public.gh_warmups where repository_id in (1101, 1202)) = 3, 'the App does not see every warm-up';
  update public.gh_warmups set status = 'dispatched', dispatched_at = now() where repository_id = 1202;
  get diagnostics n = row_count;
  assert n = 1, 'the App could not update a warm-up';
  update public.gh_repositories set cache_warm_sha = repeat('b', 40), cache_warm_source = 'warmup' where repository_id = 1202;
  -- A warm-up usage event of a linked installation needs its organization in the transaction.
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, warmup_id, kind, billable, reason, occurred_at)
      values (12, 1202, 'outsider/secret', (select id from public.gh_warmups where repository_id = 1202), 'warmup', false, 'warm-up', now());
    assert false, 'the App wrote a usage event outside its organization';
  exception when insufficient_privilege then null; end;
  perform set_config('app.workspace_id', r.xw::text, true);
  insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, warmup_id, kind, billable, reason, occurred_at)
    values (12, 1202, 'outsider/secret', (select id from public.gh_warmups where repository_id = 1202), 'warmup', false, 'warm-up', now());
  -- No delete.
  begin
    delete from public.gh_warmups where repository_id = 1202;
    assert false, 'the App deleted a warm-up';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

select 'WARM RLS OK' as result;
rollback;
