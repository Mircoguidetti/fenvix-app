-- The account linking rules of 0006_account_linking.sql on a plain Postgres (local-stub.sql stands
-- in for Supabase Auth's tables). The same rules against the real Supabase Auth server, with
-- sign-ins, are in supabase/tests/account-linking/ (needs Docker).
--
-- Runs in one transaction that is rolled back, so it leaves no trace. A clean run ends with
-- "ACCOUNT LINKING OK".

begin;

do $$
declare
  owner uuid := 'aaaaaaaa-0000-4000-8000-000000000a01';
  pending uuid := 'aaaaaaaa-0000-4000-8000-000000000a02';
  shadow uuid := 'aaaaaaaa-0000-4000-8000-000000000a03';
  refused boolean;
begin
  -- 5. a workspace for a confirmed address, none for an unconfirmed one until it is confirmed
  insert into auth.users (id, email, email_confirmed_at) values (owner, 'owner@fenvix.invalid', now());
  assert exists (select 1 from public.workspace_members where user_id = owner), 'a confirmed account gets a workspace';
  insert into auth.users (id, email, email_confirmed_at) values (pending, 'pending@fenvix.invalid', null);
  assert not exists (select 1 from public.workspace_members where user_id = pending), 'an unconfirmed sign-up gets no workspace';
  update auth.users set email_confirmed_at = now() where id = pending;
  assert (select count(*) from public.workspace_members where user_id = pending) = 1, 'confirming makes exactly one workspace';
  update auth.users set email_confirmed_at = now() where id = pending;
  assert (select count(*) from public.workspace_members where user_id = pending) = 1, 'and confirming again makes no second one';

  -- 1. no identity opens a second account for an address that has one (the "shadow" of the report)
  insert into auth.users (id, email, email_confirmed_at) values (shadow, null, null);
  refused := false;
  begin
    insert into auth.identities (provider_id, user_id, identity_data, provider)
      values ('gh-1', shadow, '{"email":"Owner@Fenvix.invalid","email_verified":false}', 'github');
  exception when raise_exception then refused := true; end;
  assert refused, 'an identity with another account''s address (any case) was given to a new account';
  insert into auth.identities (provider_id, user_id, identity_data, provider)
    values ('g-1', owner, '{"email":"owner@fenvix.invalid","email_verified":true}', 'google');

  -- 2. a confirmed account carries only verified addresses, or its own
  refused := false;
  begin
    insert into auth.identities (provider_id, user_id, identity_data, provider)
      values ('gh-2', owner, '{"email":"victim@fenvix.invalid","email_verified":false}', 'github');
  exception when raise_exception then refused := true; end;
  assert refused, 'an unverified address that is not the account''s own was linked';
  insert into auth.identities (provider_id, user_id, identity_data, provider)
    values ('gh-3', owner, '{"email":"owner.work@fenvix.invalid","email_verified":true}', 'github');
  insert into auth.identities (provider_id, user_id, identity_data, provider)
    values ('kc-1', owner, '{"email":"OWNER@fenvix.invalid","email_verified":false}', 'keycloak');
  refused := false;
  begin
    update auth.identities set identity_data = '{"email":"victim@fenvix.invalid","email_verified":false}' where provider_id = 'gh-3';
  exception when raise_exception then refused := true; end;
  assert refused, 'an identity was changed to carry an unverified address that is not the account''s own';

  -- 1 also covers addresses carried on another account's identity
  refused := false;
  begin
    insert into auth.users (id, email, email_confirmed_at) values ('aaaaaaaa-0000-4000-8000-000000000a04', null, null);
    insert into auth.identities (provider_id, user_id, identity_data, provider)
      values ('e-1', 'aaaaaaaa-0000-4000-8000-000000000a04', '{"email":"owner.work@fenvix.invalid","email_verified":true}', 'email');
  exception when raise_exception then refused := true; end;
  assert refused, 'an address carried by another account''s identity opened a second account';

  -- 3. a shadow made before 0006 is never confirmed into a second account
  set local fenvix.account_merge = 'on';
  insert into auth.identities (provider_id, user_id, identity_data, provider)
    values ('gh-old', shadow, '{"email":"owner@fenvix.invalid","email_verified":true}', 'github');
  set local fenvix.account_merge = 'off';
  refused := false;
  begin
    update auth.users set email_confirmed_at = now() where id = shadow;
  exception when raise_exception then refused := true; end;
  assert refused, 'a shadow was confirmed into a second account';

  -- 4. a GitHub noreply address opens no account
  refused := false;
  begin
    insert into auth.users (email, email_confirmed_at) values ('12345+someone@users.noreply.github.com', now());
  exception when raise_exception then refused := true; end;
  assert refused, 'a noreply address opened an account';
end $$;

-- the helpers are not callable from the browser (they would tell which addresses have accounts)
set local role authenticated;
do $$
begin
  perform public.fenvix_email_in_use_by_other('owner@fenvix.invalid', null);
  assert false, 'the browser role can ask which addresses have accounts';
exception when insufficient_privilege then null;
end $$;
reset role;

select 'ACCOUNT LINKING OK' as result;

rollback;
