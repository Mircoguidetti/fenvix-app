-- Our machines (0018_our_machines.sql): who may see the machines, the leases (they carry each job's sealed
-- credentials until taken) and the redeliveries. Run AFTER 0001 to 0018. One transaction, rolled back; a clean run
-- ends with "MACHINES RLS OK".
--   Only the GitHub App's role reads or writes them. A signed-in member, an anonymous caller and the dashboard API's
--   role are refused outright (no grant), whatever the row. And the database itself refuses to give a machine that
--   held one customer's work to another, or to make it clean again.
begin;

do $$
declare t text; who text; ok boolean;
begin
  foreach who in array array['authenticated', 'anon', 'fenvix_api'] loop
    foreach t in array array['gh_machines', 'gh_leases', 'gh_redeliveries', 'gh_machine_minutes'] loop
      execute format('set local role %I', who);
      ok := false;
      begin
        execute format('select 1 from public.%I limit 1', t);
      exception when insufficient_privilege then ok := true;
      end;
      reset role;
      if not ok then raise exception 'MACHINES RLS: % can read %', who, t; end if;
    end loop;
  end loop;
end $$;

-- The App's role can use them.
set local role fenvix_github_app;
select count(*) from public.gh_machines;
select count(*) from public.gh_leases;
reset role;

-- One customer per machine, for its whole life.
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  ('5aaaaaaa-0000-4000-8000-000000000001', 'm.a@fenvix.invalid', '{"full_name":"A"}', now()),
  ('5bbbbbbb-0000-4000-8000-000000000002', 'm.b@fenvix.invalid', '{"full_name":"B"}', now());
do $$
declare a uuid; b uuid; m bigint; ok boolean;
begin
  select workspace_id into a from public.workspace_members where user_id = '5aaaaaaa-0000-4000-8000-000000000001';
  select workspace_id into b from public.workspace_members where user_id = '5bbbbbbb-0000-4000-8000-000000000002';
  insert into public.gh_machines (region, size, instance_type, slots, state, workspace_id, ever_bound, bound_at)
    values ('eu', 'standard', 'c7a.xlarge', 2, 'bound', a, true, now()) returning id into m;
  ok := false; begin update public.gh_machines set workspace_id = b where id = m; exception when others then ok := true; end;
  if not ok then raise exception 'MACHINES RLS: a machine of A was given to B'; end if;
  ok := false; begin update public.gh_machines set state = 'ready', workspace_id = null where id = m; exception when others then ok := true; end;
  if not ok then raise exception 'MACHINES RLS: a used machine was made clean again'; end if;
  ok := false; begin insert into public.gh_leases (machine_id, slot, kind, job_id, workspace_id) values (m, 2, 'job', 77, b); exception when others then ok := true; end;
  if not ok then raise exception 'MACHINES RLS: B got a lease on A''s machine'; end if;
  -- A deleted customer: the machine keeps the fact that it was used.
  update public.gh_machines set workspace_id = null, state = 'retiring' where id = m;
  ok := false; begin update public.gh_machines set state = 'ready' where id = m; exception when others then ok := true; end;
  if not ok then raise exception 'MACHINES RLS: a used machine whose customer is gone was made clean again'; end if;
end $$;

select 'MACHINES RLS OK';
rollback;
