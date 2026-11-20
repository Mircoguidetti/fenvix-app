-- 0018: our machines (P-047, F-15). Safe to run twice.
--
-- 1. Region honesty (audit G-0185, G-0190). The only fleet is AWS eu-west-1 (Ireland). Organizations defaulted to
--    region 'us', and their jobs ran in Ireland while the dashboard said United States. New organizations default to
--    'eu'; every existing 'us' organization is moved to 'eu', which is where its jobs actually ran. The API lets an
--    organization choose a region only when that region has machines (FENVIX_MACHINE_REGIONS).
alter table public.workspaces alter column region set default 'eu';
update public.workspaces set region = 'eu' where region = 'us';

-- 2. Our machines (the design of 2026-11-20). One row per EC2 machine the dispatcher made.
--
--    state   launching   RunInstances asked for a clean machine (the always-on one or a future reserve); not booted
--            preparing   a reserve machine on its first boot: it said hello, the dispatcher stops it
--            reserve     stopped, never used by any customer (only its disk is paid)
--            starting    a reserve machine being started to become ready
--            ready       running, never used by any customer (the always-on machine, or a started reserve)
--            bound       ONE customer's (booting, running, or lingering after its last job). A job that finds no
--                        clean running machine gets a reserve machine started or a new one launched directly as bound.
--            retiring    terminate requested; never takes a job again
--            gone        terminated
--
--    Isolation (audit G-0605, G-1786): a machine belongs to at most ONE customer in its whole life. workspace_id is set
--    once (ready/reserve -> bound) and never changes (trigger below); a bound machine is never stopped back into the
--    reserve and never made ready again: when its customer's jobs are over it is terminated, and the next customer
--    gets a machine made from the clean image. Different customers therefore never share a kernel, a disk or memory.
create table if not exists public.gh_machines (
  id bigint generated always as identity primary key,
  region text not null check (region in ('us', 'eu')),
  -- The size name (settings: e.g. "standard" = c7a.xlarge) and the EC2 type it was started as.
  size text not null check (size ~ '^[a-z][a-z0-9-]{0,30}$'),
  instance_type text not null check (instance_type ~ '^[a-z0-9]+\.[a-z0-9]+$'),
  market text not null default 'on-demand' check (market in ('on-demand', 'spot')),
  slots int not null check (slots between 1 and 16),
  instance_id text unique check (instance_id is null or instance_id ~ '^i-[0-9a-f]{8,17}$'),
  state text not null check (state in ('launching', 'preparing', 'reserve', 'starting', 'ready', 'bound', 'retiring', 'gone')),
  workspace_id uuid references public.workspaces (id) on delete set null,
  -- Set when it was bound: the customer may be deleted later, the fact that it was used must stay.
  ever_bound boolean not null default false,
  -- The machine's single-use boot secret (sha256, hex) and its session generation (credentials.ts machine tokens).
  boot_secret_sha256 text check (boot_secret_sha256 is null or boot_secret_sha256 ~ '^[0-9a-f]{64}$'),
  session_gen int not null default 0,
  -- The engine the machine's image carries, as the machine reports it at hello (shown in the job log too).
  engine_version text check (engine_version is null or char_length(engine_version) <= 200),
  image_id text,
  detail text not null default '' check (char_length(detail) <= 1000),
  -- A spot machine told by EC2 that it will be taken back (its jobs are re-run).
  interrupted_at timestamptz,
  -- A reserve machine's first boot is done (it said so); the next tick stops it.
  prepared_at timestamptz,
  launched_at timestamptz,
  hello_at timestamptz,
  last_seen_at timestamptz,
  bound_at timestamptz,
  -- When its last job ended (null while it holds one): lingers for its customer, then retires.
  empty_since timestamptz,
  retire_requested_at timestamptz,
  gone_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gh_machines_bound_once check (state <> 'bound' or ever_bound),
  constraint gh_machines_clean check (state not in ('launching', 'preparing', 'reserve', 'starting', 'ready') or not ever_bound)
);
create index if not exists gh_machines_live on public.gh_machines (region, state) where state <> 'gone';
create index if not exists gh_machines_ws on public.gh_machines (workspace_id) where state <> 'gone';

-- The customer of a machine is set once and never changes; a used machine never becomes clean again.
create or replace function public.gh_machines_one_customer() returns trigger language plpgsql as $$
begin
  if new.workspace_id is not null then new.ever_bound := true; end if;
  if old.ever_bound and new.workspace_id is distinct from old.workspace_id and new.workspace_id is not null then
    raise exception 'machine % belonged to another customer: it is never given to a second one', old.id;
  end if;
  if old.ever_bound and new.state in ('ready', 'reserve', 'preparing', 'starting') then
    raise exception 'machine % was used by a customer: it is terminated, never made clean again', old.id;
  end if;
  if old.ever_bound then new.ever_bound := true; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists gh_machines_one_customer on public.gh_machines;
create trigger gh_machines_one_customer before update on public.gh_machines for each row execute function public.gh_machines_one_customer();

-- 3. Leases: one slot of one machine for one piece of work (a customer's GitHub job, a warm-up, a replay).
--    state   offered    the machine has not fetched it yet (payload: the work's credentials, sealed)
--            running    the machine took it (payload deleted)
--            done       finished (the machine said so, or GitHub said the job completed)
--            lost       never fetched in time, the machine went away, or a spot interruption
create table if not exists public.gh_leases (
  id bigint generated always as identity primary key,
  machine_id bigint not null references public.gh_machines (id),
  slot int not null check (slot between 1 and 16),
  kind text not null check (kind in ('job', 'warmup', 'replay')),
  job_id bigint,
  warmup_id bigint,
  replay_id bigint,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  state text not null default 'offered' check (state in ('offered', 'running', 'done', 'lost')),
  -- AES-256-GCM sealed JSON (src/machines/seal.ts); deleted when the machine takes it.
  payload text,
  detail text not null default '' check (char_length(detail) <= 1000),
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  finished_at timestamptz,
  check ((kind = 'job') = (job_id is not null)),
  check ((kind = 'warmup') = (warmup_id is not null))
);
-- One active lease per job (a lost lease's job gets a new one).
create unique index if not exists gh_leases_one_per_job on public.gh_leases (job_id) where state in ('offered', 'running');
create index if not exists gh_leases_job on public.gh_leases (job_id) where job_id is not null;
-- One active lease per slot.
create unique index if not exists gh_leases_slot on public.gh_leases (machine_id, slot) where state in ('offered', 'running');
create index if not exists gh_leases_active on public.gh_leases (workspace_id) where state in ('offered', 'running');
create index if not exists gh_leases_warmup on public.gh_leases (warmup_id) where warmup_id is not null;

-- A lease's customer is its machine's customer, always.
create or replace function public.gh_leases_same_customer() returns trigger language plpgsql as $$
declare m record;
begin
  select workspace_id, state into m from public.gh_machines where id = new.machine_id for share;
  if m.workspace_id is distinct from new.workspace_id then
    raise exception 'lease for customer % on machine % of customer %', new.workspace_id, new.machine_id, m.workspace_id;
  end if;
  if tg_op = 'INSERT' and m.state <> 'bound' then
    raise exception 'machine % is %: it takes no new work', new.machine_id, m.state;
  end if;
  return new;
end $$;
drop trigger if exists gh_leases_same_customer on public.gh_leases;
create trigger gh_leases_same_customer before insert or update of machine_id, workspace_id on public.gh_leases for each row execute function public.gh_leases_same_customer();

-- 4. The dispatcher's view of each customer job.
alter table public.gh_jobs add column if not exists size text;
alter table public.gh_jobs add column if not exists dispatch_state text check (dispatch_state is null or dispatch_state in ('pending', 'leased', 'none'));
alter table public.gh_jobs add column if not exists dispatch_detail text not null default '' check (char_length(dispatch_detail) <= 1000);
alter table public.gh_jobs add column if not exists queued_at timestamptz;
alter table public.gh_jobs add column if not exists leased_at timestamptz;
-- Re-runs asked after a spot interruption (a deterministic run gives the same result).
alter table public.gh_jobs add column if not exists interrupted_reruns int not null default 0;
create index if not exists gh_jobs_pending on public.gh_jobs (region, queued_at) where dispatch_state = 'pending';

-- 5. Per-customer caps (null: the service defaults, settings MACHINES_PER_CUSTOMER and JOBS_PER_CUSTOMER).
alter table public.workspaces add column if not exists max_machines int check (max_machines is null or max_machines between 0 and 100);
alter table public.workspaces add column if not exists max_concurrent_jobs int check (max_concurrent_jobs is null or max_concurrent_jobs between 0 and 400);
grant select (id, region, max_machines, max_concurrent_jobs) on public.workspaces to fenvix_github_app;

-- 6. Metering (audit: "minutes per job, per customer and per machine size"; no billing is built). Each usage event
--    of a customer job carries the machine it ran on; machine minutes per customer are gh_machines' bound time.
alter table public.ci_usage_events add column if not exists machine_size text;
alter table public.ci_usage_events add column if not exists instance_type text;
alter table public.ci_usage_events add column if not exists machine_market text check (machine_market is null or machine_market in ('on-demand', 'spot'));
alter table public.ci_usage_events add column if not exists machine_id bigint;

create or replace view public.gh_machine_minutes with (security_invoker = true) as
  select m.workspace_id, m.region, m.size, m.instance_type, m.market, date_trunc('day', m.bound_at) as day,
         count(*) as machines,
         round(sum(extract(epoch from (coalesce(m.gone_at, m.retire_requested_at, now()) - m.bound_at))) / 60.0, 2) as machine_minutes
    from public.gh_machines m where m.bound_at is not null
   group by 1, 2, 3, 4, 5, 6;

-- ---------------------------------------------------------------- row level security
alter table public.gh_machines enable row level security;
alter table public.gh_leases enable row level security;
revoke all on public.gh_machines, public.gh_leases from public, anon, authenticated;
grant select, insert, update on public.gh_machines, public.gh_leases to fenvix_github_app;
drop policy if exists gh_machines_github_app on public.gh_machines;
create policy gh_machines_github_app on public.gh_machines for all to fenvix_github_app using (true) with check (true);
drop policy if exists gh_leases_github_app on public.gh_leases;
create policy gh_leases_github_app on public.gh_leases for all to fenvix_github_app using (true) with check (true);
revoke all on public.gh_machine_minutes from public, anon, authenticated;
grant select on public.gh_machine_minutes to fenvix_github_app;

notify pgrst, 'reload schema';
