-- fenvix: parallel with proof and NOT PROVEN (docs/data-contract.md, "Parallel with proof"). Safe to run more than
-- once. Run it AFTER 0001 to 0018.
--
-- ci_runs: the summary's `exit` (exit_code), its `proof` object (null for a serial run, and until the runner sends it) and N, the run's count
-- of tests not proven identical to the serial run; the status `not_proven` (finished, never green).
-- ci_test_results: the outcome `not_proven` and its cause, when the runner says.
-- Rollback: a migration that drops the three columns and narrows the two CHECK constraints back, once no row uses
-- 'not_proven' (older code never reads the new columns).

alter table public.ci_runs add column if not exists proof jsonb;
alter table public.ci_runs add column if not exists tests_not_proven int not null default 0;
-- The test command's exit code (summary.json `exit`): null while running, without a summary, and for older rows.
alter table public.ci_runs add column if not exists exit_code int;
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
