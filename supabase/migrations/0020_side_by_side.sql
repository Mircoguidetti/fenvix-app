-- fenvix: side-by-side runs (docs/data-contract.md, "Side-by-side runs"). Safe to run more than once. Run it AFTER 0001
-- to 0019.
--
-- An organization chooses how its repositories are onboarded (workspaces.onboarding_kind): "move" (today's setup pull
-- request changes the test job's runs-on) or "side_by_side" (a pull request adds one new workflow file,
-- .github/workflows/fenvix-side-by-side.yml, that runs a copy of the test job on fenvix; the customer's own workflow is
-- not changed and decides green or red alone). A side-by-side job is never billable, never gets a check run or a pull
-- request comment, and its run row is ci_runs.kind = 'side_by_side' (every reader of runs reads kind 'ci_run' only).
-- The customer's own test job is stored in gh_customer_jobs so that the console can show both side by side.
--
-- Rollback: supabase/rollback/0020_side_by_side_down.sql (kinds back to their defaults, then the added columns and
-- tables dropped). The deploy (deploy/lib/migrate.mjs) runs this file in one transaction.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------- the organization's choice

alter table public.workspaces add column if not exists onboarding_kind text not null default 'move';
alter table public.workspaces drop constraint if exists workspaces_onboarding_kind_check;
alter table public.workspaces add constraint workspaces_onboarding_kind_check check (onboarding_kind in ('move', 'side_by_side'));
-- The dashboard API: an owner or admin changes it (PUT /v1/organization/onboarding-kind; the update policy of 0014).
grant update (onboarding_kind) on public.workspaces to fenvix_api;
-- The GitHub App reads it for the organization of its transaction (policy workspaces_github_app of 0014).
grant select (onboarding_kind) on public.workspaces to fenvix_github_app;

-- ---------------------------------------------------------------- repositories

-- A repository chosen one by one waits for the organization's link before its pull request (the kind is the
-- organization's setting, unknown before the link).
alter table public.gh_repositories add column if not exists awaiting_link boolean not null default false;
-- The matrix combination the side-by-side job runs (JSON), and its " (v1, v2)" name suffix (null without a matrix).
alter table public.gh_repositories add column if not exists side_by_side_matrix text;
alter table public.gh_repositories add column if not exists side_by_side_matrix_suffix text;
-- The resolved name of the customer's test job and its test step's name (to find his job and his failing step).
alter table public.gh_repositories add column if not exists side_by_side_job_name text;
alter table public.gh_repositories add column if not exists side_by_side_test_step text;
-- Our job's timeout-minutes (his, at most 60): the full machine's hard lifetime is this plus 10 minutes.
alter table public.gh_repositories add column if not exists side_by_side_timeout_minutes integer;
-- Reading the customer's last 30 days of runs: where it stopped (rate limit) and when it goes on.
alter table public.gh_repositories add column if not exists history_cursor jsonb;
alter table public.gh_repositories add column if not exists history_next_at timestamptz;
alter table public.gh_repositories drop constraint if exists gh_repositories_onboarding_state_check;
alter table public.gh_repositories add constraint gh_repositories_onboarding_state_check check (onboarding_state in
  ('pending', 'pr_open', 'merged', 'closed', 'no_workflow', 'no_test_job', 'already_fenvix', 'unsupported', 'failed',
   'side_by_side_pr_open', 'side_by_side'));
create index if not exists gh_repositories_history_due on public.gh_repositories (history_next_at) where history_next_at is not null;

-- ---------------------------------------------------------------- our jobs

-- kind: 'side_by_side' when the job carries the fenvix label and its workflow file is fenvix-side-by-side.yml (from
-- the workflow run's path, cached in workflow_path); event and pr_number from the workflow run (the pairing key);
-- skip_machine: the job got a small machine that skips every kept step (daily cap, suspended, fleet full);
-- has_summary: whether the runner's summary had come when the job was published.
alter table public.gh_jobs add column if not exists kind text not null default 'ci_run';
alter table public.gh_jobs drop constraint if exists gh_jobs_kind_check;
alter table public.gh_jobs add constraint gh_jobs_kind_check check (kind in ('ci_run', 'side_by_side'));
alter table public.gh_jobs add column if not exists workflow_path text;
alter table public.gh_jobs add column if not exists event text;
alter table public.gh_jobs add column if not exists pr_number int;
alter table public.gh_jobs add column if not exists skip_machine boolean not null default false;
-- Whether the runner's summary came by the time the job was published (a side-by-side result is judged from it only).
alter table public.gh_jobs add column if not exists has_summary boolean;
-- The commit the runner checked out (summary.json `commit`): for a pull request, the merge commit both workflows test.
alter table public.gh_jobs add column if not exists checkout_sha text;
-- A full side-by-side machine stopped so that a paying job gets its slots (customers' jobs first).
alter table public.gh_jobs add column if not exists sbs_stopped_at timestamptz;
create index if not exists gh_jobs_side_by_side on public.gh_jobs (repository_id, launched_at) where kind = 'side_by_side';

alter table public.ci_runs add column if not exists kind text not null default 'ci_run';
alter table public.ci_runs drop constraint if exists ci_runs_kind_check;
alter table public.ci_runs add constraint ci_runs_kind_check check (kind in ('ci_run', 'side_by_side'));
create index if not exists ci_runs_side_by_side on public.ci_runs (project_id, started_at) where kind = 'side_by_side';

-- A side-by-side job's usage event: one per GitHub job, never billable.
alter table public.ci_usage_events drop constraint if exists ci_usage_events_kind_check;
alter table public.ci_usage_events add constraint ci_usage_events_kind_check check (kind in ('ci_run', 'warmup', 'side_by_side'));
alter table public.ci_usage_events drop constraint if exists ci_usage_events_warmup_check;
alter table public.ci_usage_events add constraint ci_usage_events_warmup_check check (
  (kind = 'ci_run' and github_job_id is not null and github_run_id is not null and warmup_id is null)
  or (kind = 'warmup' and github_job_id is null and billable = false and reason = 'warm-up')
  or (kind = 'side_by_side' and github_job_id is not null and github_run_id is not null and warmup_id is null and billable = false and reason = 'side-by-side'));

-- ---------------------------------------------------------------- the customer's own test job

create table if not exists public.gh_customer_jobs (
  job_id bigint primary key check (job_id > 0),
  repository_id bigint not null references public.gh_repositories (repository_id) on delete cascade,
  run_id bigint not null,
  run_attempt int not null default 1,
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  event text,
  pr_number int,
  name text not null default '',
  matrix_suffix text,
  labels text[] not null default '{}',
  conclusion text,
  started_at timestamptz,
  completed_at timestamptz,
  steps jsonb,
  source text not null check (source in ('webhook', 'history')),
  created_at timestamptz not null default now()
);
create index if not exists gh_customer_jobs_key on public.gh_customer_jobs (repository_id, head_sha, event, pr_number);
create index if not exists gh_customer_jobs_completed on public.gh_customer_jobs (repository_id, completed_at);
create index if not exists gh_customer_jobs_run on public.gh_customer_jobs (repository_id, run_id);

alter table public.gh_customer_jobs enable row level security;
revoke all on public.gh_customer_jobs from public, anon, authenticated;
grant select, insert, update on public.gh_customer_jobs to fenvix_github_app;
drop policy if exists gh_customer_jobs_github_app on public.gh_customer_jobs;
create policy gh_customer_jobs_github_app on public.gh_customer_jobs for all to fenvix_github_app using (true) with check (true);
-- The dashboard API: the jobs of its organization's repositories, read only.
grant select on public.gh_customer_jobs to fenvix_api;
drop policy if exists gh_customer_jobs_api_read on public.gh_customer_jobs;
create policy gh_customer_jobs_api_read on public.gh_customer_jobs for select to fenvix_api
  using (repository_id in (select r.repository_id from public.gh_repositories r where r.workspace_id = public.api_workspace()));
-- And its side-by-side jobs (gh_jobs kind side_by_side), read only: the pairs of the console.
grant select on public.gh_jobs to fenvix_api;
drop policy if exists gh_jobs_api_side_by_side on public.gh_jobs;
create policy gh_jobs_api_side_by_side on public.gh_jobs for select to fenvix_api
  using (kind = 'side_by_side' and repository_id in (select r.repository_id from public.gh_repositories r where r.workspace_id = public.api_workspace()));

-- ---------------------------------------------------------------- prices of the customer's runners

-- A range (Ubicloud bills between two prices) and the runner labels each price is for. Labels not listed: price unknown.
alter table public.ci_reference_rates add column if not exists usd_per_minute_max numeric(10, 5);
alter table public.ci_reference_rates drop constraint if exists ci_reference_rates_max_check;
alter table public.ci_reference_rates add constraint ci_reference_rates_max_check check (usd_per_minute_max is null or usd_per_minute_max >= usd_per_minute);
create table if not exists public.ci_runner_label_rates (
  label text primary key,
  rate_key text not null references public.ci_reference_rates (key)
);
alter table public.ci_runner_label_rates enable row level security;
revoke all on public.ci_runner_label_rates from public, anon, authenticated;
grant select on public.ci_runner_label_rates to fenvix_api, fenvix_github_app;
drop policy if exists ci_runner_label_rates_read on public.ci_runner_label_rates;
create policy ci_runner_label_rates_read on public.ci_runner_label_rates for select to fenvix_api, fenvix_github_app using (true);

insert into public.ci_reference_rates (key, usd_per_minute, runner, source, checked_on) values
  ('github-linux-2core', 0.006, 'GitHub-hosted Linux, 2 cores', 'GitHub Actions pricing (research 2026-11-23)', date '2026-11-23')
on conflict (key) do update set usd_per_minute = excluded.usd_per_minute, source = excluded.source, checked_on = excluded.checked_on;
insert into public.ci_reference_rates (key, usd_per_minute, usd_per_minute_max, runner, source, checked_on) values
  ('ubicloud-x64-2', 0.00125, 0.002, 'Ubicloud x64, 2 vCPU', 'https://www.ubicloud.com/docs/about/pricing', date '2026-11-26'),
  ('blacksmith-2vcpu-ubuntu-2404', 0.004, null, 'Blacksmith 2 vCPU', 'Blacksmith pricing (research 2026-11-23)', date '2026-11-23'),
  ('blacksmith-4vcpu-ubuntu-2404', 0.008, null, 'Blacksmith 4 vCPU', 'Blacksmith pricing (research 2026-11-23)', date '2026-11-23'),
  ('blacksmith-8vcpu-ubuntu-2404', 0.016, null, 'Blacksmith 8 vCPU', 'Blacksmith pricing (research 2026-11-23)', date '2026-11-23'),
  ('blacksmith-16vcpu-ubuntu-2404', 0.032, null, 'Blacksmith 16 vCPU', 'Blacksmith pricing (research 2026-11-23)', date '2026-11-23')
on conflict (key) do update set usd_per_minute = excluded.usd_per_minute, usd_per_minute_max = excluded.usd_per_minute_max,
  runner = excluded.runner, source = excluded.source, checked_on = excluded.checked_on;
insert into public.ci_runner_label_rates (label, rate_key) values
  ('ubuntu-latest', 'github-linux-2core'), ('ubuntu-24.04', 'github-linux-2core'), ('ubuntu-22.04', 'github-linux-2core'),
  ('ubicloud-standard-2', 'ubicloud-x64-2'),
  ('blacksmith-2vcpu-ubuntu-2404', 'blacksmith-2vcpu-ubuntu-2404'), ('blacksmith-4vcpu-ubuntu-2404', 'blacksmith-4vcpu-ubuntu-2404'),
  ('blacksmith-8vcpu-ubuntu-2404', 'blacksmith-8vcpu-ubuntu-2404'), ('blacksmith-16vcpu-ubuntu-2404', 'blacksmith-16vcpu-ubuntu-2404')
on conflict (label) do update set rate_key = excluded.rate_key;

notify pgrst, 'reload schema';
