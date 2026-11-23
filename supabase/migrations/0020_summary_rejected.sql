-- fenvix: a run summary refused at intake is stored, so that its run is published not proven at once (docs/data-contract.md,
-- "3. The run summary"). Safe to run more than once. Run it AFTER 0001 to 0019.
--
-- gh_run_summaries: rejected_at and rejected_reason (why POST /v1/runner/summaries answered 422, at most 500
-- characters), and `summary` may be null: a row with a null summary is a rejected summary. A later valid summary
-- replaces the row and clears both columns; a rejection never overwrites a stored valid summary (the App's upsert says
-- `where gh_run_summaries.summary is null`). No new constraint, so no NOT VALID step.
-- Rollback (a later migration, in this order):
--   delete from public.gh_run_summaries where summary is null;
--   alter table public.gh_run_summaries alter column summary set not null;
--   alter table public.gh_run_summaries drop column rejected_reason, drop column rejected_at;
-- The deploy (deploy/lib/migrate.mjs) runs this file in one transaction: it waits at most 5 s for each table's lock and
-- 60 s for any statement.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.gh_run_summaries add column if not exists rejected_at timestamptz;
alter table public.gh_run_summaries add column if not exists rejected_reason text;
alter table public.gh_run_summaries alter column summary drop not null;
