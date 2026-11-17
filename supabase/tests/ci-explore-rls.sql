-- Row level security of 0012 (explorations). One transaction, rolled back; a clean run ends with "CI EXPLORE RLS OK".
begin;
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('2aaaaaaa-0000-4000-8000-000000000001', 'ex.owner@fenvix.invalid', '{}', now()),
  ('2ddddddd-0000-4000-8000-000000000004', 'ex.outsider@fenvix.invalid', '{}', now());
create temporary table ex_ids on commit drop as select
  (select workspace_id from public.workspace_members where user_id = '2aaaaaaa-0000-4000-8000-000000000001') as w,
  (select workspace_id from public.workspace_members where user_id = '2ddddddd-0000-4000-8000-000000000004') as xw;
grant select on ex_ids to authenticated, fenvix_control_plane;
do $$
declare r ex_ids%rowtype; p uuid; xp uuid;
begin
  select * into r from ex_ids;
  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.w, 'own/app', 'python', 'pytest', 1) returning id into p;
  insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id) values (r.xw, 'other/app', 'python', 'pytest', 2) returning id into xp;
  -- the organization comes from the project, whatever the writer says
  insert into public.ci_explorations (workspace_id, project_id, started_at, finished_at, commit_sha, seeds, runs) values (r.xw, p, now(), now(), repeat('a', 40), 50, 50);
  insert into public.ci_explorations (project_id, started_at, finished_at, commit_sha, seeds, runs) values (xp, now(), now(), repeat('b', 40), 50, 50);
  assert (select count(*) from public.ci_explorations where workspace_id = r.w) = 1, 'an exploration did not take its project''s organization';
  insert into public.ci_runs (project_id, number, commit_sha, branch, trigger, status, pushed_at, started_at, skip_misses, miss_details)
    values (p, 1, repeat('c', 40), 'main', 'push', 'passed', now(), now(), '{"code": 3}', '[{"kind": "code", "detail": "src/x.py::f", "tests": 3}]');
end $$;
set local role anon;
do $$ declare n int; begin
  begin select count(*) into n from public.ci_explorations; assert false, 'anon can read explorations'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"2aaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';
do $$ declare r ex_ids%rowtype; begin
  select * into r from ex_ids;
  assert (select count(*) from public.ci_explorations) = 1, 'the owner does not see exactly their own exploration';
  assert (select count(*) from public.ci_explorations where workspace_id = r.xw) = 0, 'READ LEAK: another organization''s exploration';
  assert (select skip_misses ->> 'code' from public.ci_runs limit 1) = '3', 'the run''s skip misses are not readable';
  begin insert into public.ci_explorations (project_id, started_at, finished_at, commit_sha, seeds, runs) select id, now(), now(), repeat('d', 40), 1, 1 from public.ci_projects limit 1;
    assert false, 'a signed-in user can write explorations'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role fenvix_control_plane;
do $$ declare r ex_ids%rowtype; begin
  select * into r from ex_ids;
  perform set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.ci_explorations) = 1, 'the control plane does not see its organization''s exploration only';
end $$;
reset role;
select 'CI EXPLORE RLS OK' as result;
rollback;
