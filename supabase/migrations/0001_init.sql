-- FENVIX control plane, part 1 of 1: schema, row level security and the functions the
-- dashboard calls. Safe to run more than once.
--
-- Run this in the Supabase SQL editor (Database → SQL editor → New query → Run).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------- types and tables

do $$ begin
  create type public.database_state as enum ('awake', 'asleep');
exception when duplicate_object then null; end $$;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user on public.workspace_members (user_id);

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  idle_minutes int not null default 5 check (idle_minutes in (1, 5, 15, 60)),
  email_notices boolean not null default true,
  plan text not null default 'managed',
  currency text not null default 'USD',
  payment_brand text not null default 'Visa',
  payment_last4 text not null default '4242',
  payment_expires text not null default '08/2028',
  billing_email text,
  updated_at timestamptz not null default now()
);

create table if not exists public.databases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  state public.database_state not null default 'asleep',
  keep_awake boolean not null default false,
  region text not null check (region in ('eu-west', 'us-east', 'us-west', 'ap-south')),
  storage_bytes bigint not null default 0 check (storage_bytes >= 0),
  -- Kept on the row so the 3,000-row list never has to add up usage.
  requests_24h bigint not null default 0 check (requests_24h >= 0),
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  forked_from uuid references public.databases (id) on delete set null,
  restored_to timestamptz
);

create unique index if not exists databases_workspace_name on public.databases (workspace_id, name);
create index if not exists databases_ws_name on public.databases (workspace_id, name text_pattern_ops);
create index if not exists databases_ws_last_active on public.databases (workspace_id, last_active_at desc);
create index if not exists databases_ws_requests on public.databases (workspace_id, requests_24h desc);
create index if not exists databases_ws_storage on public.databases (workspace_id, storage_bytes desc);
create index if not exists databases_ws_state on public.databases (workspace_id, state);
create index if not exists databases_ws_keep_awake on public.databases (workspace_id) where keep_awake;
create index if not exists databases_name_trgm on public.databases using gin (name extensions.gin_trgm_ops);

create table if not exists public.database_tags (
  database_id uuid not null references public.databases (id) on delete cascade,
  -- Repeated from the database so filters, grouping and row level security never join.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  value text not null check (value ~ '^[a-z0-9._()-]{1,41}$'),
  primary key (database_id, key)
);
create index if not exists database_tags_group on public.database_tags (workspace_id, key, value);
create index if not exists database_tags_value on public.database_tags (workspace_id, key, value, database_id);

create table if not exists public.usage_daily (
  database_id uuid not null references public.databases (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  day date not null,
  requests bigint not null default 0 check (requests >= 0),
  storage_bytes bigint not null default 0 check (storage_bytes >= 0),
  primary key (database_id, day)
);
create index if not exists usage_daily_ws_day on public.usage_daily (workspace_id, day);
create index if not exists usage_daily_day on public.usage_daily (day, database_id);

-- The last couple of days at hourly resolution, for the 24 hour view on a database page.
create table if not exists public.usage_hourly (
  database_id uuid not null references public.databases (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  hour timestamptz not null,
  requests bigint not null default 0 check (requests >= 0),
  storage_bytes bigint not null default 0 check (storage_bytes >= 0),
  primary key (database_id, hour)
);
create index if not exists usage_hourly_ws_hour on public.usage_hourly (workspace_id, hour);

create table if not exists public.wake_events (
  id bigint generated always as identity primary key,
  database_id uuid not null references public.databases (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  at timestamptz not null default now(),
  first_request_ms int not null check (first_request_ms between 0 and 600000)
);
create index if not exists wake_events_ws_at on public.wake_events (workspace_id, at desc);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  number text not null,
  month date not null,
  issued_at timestamptz not null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'USD',
  status text not null default 'paid' check (status in ('paid', 'open')),
  unique (workspace_id, number)
);
create index if not exists invoices_ws_month on public.invoices (workspace_id, month desc);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  -- Only a SHA-256 hash and the last four characters. The key itself is never stored.
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  last4 text not null check (char_length(last4) = 4),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  unique (workspace_id, key_hash)
);
create index if not exists api_keys_ws on public.api_keys (workspace_id, created_at desc);

-- Child rows always belong to the same workspace as their database.
create or replace function public.set_workspace_from_database() returns trigger
language plpgsql as $$
begin
  select d.workspace_id into new.workspace_id from public.databases d where d.id = new.database_id;
  if new.workspace_id is null then
    raise exception 'database % does not exist', new.database_id;
  end if;
  return new;
end $$;

drop trigger if exists database_tags_workspace on public.database_tags;
create trigger database_tags_workspace before insert or update of database_id on public.database_tags
  for each row execute function public.set_workspace_from_database();
drop trigger if exists usage_daily_workspace on public.usage_daily;
create trigger usage_daily_workspace before insert or update of database_id on public.usage_daily
  for each row execute function public.set_workspace_from_database();
drop trigger if exists usage_hourly_workspace on public.usage_hourly;
create trigger usage_hourly_workspace before insert or update of database_id on public.usage_hourly
  for each row execute function public.set_workspace_from_database();
drop trigger if exists wake_events_workspace on public.wake_events;
create trigger wake_events_workspace before insert or update of database_id on public.wake_events
  for each row execute function public.set_workspace_from_database();

-- ---------------------------------------------------------------- row level security

-- Membership test used by every policy. It is security definer so that reading
-- workspace_members from inside a policy on workspace_members cannot recurse.
create or replace function public.is_workspace_member(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  )
$$;

revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;

-- The workspaces of the caller. Policies use it as "workspace_id in (select my_workspace_ids())":
-- Postgres evaluates that subselect once per query, not once per row, which keeps a 3,000
-- database fleet (and 180,000 usage rows) fast under row level security.
create or replace function public.my_workspace_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
$$;

revoke all on function public.my_workspace_ids() from public;
grant execute on function public.my_workspace_ids() to authenticated, service_role;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.databases enable row level security;
alter table public.database_tags enable row level security;
alter table public.usage_daily enable row level security;
alter table public.usage_hourly enable row level security;
alter table public.wake_events enable row level security;
alter table public.invoices enable row level security;
alter table public.api_keys enable row level security;

-- Nothing is readable or writable unless the caller is a member of that workspace.
do $$
declare
  t text;
begin
  foreach t in array array['workspace_settings', 'databases', 'database_tags', 'usage_daily', 'usage_hourly', 'wake_events', 'invoices', 'api_keys']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_member_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_member_write', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (workspace_id in (select public.my_workspace_ids()))',
      t || '_member_read', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (workspace_id in (select public.my_workspace_ids())) with check (workspace_id in (select public.my_workspace_ids()))',
      t || '_member_write', t);
  end loop;
end $$;

drop policy if exists workspaces_member_read on public.workspaces;
create policy workspaces_member_read on public.workspaces
  for select to authenticated using (id in (select public.my_workspace_ids()));

drop policy if exists workspaces_member_update on public.workspaces;
create policy workspaces_member_update on public.workspaces
  for update to authenticated using (id in (select public.my_workspace_ids())) with check (id in (select public.my_workspace_ids()));

-- A workspace is only ever created by the sign-up trigger, never by a browser.

drop policy if exists workspace_members_self_read on public.workspace_members;
create policy workspace_members_self_read on public.workspace_members
  for select to authenticated using (user_id = (select auth.uid()) or workspace_id in (select public.my_workspace_ids()));

-- ---------------------------------------------------------------- first sign-in

/** Gives a user a workspace of their own the first time they appear. Returns its id. */
create or replace function public.ensure_workspace(p_user uuid, p_email text, p_name text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  ws uuid;
  label text;
begin
  select m.workspace_id into ws from public.workspace_members m where m.user_id = p_user limit 1;
  if ws is not null then
    return ws;
  end if;

  label := nullif(btrim(coalesce(p_name, '')), '');
  if label is null then
    label := initcap(replace(split_part(coalesce(p_email, 'workspace'), '@', 1), '.', ' '));
  end if;

  insert into public.workspaces (name) values (left(label, 60)) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, p_user, 'owner');
  insert into public.workspace_settings (workspace_id, billing_email) values (ws, p_email)
    on conflict (workspace_id) do nothing;
  return ws;
end $$;

revoke all on function public.ensure_workspace(uuid, text, text) from public;
grant execute on function public.ensure_workspace(uuid, text, text) to service_role;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
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

/** The workspace of the caller. Every function below starts here. */
create or replace function public.current_workspace() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid()) order by m.created_at limit 1
$$;

revoke all on function public.current_workspace() from public;
grant execute on function public.current_workspace() to authenticated, service_role;

-- ---------------------------------------------------------------- reading the fleet
--
-- Every function below runs as the caller, so row level security decides what it can see.
-- They return jsonb so the dashboard gets one round trip per screen.

/** True when a database satisfies one tag term: "key:value", "key", or "!key". */
create or replace function public.fenvix_tag_matches(p_db uuid, p_term text) returns boolean
language sql stable as $$
  select case
    when p_term like '!%' then not exists (
      select 1 from public.database_tags g where g.database_id = p_db and g.key = substr(p_term, 2))
    when strpos(p_term, ':') > 0 then exists (
      select 1 from public.database_tags g
      where g.database_id = p_db and g.key = split_part(p_term, ':', 1) and g.value = split_part(p_term, ':', 2))
    else exists (
      select 1 from public.database_tags g where g.database_id = p_db and g.key = p_term)
  end
$$;

/** Ids of the databases matching a filter. Tag terms combine with AND. */
create or replace function public.fenvix_filtered(
  p_ws uuid, p_search text, p_state text, p_keep boolean, p_tags text[]
) returns table (id uuid) language sql stable as $$
  select d.id
  from public.databases d
  where d.workspace_id = p_ws
    and (p_search is null or p_search = '' or d.name ilike '%' || p_search || '%')
    and (p_state is null or d.state = p_state::public.database_state)
    and (p_keep is null or d.keep_awake = p_keep)
    and (
      p_tags is null or cardinality(p_tags) = 0
      or not exists (select 1 from unnest(p_tags) as t(term) where not public.fenvix_tag_matches(d.id, t.term))
    )
$$;

create or replace function public.fenvix_list_databases(
  p_search text default null,
  p_state text default null,
  p_keep boolean default null,
  p_tags text[] default null,
  p_sort text default 'name',
  p_dir text default 'asc',
  p_page int default 1,
  p_page_size int default 50
) returns jsonb language plpgsql stable as $$
declare
  ws uuid := public.current_workspace();
  v_limit int := least(greatest(coalesce(p_page_size, 50), 1), 200);
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_order text;
  v_total bigint := 0;
  v_items jsonb := '[]'::jsonb;
begin
  if ws is null then
    return jsonb_build_object('items', v_items, 'total', 0, 'page', v_page, 'pageSize', v_limit);
  end if;

  select count(*) into v_total from public.fenvix_filtered(ws, p_search, p_state, p_keep, p_tags);

  v_order := case p_sort
    when 'name' then 'd.name'
    when 'state' then 'd.state::text'
    when 'keepAwake' then 'd.keep_awake::int'
    when 'storageMb' then 'd.storage_bytes'
    when 'requests24h' then 'd.requests_24h'
    when 'lastActiveAt' then 'd.last_active_at'
    else 'd.name'
  end || case when upper(coalesce(p_dir, 'asc')) = 'DESC' then ' desc' else ' asc' end || ', d.name asc';

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    from (
      select d.id, d.name, d.state::text as state, d.keep_awake, d.region,
             (d.storage_bytes / 1048576)::bigint as storage_mb, d.requests_24h,
             d.created_at, d.last_active_at, d.forked_from, d.restored_to,
             (select coalesce(array_agg(g.key || ':' || g.value order by g.key, g.value), '{}')
                from public.database_tags g where g.database_id = d.id) as tags
      from public.databases d
      where d.id in (select id from public.fenvix_filtered($1, $2, $3, $4, $5))
      order by %s
      limit $6 offset $7
    ) r
  $q$, v_order)
  into v_items
  using ws, p_search, p_state, p_keep, p_tags, v_limit, (v_page - 1) * v_limit;

  return jsonb_build_object('items', v_items, 'total', v_total, 'page', v_page, 'pageSize', v_limit);
end $$;

create or replace function public.fenvix_database_ids(
  p_search text default null, p_state text default null, p_keep boolean default null, p_tags text[] default null
) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(f.id), '[]'::jsonb)
  from public.fenvix_filtered(public.current_workspace(), p_search, p_state, p_keep, p_tags) f
$$;

create or replace function public.fenvix_get_database(p_id uuid) returns jsonb
language sql stable as $$
  select to_jsonb(r) from (
    select d.id, d.name, d.state::text as state, d.keep_awake, d.region,
           (d.storage_bytes / 1048576)::bigint as storage_mb, d.requests_24h,
           d.created_at, d.last_active_at, d.forked_from, d.restored_to,
           (select coalesce(array_agg(g.key || ':' || g.value order by g.key, g.value), '{}')
              from public.database_tags g where g.database_id = d.id) as tags
    from public.databases d where d.id = p_id
  ) r
$$;

create or replace function public.fenvix_group_databases(
  p_group_by text, p_search text default null, p_state text default null,
  p_keep boolean default null, p_tags text[] default null
) returns jsonb language plpgsql stable as $$
declare
  ws uuid := public.current_workspace();
  v_groups jsonb;
  v_total bigint := 0;
begin
  if ws is null then
    return jsonb_build_object('groupBy', p_group_by, 'total', 0, 'groups', '[]'::jsonb);
  end if;

  with picked as (
    select d.id, d.state, d.keep_awake, d.storage_bytes,
           (select g.value from public.database_tags g where g.database_id = d.id and g.key = p_group_by) as value
    from public.databases d
    where d.id in (select id from public.fenvix_filtered(ws, p_search, p_state, p_keep, p_tags))
  ),
  grouped as (
    select value,
           count(*) as count,
           count(*) filter (where state = 'awake') as awake,
           count(*) filter (where keep_awake) as keep_awake,
           (sum(storage_bytes) / 1048576)::bigint as storage_mb
    from picked group by value
  )
  select coalesce(jsonb_agg(to_jsonb(g) order by (g.value is null), g.count desc, g.value), '[]'::jsonb),
         coalesce(sum(g.count), 0)
  into v_groups, v_total
  from grouped g;

  return jsonb_build_object('groupBy', p_group_by, 'total', v_total, 'groups', v_groups);
end $$;

create or replace function public.fenvix_list_tags() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.key, t.count desc, t.value), '[]'::jsonb)
  from (
    select g.key, g.value, count(*) as count
    from public.database_tags g
    where g.workspace_id = public.current_workspace()
    group by g.key, g.value
  ) t
$$;

create or replace function public.fenvix_tag_breakdown(p_key text, p_limit int default 8) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.requests desc, t.storage_gb desc), '[]'::jsonb)
  from (
    select coalesce(g.value, '(none)') as value,
           count(*) as databases,
           round((sum(d.storage_bytes) / 1073741824.0)::numeric, 2) as storage_gb,
           coalesce(sum(d.requests_24h), 0) as requests
    from public.databases d
    left join public.database_tags g on g.database_id = d.id and g.key = p_key
    where d.workspace_id = public.current_workspace()
    group by coalesce(g.value, '(none)')
    order by requests desc, storage_gb desc
    limit least(greatest(coalesce(p_limit, 8), 1), 50)
  ) t
$$;

grant execute on function public.fenvix_tag_matches(uuid, text) to authenticated;
grant execute on function public.fenvix_filtered(uuid, text, text, boolean, text[]) to authenticated;
grant execute on function public.fenvix_list_databases(text, text, boolean, text[], text, text, int, int) to authenticated;
grant execute on function public.fenvix_database_ids(text, text, boolean, text[]) to authenticated;
grant execute on function public.fenvix_get_database(uuid) to authenticated;
grant execute on function public.fenvix_group_databases(text, text, text, boolean, text[]) to authenticated;
grant execute on function public.fenvix_list_tags() to authenticated;
grant execute on function public.fenvix_tag_breakdown(text, int) to authenticated;

-- ---------------------------------------------------------------- usage, cost, invoices

/** What a workspace pays for storage and requests. One place, used by every money figure. */
create or replace function public.fenvix_rates()
returns table (storage_per_gb_month numeric, requests_per_million numeric)
language sql immutable as $$ select 0.25::numeric, 0.40::numeric $$;

/** Usage of one database over a range, hourly for 24h and daily otherwise. */
create or replace function public.fenvix_usage_series(p_database uuid, p_range text default '7d') returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.at), '[]'::jsonb)
  from (
    select u.hour as at, u.requests, (u.storage_bytes / 1048576)::bigint as storage_mb,
           (u.requests > 0) as awake
    from public.usage_hourly u
    where p_range = '24h' and u.database_id = p_database and u.hour > now() - interval '24 hours'
    union all
    select (u.day + time '12:00') at time zone 'UTC' as at, u.requests,
           (u.storage_bytes / 1048576)::bigint as storage_mb, (u.requests > 0) as awake
    from public.usage_daily u
    where p_range <> '24h' and u.database_id = p_database
      and u.day > (current_date - case when p_range = '30d' then 30 else 7 end)
  ) p
$$;

/** Months that have usage, newest first. */
create or replace function public.fenvix_usage_months() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_char(m, 'YYYY-MM') order by m desc), '[]'::jsonb)
  from (
    select distinct date_trunc('month', u.day)::date as m
    from public.usage_daily u
    where u.workspace_id = public.current_workspace()
    order by 1 desc
    limit 6
  ) t
$$;

/** Storage and requests for one month, per database or per value of a tag key. */
create or replace function public.fenvix_usage_report(
  p_month date,
  p_by text default 'database',
  p_tag_key text default null,
  p_sort text default 'requests',
  p_dir text default 'desc',
  p_page int default 1,
  p_page_size int default 50
) returns jsonb language plpgsql stable as $$
declare
  ws uuid := public.current_workspace();
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_limit int := least(greatest(coalesce(p_page_size, 50), 1), 5000);
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_order text;
  v_result jsonb;
begin
  if ws is null then
    return jsonb_build_object('month', to_char(v_start, 'YYYY-MM'), 'items', '[]'::jsonb, 'total', 0,
                              'page', v_page, 'pageSize', v_limit,
                              'totals', jsonb_build_object('databases', 0, 'storageGb', 0, 'requests', 0));
  end if;

  v_order := case p_sort
    when 'name' then 'name'
    when 'databases' then 'databases'
    when 'storageGb' then 'storage_gb'
    else 'requests'
  end || case when upper(coalesce(p_dir, 'desc')) = 'ASC' then ' asc' else ' desc' end || ', name asc';

  -- One statement: the month is read once and paged, so the function stays read only.
  execute format($q$
    with picked as (
      select d.id, d.name,
             (select coalesce(array_agg(g.key || ':' || g.value order by g.key, g.value), '{}')
                from public.database_tags g where g.database_id = d.id) as tags,
             round((avg(u.storage_bytes) / 1073741824.0)::numeric, 2) as storage_gb,
             sum(u.requests) as requests
      from public.databases d
      join public.usage_daily u on u.database_id = d.id and u.day >= $2 and u.day < $3
      where d.workspace_id = $1
      group by d.id, d.name
    ),
    tag_rows as (
      select p.id, p.storage_gb, p.requests, g.key || ':' || g.value as label
      from picked p join public.database_tags g on g.database_id = p.id
      where $5 is null
      union all
      select p.id, p.storage_gb, p.requests,
             $5 || ':' || coalesce((select g.value from public.database_tags g
                                     where g.database_id = p.id and g.key = $5), '(none)') as label
      from picked p
      where $5 is not null
    ),
    grouped as (
      select label as id, label as name, '{}'::text[] as tags, count(*)::bigint as databases,
             round(sum(storage_gb)::numeric, 2) as storage_gb, sum(requests)::bigint as requests
      from tag_rows group by label
    ),
    rows as (
      select p.id::text as id, p.name, p.tags, 1::bigint as databases, p.storage_gb, p.requests::bigint
      from picked p where $4 <> 'tag'
      union all
      select g.id, g.name, g.tags, g.databases, g.storage_gb, g.requests from grouped g where $4 = 'tag'
    ),
    totals as (
      select count(*)::bigint as databases, round(coalesce(sum(storage_gb), 0)::numeric, 2) as storage_gb,
             coalesce(sum(requests), 0)::bigint as requests
      from picked
    ),
    page as (
      select * from rows order by %s limit $6 offset $7
    )
    select jsonb_build_object(
      'month', to_char($2::date, 'YYYY-MM'),
      'items', coalesce((select jsonb_agg(to_jsonb(pg) order by pg.ord) from (select p.*, row_number() over () as ord from page p) pg), '[]'::jsonb),
      'total', (select count(*) from rows),
      'page', $8,
      'pageSize', $6,
      'totals', (select to_jsonb(t) from totals t))
  $q$, v_order)
  into v_result
  using ws, v_start, v_end, p_by, p_tag_key, v_limit, (v_page - 1) * v_limit, v_page;

  return v_result;
end $$;

/** Totals per month, oldest first, for the small trend lines. */
create or replace function public.fenvix_usage_history() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(h) order by h.month), '[]'::jsonb)
  from (
    select to_char(date_trunc('month', u.day), 'YYYY-MM') as month,
           count(distinct u.database_id) as databases,
           round((sum(u.storage_bytes) / count(distinct u.day)::numeric / 1073741824.0)::numeric, 2) as storage_gb,
           sum(u.requests) as requests
    from public.usage_daily u
    where u.workspace_id = public.current_workspace()
    group by date_trunc('month', u.day)
    order by date_trunc('month', u.day) desc
    limit 6
  ) h
$$;

/** Daily requests of a month split over the five biggest values of a tag key, plus Other. */
create or replace function public.fenvix_usage_trend(p_month date, p_tag_key text default 'customer') returns jsonb
language plpgsql stable as $$
declare
  ws uuid := public.current_workspace();
  v_start date := date_trunc('month', p_month)::date;
  v_end date := least((date_trunc('month', p_month) + interval '1 month')::date, (current_date + 1));
  v_days jsonb;
  v_series jsonb;
begin
  if ws is null then
    return jsonb_build_object('days', '[]'::jsonb, 'series', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(to_jsonb(d.day) order by d.day), '[]'::jsonb) into v_days
  from generate_series(v_start, v_end - 1, interval '1 day') as d(day);

  with per_day as (
    select u.day,
           coalesce((select g.value from public.database_tags g
                      where g.database_id = u.database_id and g.key = p_tag_key), '(none)') as value,
           sum(u.requests) as requests
    from public.usage_daily u
    where u.workspace_id = ws and u.day >= v_start and u.day < v_end
    group by u.day, value
  ),
  ranked as (
    select value, sum(requests) as total,
           row_number() over (order by sum(requests) desc) as rank
    from per_day group by value
  ),
  labelled as (
    select p.day, case when r.rank <= 5 then p.value else 'Other' end as label, p.requests
    from per_day p join ranked r on r.value = p.value
  ),
  filled as (
    select l.label,
           d.day,
           coalesce(sum(l2.requests), 0) as requests,
           min(case when l.label = 'Other' then 1 else 0 end) as is_other,
           max(t.total) as total
    from (select distinct label from labelled) l
    cross join generate_series(v_start, v_end - 1, interval '1 day') as d(day)
    left join labelled l2 on l2.label = l.label and l2.day = d.day::date
    left join (select case when r.rank <= 5 then r.value else 'Other' end as label, sum(r.total) as total
                 from ranked r group by 1) t on t.label = l.label
    group by l.label, d.day
  )
  select coalesce(jsonb_agg(s order by (s ->> 'isOther')::int, (s ->> 'total')::bigint desc), '[]'::jsonb)
  into v_series
  from (
    select jsonb_build_object(
             'label', f.label,
             'isOther', max(f.is_other),
             'total', max(f.total),
             'values', jsonb_agg(f.requests order by f.day)) as s
    from filled f group by f.label
  ) x;

  return jsonb_build_object('days', v_days, 'series', v_series);
end $$;

grant execute on function public.fenvix_rates() to authenticated;
grant execute on function public.fenvix_usage_series(uuid, text) to authenticated;
grant execute on function public.fenvix_usage_months() to authenticated;
grant execute on function public.fenvix_usage_report(date, text, text, text, text, int, int) to authenticated;
grant execute on function public.fenvix_usage_history() to authenticated;
grant execute on function public.fenvix_usage_trend(date, text) to authenticated;

-- ---------------------------------------------------------------- the overview screen

create or replace function public.fenvix_overview(p_range text default '7d') returns jsonb
language plpgsql stable as $$
declare
  ws uuid := public.current_workspace();
  v_hourly boolean := p_range = '24h';
  v_days int := case p_range when '30d' then 30 else 7 end;
  v_month_start date := date_trunc('month', current_date)::date;
  v_prev_start date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_storage_rate numeric;
  v_request_rate numeric;
  v_awake jsonb;
  v_requests jsonb;
  v_storage jsonb;
  v_cost jsonb;
  v_totals jsonb;
  v_top jsonb;
  v_wakes jsonb;
  v_mtd numeric := 0;
begin
  if ws is null then
    return jsonb_build_object('range', p_range, 'totals', '{}'::jsonb, 'awakeSeries', '[]'::jsonb,
      'requestSeries', '[]'::jsonb, 'costSeries', '[]'::jsonb, 'topDatabases', '[]'::jsonb,
      'recentWakeUps', '[]'::jsonb);
  end if;

  select storage_per_gb_month, requests_per_million into v_storage_rate, v_request_rate from public.fenvix_rates();

  if v_hourly then
    with buckets as (
      select generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') as at
    ),
    per_bucket as (
      select b.at,
             coalesce(sum(u.requests), 0) as requests,
             count(distinct u.database_id) filter (where u.requests > 0) as awake,
             round((coalesce(sum(u.storage_bytes), 0) / 1073741824.0)::numeric, 2) as storage_gb
      from buckets b
      left join public.usage_hourly u on u.workspace_id = ws and u.hour = b.at
      group by b.at
    )
    select jsonb_agg(jsonb_build_object('at', p.at, 'awake', p.awake,
             'total', (select count(*) from public.databases d where d.workspace_id = ws and d.created_at <= p.at + interval '1 hour')) order by p.at),
           jsonb_agg(jsonb_build_object('at', p.at, 'requests', p.requests) order by p.at),
           jsonb_agg(p.storage_gb order by p.at)
    into v_awake, v_requests, v_storage
    from per_bucket p;
  else
    with buckets as (
      select generate_series(current_date - (v_days - 1), current_date, interval '1 day')::date as day
    ),
    per_bucket as (
      select b.day,
             coalesce(sum(u.requests), 0) as requests,
             count(distinct u.database_id) filter (where u.requests > 0) as awake,
             round((coalesce(sum(u.storage_bytes), 0) / 1073741824.0)::numeric, 2) as storage_gb
      from buckets b
      left join public.usage_daily u on u.workspace_id = ws and u.day = b.day
      group by b.day
    )
    select jsonb_agg(jsonb_build_object('at', (p.day + time '12:00') at time zone 'UTC', 'awake', p.awake,
             'total', (select count(*) from public.databases d where d.workspace_id = ws and d.created_at::date <= p.day)) order by p.day),
           jsonb_agg(jsonb_build_object('at', (p.day + time '12:00') at time zone 'UTC', 'requests', p.requests) order by p.day),
           jsonb_agg(p.storage_gb order by p.day)
    into v_awake, v_requests, v_storage
    from per_bucket p;
  end if;

  -- Cost of this month so far, day by day, against the same days of the month before.
  with days as (
    select generate_series(v_month_start, (v_month_start + interval '1 month' - interval '1 day')::date, interval '1 day')::date as day
  ),
  daily as (
    select d.day,
           coalesce((select sum(u.requests) from public.usage_daily u where u.workspace_id = ws and u.day = d.day), 0) as requests,
           coalesce((select sum(u.storage_bytes) from public.usage_daily u where u.workspace_id = ws and u.day = d.day), 0) as storage_bytes,
           coalesce((select sum(u.requests) from public.usage_daily u where u.workspace_id = ws and u.day = (v_prev_start + (d.day - v_month_start))), 0) as prev_requests,
           coalesce((select sum(u.storage_bytes) from public.usage_daily u where u.workspace_id = ws and u.day = (v_prev_start + (d.day - v_month_start))), 0) as prev_storage_bytes
    from days d
  ),
  priced as (
    select day,
           (requests / 1000000.0) * v_request_rate
             + (storage_bytes / 1073741824.0) * v_storage_rate / extract(day from (date_trunc('month', day) + interval '1 month' - interval '1 day')) as cost,
           (prev_requests / 1000000.0) * v_request_rate
             + (prev_storage_bytes / 1073741824.0) * v_storage_rate / extract(day from (date_trunc('month', day) + interval '1 month' - interval '1 day')) as prev_cost
    from daily
  ),
  running as (
    select day,
           sum(cost) over (order by day) as cost_to_date,
           sum(prev_cost) over (order by day) as prev_to_date
    from priced
  )
  select jsonb_agg(jsonb_build_object(
           'at', (day + time '00:00') at time zone 'UTC',
           'cost', case when day <= current_date then round(cost_to_date::numeric, 2) else 0 end,
           'reference', round(prev_to_date::numeric, 2)) order by day)
  into v_cost
  from running;

  select round(coalesce(max(c), 0)::numeric, 2) into v_mtd
  from (select ((p ->> 'cost'))::numeric as c from jsonb_array_elements(v_cost) p) t;

  select jsonb_build_object(
    'databases', count(*),
    'awake', count(*) filter (where state = 'awake'),
    'asleep', count(*) filter (where state = 'asleep'),
    'asleepPercent', case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where state = 'asleep') / count(*)) end,
    'requests', (select coalesce(sum((r ->> 'requests')::bigint), 0) from jsonb_array_elements(v_requests) r),
    'storageGb', round((coalesce(sum(storage_bytes), 0) / 1073741824.0)::numeric, 2),
    'costMtd', v_mtd,
    'currency', coalesce((select s.currency from public.workspace_settings s where s.workspace_id = ws), 'USD'))
  into v_totals
  from public.databases where workspace_id = ws;

  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'requests', t.requests_24h) order by t.requests_24h desc), '[]'::jsonb)
  into v_top
  from (select id, name, requests_24h from public.databases where workspace_id = ws order by requests_24h desc limit 10) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', w.database_id, 'name', d.name, 'at', w.at, 'latencyMs', w.first_request_ms) order by w.at desc), '[]'::jsonb)
  into v_wakes
  from (select * from public.wake_events where workspace_id = ws order by at desc limit 8) w
  join public.databases d on d.id = w.database_id;

  return jsonb_build_object('range', p_range, 'totals', v_totals,
    'awakeSeries', coalesce(v_awake, '[]'::jsonb), 'requestSeries', coalesce(v_requests, '[]'::jsonb),
    'storageSeries', coalesce(v_storage, '[]'::jsonb),
    'costSeries', coalesce(v_cost, '[]'::jsonb), 'topDatabases', v_top, 'recentWakeUps', v_wakes);
end $$;

/** The numbers behind the billing page. The wording around them lives in the dashboard. */
create or replace function public.fenvix_billing() returns jsonb
language plpgsql stable as $$
declare
  ws uuid := public.current_workspace();
  v_month_start date := date_trunc('month', current_date)::date;
  v_days_in_month numeric := extract(day from (date_trunc('month', current_date) + interval '1 month' - interval '1 day'));
  v_storage_rate numeric;
  v_request_rate numeric;
  v_requests bigint := 0;
  v_gb_months numeric := 0;
  v_storage_cost numeric := 0;
  v_request_cost numeric := 0;
begin
  if ws is null then return '{}'::jsonb; end if;
  select storage_per_gb_month, requests_per_million into v_storage_rate, v_request_rate from public.fenvix_rates();

  select coalesce(sum(u.requests), 0),
         round((coalesce(sum(u.storage_bytes), 0) / 1073741824.0 / v_days_in_month)::numeric, 2)
  into v_requests, v_gb_months
  from public.usage_daily u
  where u.workspace_id = ws and u.day >= v_month_start and u.day <= current_date;

  v_storage_cost := round((v_gb_months * v_storage_rate)::numeric, 2);
  v_request_cost := round(((v_requests / 1000000.0) * v_request_rate)::numeric, 2);

  return jsonb_build_object(
    'currency', coalesce((select s.currency from public.workspace_settings s where s.workspace_id = ws), 'USD'),
    'plan', coalesce((select s.plan from public.workspace_settings s where s.workspace_id = ws), 'managed'),
    'periodStart', v_month_start,
    'periodEnd', current_date,
    'storageGbMonths', v_gb_months,
    'requests', v_requests,
    'storageCost', v_storage_cost,
    'requestCost', v_request_cost,
    'total', v_storage_cost + v_request_cost,
    'storageRate', v_storage_rate,
    'requestRate', v_request_rate,
    'paymentMethod', jsonb_build_object(
      'brand', coalesce((select s.payment_brand from public.workspace_settings s where s.workspace_id = ws), 'Visa'),
      'last4', coalesce((select s.payment_last4 from public.workspace_settings s where s.workspace_id = ws), '4242'),
      'expires', coalesce((select s.payment_expires from public.workspace_settings s where s.workspace_id = ws), '08/2028')),
    'billingEmail', (select s.billing_email from public.workspace_settings s where s.workspace_id = ws));
end $$;

/** Workspace name and the settings the dashboard can change. */
create or replace function public.fenvix_settings() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'workspaceName', w.name,
    'idleMinutes', s.idle_minutes,
    'emailNotices', s.email_notices,
    'plan', s.plan)
  from public.workspaces w
  join public.workspace_settings s on s.workspace_id = w.id
  where w.id = public.current_workspace()
$$;

grant execute on function public.fenvix_overview(text) to authenticated;
grant execute on function public.fenvix_billing() to authenticated;
grant execute on function public.fenvix_settings() to authenticated;

-- ---------------------------------------------------------------- changing things
--
-- Each function is one transaction: if anything inside fails, nothing is left half done.
-- They run as the caller, so row level security still applies to every row they touch.

/** Splits "key:value" tags into rows and rejects bad ones with a message people can read. */
create or replace function public.fenvix_parse_tags(p_tags text[])
returns table (key text, value text) language plpgsql immutable as $$
declare
  t text;
  k text;
  v text;
begin
  foreach t in array coalesce(p_tags, '{}') loop
    t := lower(btrim(t));
    k := split_part(t, ':', 1);
    v := substr(t, strpos(t, ':') + 1);
    if strpos(t, ':') < 2 or v = '' or k !~ '^[a-z0-9][a-z0-9._-]{0,39}$' or v !~ '^[a-z0-9][a-z0-9._-]{0,39}$' then
      raise exception 'Write a tag as key:value, for example customer:acme-labs.' using errcode = '22023';
    end if;
    key := k; value := v;
    return next;
  end loop;
end $$;

create or replace function public.fenvix_create_database(p_name text, p_region text, p_tags text[] default '{}')
returns jsonb language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  v_name text := lower(btrim(p_name));
  v_id uuid;
begin
  if ws is null then raise exception 'You are not part of a workspace.' using errcode = '42501'; end if;
  if v_name !~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' then
    raise exception 'Use 3 to 48 lowercase letters, numbers or dashes, starting and ending with a letter or number.' using errcode = '22023';
  end if;
  if p_region not in ('eu-west', 'us-east', 'us-west', 'ap-south') then
    raise exception 'Choose a region.' using errcode = '22023';
  end if;
  if exists (select 1 from public.databases d where d.workspace_id = ws and d.name = v_name) then
    raise exception 'A database named % already exists.', v_name using errcode = '23505';
  end if;
  if (select count(distinct key) from public.fenvix_parse_tags(p_tags)) <> (select count(*) from public.fenvix_parse_tags(p_tags)) then
    raise exception 'A database can have one value per tag key.' using errcode = '22023';
  end if;
  if (select count(*) from public.fenvix_parse_tags(p_tags)) > 20 then
    raise exception 'A database can have up to 20 tags.' using errcode = '22023';
  end if;

  insert into public.databases (workspace_id, name, region) values (ws, v_name, p_region) returning id into v_id;
  insert into public.database_tags (database_id, workspace_id, key, value)
    select v_id, ws, t.key, t.value from public.fenvix_parse_tags(p_tags) t;
  return public.fenvix_get_database(v_id);
end $$;

create or replace function public.fenvix_fork_database(p_id uuid, p_name text) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  src public.databases%rowtype;
  v_name text := lower(btrim(p_name));
  v_id uuid;
begin
  select * into src from public.databases d where d.id = p_id and d.workspace_id = ws;
  if not found then raise exception 'Database not found' using errcode = 'P0002'; end if;
  if v_name !~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$' then
    raise exception 'Use 3 to 48 lowercase letters, numbers or dashes, starting and ending with a letter or number.' using errcode = '22023';
  end if;
  if exists (select 1 from public.databases d where d.workspace_id = ws and d.name = v_name) then
    raise exception 'A database named % already exists.', v_name using errcode = '23505';
  end if;

  insert into public.databases (workspace_id, name, region, storage_bytes, forked_from)
    values (ws, v_name, src.region, src.storage_bytes, src.id) returning id into v_id;
  insert into public.database_tags (database_id, workspace_id, key, value)
    select v_id, ws, g.key, g.value from public.database_tags g where g.database_id = src.id;
  return public.fenvix_get_database(v_id);
end $$;

create or replace function public.fenvix_restore_database(p_id uuid, p_at timestamptz) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  src public.databases%rowtype;
begin
  select * into src from public.databases d where d.id = p_id and d.workspace_id = ws for update;
  if not found then raise exception 'Database not found' using errcode = 'P0002'; end if;
  if p_at is null then raise exception 'Choose a date and time.' using errcode = '22023'; end if;
  if p_at > now() then raise exception 'Choose a time in the past.' using errcode = '22023'; end if;
  if p_at < src.created_at then raise exception 'That is before this database was created.' using errcode = '22023'; end if;
  update public.databases set restored_to = p_at, last_active_at = now() where id = p_id;
  return public.fenvix_get_database(p_id);
end $$;

create or replace function public.fenvix_erase_databases(p_ids uuid[]) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  n int;
begin
  if cardinality(p_ids) > 5000 then raise exception 'Erase up to 5,000 databases at a time.' using errcode = '22023'; end if;
  delete from public.databases d where d.workspace_id = ws and d.id = any(p_ids);
  get diagnostics n = row_count;
  return jsonb_build_object('affected', n);
end $$;

create or replace function public.fenvix_set_keep_awake(p_ids uuid[], p_enabled boolean) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  n int;
begin
  if cardinality(p_ids) > 5000 then raise exception 'Change up to 5,000 databases at a time.' using errcode = '22023'; end if;
  update public.databases d
     set keep_awake = p_enabled,
         state = case when p_enabled then 'awake'::public.database_state else d.state end
   where d.workspace_id = ws and d.id = any(p_ids);
  get diagnostics n = row_count;
  return jsonb_build_object('affected', n);
end $$;

create or replace function public.fenvix_set_tags(p_id uuid, p_tags text[]) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
begin
  if not exists (select 1 from public.databases d where d.id = p_id and d.workspace_id = ws) then
    raise exception 'Database not found' using errcode = 'P0002';
  end if;
  if (select count(distinct key) from public.fenvix_parse_tags(p_tags)) <> (select count(*) from public.fenvix_parse_tags(p_tags)) then
    raise exception 'A database can have one value per tag key.' using errcode = '22023';
  end if;
  if (select count(*) from public.fenvix_parse_tags(p_tags)) > 20 then
    raise exception 'A database can have up to 20 tags.' using errcode = '22023';
  end if;
  delete from public.database_tags g where g.database_id = p_id;
  insert into public.database_tags (database_id, workspace_id, key, value)
    select p_id, ws, t.key, t.value from public.fenvix_parse_tags(p_tags) t;
  return public.fenvix_get_database(p_id);
end $$;

create or replace function public.fenvix_add_tags(p_ids uuid[], p_tags text[]) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  n int;
begin
  if cardinality(p_ids) > 5000 then raise exception 'Change up to 5,000 databases at a time.' using errcode = '22023'; end if;
  if (select count(distinct key) from public.fenvix_parse_tags(p_tags)) <> (select count(*) from public.fenvix_parse_tags(p_tags)) then
    raise exception 'A database can have one value per tag key.' using errcode = '22023';
  end if;
  insert into public.database_tags (database_id, workspace_id, key, value)
    select d.id, ws, t.key, t.value
    from public.databases d cross join public.fenvix_parse_tags(p_tags) t
    where d.workspace_id = ws and d.id = any(p_ids)
  on conflict (database_id, key) do update set value = excluded.value;
  select count(*) into n from public.databases d where d.workspace_id = ws and d.id = any(p_ids);
  return jsonb_build_object('affected', n);
end $$;

create or replace function public.fenvix_remove_tags(p_ids uuid[], p_tags text[]) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  n int;
  term text;
begin
  if cardinality(p_ids) > 5000 then raise exception 'Change up to 5,000 databases at a time.' using errcode = '22023'; end if;
  foreach term in array coalesce(p_tags, '{}') loop
    term := lower(btrim(term));
    if strpos(term, ':') > 0 then
      delete from public.database_tags g
       where g.workspace_id = ws and g.database_id = any(p_ids)
         and g.key = split_part(term, ':', 1) and g.value = substr(term, strpos(term, ':') + 1);
    else
      delete from public.database_tags g
       where g.workspace_id = ws and g.database_id = any(p_ids) and g.key = term;
    end if;
  end loop;
  select count(*) into n from public.databases d where d.workspace_id = ws and d.id = any(p_ids);
  return jsonb_build_object('affected', n);
end $$;

create or replace function public.fenvix_save_settings(p_name text, p_idle int, p_notices boolean) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'Enter a workspace name of 60 characters or fewer.' using errcode = '22023';
  end if;
  if p_idle not in (1, 5, 15, 60) then
    raise exception 'Choose 1, 5, 15 or 60 minutes.' using errcode = '22023';
  end if;
  update public.workspaces set name = btrim(p_name) where id = ws;
  update public.workspace_settings set idle_minutes = p_idle, email_notices = p_notices, updated_at = now() where workspace_id = ws;
  return public.fenvix_settings();
end $$;

-- API keys: the browser makes the key and sends only its hash. The key is shown once and is
-- never sent to the database, so nothing stored here can be turned back into a working key.
create or replace function public.fenvix_create_api_key(p_name text, p_key_hash text, p_last4 text) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
  v_id uuid;
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'Use 1 to 60 characters for the name.' using errcode = '22023';
  end if;
  if p_key_hash !~ '^[0-9a-f]{64}$' or char_length(p_last4) <> 4 then
    raise exception 'The key could not be stored.' using errcode = '22023';
  end if;
  insert into public.api_keys (workspace_id, name, key_hash, last4) values (ws, btrim(p_name), p_key_hash, p_last4)
    returning id into v_id;
  return (select jsonb_build_object('id', k.id, 'name', k.name, 'hint', k.last4, 'createdAt', k.created_at,
                                    'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at)
            from public.api_keys k where k.id = v_id);
end $$;

create or replace function public.fenvix_revoke_api_key(p_id uuid) returns jsonb
language plpgsql as $$
declare
  ws uuid := public.current_workspace();
begin
  update public.api_keys set revoked_at = coalesce(revoked_at, now()) where id = p_id and workspace_id = ws;
  if not found then raise exception 'Key not found' using errcode = 'P0002'; end if;
  return (select jsonb_build_object('id', k.id, 'name', k.name, 'hint', k.last4, 'createdAt', k.created_at,
                                    'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at)
            from public.api_keys k where k.id = p_id);
end $$;

create or replace function public.fenvix_list_api_keys() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'hint', k.last4,
           'createdAt', k.created_at, 'lastUsedAt', k.last_used_at, 'revokedAt', k.revoked_at)
           order by k.created_at desc), '[]'::jsonb)
  from public.api_keys k where k.workspace_id = public.current_workspace()
$$;

create or replace function public.fenvix_list_invoices(p_page int default 1, p_page_size int default 12) returns jsonb
language plpgsql stable as $$
declare
  ws uuid := public.current_workspace();
  v_limit int := least(greatest(coalesce(p_page_size, 12), 1), 100);
  v_page int := greatest(coalesce(p_page, 1), 1);
begin
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'month', to_char(i.month, 'YYYY-MM'),
                'issuedAt', i.issued_at, 'amount', i.amount_cents / 100.0, 'currency', i.currency, 'status', i.status)
                order by i.month desc)
              from (select * from public.invoices where workspace_id = ws order by month desc limit v_limit offset (v_page - 1) * v_limit) i), '[]'::jsonb),
    'total', (select count(*) from public.invoices where workspace_id = ws),
    'page', v_page, 'pageSize', v_limit);
end $$;

create or replace function public.fenvix_get_invoice(p_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', i.id, 'number', i.number, 'month', to_char(i.month, 'YYYY-MM'), 'issuedAt', i.issued_at,
           'amount', i.amount_cents / 100.0, 'currency', i.currency, 'status', i.status,
           'workspace', (select w.name from public.workspaces w where w.id = i.workspace_id))
  from public.invoices i where i.id = p_id and i.workspace_id = public.current_workspace()
$$;

/** Rows for an export: the database, its tags and its last 30 days of usage. */
create or replace function public.fenvix_export_databases(p_ids uuid[]) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', d.name, 'region', d.region, 'createdAt', d.created_at,
    'storageMb', (d.storage_bytes / 1048576)::bigint,
    'tags', (select coalesce(array_agg(g.key || ':' || g.value order by g.key), '{}') from public.database_tags g where g.database_id = d.id),
    'usage', (select coalesce(jsonb_agg(jsonb_build_object('day', u.day, 'requests', u.requests) order by u.day), '[]'::jsonb)
                from public.usage_daily u where u.database_id = d.id and u.day > current_date - 30)
  ) order by d.name), '[]'::jsonb)
  from public.databases d
  where d.workspace_id = public.current_workspace() and d.id = any(p_ids)
$$;

/** Everything the usage CSV needs, in one call, for any month. */
create or replace function public.fenvix_usage_export(p_month date, p_by text default 'database', p_tag_key text default null,
                                                       p_sort text default 'requests', p_dir text default 'desc') returns jsonb
language sql stable as $$
  select public.fenvix_usage_report(p_month, p_by, p_tag_key, p_sort, p_dir, 1, 5000)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'fenvix_parse_tags(text[])', 'fenvix_create_database(text,text,text[])', 'fenvix_fork_database(uuid,text)',
    'fenvix_restore_database(uuid,timestamptz)', 'fenvix_erase_databases(uuid[])', 'fenvix_set_keep_awake(uuid[],boolean)',
    'fenvix_set_tags(uuid,text[])', 'fenvix_add_tags(uuid[],text[])', 'fenvix_remove_tags(uuid[],text[])',
    'fenvix_save_settings(text,int,boolean)', 'fenvix_create_api_key(text,text,text)', 'fenvix_revoke_api_key(uuid)',
    'fenvix_list_api_keys()', 'fenvix_list_invoices(int,int)', 'fenvix_get_invoice(uuid)',
    'fenvix_export_databases(uuid[])', 'fenvix_usage_export(date,text,text,text,text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------- who may touch what
--
-- Row level security decides which rows; these grants decide which roles may try at all.
-- Signed-out visitors (anon) get nothing. Signed-in users get table access that RLS narrows.

revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.workspace_members to authenticated;
revoke insert, update, delete on public.workspace_members from authenticated;
revoke insert, delete on public.workspaces from authenticated;
alter default privileges in schema public revoke all on tables from anon;
