-- fenvix: remove a project and delete an organization from the console. Safe to run more than once. Run it AFTER 0001
-- to 0020. Additive: one column and three functions the dashboard API's role fenvix_api calls.
--
--   * Remove a project (DELETE /v1/projects/{projectId}, an owner or admin): the repository is marked excluded
--     (gh_repositories.excluded_at), then the project row is deleted (its runs, defects, receipts, test results and
--     explorations go with it, on delete cascade). The GitHub App skips an excluded repository everywhere it skips a
--     removed one, so the project does not come back on the next sync and its queued jobs start no machine.
--   * Add it again (POST /v1/github/repositories/{repositoryId}/restore, an owner or admin): excluded_at is cleared; the
--     API then queues the work "sync_repository" for the App, which creates the project again.
--   * Delete the organization (DELETE /v1/organization, the owner only): the workspaces row is deleted (everything of
--     the organization goes with it, on delete cascade; its installations keep their row with workspace_id null, so the
--     App refuses their jobs); the caller's own login is deleted when no membership is left for it. The function returns
--     the organization's installation ids: the API queues one "uninstall_installation" per id for the App.
--
-- The deploy (deploy/lib/migrate.mjs) runs this file in one transaction; its probe is the column first and
-- api_delete_organization last.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------- a repository removed from fenvix by its organization

alter table public.gh_repositories add column if not exists excluded_at timestamptz;
-- An organization was deleted: the App is to be uninstalled from this installation's GitHub account. The worker
-- ("uninstall_installation", and the App's sweep when that message was lost) uninstalls only installations marked so.
alter table public.gh_installations add column if not exists uninstall_requested_at timestamptz;

-- ---------------------------------------------------------------- remove a project

-- True when the project was this organization's and is gone; false for an unknown project or another organization's
-- (the API answers 404 for both). The repository (by its project link, else by its name in this organization) is
-- excluded first, so that no sync between the two statements can create the project again.
create or replace function public.api_remove_project(p_project uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid := public.api_admin_workspace(); v_name text;
begin
  if v_ws is null then
    raise exception 'Only an owner or admin of the organization can remove a project.' using errcode = '42501';
  end if;
  select p.full_name into v_name from public.ci_projects p where p.id = p_project and p.workspace_id = v_ws;
  if v_name is null then return false; end if;
  -- The repository row first, then the project: the App's syncProject locks them in the same order, so a run being
  -- published at the same moment either finishes first (its run is deleted with the project) or sees excluded_at.
  update public.gh_repositories r set excluded_at = coalesce(r.excluded_at, now()), updated_at = now()
   where r.workspace_id = v_ws and (r.project_id = p_project or (r.project_id is null and lower(r.full_name) = lower(v_name)));
  delete from public.ci_projects p where p.id = p_project and p.workspace_id = v_ws;
  if not found then return false; end if;
  return true;
end $$;

-- ---------------------------------------------------------------- add a repository again

-- True when the repository is this organization's (excluded_at is cleared, if it was set); false otherwise (404).
create or replace function public.api_restore_repository(p_repository bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid := public.api_admin_workspace();
begin
  if v_ws is null then
    raise exception 'Only an owner or admin of the organization can add a repository again.' using errcode = '42501';
  end if;
  update public.gh_repositories r set excluded_at = null, updated_at = now()
   where r.repository_id = p_repository and r.workspace_id = v_ws;
  return found;
end $$;

-- ---------------------------------------------------------------- delete the organization

-- The owner only. Returns the organization's GitHub App installations (the API asks the App to uninstall each) and
-- whether the caller's own login was deleted (it is when they belong to no other organization).
create or replace function public.api_delete_organization()
returns table (installation_ids bigint[], login_deleted boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid := public.api_owner_workspace(); v_user uuid := public.api_user(); v_ids bigint[]; v_deleted boolean := false;
begin
  if v_ws is null or v_user is null then
    raise exception 'Only an owner of the organization can delete it.' using errcode = '42501';
  end if;
  perform 1 from public.workspaces w where w.id = v_ws for update;
  select coalesce(array_agg(i.installation_id order by i.installation_id), '{}'::bigint[]) into v_ids
    from public.gh_installations i where i.workspace_id = v_ws;
  update public.gh_installations i set uninstall_requested_at = now(), updated_at = now() where i.workspace_id = v_ws;
  -- A removal is this organization's choice: it does not follow the repository to an organization that links it later.
  update public.gh_repositories r set excluded_at = null, updated_at = now() where r.workspace_id = v_ws and r.excluded_at is not null;
  delete from public.workspaces w where w.id = v_ws;
  if not exists (select 1 from public.workspace_members m where m.user_id = v_user) then
    delete from auth.users u where u.id = v_user;
    v_deleted := found;
  end if;
  return query select v_ids, v_deleted;
end $$;

do $$
declare f text;
begin
  foreach f in array array['api_remove_project(uuid)', 'api_restore_repository(bigint)', 'api_delete_organization()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to fenvix_api', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
