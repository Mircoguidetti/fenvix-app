-- 0019: ci_runs.status and ci_test_results.outcome accept not_proven (each through its one named CHECK constraint, the
-- old one replaced, not kept beside), ci_runs has proof and tests_not_proven, ci_test_results has not_proven_cause.
do $$
declare
  d text;
  n int;
begin
  select count(*), max(pg_get_constraintdef(k.oid)) into n, d from pg_constraint k join pg_class r on r.oid = k.conrelid
   where r.relname = 'ci_runs' and k.contype = 'c' and pg_get_constraintdef(k.oid) like '%status%''running''%';
  if n <> 1 or d not like '%''not_proven''%' or d not like '%''passed''%' or d not like '%''cancelled''%' then
    raise exception 'ci_runs.status: % constraint(s): %', n, d;
  end if;
  select count(*), max(pg_get_constraintdef(k.oid)) into n, d from pg_constraint k join pg_class r on r.oid = k.conrelid
   where r.relname = 'ci_test_results' and k.contype = 'c' and k.conname = 'ci_test_results_outcome_check';
  if n <> 1 or d not like '%''not_proven''%' or d not like '%''skipped_with_proof''%' then
    raise exception 'ci_test_results.outcome: %', d;
  end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and ((table_name = 'ci_runs' and column_name in ('proof', 'tests_not_proven', 'exit_code', 'not_proven_reason'))
      or (table_name = 'ci_test_results' and column_name = 'not_proven_cause'));
  if n <> 5 then raise exception 'expected 5 new columns, found %', n; end if;
  raise notice 'RUN PROOF CHECK OK';
end $$;
select 'RUN PROOF CHECK OK';
