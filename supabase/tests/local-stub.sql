-- Stand-ins for the parts of Supabase the schema leans on, so the migration and the tests can
-- run on a plain, empty Postgres. FOR A LOCAL SCRATCH DATABASE ONLY: never run this on a
-- Supabase project, which already has all of it.
create schema if not exists extensions;
create schema if not exists auth;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, extensions, auth to anon, authenticated, service_role;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', 'anon')
$$;
-- Supabase Auth sets this when the address is confirmed (a link was followed, or the provider vouched for it).
alter table auth.users add column if not exists email_confirmed_at timestamptz;
