-- fenvix: fixes of review R-016 (docs/REVIEW-R-016.md). Safe to run more than once. Run it AFTER 0014.
--
-- F1, F2  Connecting GitHub: /github/setup no longer links. It checks the state, the OAuth code, that the GitHub user
--         sees the installation AND administers its account (the account itself, or an organization admin), then
--         stores a short-lived, single-use completion (gh_install_completions; one per state: the state is consumed)
--         and sends the browser to the dashboard. The link is made by api_complete_github_link(), called by the API
--         with the signed-in person's verified token: only the fenvix person named in the state completes it.
-- F3      Billing: run units come from the minutes our machine was held, measured by GitHub's job timings
--         (workflow_job started_at -> completed_at, delivered in a webhook signed by GitHub), never from summary.json.
--         ci_usage_events.held_minutes; baseline_minutes and units are now generated from it.
-- F4      The run's mode is decided by the App when the job starts (gh_jobs.mode), never by the job's own files.
-- F5      One trial per GitHub account: ci_trial_accounts records every installation account that had a trial (or
--         was a customer before trials existed); gh_link_installation starts no trial for those.
-- F6      An organization that already has (or had) another linked installation gets no new trial: existing customers
--         from before 0014 are never put into a shadow trial. Existing linked organizations without trial dates are
--         marked with trial dates in the past.
-- F7      The App may delete staged runner results (gh_run_results) once they are old (the sweep).
-- F8      Row level security holds the owner-only rules: only an owner changes or removes an admin or owner, makes
--         someone admin or owner, or invites (or revokes the invitation of) an admin.

-- ================================================================ F1, F2: completing a link in the person's session

create table if not exists public.gh_install_completions (
  id uuid primary key default gen_random_uuid(),
  -- sha256 (hex) of the one-time code the browser carries to the dashboard (the code itself is never stored).
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  -- sha256 (hex) of the install-link state: a state completes at most once.
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  installation_id bigint not null references public.gh_installations (installation_id) on delete cascade,
  -- From the signed state: the organization and the fenvix person who asked for the link.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null,
  -- The GitHub user who completed the installation (checked an admin of the installation's account).
  github_user_id bigint not null,
  github_login text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists gh_install_completions_expires on public.gh_install_completions (expires_at);
alter table public.gh_install_completions enable row level security;
revoke all on public.gh_install_completions from public, anon, authenticated;
-- The App writes them (/github/setup) and removes old ones (the sweep); the API reaches them only through
-- api_complete_github_link().
grant select, insert, delete on public.gh_install_completions to fenvix_github_app;
drop policy if exists gh_install_completions_github_app on public.gh_install_completions;
create policy gh_install_completions_github_app on public.gh_install_completions for all to fenvix_github_app using (true) with check (true);

-- The API completes a link for the signed-in person (app.user_id): the completion must be theirs, unexpired and not
-- used. Every refusal returns no row (the API answers them all with the same 404). Being an owner or admin of the
-- organization, the installation not being another organization's, etc. are checked by gh_link_installation.
create or replace function public.api_complete_github_link(p_hash text)
returns table (workspace_id uuid, installation_id bigint, account text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid := public.api_user(); v_c record; v_login text;
begin
  if v_user is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return; end if;
  select c.* into v_c from public.gh_install_completions c where c.code_hash = p_hash for update;
  if v_c.id is null or v_c.completed_at is not null or v_c.expires_at <= now() or v_c.user_id <> v_user then return; end if;
  update public.gh_install_completions set completed_at = now() where id = v_c.id;
  v_login := public.gh_link_installation(v_c.installation_id, v_c.workspace_id, v_user);
  return query select v_c.workspace_id, v_c.installation_id, v_login;
end $$;
revoke all on function public.api_complete_github_link(text) from public, anon, authenticated;
grant execute on function public.api_complete_github_link(text) to fenvix_api;

-- ================================================================ F3: units from the minutes the machine was held

-- GitHub's timings of the job (started_at -> completed_at), in minutes. The job's own summary.json cannot change it.
alter table public.ci_usage_events add column if not exists held_minutes numeric(12, 2) not null default 0;
alter table public.ci_usage_events drop constraint if exists ci_usage_events_held_minutes_check;
alter table public.ci_usage_events add constraint ci_usage_events_held_minutes_check check (held_minutes >= 0);

do $$
declare v_expr text;
begin
  select pg_get_expr(d.adbin, d.adrelid) into v_expr
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.ci_usage_events'::regclass and a.attname = 'baseline_minutes';
  if v_expr is null or v_expr not like '%held_minutes%' then
    -- Events before this migration: GitHub's timings of their job where we have them, else what was measured then
    -- without the claimed saved time (tests run + other steps, i.e. the job's own minutes).
    update public.ci_usage_events e set held_minutes = round(greatest(0, extract(epoch from (j.completed_at - j.started_at)) / 60.0)::numeric, 2)
      from public.gh_jobs j where j.job_id = e.github_job_id and j.started_at is not null and j.completed_at is not null;
    update public.ci_usage_events e set held_minutes = e.test_minutes_ran + e.other_step_minutes
     where e.held_minutes = 0 and not exists (select 1 from public.gh_jobs j where j.job_id = e.github_job_id and j.started_at is not null and j.completed_at is not null);
    alter table public.ci_usage_events drop column if exists units;
    alter table public.ci_usage_events drop column if exists baseline_minutes;
    alter table public.ci_usage_events add column baseline_minutes numeric generated always as (held_minutes) stored;
    alter table public.ci_usage_events add column units numeric generated always as (round(held_minutes / 10.0, 2)) stored;
  end if;
end $$;

-- ================================================================ F4: the run's mode is the App's

alter table public.gh_jobs add column if not exists mode text;
alter table public.gh_jobs drop constraint if exists gh_jobs_mode_check;
alter table public.gh_jobs add constraint gh_jobs_mode_check check (mode is null or mode in ('enforce', 'shadow'));

notify pgrst, 'reload schema';
