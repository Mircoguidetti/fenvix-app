-- fenvix: the identity of the machine that ran each job and warm-up (idea 3, "is this red real?": two jobs are
-- comparable only when they ran on the same kind of machine from the same image; docs/data-contract.md).
-- Safe to run more than once. Run it AFTER 0001 to 0021.
--
-- gh_jobs and gh_warmups: image_id (the AMI EC2 reports for the machine launched for the job / warm-up),
-- instance_type (its EC2 instance type) and machine_kind ('ec2', 'prototype' or null; warm-ups: 'ec2' or null).
-- Nullable columns, no backfill: existing rows keep null (not comparable, the safe value). The CHECKs are on new
-- columns (every existing row is null, so they hold at once and need no NOT VALID step).
-- Rollback (a later migration):
--   drop function public.gh_machine_kind(bigint, text, text);
--   alter table public.gh_warmups drop column machine_kind, drop column instance_type, drop column image_id;
--   alter table public.gh_jobs drop column machine_kind, drop column instance_type, drop column image_id;
-- The deploy (deploy/lib/migrate.mjs) runs this file in one transaction: it waits at most 5 s for each table's lock and
-- 60 s for any statement.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.gh_jobs add column if not exists image_id text;
alter table public.gh_jobs add column if not exists instance_type text;
alter table public.gh_jobs add column if not exists machine_kind text;
alter table public.gh_jobs drop constraint if exists gh_jobs_machine_kind_check;
alter table public.gh_jobs add constraint gh_jobs_machine_kind_check check (machine_kind is null or machine_kind in ('ec2', 'prototype'));
alter table public.gh_warmups add column if not exists image_id text;
alter table public.gh_warmups add column if not exists instance_type text;
alter table public.gh_warmups add column if not exists machine_kind text;
alter table public.gh_warmups drop constraint if exists gh_warmups_machine_kind_check;
alter table public.gh_warmups add constraint gh_warmups_machine_kind_check check (machine_kind is null or machine_kind = 'ec2');

-- The kind of machine that ran a job: 'ec2' only when the runner that took it is the just-in-time runner the App
-- registered for this job (fenvix-j<job_id>, or fenvix-j<job_id>-<suffix> after a 409) AND the launched image is
-- known. Another job's just-in-time runner (fenvix-j<other id>: GitHub does not bind a JIT runner to the job it was
-- registered for) is an EC2 machine whose image is not the one stored on this row: null. Any other runner name
-- (demo machine, the prototype machine, an always-on runner) is 'prototype'. No runner yet: null.
-- image_id / instance_type are the machine launched FOR this job; they describe the machine that RAN it only when
-- machine_kind = 'ec2'. C3 must ignore them otherwise, and treats null as not comparable.
create or replace function public.gh_machine_kind(p_job_id bigint, p_runner_name text, p_image_id text)
returns text language sql immutable as $$
  select case
    when p_runner_name is null then null
    when p_runner_name ~ ('^fenvix-j' || p_job_id::text || '(-[0-9a-z]+)?$') then
      case when p_image_id is null then null else 'ec2' end
    when p_runner_name ~ '^fenvix-j[0-9]+(-[0-9a-z]+)?$' then null
    else 'prototype'
  end
$$;
revoke all on function public.gh_machine_kind(bigint, text, text) from public, anon, authenticated;
grant execute on function public.gh_machine_kind(bigint, text, text) to fenvix_github_app;
