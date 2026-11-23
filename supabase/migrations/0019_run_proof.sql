-- fenvix: parallel with proof and NOT PROVEN (docs/data-contract.md, "Parallel with proof"). Safe to run more than
-- once. Run it AFTER 0001 to 0018.
--
-- ci_runs: the summary's `exit` (exit_code), its `proof` object (null for a serial run, and until the runner sends it), N,
-- the run's count of tests not proven identical to the serial run, and why when no proof cause says it
-- (not_proven_reason); the status `not_proven` (finished, never green).
-- ci_test_results: the outcome `not_proven` and its cause, when the runner says.
-- Rollback (a later migration, in this order): rewrite the rows that use the new values, then narrow the checks and
-- drop the columns (older code never reads them):
--   update public.ci_test_results set outcome = 'failed', failure_kind = 'real', failure_phase = 'call',
--     failure_message = coalesce('not proven: ' || not_proven_cause, 'not proven identical to the serial run'), not_proven_cause = null
--     where outcome = 'not_proven';
--   update public.ci_runs set tests_failed = tests_failed + tests_not_proven,
--     status = case when status = 'not_proven' then 'failed' else status end
--     where tests_not_proven > 0 or status = 'not_proven';
--   then re-create ci_runs_status_check and ci_test_results_outcome_check without 'not_proven', drop
--   ci_test_results_not_proven_cause_check, ci_runs_proof_check, ci_runs_tests_not_proven_check and the columns
--   not_proven_cause, proof, tests_not_proven, exit_code, not_proven_reason.
-- The deploy (deploy/lib/migrate.mjs) runs this file in one transaction: it waits at most 5 s for each table's lock and
-- 60 s for any statement.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.ci_runs add column if not exists proof jsonb;
alter table public.ci_runs add column if not exists tests_not_proven int not null default 0;
-- The test command's exit code (summary.json `exit`): null while running, without a summary, and for older rows.
alter table public.ci_runs add column if not exists exit_code int;
-- Why the run is not proven when no proof cause says it (an unreadable summary, a missing exit code, a failed verify).
alter table public.ci_runs add column if not exists not_proven_reason text;
alter table public.ci_runs drop constraint if exists ci_runs_not_proven_reason_check;
alter table public.ci_runs add constraint ci_runs_not_proven_reason_check check (not_proven_reason is null or length(not_proven_reason) <= 200);
alter table public.ci_runs drop constraint if exists ci_runs_tests_not_proven_check;
alter table public.ci_runs add constraint ci_runs_tests_not_proven_check check (tests_not_proven >= 0);
alter table public.ci_runs drop constraint if exists ci_runs_proof_check;
alter table public.ci_runs add constraint ci_runs_proof_check check (proof is null or jsonb_typeof(proof) = 'object');

alter table public.ci_runs drop constraint if exists ci_runs_status_check;
alter table public.ci_runs add constraint ci_runs_status_check
  check (status in ('running', 'passed', 'failed', 'cancelled', 'not_proven'));

alter table public.ci_test_results add column if not exists not_proven_cause text;
alter table public.ci_test_results drop constraint if exists ci_test_results_not_proven_cause_check;
alter table public.ci_test_results add constraint ci_test_results_not_proven_cause_check
  check (not_proven_cause is null or (outcome = 'not_proven' and length(not_proven_cause) <= 500));

alter table public.ci_test_results drop constraint if exists ci_test_results_outcome_check;
alter table public.ci_test_results add constraint ci_test_results_outcome_check
  check (outcome in ('passed', 'failed', 'skipped_with_proof', 'not_proven'));
