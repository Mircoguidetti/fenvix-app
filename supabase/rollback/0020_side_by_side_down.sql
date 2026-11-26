-- Rollback of supabase/migrations/0020_side_by_side.sql. NOT a migration (deploy/lib/migrate.mjs applies only
-- supabase/migrations/): run it by hand, after the code that reads 0020 has been reverted, then delete 0020's row
-- from fenvix_deploy.schema_migrations. Safe to run more than once.
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -1 -f supabase/rollback/0020_side_by_side_down.sql
--
-- BEFORE running it: list the repositories that run side by side (they keep .github/workflows/fenvix-side-by-side.yml
-- until the customer deletes it, and the code before 0020 would bill their jobs and comment on their pull requests):
--   select full_name, setup_pr_url from public.gh_repositories where onboarding_state in ('side_by_side_pr_open', 'side_by_side');
-- and have each file deleted (or the App's fenvix label removed from it) before the older code serves webhooks.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Kinds back to their defaults (rows that use the new values), so that the narrower checks hold. Only while 0020's
-- columns are there (a second run finds them gone).
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'onboarding_kind') then
    update public.workspaces set onboarding_kind = 'move' where onboarding_kind <> 'move';
  end if;
  update public.gh_repositories set onboarding_state = 'pending', onboarding_detail = 'the setup pull request has not been opened yet'
    where onboarding_state in ('side_by_side_pr_open', 'side_by_side');
  delete from public.ci_usage_events where kind = 'side_by_side';
  -- Our side-by-side jobs, while gh_jobs.kind still tells them apart: marked published, so that the code before 0020
  -- (its sweep: completed, published_at null, publish_attempts < 5; its webhooks: tryPublish stops at published_at)
  -- never publishes one as an ordinary job (a check run, a comment, a billable usage event).
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_jobs' and column_name = 'kind') then
    update public.gh_jobs set published_at = coalesce(published_at, now()), publish_attempts = greatest(publish_attempts, 5)
      where kind = 'side_by_side';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ci_runs' and column_name = 'kind') then
    update public.gh_jobs set ci_run_id = null where ci_run_id in (select id from public.ci_runs where kind = 'side_by_side');
    delete from public.ci_runs where kind = 'side_by_side';
  end if;
end $$;

-- Checks as 0013 and 0017 made them.
alter table public.gh_repositories drop constraint if exists gh_repositories_onboarding_state_check;
alter table public.gh_repositories add constraint gh_repositories_onboarding_state_check check (onboarding_state in
  ('pending', 'pr_open', 'merged', 'closed', 'no_workflow', 'no_test_job', 'already_fenvix', 'unsupported', 'failed'));
alter table public.ci_usage_events drop constraint if exists ci_usage_events_warmup_check;
alter table public.ci_usage_events drop constraint if exists ci_usage_events_kind_check;
alter table public.ci_usage_events add constraint ci_usage_events_kind_check check (kind in ('ci_run', 'warmup'));
alter table public.ci_usage_events add constraint ci_usage_events_warmup_check check (
  (kind = 'ci_run' and github_job_id is not null and github_run_id is not null and warmup_id is null)
  or (kind = 'warmup' and github_job_id is null and billable = false and reason = 'warm-up'));

-- Added tables, policies and columns.
drop policy if exists gh_jobs_api_side_by_side on public.gh_jobs;
revoke select on public.gh_jobs from fenvix_api;
drop table if exists public.gh_customer_jobs;
drop table if exists public.ci_runner_label_rates;
delete from public.ci_reference_rates where key in ('ubicloud-x64-2', 'blacksmith-2vcpu-ubuntu-2404', 'blacksmith-4vcpu-ubuntu-2404',
  'blacksmith-8vcpu-ubuntu-2404', 'blacksmith-16vcpu-ubuntu-2404');
update public.ci_reference_rates set usd_per_minute = 0.008, source = 'GitHub Actions pricing page, as quoted in PRODUCT.md (to verify)', checked_on = date '2026-11-16'
  where key = 'github-linux-2core';
alter table public.ci_reference_rates drop constraint if exists ci_reference_rates_max_check;
alter table public.ci_reference_rates drop column if exists usd_per_minute_max;
drop index if exists public.ci_runs_side_by_side;
alter table public.ci_runs drop constraint if exists ci_runs_kind_check;
alter table public.ci_runs drop column if exists kind;
drop index if exists public.gh_jobs_side_by_side;
alter table public.gh_jobs drop constraint if exists gh_jobs_kind_check;
alter table public.gh_jobs drop column if exists kind, drop column if exists workflow_path, drop column if exists event,
  drop column if exists pr_number, drop column if exists skip_machine, drop column if exists has_summary, drop column if exists checkout_sha;
drop index if exists public.gh_repositories_history_due;
alter table public.gh_repositories drop column if exists awaiting_link, drop column if exists side_by_side_matrix,
  drop column if exists side_by_side_matrix_suffix, drop column if exists side_by_side_job_name, drop column if exists side_by_side_test_step,
  drop column if exists side_by_side_timeout_minutes, drop column if exists history_cursor, drop column if exists history_next_at;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'onboarding_kind') then
    revoke update (onboarding_kind) on public.workspaces from fenvix_api;
    revoke select (onboarding_kind) on public.workspaces from fenvix_github_app;
  end if;
end $$;
alter table public.workspaces drop constraint if exists workspaces_onboarding_kind_check;
alter table public.workspaces drop column if exists onboarding_kind;

notify pgrst, 'reload schema';
