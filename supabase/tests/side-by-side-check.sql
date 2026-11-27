-- 0020 (side-by-side runs): its CHECK constraints, and the rollback leaving no side-by-side job the older code would
-- publish. Run after 0020 is applied (twice); the second half applies the rollback, then 0020 again.
-- protects=a side-by-side usage event is never billable, kinds are only the known ones, a rate's max is not below it;
-- fails_when=a constraint is missing or wider; no_claim=-.
do $$
begin
  insert into public.gh_installations (installation_id, account_id, account_login, account_type) values (9901, 9901, 'sbs-check', 'Organization') on conflict do nothing;
  insert into public.gh_repositories (repository_id, installation_id, full_name) values (9901, 9901, 'sbs-check/app') on conflict do nothing;
  begin
    insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, github_job_id, github_run_id, billable, reason, occurred_at, kind)
      values (9901, 9901, 'sbs-check/app', 990001, 1, true, 'side-by-side', now(), 'side_by_side');
    raise exception 'a billable side-by-side usage event was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.gh_jobs (job_id, repository_id, installation_id, run_id, head_sha, status, kind) values (990002, 9901, 9901, 1, repeat('a', 40), 'queued', 'free');
    raise exception 'an unknown job kind was accepted';
  exception when check_violation then null; end;
  begin
    update public.gh_repositories set onboarding_state = 'side_by_side_maybe' where repository_id = 9901;
    raise exception 'an unknown onboarding state was accepted';
  exception when check_violation then null; end;
  raise notice 'SIDE BY SIDE CHECK OK';
end $$;
select 'SIDE BY SIDE CHECK OK';
