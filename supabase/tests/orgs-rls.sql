-- Row level security of organizations (0008_organizations.sql). Run AFTER 0001, 0002 and 0008 (0003, 0004, 0005,
-- 0007 optional). Like rls.sql it works inside one transaction and rolls everything back; a failed assertion stops
-- the script with a message naming the check; a clean run ends with "ORGS RLS OK".
--
--   owner O and member M share workspace W (O also owns nothing else; M also owns their own workspace MW).
--   admin D is admin of W. outsider X owns workspace XW only.

begin;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('0aaaaaaa-0000-4000-8000-000000000001', 'org.owner@fenvix.invalid', '{"full_name":"Org Owner"}', now()),
  ('0bbbbbbb-0000-4000-8000-000000000002', 'org.member@fenvix.invalid', '{"full_name":"Org Member"}', now()),
  ('0ccccccc-0000-4000-8000-000000000003', 'org.admin@fenvix.invalid', '{"full_name":"Org Admin"}', null),
  ('0ddddddd-0000-4000-8000-000000000004', 'org.outsider@fenvix.invalid', '{"full_name":"Org Outsider"}', now());

create temporary table org_ids on commit drop as
select
  (select workspace_id from public.workspace_members where user_id = '0aaaaaaa-0000-4000-8000-000000000001') as w,
  (select workspace_id from public.workspace_members where user_id = '0bbbbbbb-0000-4000-8000-000000000002') as mw,
  (select workspace_id from public.workspace_members where user_id = '0ccccccc-0000-4000-8000-000000000003') as dw,
  (select workspace_id from public.workspace_members where user_id = '0ddddddd-0000-4000-8000-000000000004') as xw;
grant select on org_ids to authenticated, fenvix_control_plane;

do $$
declare r org_ids%rowtype;
begin
  select * into r from org_ids;
  -- The sign-up trigger is unchanged: one workspace each, owner, name not confirmed.
  assert (select count(*) from public.workspaces where id in (r.w, r.mw, r.dw, r.xw)) = 4, 'the sign-up trigger did not make one workspace each';
  assert not exists (select 1 from public.workspaces where id in (r.w, r.mw, r.dw, r.xw) and name_confirmed), 'a new workspace starts with name_confirmed = false';
  -- M and D join W. D's own workspace goes (admins here are only admins of W).
  delete from public.workspaces where id = r.dw;
  insert into public.workspace_members (workspace_id, user_id, role) values
    (r.w, '0bbbbbbb-0000-4000-8000-000000000002', 'member'),
    (r.w, '0ccccccc-0000-4000-8000-000000000003', 'admin');
  -- Joined later than the sign-up (one transaction gives every row the same now()).
  update public.workspace_members set created_at = now() + interval '1 minute' where workspace_id = r.w and role <> 'owner';
  insert into public.databases (workspace_id, name, region) values (r.w, 'org-shared-01', 'eu-west'), (r.xw, 'org-outsider-01', 'eu-west');
  insert into public.workspace_invites (workspace_id, email, role, token_hash, expires_at) values
    (r.w, 'invited@fenvix.invalid', 'member', repeat('1', 64), now() + interval '7 days'),
    (r.xw, 'invited@fenvix.invalid', 'admin', repeat('2', 64), now() + interval '7 days');
end $$;

-- ---------------------------------------------------------------- signed out: nothing
set local role anon;
do $$
declare n int;
begin
  begin
    select count(*) into n from public.workspace_invites;
    assert false, 'anon can read workspace_invites';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---------------------------------------------------------------- the member reads, never writes
set local role authenticated;
set local request.jwt.claims = '{"sub":"0bbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare r org_ids%rowtype; n int;
begin
  select * into r from org_ids;
  begin
    select count(*) into n from public.workspace_invites;
    assert false, 'a signed-in user can read workspace_invites (they are for the service only)';
  exception when insufficient_privilege then null; end;

  assert (select count(*) from public.databases where workspace_id = r.w) = 1, 'the member cannot read W''s databases';
  assert (select count(*) from public.workspace_members where workspace_id = r.w) = 3, 'the member cannot see W''s members';
  assert (select count(*) from public.workspaces where id = r.xw) = 0, 'READ LEAK: the member sees the outsider''s workspace';
  assert (select count(*) from public.workspace_members where workspace_id = r.xw) = 0, 'READ LEAK: the member sees the outsider''s members';

  update public.workspaces set name = 'Renamed by member' where id = r.w;
  get diagnostics n = row_count;
  assert n = 0, 'ROLE LEAK: a member renamed the workspace';

  -- Where 0003 was not applied, the write policies exist: they now need owner or admin.
  if exists (select 1 from pg_policies where tablename = 'databases' and policyname = 'databases_member_write') then
    update public.databases set keep_awake = true where workspace_id = r.w;
    get diagnostics n = row_count;
    assert n = 0, 'ROLE LEAK: a member changed a database';
    delete from public.databases where workspace_id = r.w;
    get diagnostics n = row_count;
    assert n = 0, 'ROLE LEAK: a member deleted a database';
  end if;

  begin
    update public.workspaces set name_confirmed = true where id = r.mw;
    assert false, 'a signed-in user can set name_confirmed directly';
  exception when insufficient_privilege then null; end;
  begin
    update public.workspace_members set role = 'owner' where user_id = '0bbbbbbb-0000-4000-8000-000000000002';
    assert false, 'a signed-in user can change their own role';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.workspace_members (workspace_id, user_id, role) values (r.xw, '0bbbbbbb-0000-4000-8000-000000000002', 'owner');
    assert false, 'a signed-in user can add themselves to a workspace';
  exception when insufficient_privilege then null; end;

  -- The organization the browser names: honoured only when the caller is a member of it.
  perform set_config('request.headers', '{}', true);
  assert public.current_workspace() = r.mw, 'without a choice the oldest membership is used';
  perform set_config('request.headers', json_build_object('x-fenvix-workspace', r.w)::text, true);
  assert public.current_workspace() = r.w, 'the chosen organization is not used';
  perform set_config('request.headers', json_build_object('x-fenvix-workspace', upper(r.w::text))::text, true);
  assert public.current_workspace() = r.w, 'upper case ids are the same organization';
  perform set_config('request.headers', json_build_object('x-fenvix-workspace', r.xw)::text, true);
  assert public.current_workspace() = r.mw, 'ESCALATION: naming another workspace gives access to it';
  perform set_config('request.headers', '{"x-fenvix-workspace":"''; drop table public.databases; --"}', true);
  assert public.current_workspace() = r.mw, 'a malformed choice must fall back to the oldest membership';
  perform set_config('request.headers', 'not json', true);
  assert public.current_workspace() = r.mw, 'broken headers must fall back to the oldest membership';
  perform set_config('request.headers', json_build_object('x-fenvix-workspace', r.xw)::text, true);
  assert (select (public.fenvix_list_databases() ->> 'total')::int) = 0, 'READ LEAK: the dashboard functions follow a workspace the caller is not in';
  perform set_config('request.headers', json_build_object('x-fenvix-workspace', r.w)::text, true);
  assert (select (public.fenvix_list_databases() ->> 'total')::int) = 1, 'the dashboard functions do not follow the chosen organization';
end $$;
reset role;

-- ---------------------------------------------------------------- the admin may rename, not set name_confirmed
set local role authenticated;
set local request.jwt.claims = '{"sub":"0ccccccc-0000-4000-8000-000000000003","role":"authenticated"}';
do $$
declare r org_ids%rowtype; n int;
begin
  select * into r from org_ids;
  update public.workspaces set name = 'Renamed by admin' where id = r.w;
  get diagnostics n = row_count;
  assert n = 1, 'an admin cannot rename the workspace';
  update public.workspaces set name = 'Outsider renamed' where id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: an admin of W renamed another workspace';
end $$;
reset role;

-- ---------------------------------------------------------------- the control plane: one workspace per transaction
set local role fenvix_control_plane;
do $$
declare r org_ids%rowtype; n int;
begin
  select * into r from org_ids;
  perform set_config('app.workspace_id', r.w::text, true);
  assert (select count(*) from public.workspace_invites) = 1, 'the control plane sees invitations of other workspaces';
  assert (select count(*) from public.workspace_members where workspace_id <> r.w) = 0, 'the control plane sees other workspaces'' members';
  assert (select count(*) from public.fenvix_cp_members()) = 3, 'fenvix_cp_members does not list W''s three members';
  assert not exists (select 1 from public.fenvix_cp_members() where email = 'org.outsider@fenvix.invalid'), 'fenvix_cp_members leaks another workspace';

  update public.workspace_invites set revoked_at = now() where workspace_id = r.xw;
  get diagnostics n = row_count;
  assert n = 0, 'WRITE LEAK: the control plane revoked another workspace''s invitation';
  begin
    insert into public.workspace_invites (workspace_id, email, role, token_hash, expires_at) values (r.xw, 'x@fenvix.invalid', 'member', repeat('3', 64), now() + interval '1 day');
    assert false, 'the control plane can invite into another workspace';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.workspace_members (workspace_id, user_id, role) values (r.xw, '0bbbbbbb-0000-4000-8000-000000000002', 'owner');
    assert false, 'the control plane can add a member to another workspace';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.workspace_invites;
    assert false, 'the control plane can delete invitations (they are kept)';
  exception when insufficient_privilege then null; end;
  begin
    update public.workspace_invites set token_hash = repeat('4', 64);
    assert false, 'the control plane can change a token hash';
  exception when insufficient_privilege then null; end;
  begin
    update public.workspace_members set user_id = '0ddddddd-0000-4000-8000-000000000004';
    assert false, 'the control plane can move a membership to another person';
  exception when insufficient_privilege then null; end;

  -- The last owner stays, whoever tries.
  begin
    delete from public.workspace_members where user_id = '0aaaaaaa-0000-4000-8000-000000000001';
    assert false, 'the last owner was removed';
  exception when check_violation then null; end;
  begin
    update public.workspace_members set role = 'admin' where user_id = '0aaaaaaa-0000-4000-8000-000000000001';
    assert false, 'the last owner was demoted';
  exception when check_violation then null; end;
  update public.workspace_members set role = 'owner' where user_id = '0ccccccc-0000-4000-8000-000000000003';
  update public.workspace_members set role = 'member' where user_id = '0aaaaaaa-0000-4000-8000-000000000001';
  assert (select count(*) from public.workspace_members where role = 'owner') = 1, 'with a second owner the first may step down';

  -- The four functions: memberships of anyone the service names, e-mail and whether it is verified, invitations by hash.
  assert (select count(*) from public.fenvix_cp_memberships('0bbbbbbb-0000-4000-8000-000000000002')) = 2, 'fenvix_cp_memberships misses a membership';
  assert (select verified from public.fenvix_cp_user_email('0ccccccc-0000-4000-8000-000000000003')) = false, 'an unverified e-mail reads as verified';
  assert (select workspace_id from public.fenvix_cp_find_invite(repeat('2', 64))) = r.xw, 'fenvix_cp_find_invite does not find by hash';
  assert not exists (select 1 from public.fenvix_cp_find_invite(repeat('9', 64))), 'fenvix_cp_find_invite finds a hash that does not exist';
end $$;
reset role;

-- The functions are for the control plane only.
set local role authenticated;
set local request.jwt.claims = '{"sub":"0bbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
begin
  begin perform public.fenvix_cp_memberships('0aaaaaaa-0000-4000-8000-000000000001'); assert false, 'a signed-in user can call fenvix_cp_memberships';
  exception when insufficient_privilege then null; end;
  begin perform public.fenvix_cp_user_email('0aaaaaaa-0000-4000-8000-000000000001'); assert false, 'a signed-in user can call fenvix_cp_user_email';
  exception when insufficient_privilege then null; end;
  begin perform public.fenvix_cp_find_invite(repeat('1', 64)); assert false, 'a signed-in user can call fenvix_cp_find_invite';
  exception when insufficient_privilege then null; end;
  begin perform public.fenvix_cp_members(); assert false, 'a signed-in user can call fenvix_cp_members';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Deleting a workspace or an account still works: the last-owner rule does not block a cascade.
do $$
declare r org_ids%rowtype;
begin
  select * into r from org_ids;
  delete from public.workspaces where id = r.xw;
  assert not exists (select 1 from public.workspace_members where workspace_id = r.xw), 'the cascade left members behind';
  delete from auth.users where id = '0bbbbbbb-0000-4000-8000-000000000002';
  assert not exists (select 1 from public.workspace_members where user_id = '0bbbbbbb-0000-4000-8000-000000000002'), 'deleting an account left memberships';
end $$;

select 'ORGS RLS OK' as result;

rollback;
