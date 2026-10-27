-- FENVIX seed: a believable fleet for one workspace.
--
-- Run this in the Supabase SQL editor AFTER you have signed in once, so the account exists.
-- It finds the user by email, uses their workspace, and fills it with about 3,000 databases
-- over 200 customers (roughly 9 in 10 asleep), 61 days of usage, wake-ups, six months of
-- invoices and two API keys. Running it again changes nothing: it stops if the workspace
-- already holds databases. To start over, erase the databases from the dashboard or run
--   delete from public.databases where workspace_id = '<workspace id>';
-- and run this file again.

do $seed$
declare
  v_email constant text := 'mircoguidetti1994@gmail.com';
  v_user uuid;
  v_ws uuid;
  v_first text[] := array['acme','brio','cald','dyna','elan','fenn','glim','hexa','ivor','juno','kest','lumo','mera','nova','orbi','pyra','quil','rhea','sova','tavi'];
  v_second text[] := array['labs','works','corp','soft','pay','data','logic','cloud','bank','mart'];
  v_envs text[] := array['prod','prod','prod','staging','dev','dev','sandbox'];
  v_apps text[] := array['orders','agents','analytics','billing'];
  v_regions text[] := array['eu-west','us-east','us-west','ap-south'];
  v_fleet int := 3000;
begin
  select u.id into v_user from auth.users u where lower(u.email) = lower(v_email);
  if v_user is null then
    raise exception 'No account for % yet. Sign in to the dashboard once, then run this again.', v_email;
  end if;

  v_ws := public.ensure_workspace(v_user, v_email, null);

  if exists (select 1 from public.databases d where d.workspace_id = v_ws) then
    raise notice 'This workspace already has databases. Nothing was changed.';
    return;
  end if;

  update public.workspaces set name = 'Northwind Cloud' where id = v_ws;
  update public.workspace_settings set billing_email = 'billing@northwind.cloud' where workspace_id = v_ws;

  -- Every "random" number below comes from hashtext() of a name, so a run always builds the same fleet.

  -- ------------------------------------------------------------ customers and their sizes
  create temporary table seed_customers on commit drop as
  with names as (
    select 'northwind'::text as customer, 1 as ord
    union all
    select (v_first[f] || '-' || v_second[s])::text, 1 + ((f - 1) * 10 + s)
    from generate_series(1, 20) f cross join generate_series(1, 10) s
    where ((f - 1) * 10 + s) <= 199
  ),
  weighted as (
    select customer, ord, 1.0 / power(ord, 0.75) as w from names
  ),
  sized as (
    select customer, ord,
           greatest(2, round((v_fleet - 12) * w / sum(w) over ())::int) as n
    from weighted
  )
  select customer, ord,
         n + case when ord = 1 then (v_fleet - 12) - sum(n) over () else 0 end as n
  from sized;

  -- ------------------------------------------------------------ databases
  create temporary table seed_dbs on commit drop as
  with expanded as (
    select c.customer, c.ord, k,
           v_envs[1 + (abs(hashtext(c.customer || ':env:' || k)) % 7)] as env
    from seed_customers c cross join lateral generate_series(1, c.n) k
  ),
  numbered as (
    select e.*, row_number() over (partition by e.customer, e.env order by e.k) as seq
    from expanded e
  ),
  rolled as (
    select n.*,
           (abs(hashtext(n.customer || ':awake:' || n.k)) % 1000) < 85 as awake,
           (abs(hashtext(n.customer || ':keep:' || n.k)) % 1000) / 1000.0 as r_keep,
           (abs(hashtext(n.customer || ':size:' || n.k)) % 100000) / 100000.0 as r_size,
           (abs(hashtext(n.customer || ':req:' || n.k)) % 100000) / 100000.0 as r_req,
           (abs(hashtext(n.customer || ':last:' || n.k)) % 100000) / 100000.0 as r_last,
           (abs(hashtext(n.customer || ':age:' || n.k)) % 100000) / 100000.0 as r_age,
           (abs(hashtext(n.customer || ':region:' || n.k)) % 4) as r_region,
           (abs(hashtext(n.customer || ':app:' || n.k)) % 1000) / 1000.0 as r_app,
           (abs(hashtext(n.customer || ':appname:' || n.k)) % 4) as r_appname,
           (abs(hashtext(n.customer || ':hot:' || n.k)) % 1000) / 1000.0 as r_hot
    from numbered n
  )
  select gen_random_uuid() as id,
         customer || '-' || env || '-' || case when seq < 10 then '0' || seq::text else seq::text end as name,
         customer, env,
         case when r_app < 0.30 then v_apps[1 + r_appname] end as app,
         awake,
         (awake and r_keep < 0.20) as keep_awake,
         v_regions[1 + r_region] as region,
         case when awake then (200 + r_size * 8800)
              else greatest(2, exp(ln(5) + r_size * ln(800))) end::numeric as storage_mb,
         case when awake then (5000 + r_req * 195000) * case when r_hot < 0.04 then 3 + r_hot * 100 else 1 end
              when r_req < 0.6 then r_req * 80
              else r_req * 3000 end::bigint as requests_24h,
         case when awake then r_last * 25 * 60
              else 3600 + power(r_last, 2) * 45 * 86400 end as idle_seconds,
         (1 + r_age * 500)::int as age_days
  from rolled;

  -- A handful of named databases, so the busiest customer looks lived in.
  insert into seed_dbs (id, name, customer, env, app, awake, keep_awake, region, storage_mb, requests_24h, idle_seconds, age_days)
  values
    (gen_random_uuid(), 'orders-prod', 'northwind', 'prod', 'orders', true, true, 'eu-west', 4820, 182340, 120, 210),
    (gen_random_uuid(), 'agent-memory', 'northwind', 'prod', 'agents', true, false, 'us-east', 912, 54210, 540, 64),
    (gen_random_uuid(), 'orders-staging', 'northwind', 'staging', 'orders', false, false, 'eu-west', 1730, 1204, 18000, 120),
    (gen_random_uuid(), 'ci-4417', 'northwind', 'dev', null, false, false, 'us-east', 38, 311, 68400, 2),
    (gen_random_uuid(), 'analytics-archive', 'northwind', 'dev', 'analytics', false, false, 'eu-west', 12400, 0, 518400, 300),
    (gen_random_uuid(), 'support-bot', 'northwind', 'prod', 'agents', true, false, 'ap-south', 256, 9120, 2460, 33),
    (gen_random_uuid(), 'feature-flags', 'northwind', 'prod', null, false, false, 'eu-west', 12, 4410, 10800, 400),
    (gen_random_uuid(), 'billing-events', 'northwind', 'prod', 'billing', true, false, 'us-east', 7305, 98560, 30, 180),
    (gen_random_uuid(), 'branch-982', 'northwind', 'sandbox', null, false, false, 'eu-west', 54, 0, 950400, 12),
    (gen_random_uuid(), 'research-notes', 'northwind', 'dev', null, false, false, 'ap-south', 2210, 530, 28800, 75),
    (gen_random_uuid(), 'bench-run-12', 'northwind', 'dev', null, false, false, 'us-east', 20480, 12, 93600, 5),
    (gen_random_uuid(), 'acme-labs-prod', 'acme-labs', 'prod', null, false, false, 'us-east', 640, 87, 172800, 18)
  on conflict do nothing;

  -- Names must be unique inside a workspace.
  delete from seed_dbs s using seed_dbs t
   where s.name = t.name and s.ctid > t.ctid;

  insert into public.databases (id, workspace_id, name, state, keep_awake, region, storage_bytes, requests_24h, created_at, last_active_at)
  select s.id, v_ws, s.name,
         case when s.awake then 'awake'::public.database_state else 'asleep'::public.database_state end,
         s.keep_awake, s.region,
         (s.storage_mb * 1048576)::bigint, s.requests_24h,
         now() - make_interval(days => s.age_days),
         now() - make_interval(secs => s.idle_seconds)
  from seed_dbs s;

  insert into public.database_tags (database_id, workspace_id, key, value)
  select s.id, v_ws, 'customer', s.customer from seed_dbs s
  union all
  select s.id, v_ws, 'env', s.env from seed_dbs s
  union all
  select s.id, v_ws, 'app', s.app from seed_dbs s where s.app is not null;

  -- ------------------------------------------------------------ 61 days of usage
  -- (the last 30 days plus the whole of the month before, so the cost chart can draw its
  -- "month before" line and the usage page has a full previous month)
  insert into public.usage_daily (database_id, workspace_id, day, requests, storage_bytes)
  select s.id, v_ws, d.day,
         case
           when s.keep_awake then round(s.requests_24h * sh.shape * sh.jitter)
           when s.awake then round(s.requests_24h * sh.shape * sh.jitter)
           -- A sleeping database is busy on some days and silent on the rest.
           when sh.silent < 0.45 then 0
           else round(greatest(s.requests_24h, 3) * sh.shape * sh.jitter)
         end::bigint,
         round(s.storage_mb * 1048576 * (0.85 + 0.15 * ((d.day - (current_date - 61))::numeric / 61)))::bigint
  from seed_dbs s
  cross join (select (current_date - 61 + i)::date as day from generate_series(0, 61) i) d
  cross join lateral (
    select (case when extract(isodow from d.day) in (6, 7) then 0.72 else 1.0 end) as shape,
           0.7 + 0.6 * (abs(hashtext(s.name || ':j:' || d.day::text)) % 1000) / 1000.0 as jitter,
           (abs(hashtext(s.name || ':z:' || d.day::text)) % 1000) / 1000.0 as silent
  ) sh;

  -- The last 24 hours, hour by hour.
  insert into public.usage_hourly (database_id, workspace_id, hour, requests, storage_bytes)
  select s.id, v_ws, h.hour,
         case
           when s.awake then round((s.requests_24h / 24.0) * (0.62 + 0.38 * sin(((extract(hour from h.hour) - 4) / 24.0) * 2 * pi())) * j.jitter)
           when j.silent < 0.80 then 0
           else round(greatest(s.requests_24h, 3) / 24.0 * j.jitter)
         end::bigint,
         round(s.storage_mb * 1048576)::bigint
  from seed_dbs s
  cross join generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') as h(hour)
  cross join lateral (
    select 0.7 + 0.6 * (abs(hashtext(s.name || ':h:' || h.hour::text)) % 1000) / 1000.0 as jitter,
           (abs(hashtext(s.name || ':hz:' || h.hour::text)) % 1000) / 1000.0 as silent
  ) j;

  -- ------------------------------------------------------------ wake-ups
  insert into public.wake_events (database_id, workspace_id, at, first_request_ms)
  select s.id, v_ws,
         now() - make_interval(mins => w.minutes_ago),
         180 + (abs(hashtext(s.name || ':ms:' || w.i)) % 760)
  from (
    select s2.*, row_number() over (order by abs(hashtext(s2.name || ':wake'))) as pick
    from seed_dbs s2 where not s2.keep_awake and s2.requests_24h > 0
  ) s
  join (
    select i, (case when i <= 8 then (array[2, 6, 13, 21, 34, 52, 78, 115])[i]
                    else 130 + (abs(hashtext('wake:' || i)) % 2700) end)::int as minutes_ago
    from generate_series(1, 400) i
  ) w on w.i = s.pick
  where s.pick <= 400;

  -- ------------------------------------------------------------ six months of invoices
  insert into public.invoices (workspace_id, number, month, issued_at, amount_cents, currency, status)
  select v_ws, 'FNX-' || to_char(m.month, 'YYYY-MM'), m.month,
         (m.month + interval '1 month')::timestamptz,
         round((617.20 + (6 - m.back) * 63.4 + (abs(hashtext('inv:' || m.back)) % 3000) / 100.0) * 100)::bigint,
         'USD', 'paid'
  from (
    select (date_trunc('month', current_date) - make_interval(months => b))::date as month, b as back
    from generate_series(1, 6) b
  ) m;

  -- ------------------------------------------------------------ two API keys (hashes only)
  insert into public.api_keys (workspace_id, name, key_hash, last4, created_at, last_used_at)
  select v_ws, k.name, h.hash, right(h.hash, 4), now() - make_interval(days => k.age), now() - make_interval(mins => k.used)
  from (values ('Production backend', 90, 4), ('Deploy pipeline', 41, 1140)) as k(name, age, used)
  cross join lateral (select encode(sha256(convert_to(gen_random_uuid()::text || k.name, 'UTF8')), 'hex') as hash) h;

  raise notice 'Seeded % databases for % in workspace %.', (select count(*) from seed_dbs), v_email, v_ws;
end
$seed$;
