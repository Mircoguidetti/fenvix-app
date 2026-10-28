-- FENVIX, part 6: one account per verified email address. Safe to run more than once.
-- Run it AFTER 0001_init.sql and 0002_control_plane.sql. It does not depend on 0003, 0004 or 0005,
-- which other branches use; 0006 is the first number no branch has taken (see
-- docs/account-linking.md).
--
-- Supabase Auth already links a new GitHub, Google or email-link sign-in to the account that has
-- the same address, when the provider says the address is verified. What it does not do, and what
-- this file adds, as rules the database enforces whatever path a sign-in takes:
--
--   1. No account is ever made for an address that another account already has. When a provider
--      sends an UNVERIFIED address that belongs to someone else, Supabase Auth makes a second,
--      address-less account for it ("shadow"), and that shadow becomes a real second account as
--      soon as the address is verified at the provider. That is how one person ended up with two
--      accounts and two workspaces. Now the sign-in is refused instead and nothing is created.
--   2. An account that someone can sign in to never carries an unverified address that is not its
--      own. Otherwise "Link GitHub" with a GitHub account that claims someone else's (unverified)
--      address would make Supabase Auth put that person into this account the first time they
--      sign in with Google. A linked identity must have its address verified by its provider, or
--      have the account's own address.
--   3. A shadow made before this file existed can never be confirmed into a second account.
--   4. A GitHub "noreply" address cannot open a new account: it is not an address anyone can be
--      reached at, so it would always be a second account. Sign in another way, then link GitHub.
--   5. A workspace is made when the account's address is confirmed, not when the row appears: an
--      unconfirmed sign-up (an unclicked email link, an unverified provider) gets nothing.
--
-- Every refusal raises an error inside Supabase Auth's own transaction, so nothing is half-made,
-- and the error never names the address or says whether an account has it.
--
-- supabase/account-merge/undo_merge.sql puts back rows exactly as they were and sets
-- fenvix.account_merge = 'on' for its own transaction to skip these rules. That needs no new
-- right: only a role that can already write auth.users and auth.identities directly (postgres,
-- supabase_auth_admin) ever fires these triggers; the browser roles cannot.

-- ---------------------------------------------------------------- helpers

/** The form addresses are compared in. */
create or replace function public.fenvix_email_key(p_email text) returns text
language sql immutable set search_path = pg_catalog as $$
  select nullif(lower(btrim(p_email)), '')
$$;

/** Whether the provider said the address on an identity is verified. */
create or replace function public.fenvix_identity_email_verified(p_data jsonb) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(lower(p_data ->> 'email_verified') = 'true', false)
$$;

/**
 * True when an account other than p_user has the address, as its own or on one of its identities.
 * Supabase Auth stores account addresses in lower case and identities.email is lower(...), so both
 * lookups are plain equality on indexed columns (users_email_partial_key covers is_sso_user = false;
 * FENVIX has no SSO accounts): this runs inside every sign-in.
 */
create or replace function public.fenvix_email_in_use_by_other(p_email text, p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.fenvix_email_key(p_email) is not null and (
    exists (select 1 from auth.users u
            where u.email = public.fenvix_email_key(p_email) and u.is_sso_user = false and u.id is distinct from p_user)
    or exists (select 1 from auth.identities i
               where i.email = public.fenvix_email_key(p_email) and i.user_id is distinct from p_user))
$$;

/** Addresses that cannot open an account: GitHub's private relay addresses. */
create or replace function public.fenvix_unusable_signup_email(p_email text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(public.fenvix_email_key(p_email) like '%@users.noreply.github.com', false)
$$;

-- None of these is for the browser: they would let anyone ask which addresses have accounts.
revoke all on function public.fenvix_email_key(text) from public, anon, authenticated;
revoke all on function public.fenvix_identity_email_verified(jsonb) from public, anon, authenticated;
revoke all on function public.fenvix_email_in_use_by_other(text, uuid) from public, anon, authenticated;
revoke all on function public.fenvix_unusable_signup_email(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- rules 1, 2: identities

create or replace function public.fenvix_guard_identity() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  addr text := public.fenvix_email_key(new.identity_data ->> 'email');
  owner auth.users%rowtype;
begin
  if addr is null or current_setting('fenvix.account_merge', true) = 'on' then
    return new;
  end if;

  -- 1. A new identity whose address is another account's is never given an account of its own.
  --    (When the address is verified, Supabase Auth links it to that account and this never fires.)
  if tg_op = 'INSERT' and public.fenvix_email_in_use_by_other(addr, new.user_id) then
    raise exception 'fenvix: sign-in refused by the account linking rules'
      using hint = 'An identity cannot open a second account for an address that already has one.';
  end if;

  -- 2. On an account that can be signed in to, an identity carries a verified address or the
  --    account's own address. The email identity is the account's own address by definition.
  select * into owner from auth.users u where u.id = new.user_id;
  if new.provider <> 'email'
     and owner.email_confirmed_at is not null
     and not public.fenvix_identity_email_verified(new.identity_data)
     and addr is distinct from public.fenvix_email_key(owner.email) then
    raise exception 'fenvix: sign-in refused by the account linking rules'
      using hint = 'An identity with an unverified address cannot be linked to an account with a different address.';
  end if;

  return new;
end $$;

revoke all on function public.fenvix_guard_identity() from public, anon, authenticated;

drop trigger if exists fenvix_guard_identity on auth.identities;
create trigger fenvix_guard_identity before insert or update of identity_data, user_id on auth.identities
  for each row execute function public.fenvix_guard_identity();

-- ---------------------------------------------------------------- rules 3, 4: accounts

create or replace function public.fenvix_guard_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if current_setting('fenvix.account_merge', true) = 'on' then
    return new;
  end if;
  -- 4. A GitHub noreply address cannot open an account.
  if tg_op = 'INSERT' and public.fenvix_unusable_signup_email(new.email) then
    raise exception 'fenvix: sign-in refused by the account linking rules'
      using hint = 'A private relay address cannot open an account.';
  end if;

  -- 3. An account is not confirmed while one of its identities has another account's address
  --    (a shadow made before this file, whose address was later verified at the provider).
  if tg_op = 'UPDATE' and old.email_confirmed_at is null and new.email_confirmed_at is not null
     and exists (select 1 from auth.identities i
                 where i.user_id = new.id and public.fenvix_email_in_use_by_other(i.email, new.id)) then
    raise exception 'fenvix: sign-in refused by the account linking rules'
      using hint = 'An account cannot be confirmed with an address that another account has.';
  end if;

  return new;
end $$;

revoke all on function public.fenvix_guard_user() from public, anon, authenticated;

drop trigger if exists fenvix_guard_user_insert on auth.users;
create trigger fenvix_guard_user_insert before insert on auth.users
  for each row execute function public.fenvix_guard_user();
drop trigger if exists fenvix_guard_user_confirm on auth.users;
create trigger fenvix_guard_user_confirm before update of email_confirmed_at on auth.users
  for each row execute function public.fenvix_guard_user();

-- ---------------------------------------------------------------- rule 5: the workspace

-- Same function as in 0001, now only for an account whose address is confirmed. ensure_workspace
-- returns the existing workspace when there is one, so running it again changes nothing.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.email is null or new.email_confirmed_at is null or current_setting('fenvix.account_merge', true) = 'on' then
    return new;
  end if;
  perform public.ensure_workspace(
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '')
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at, email on auth.users
  for each row when (new.email_confirmed_at is not null and new.email is not null)
  execute function public.handle_new_user();

notify pgrst, 'reload schema';
