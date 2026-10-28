-- FENVIX control plane, part 7: the customers' own database users ("Database Access",
-- control-plane/docs/database-users.md).
-- Safe to run more than once. Run it AFTER 0002_control_plane.sql and 0004_data_explorer.sql. It does not depend on
-- 0003, 0005 or 0006 and does not run them. It stores no secret: the users and their SCRAM hashes live in the engine
-- only, and their passwords are never written anywhere.
--
--   * public.api_keys.user_access: what an API key may do with a database's users. 'none' (the default, and what
--     every key that exists today becomes): it can list them, nothing else. 'manage': it can also create users,
--     reset their passwords and delete them.
--   * public.databases.app_user: the name of the user the database's connection string shows (the initial user made
--     with the database, by default "app"). Only a name, never a password. Null for databases made before this file
--     and after that user was deleted: the connection string then says <username>.
--
-- Creating, resetting and deleting users is recorded in public.audit_log (0002): who, which database, which user,
-- when, outcome. Never a password or a hash.

alter table public.api_keys add column if not exists user_access text not null default 'none';
alter table public.api_keys drop constraint if exists api_keys_user_access_check;
alter table public.api_keys add constraint api_keys_user_access_check check (user_access in ('none', 'manage'));

alter table public.databases add column if not exists app_user text;
alter table public.databases drop constraint if exists databases_app_user_check;
alter table public.databases add constraint databases_app_user_check
  check (app_user is null or app_user ~ '^[a-z][a-z0-9_-]{2,31}$');

notify pgrst, 'reload schema';
