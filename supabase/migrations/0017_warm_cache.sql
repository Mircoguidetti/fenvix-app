-- fenvix: warm cache at install (docs/data-contract.md "Warm-up runs", github-app/src/warmup/). Safe to run more than
-- once. Run it AFTER 0001 to 0016.
--
-- A customer should almost never see a cold first run. When a repository is onboarded (its setup pull request merged,
-- or it was already on runs-on: fenvix) in an installation linked to an organization, and after every push to its
-- default branch, the GitHub App starts ONE warm-up run of the repository's test job on our runners, in the
-- organization's region, so the shared cache holds the default branch's proofs before the customer's next pull
-- request. A warm-up is a job of our own (not a GitHub Actions run): no check run, no pull request comment, nothing
-- on the customer's commits, no GitHub Actions minutes. It is never billed: its usage event is non-billable with
-- reason 'warm-up'.
--
-- Who may do what:
--   * the GitHub App (fenvix_github_app) reads and writes every warm-up row (keyed by GitHub ids from verified
--     webhooks, like its other gh_* tables);
--   * the dashboard API (fenvix_api) reads the warm-ups and the cache state of its organization's repositories only;
--   * the browser's roles (anon, authenticated) reach nothing (0014).

-- ---------------------------------------------------------------- one warm-up per (repository, default-branch commit)

create table if not exists public.gh_warmups (
  id bigint generated always as identity primary key,
  repository_id bigint not null references public.gh_repositories (repository_id) on delete cascade,
  installation_id bigint not null references public.gh_installations (installation_id) on delete cascade,
  -- Always the installation's organization (trigger gh_workspace_from_installation), whatever the writer says.
  workspace_id uuid references public.workspaces (id) on delete cascade,
  commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  -- The default branch it was taken from (refs/heads/<branch>).
  ref text not null check (ref ~ '^refs/heads/.{1,250}$'),
  -- What asked for it: the setup pull request merged (or the repository found already on fenvix), a push to the
  -- default branch, or the installation linked while the repository was already onboarded.
  trigger text not null check (trigger in ('onboarded', 'push', 'linked')),
  -- pending: waiting (grace period, capacity, the organization's concurrency, the repository's daily cap);
  -- dispatched: a machine was requested; running: the machine reported that it started;
  -- succeeded / failed / unsupported: what the machine reported at the end (unsupported: the runner cannot run this
  --   job definition outside GitHub Actions, detail says why);
  -- covered: the customer's own trusted run on this commit (a push run on the default branch) fills the cache;
  -- superseded: a newer default-branch commit came first (a running machine is terminated);
  -- cancelled: the installation was suspended or removed, or the repository left it, or no machine came in time.
  status text not null default 'pending' check (status in
    ('pending', 'dispatched', 'running', 'succeeded', 'failed', 'unsupported', 'covered', 'superseded', 'cancelled')),
  detail text not null default '' check (char_length(detail) <= 1000),
  -- When the commit reached the default branch (the push), for ordering: an older commit never supersedes a newer one.
  pushed_at timestamptz not null default now(),
  -- Not dispatched before this time (the grace period that lets the customer's own push run cover the commit).
  not_before timestamptz not null default now(),
  -- The organization's region when the machine was placed (the machine runs there or not at all).
  region text check (region is null or region in ('us', 'eu')),
  runner_name text check (runner_name is null or runner_name ~ '^[A-Za-z0-9._-]{1,100}$'),
  instance_id text,
  -- Machines requested for it (a preempted warm-up goes back to pending and gets a new machine later).
  attempts int not null default 0 check (attempts >= 0),
  preemptions int not null default 0 check (preemptions >= 0),
  -- The customer's job that covered it (gh_jobs.job_id), when status is covered.
  covered_by_job bigint,
  -- Seconds our machines spent on it, over all attempts (our cost; never billed).
  machine_seconds numeric(12, 2) not null default 0 check (machine_seconds >= 0),
  -- The runner's summary.json at the end (per-test maps trimmed), when it sent one.
  summary jsonb,
  -- When its non-billable usage event was written (once a machine ran for it and it reached its end).
  usage_recorded_at timestamptz,
  -- A machine that must be terminated (superseded, cancelled, preempted, timed out) and when it was.
  terminate_requested_at timestamptz,
  terminated_at timestamptz,
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, commit_sha)
);
-- At most one warm-up in flight per repository: a newer commit supersedes the older one in the same transaction.
create unique index if not exists gh_warmups_one_active on public.gh_warmups (repository_id) where status in ('pending', 'dispatched', 'running');
create index if not exists gh_warmups_due on public.gh_warmups (status, not_before) where status in ('pending', 'dispatched', 'running');
create index if not exists gh_warmups_ws on public.gh_warmups (workspace_id);
create index if not exists gh_warmups_daily on public.gh_warmups (repository_id, dispatched_at) where dispatched_at is not null;
create index if not exists gh_warmups_terminate on public.gh_warmups (terminate_requested_at) where terminate_requested_at is not null and terminated_at is null;

drop trigger if exists gh_warmups_workspace on public.gh_warmups;
create trigger gh_warmups_workspace before insert or update on public.gh_warmups
  for each row execute function public.gh_workspace_from_installation();

-- ---------------------------------------------------------------- the repository's cache: warm since which commit

-- The latest default-branch commit whose proofs are in the shared cache: written when a warm-up succeeds, or when a
-- customer's trusted run (cache write access: push, schedule or manual run on the default branch) publishes with a
-- summary. Ordered by when the commit was pushed: an older commit finishing late never replaces a newer one.
alter table public.gh_repositories add column if not exists cache_warm_sha text check (cache_warm_sha is null or cache_warm_sha ~ '^[0-9a-f]{40}$');
alter table public.gh_repositories add column if not exists cache_warm_at timestamptz;
alter table public.gh_repositories add column if not exists cache_warm_source text check (cache_warm_source is null or cache_warm_source in ('warmup', 'run'));
alter table public.gh_repositories add column if not exists cache_warm_pushed_at timestamptz;

-- A customer's job: whether its machine got write access to the shared cache (trusted ref). A warm-up is covered by
-- a job with write access on the same commit.
alter table public.gh_jobs add column if not exists cache_access text check (cache_access is null or cache_access in ('read', 'write'));
-- When the job's machine was requested (per-job mode). A job queued without one is a customer waiting for a machine:
-- warm-ups never take a machine in that region meanwhile.
alter table public.gh_jobs add column if not exists launched_at timestamptz;
create index if not exists gh_jobs_repo_sha on public.gh_jobs (repository_id, head_sha);

-- ---------------------------------------------------------------- usage events: warm-ups, never billed

-- A warm-up's usage event has no GitHub job or run: it is keyed by the warm-up (unique: recorded once), kind
-- 'warmup', reason 'warm-up', and is never billable. Every other event stays as it was (one per GitHub job).
alter table public.ci_usage_events alter column github_job_id drop not null;
alter table public.ci_usage_events alter column github_run_id drop not null;
alter table public.ci_usage_events add column if not exists warmup_id bigint unique references public.gh_warmups (id) on delete set null;
alter table public.ci_usage_events drop constraint if exists ci_usage_events_kind_check;
alter table public.ci_usage_events add constraint ci_usage_events_kind_check check (kind in ('ci_run', 'warmup'));
alter table public.ci_usage_events drop constraint if exists ci_usage_events_warmup_check;
alter table public.ci_usage_events add constraint ci_usage_events_warmup_check check (
  (kind = 'ci_run' and github_job_id is not null and github_run_id is not null and warmup_id is null)
  or (kind = 'warmup' and github_job_id is null and billable = false and reason = 'warm-up'));

-- ---------------------------------------------------------------- row level security

alter table public.gh_warmups enable row level security;
revoke all on public.gh_warmups from public, anon, authenticated;

-- The GitHub App: every warm-up row (its own table, like gh_jobs).
grant select, insert, update on public.gh_warmups to fenvix_github_app;
drop policy if exists gh_warmups_github_app on public.gh_warmups;
create policy gh_warmups_github_app on public.gh_warmups for all to fenvix_github_app using (true) with check (true);

-- The dashboard API: its organization's warm-ups, read only.
grant select on public.gh_warmups to fenvix_api;
drop policy if exists gh_warmups_api_read on public.gh_warmups;
create policy gh_warmups_api_read on public.gh_warmups for select to fenvix_api using (workspace_id = public.api_workspace());

notify pgrst, 'reload schema';
