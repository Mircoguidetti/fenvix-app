-- 0014: customer mode on phoenixNAP Bare Metal Cloud (docs/CUSTOMER-MODE-PNAP.md).
--
-- Hosts are rented by the hour, one pool per region; each customer job runs in its own Firecracker microVM on a host
-- of its customer's region. The App's scaler (github-app/src/pnap/scaler.ts) keeps these tables; the hosts' agents
-- reach them only through the App's host routes (/v1/hosts/*). Safe to apply twice.

-- The region an installation's jobs run in. NULL: not placed until set (no job ever runs in another region).
alter table public.gh_installations add column if not exists pnap_region text;
do $$ begin
  alter table public.gh_installations add constraint gh_installations_pnap_region check (pnap_region in ('ASH', 'PHX', 'CHI', 'SEA', 'NLD'));
exception when duplicate_object then null; end $$;

-- Every server we rent: job hosts and the regions' cache servers.
create table if not exists public.pnap_hosts (
  host_id text primary key check (host_id ~ '^[a-z0-9-]{3,63}$'),     -- ours, also the server's hostname
  role text not null check (role in ('runner', 'cache')),
  region text not null check (region in ('ASH', 'PHX', 'CHI', 'SEA', 'NLD')),
  server_type text not null,
  pricing_model text not null default 'HOURLY',
  server_id text unique,                                               -- phoenixNAP's id, once the order is accepted
  state text not null check (state in ('ordering', 'provisioning', 'ready', 'draining', 'releasing', 'released', 'failed')),
  slots int not null default 0 check (slots >= 0),
  -- SHA-256 of the single-use enrolment secret in the server's user data; NULL once spent.
  enrol_sha256 text,
  -- The host credential's generation: bumping it revokes every credential issued before.
  cred_gen int not null default 1,
  public_ip text,
  private_ip text,
  running int not null default 0,
  ordered_at timestamptz not null default now(),
  provisioned_at timestamptz,
  enrolled_at timestamptz,
  last_seen_at timestamptz,
  last_job_at timestamptz,
  drain_requested_at timestamptz,
  released_at timestamptz,
  detail text,
  updated_at timestamptz not null default now()
);
create index if not exists pnap_hosts_live on public.pnap_hosts (region, role, state);

-- The per-region queue of jobs waiting for a microVM. A job is only ever leased by a host of its region.
create table if not exists public.pnap_jobs (
  job_id bigint primary key references public.gh_jobs (job_id) on delete cascade,
  region text not null check (region in ('ASH', 'PHX', 'CHI', 'SEA', 'NLD')),
  installation_id bigint not null,
  repository_id bigint not null,
  state text not null check (state in ('queued', 'leased', 'done', 'cancelled', 'failed')),
  host_id text references public.pnap_hosts (host_id),
  slot int,
  runner_name text,
  runner_id bigint,
  attempts int not null default 0,
  queued_at timestamptz not null default now(),
  leased_at timestamptz,
  finished_at timestamptz,
  outcome text,
  timings jsonb,
  detail text
);
create index if not exists pnap_jobs_queue on public.pnap_jobs (region, state, queued_at);

-- A floor of hosts for a while (the first real test: one host for about an hour), set by the scaler's "hold" action.
create table if not exists public.pnap_region_holds (
  region text primary key check (region in ('ASH', 'PHX', 'CHI', 'SEA', 'NLD')),
  hosts int not null check (hosts between 0 and 10),
  until timestamptz not null,
  reason text not null default ''
);

do $$
declare t text;
begin
  foreach t in array array['pnap_hosts', 'pnap_jobs', 'pnap_region_holds']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to fenvix_github_app', t);
    execute format('drop policy if exists %I on public.%I', t || '_github_app', t);
    execute format('create policy %I on public.%I for all to fenvix_github_app using (true) with check (true)', t || '_github_app', t);
  end loop;
end $$;
grant delete on public.pnap_region_holds to fenvix_github_app;
