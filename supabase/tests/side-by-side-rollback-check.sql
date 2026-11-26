-- protects=after the 0020 rollback (supabase/rollback/0020_side_by_side_down.sql, run by run-local.sh just before this),
-- the code before 0020 finds no side-by-side job to publish: its sweep reads completed jobs with published_at null and
-- publish_attempts < 5 (and its webhooks call tryPublish, which stops at published_at); an ordinary job still waits
-- for it; fails_when=the side-by-side job is still due (it would be billed, checked and commented); no_claim=-.
do $$
declare n int;
begin
  select count(*) into n from public.gh_jobs where job_id in (990101, 990102) and status = 'completed' and published_at is null and publish_attempts < 5;
  if n <> 1 or not exists (select 1 from public.gh_jobs where job_id = 990102 and published_at is null) then
    raise exception 'after the rollback % job(s) are due for the older publish path (expected only the ordinary one)', n;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gh_jobs' and column_name = 'kind') then
    raise exception 'gh_jobs.kind is still there after the rollback';
  end if;
  raise notice 'SIDE BY SIDE ROLLBACK OK';
end $$;
select 'SIDE BY SIDE ROLLBACK OK';
