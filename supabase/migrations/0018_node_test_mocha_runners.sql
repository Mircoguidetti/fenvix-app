-- fenvix: node:test and mocha as test runners of a project (Node customers on our machines: fenvix-engine-cli
-- `fenvix-run node` runs vitest, jest, node:test and mocha in the engine). Safe to run more than once. Run it AFTER
-- 0001 to 0017.
--
-- Widens the two CHECK constraints that list the runners (0011 ci_projects.test_runner, 0013
-- gh_repositories.detected_test_runner); nothing else changes. Rollback: a migration that narrows them back, once no
-- row uses 'node:test' or 'mocha'.

alter table public.ci_projects drop constraint if exists ci_projects_test_runner_check;
alter table public.ci_projects add constraint ci_projects_test_runner_check
  check (test_runner in ('pytest', 'vitest', 'jest', 'go test', 'node:test', 'mocha'));

alter table public.gh_repositories drop constraint if exists gh_repositories_detected_test_runner_check;
alter table public.gh_repositories add constraint gh_repositories_detected_test_runner_check
  check (detected_test_runner is null
         or detected_test_runner in ('pytest', 'vitest', 'jest', 'go test', 'node:test', 'mocha'));
