-- fenvix CI dashboard, part 2 (docs/data-contract.md, "Exploration" and the run's skip misses). Safe to run more than
-- once. Run it AFTER 0011_ci_runs.sql. Same rules as 0011: members read their organization's rows, the control plane
-- (fed by the runner) writes them for the one organization of the transaction, a row takes its project's organization.

-- Why the tests of a run ran: counts by the engine's reason ({"code": 41, "data": 3, ...}) and the details that made
-- most tests run ([{"kind": "code", "detail": "src/x.py::func", "tests": 12}, ...]).
alter table public.ci_runs add column if not exists skip_misses jsonb not null default '{}'::jsonb;
alter table public.ci_runs add column if not exists miss_details jsonb not null default '[]'::jsonb;

-- One night of exploration of a project: the engine's explore.json, summarised.
create table if not exists public.ci_explorations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id uuid not null references public.ci_projects (id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  branch text not null default 'main',
  seeds int not null check (seeds >= 0),
  runs int not null check (runs >= 0),
  collected int not null default 0,
  seconds numeric(12, 2) not null default 0,
  flaky_failing jsonb not null default '[]'::jsonb,
  always_failing jsonb not null default '[]'::jsonb,
  not_reproduced jsonb not null default '[]'::jsonb,
  new_defect_ids jsonb not null default '[]'::jsonb,
  families_by_polluter jsonb not null default '{}'::jsonb,
  seeds_log jsonb not null default '[]'::jsonb,
  check (finished_at >= started_at)
);
create index if not exists ci_explorations_project_started on public.ci_explorations (project_id, started_at desc);

drop trigger if exists ci_explorations_workspace on public.ci_explorations;
create trigger ci_explorations_workspace before insert or update on public.ci_explorations
  for each row execute function public.ci_workspace_from_parent();

-- ci_workspace_from_parent() reads the project for ci_runs and ci_defects; teach it ci_explorations too.
create or replace function public.ci_workspace_from_parent() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  if tg_table_name in ('ci_runs', 'ci_defects', 'ci_explorations') then
    select workspace_id into v_ws from public.ci_projects where id = new.project_id;
  else
    select workspace_id into v_ws from public.ci_runs where id = new.run_id;
  end if;
  if v_ws is null then
    raise exception 'The parent row of this % does not exist.', tg_table_name using errcode = '23503';
  end if;
  new.workspace_id := v_ws;
  return new;
end $$;
revoke all on function public.ci_workspace_from_parent() from public, anon, authenticated;

alter table public.ci_explorations enable row level security;
revoke all on public.ci_explorations from public, anon, authenticated;
grant select on public.ci_explorations to authenticated;
drop policy if exists ci_explorations_member_read on public.ci_explorations;
create policy ci_explorations_member_read on public.ci_explorations for select to authenticated
  using (workspace_id in (select public.my_workspace_ids()));

grant select, insert, update on public.ci_explorations to fenvix_control_plane;
drop policy if exists ci_explorations_control_plane on public.ci_explorations;
create policy ci_explorations_control_plane on public.ci_explorations for all to fenvix_control_plane
  using (workspace_id = public.cp_workspace()) with check (workspace_id = public.cp_workspace());

notify pgrst, 'reload schema';
