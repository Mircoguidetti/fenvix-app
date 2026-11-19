-- fenvix: fixes of review R-016b (docs/REVIEW-R-016b.md). Safe to run more than once. Run it AFTER 0015.
--
-- G1      Billing: whether a job is billable rests on GitHub's data only (no schema change; github-app/src/service.ts).
-- G2      Runner records have limits on every endpoint, explorations included:
--         - ci_explorations.received_at: when the App stored the exploration (the App's clock, not the runner's
--           startedAt). A project gets at most one new exploration per UTC day (sending the same one again updates it).
--         - The App may delete explorations: it keeps the newest EXPLORATION_KEEP_NIGHTS of a project.
--         - The App may delete staged summaries (gh_run_summaries) once they are old (the sweep), as it does results.

-- ================================================================ G2: explorations are bounded per project

alter table public.ci_explorations add column if not exists received_at timestamptz not null default now();
create index if not exists ci_explorations_project_received on public.ci_explorations (project_id, received_at desc);
-- The policy ci_explorations_github_app (0014) is "for all" on the organization of the transaction.
grant delete on public.ci_explorations to fenvix_github_app;

-- ================================================================ G2: staged summaries are not kept for good

-- The policy gh_run_summaries_github_app (0013) is "for all".
grant delete on public.gh_run_summaries to fenvix_github_app;
create index if not exists gh_run_summaries_received on public.gh_run_summaries (received_at);
