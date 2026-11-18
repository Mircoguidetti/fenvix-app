/*
 * Realistic CI data for one organization, written as the database owner (what the GitHub App and the runner would
 * have written): an installation with repositories, two projects, runs this month and last (shadow runs in the trial,
 * a running run with live progress, pull request runs, audited runs), per-test results with a skip receipt, defects,
 * audit reruns, a night of exploration, usage events, the subscription with its trial and the nightly add-on.
 */
import type pg from "pg";
import { at, githubId, key32, sha } from "./helpers.ts";

export interface Seeded {
  workspaceId: string;
  installationId: number;
  repoIds: { shop: number; web: number; loose: number };
  projects: { shop: string; web: string };
  runs: { latest: string; failed: string; running: string; reused: string; shadow: string; lastMonth: string };
  receipt: string;
  defects: { open: string; fixed: string };
  exploration: string;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, any>[]>;

export async function seedOrg(admin: pg.Client, workspaceId: string, account: string): Promise<Seeded> {
  const q: Q = async (sql, params = []) => (await admin.query(sql, params)).rows;
  const installationId = githubId();
  await q(`insert into public.gh_installations (installation_id, workspace_id, account_id, account_login, account_type, repository_selection, linked_at)
           values ($1, $2, $3, $4, 'Organization', 'selected', $5)`, [installationId, workspaceId, githubId(), account, at(12)]);
  const repoIds = { shop: githubId(), web: githubId(), loose: githubId() };

  const project = async (name: string, language: string, runner: string, state: string, pr: number | null, prState: string | null) => (await q(
    `insert into public.ci_projects (workspace_id, full_name, language, test_runner, installation_id, setup_state, setup_pr_number, setup_pr_url, setup_pr_state,
       connected_at, baseline_median_ttg_s, baseline_median_job_minutes, baseline_runs_sampled, baseline_from, baseline_to)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 540, 9.5, 40, '2026-10-01', '2026-10-31') returning id`,
    [workspaceId, `${account}/${name}`, language, runner, installationId, state, pr, pr ? `https://github.com/${account}/${name}/pull/${pr}` : null, prState, at(12)]))[0]!.id as string;
  const shop = await project("shop", "python", "pytest", "active", 1, "merged");
  const web = await project("web", "node", "vitest", "pr_open", 4, "open");

  const repo = (id: number, name: string, state: string, projectId: string | null, extra: Record<string, unknown> = {}) => q(
    `insert into public.gh_repositories (repository_id, installation_id, full_name, private, project_id, onboarding_state, onboarding_detail,
       onboarding_workflow_path, onboarding_job, setup_pr_number, setup_pr_url, detected_language, detected_test_runner)
     values ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, installationId, `${account}/${name}`, projectId, state, extra.detail ?? "", extra.path ?? null, extra.job ?? null, extra.pr ?? null,
      extra.pr ? `https://github.com/${account}/${name}/pull/${extra.pr}` : null, extra.lang ?? null, extra.runner ?? null]);
  await repo(repoIds.shop, "shop", "merged", shop, { path: ".github/workflows/ci.yml", job: "test", pr: 1, lang: "python", runner: "pytest", detail: "changed .github/workflows/ci.yml:test" });
  await repo(repoIds.web, "web", "pr_open", web, { path: ".github/workflows/test.yml", job: "unit", pr: 4, lang: "node", runner: "vitest" });
  await repo(repoIds.loose, "docs", "no_test_job", null, { detail: "No job runs tests.", path: ".github/workflows/docs.yml" });

  // The trial: started 10 days ago, 30 days long; the nightly exploration add-on.
  await q(`insert into public.ci_subscriptions (workspace_id, plan_id, github_account, nightly_exploration_addon, trial_started_at, trial_ends_at)
           values ($1, 'team', $2, true, $3, $4)
           on conflict (workspace_id) do update set plan_id = excluded.plan_id, nightly_exploration_addon = true,
             trial_started_at = excluded.trial_started_at, trial_ends_at = excluded.trial_ends_at`, [workspaceId, account, at(10), at(-20)]);

  let n = 0;
  const run = async (projectId: string, o: {
    daysAgo: number; status?: string; mode?: string; pr?: number | null; branch?: string; ran?: number; skipped?: number; failed?: number; flaky?: number;
    ranMs?: number; skippedMs?: number; wouldSkip?: number; wouldMs?: number; audit?: [number, number]; progress?: Record<string, unknown> | null; commit?: string; engineRunId?: string;
  }) => {
    n++;
    const status = o.status ?? "passed";
    const ran = o.ran ?? 40;
    const skipped = o.skipped ?? 160;
    const failed = o.failed ?? (status === "failed" ? 2 : 0);
    const started = at(o.daysAgo);
    const finished = status === "running" ? null : new Date(started.getTime() + 4 * 60_000);
    return (await q(
      `insert into public.ci_runs (project_id, workspace_id, number, engine_run_id, commit_sha, commit_message, branch, pull_request, trigger, status, mode,
         pushed_at, started_at, finished_at, duration_ms, tests_total, tests_ran, tests_passed, tests_failed, tests_skipped, tests_flaky_defects,
         test_time_ran_ms, test_time_skipped_ms, other_step_minutes, engine_version, seed, skip_misses, miss_details,
         would_skip_tests, would_save_ms, audit_rerun, audit_wrong_skips, region, progress, progress_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, '0.9.1', 7,
         '{"code": 30, "new": 10}'::jsonb, '[{"kind": "code", "detail": "src/shop/cart.py changed", "tests": 30}]'::jsonb, $25, $26, $27, $28, 'us', $29, $30)
       returning id`,
      [projectId, null, n, o.engineRunId ?? `eng-${n}-${key32().slice(0, 8)}`, o.commit ?? sha(), `Change number ${n}`, o.branch ?? (o.pr ? `feature-${n}` : "main"), o.pr ?? null,
        o.pr ? "pull_request" : "push", status, o.mode ?? "enforce", new Date(started.getTime() - 30_000), started, finished, finished ? 240_000 : 0,
        ran + skipped, ran, ran - failed, failed, skipped, o.flaky ?? 0, o.ranMs ?? 120_000, o.skippedMs ?? 480_000, 1.5,
        o.wouldSkip ?? 0, o.wouldMs ?? 0, o.audit?.[0] ?? 0, o.audit?.[1] ?? 0,
        o.progress ? JSON.stringify(o.progress) : null, o.progress ? at(o.daysAgo, 0.01) : null]))[0]!.id as string;
  };
  const lastMonth = await run(shop, { daysAgo: 25 });
  const reused = await run(shop, { daysAgo: 9, audit: [8, 0] });
  const shadow = await run(shop, { daysAgo: 8, mode: "shadow", ran: 200, skipped: 0, ranMs: 600_000, skippedMs: 0, wouldSkip: 150, wouldMs: 300_000 });
  await run(shop, { daysAgo: 6, pr: 12, audit: [5, 1] });
  const failed = await run(shop, { daysAgo: 3, status: "failed", failed: 2, flaky: 1 });
  const latest = await run(shop, { daysAgo: 1, audit: [10, 0] });
  const running = await run(shop, { daysAgo: 0.01, status: "running", ran: 0, skipped: 0, ranMs: 0, skippedMs: 0,
    progress: { phase: "testing", testsTotal: 200, testsDone: 50, passed: 49, failed: 1, skippedWithProof: 30, currentTest: "tests/test_cart.py::test_total", elapsedMs: 42_000 } });
  await run(web, { daysAgo: 2, ran: 10, skipped: 20, ranMs: 30_000, skippedMs: 60_000 });

  // The latest run's tests: one failure, one pass, one skipped with proof (its receipt reuses an earlier run).
  const receipt = (await q(
    `insert into public.ci_skip_receipts (run_id, workspace_id, test_id, cache_key, reused_run_id, reused_engine_run_id, fingerprint, reused_duration_ms,
       code, modules, files_read, env_read, runtime, config, changed_files_proven)
     values ($1, $2, 'tests/test_cart.py::test_empty', $3, $4, 'eng-reused', $5, 1200,
       '[{"path": "src/shop/cart.py", "qualname": "Cart.total", "digest": "aa11"}]'::jsonb, '[{"path": "src/shop/cart.py", "kind": "content", "digest": "bb22"}]'::jsonb,
       '[{"path": "data/prices.json", "dep": "cc33"}]'::jsonb, '[{"name": "TZ", "digest": "dd44"}]'::jsonb,
       '{"digest": "ee55", "interpreter": "CPython 3.13.1", "system": "Linux", "machine": "x86_64", "libc": "glibc 2.39", "distributions": 42}'::jsonb,
       '{"digest": "ff66", "runner": "pytest 8.3.4", "engine": "fenvix 0.9.1", "inifile": "pyproject.toml", "options": "-q"}'::jsonb, 3) returning id`,
    [latest, workspaceId, key32(), reused, key32()]))[0]!.id as string;

  const defect = async (state: string, testId: string, daysAgo: number) => (await q(
    `insert into public.ci_defects (project_id, workspace_id, test_id, status, state, cause, cause_tests, minimal_order, prefix_length, seed, fingerprint,
       exception, family_key, first_seen_at, last_seen_at, first_run_id, last_run_id, occurrences, engine_version, language, replay_command)
     values ($1, $2, $3, 'reproduced', $4, 'polluter', '{tests/test_db.py::test_seed}', array['tests/test_db.py::test_seed', $3], 1, 7, $5,
       '{"type": "AssertionError", "phase": "call", "message": "expected 3 rows, found 4", "location": "tests/test_orders.py:42"}'::jsonb,
       'tests/test_db.py::test_seed', $6, $6, $7, $7, 2, '0.9.1', 'python', $8) returning id`,
    [shop, workspaceId, testId, state, key32(), at(daysAgo), failed, state === "open" ? "pytest --det --det-seed=7 --det-order=<bundle>/order.txt -n 0" : null]))[0]!.id as string;
  const open = await defect("open", "tests/test_orders.py::test_count", 3);
  const fixed = await defect("fixed", "tests/test_orders.py::test_sum", 20);

  await q(`insert into public.ci_test_results (run_id, workspace_id, test_id, outcome, duration_ms, failure_kind, failure_phase, exception_type, failure_message, failure_location, defect_id, receipt_id)
           values ($1, $2, 'tests/test_cart.py::test_total', 'passed', 300, null, null, null, null, null, null, null),
                  ($1, $2, 'tests/test_orders.py::test_count', 'failed', 900, 'flaky_defect', 'call', 'AssertionError', 'expected 3 rows, found 4', 'tests/test_orders.py:42', $3, null),
                  ($1, $2, 'tests/test_cart.py::test_empty', 'skipped_with_proof', 0, null, null, null, null, null, null, $4)`,
    [latest, workspaceId, open, receipt]);

  for (const [runId, outcome, untrusted, daysAgo] of [[reused, "confirmed", false, 9], [latest, "confirmed", false, 1], [latest, "wrong_skip", true, 1]] as const) {
    await q(`insert into public.ci_audit_reruns (workspace_id, run_id, test_id, cache_key, outcome, untrusted, detail, at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [workspaceId, runId, `tests/test_audit.py::test_${outcome}_${daysAgo}`, key32(), outcome, untrusted, untrusted ? "Failed when rerun: the key is no longer trusted." : "", at(daysAgo)]);
  }

  const exploration = (await q(
    `insert into public.ci_explorations (project_id, workspace_id, started_at, finished_at, commit_sha, branch, seeds, runs, collected, seconds,
       flaky_failing, always_failing, not_reproduced, new_defect_ids, families_by_polluter, seeds_log)
     values ($1, $2, $3, $4, $5, 'main', 20, 20, 200, 1800, '["tests/test_orders.py::test_count"]', '[]', '[]', $6,
       '{"tests/test_db.py::test_seed": ["tests/test_orders.py::test_count"]}', '[{"seed": 1, "seconds": 90, "failing": ["tests/test_orders.py::test_count"]}, {"seed": 2, "seconds": 88, "failing": []}]')
     returning id`, [shop, workspaceId, at(2), at(2, 0.5), sha(), JSON.stringify([open])]))[0]!.id as string;

  // Usage events: billable jobs this month (one of a repository that is no project), one last month, one not billable.
  const event = (projectId: string | null, repositoryId: number, name: string, daysAgo: number, billable: boolean, minutes: [number, number, number]) => q(
    `insert into public.ci_usage_events (installation_id, repository_id, repository_full_name, project_id, github_job_id, github_run_id, billable, reason, plan_id,
       test_minutes_ran, minutes_saved, other_step_minutes, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'team', $9, $10, $11, $12)`,
    [installationId, repositoryId, `${account}/${name}`, projectId, githubId(), githubId(), billable, billable ? "ran on fenvix" : "cancelled before start", ...minutes, at(daysAgo)]);
  await event(shop, repoIds.shop, "shop", 1, true, [2, 8, 1.5]);
  await event(shop, repoIds.shop, "shop", 3, true, [2.5, 7, 1.5]);
  await event(web, repoIds.web, "web", 2, true, [0.5, 1, 1]);
  await event(null, repoIds.loose, "docs", 4, true, [0, 0, 3]);
  await event(shop, repoIds.shop, "shop", 25, true, [3, 6, 1.5]);
  await event(shop, repoIds.shop, "shop", 2, false, [0, 0, 0]);

  return { workspaceId, installationId, repoIds, projects: { shop, web }, runs: { latest, failed, running, reused, shadow, lastMonth }, receipt, defects: { open, fixed }, exploration };
}
