-- fenvix: what idea 3 ("is this red real?") needs of each failed test (docs/data-contract.md, "2. Per-test results").
-- Safe to run more than once. Run it AFTER 0001 to 0020.
--
-- ci_test_results: fail_seq (the test's place among the run's failed tests, 0-based, in run order), rerun_alone_ran
-- (whether the runner re-ran it alone, without the cache), rerun_alone_outcome (that re-run's outcome: passed, failed or
-- not_proven) and rerun_alone_failure (that re-run's failure record, null unless it failed). All four are null for a
-- test that did not fail, and for a runner that does not send them. Nullable columns and one CHECK on a new column
-- (every existing row is null, so the check holds at once and needs no NOT VALID step).
-- Rollback (a later migration):
--   alter table public.ci_test_results drop column rerun_alone_failure, drop column rerun_alone_outcome,
--     drop column rerun_alone_ran, drop column fail_seq;
-- The deploy (deploy/lib/migrate.mjs) runs this file in one transaction: it waits at most 5 s for each table's lock and
-- 60 s for any statement.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.ci_test_results add column if not exists fail_seq int;
alter table public.ci_test_results add column if not exists rerun_alone_ran boolean;
alter table public.ci_test_results add column if not exists rerun_alone_outcome text;
alter table public.ci_test_results add column if not exists rerun_alone_failure jsonb;
alter table public.ci_test_results drop constraint if exists ci_test_results_rerun_alone_outcome_check;
alter table public.ci_test_results add constraint ci_test_results_rerun_alone_outcome_check
  check (rerun_alone_outcome in ('passed', 'failed', 'not_proven'));
