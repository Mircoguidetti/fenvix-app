-- READ ONLY. Lists accounts that belong to the same person, and the shadow accounts Supabase Auth
-- made before 0006_account_linking.sql. Changes nothing; safe to paste into the SQL editor.
--
-- kind = 'duplicate': two accounts that have both proved the same address (confirmed account address
--        or an identity the provider verified). Merge them with merge_accounts.sql.
-- kind = 'shadow':    an account that never confirmed an address and carries, on an identity the
--        provider did NOT verify, the address of another account. It never had access; it only
--        blocks that person's future sign-ins. merge_accounts.sql removes it (moves nothing).
--
-- suggested keep_user: the account whose own address is confirmed (the one the person signs in to
-- by email link), else the older one. Check by hand before merging.
with proved as (
  select u.id as user_id, lower(u.email) as address from auth.users u
  where u.email is not null and u.email_confirmed_at is not null
  union
  select i.user_id, i.email from auth.identities i
  where i.email is not null and coalesce(lower(i.identity_data ->> 'email_verified') = 'true', false)
),
pairs as (
  select 'duplicate' as kind, a.address, a.user_id as one, b.user_id as other
  from proved a join proved b on a.address = b.address and a.user_id < b.user_id
  union
  select 'shadow', i.email, p.user_id, s.id
  from auth.users s
  join auth.identities i on i.user_id = s.id
  join proved p on p.address = i.email and p.user_id <> s.id
  where s.email_confirmed_at is null
)
select
  p.kind,
  p.address,
  case when p.kind = 'shadow' then p.one
       when coalesce(lower(u1.email) = p.address and u1.email_confirmed_at is not null, false)
            and not coalesce(lower(u2.email) = p.address and u2.email_confirmed_at is not null, false) then p.one
       when coalesce(lower(u2.email) = p.address and u2.email_confirmed_at is not null, false)
            and not coalesce(lower(u1.email) = p.address and u1.email_confirmed_at is not null, false) then p.other
       when u1.created_at <= u2.created_at then p.one else p.other end as suggested_keep_user,
  p.one, u1.email as one_email, u1.created_at as one_created, u1.last_sign_in_at as one_last_sign_in,
  (select string_agg(i.provider, ',' order by i.provider) from auth.identities i where i.user_id = p.one) as one_providers,
  (select m.workspace_id from public.workspace_members m where m.user_id = p.one order by m.created_at limit 1) as one_workspace,
  (select count(*) from public.databases d where d.workspace_id = (select m.workspace_id from public.workspace_members m where m.user_id = p.one order by m.created_at limit 1)) as one_databases,
  p.other, u2.email as other_email, u2.created_at as other_created, u2.last_sign_in_at as other_last_sign_in,
  (select string_agg(i.provider, ',' order by i.provider) from auth.identities i where i.user_id = p.other) as other_providers,
  (select m.workspace_id from public.workspace_members m where m.user_id = p.other order by m.created_at limit 1) as other_workspace,
  (select count(*) from public.databases d where d.workspace_id = (select m.workspace_id from public.workspace_members m where m.user_id = p.other order by m.created_at limit 1)) as other_databases
from pairs p
join auth.users u1 on u1.id = p.one
join auth.users u2 on u2.id = p.other
order by p.kind, p.address;
