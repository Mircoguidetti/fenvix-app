-- 0018: the runner lists of ci_projects.test_runner and gh_repositories.detected_test_runner accept node:test and
-- mocha, and each column has exactly one CHECK constraint naming runners (the old one was replaced, not kept beside).
do $$
declare
  t text;
  c text;
  defs text[];
begin
  foreach t in array array['ci_projects.test_runner', 'gh_repositories.detected_test_runner'] loop
    c := split_part(t, '.', 2);
    select array_agg(pg_get_constraintdef(k.oid)) into defs
      from pg_constraint k join pg_class r on r.oid = k.conrelid join pg_namespace n on n.oid = r.relnamespace
     where n.nspname = 'public' and r.relname = split_part(t, '.', 1) and k.contype = 'c'
       and pg_get_constraintdef(k.oid) like '%' || c || '%';
    if coalesce(array_length(defs, 1), 0) <> 1 then
      raise exception '%: expected one CHECK constraint, found %: %', t, coalesce(array_length(defs, 1), 0), defs;
    end if;
    if defs[1] not like '%''node:test''%' or defs[1] not like '%''mocha''%' or defs[1] not like '%''pytest''%'
       or defs[1] not like '%''vitest''%' or defs[1] not like '%''jest''%' or defs[1] not like '%''go test''%' then
      raise exception '%: runner list is %', t, defs[1];
    end if;
  end loop;
  raise notice 'RUNNERS CHECK OK';
end $$;
select 'RUNNERS CHECK OK';
