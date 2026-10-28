-- FENVIX control plane, part 5: per-database engine users (control-plane/docs/data-explorer-security.md).
-- Safe to run more than once. Run it AFTER 0002_control_plane.sql. It adds no table and stores no secret: the
-- passwords of the engine users are derived from a master key and never written anywhere.
--
--   * public.fenvix_cp_engine_databases(): the databases the engine should have a user for, across workspaces, for the
--     control plane's user sweep (engine users without a database are dropped, databases without a user get one).
--     Id, region and engine state only: no name, no workspace, nothing a customer typed.

create or replace function public.fenvix_cp_engine_databases()
returns table (id uuid, region text, engine_state text)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.id, d.region, d.engine_state from public.databases d
$$;

revoke all on function public.fenvix_cp_engine_databases() from public, anon, authenticated;
grant execute on function public.fenvix_cp_engine_databases() to fenvix_control_plane;

notify pgrst, 'reload schema';
