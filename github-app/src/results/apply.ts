import type { Client } from "../db.ts";
import {
  causeOf, causeTestsOf, familyKeyOf, type RunnerAuditRerun, type RunnerDefect, type RunnerExploration, type RunnerReceipt, type RunnerResults,
  type RunnerTestOutcome,
} from "./runner-records.ts";

/**
 * Writes what the runner sent (src/results/runner-records.ts) into the dashboard's tables, as fenvix_github_app in a
 * transaction that names the run's organization (row level security keeps every other organization out):
 * ci_test_results, ci_skip_receipts, ci_defects, ci_audit_reruns, ci_explorations and the run's own columns
 * (engine run id, seed, miss details, mode, shadow-mode and audit totals).
 *
 * Idempotent: every row is an upsert on its natural key, totals are recomputed from what is stored, and a defect's
 * occurrences grow once per run (not once per application). Applying the same chunk twice changes nothing.
 */

/** The run the results belong to (a row of ci_runs that exists). */
export interface RunTarget {
  id: string;
  projectId: string;
  /** The project's language: a defect bundle that does not say its language gets it (ci_defects knows python, node). */
  language: string;
  /** When the run's defects were seen (the run's end, else its start). */
  seenAt: Date;
}

/** The job the chunks came from (gh_run_results' key). */
export interface JobKey { repositoryId: number; runId: number; runAttempt: number; runnerName: string }

export interface StoredChunk { id: number; chunk: number; payload: RunnerResults }

// ---------------------------------------------------------------- pure mappings (tests/unit/apply.test.ts)

export interface TestRow {
  test_id: string; outcome: RunnerTestOutcome["outcome"]; duration_ms: number; failure_kind: "real" | "flaky_defect" | null;
  failure_phase: string | null; exception_type: string | null; failure_message: string | null; failure_location: string | null;
  defect_fingerprint: string | null;
}

/** A per-test outcome as ci_test_results stores it: failure fields only for a failed test (a failed test always has a kind). */
export function testRow(t: RunnerTestOutcome): TestRow {
  const f = t.outcome === "failed" ? (t.failure ?? { kind: "real" as const }) : null;
  return {
    test_id: t.testId, outcome: t.outcome, duration_ms: t.durationMs,
    failure_kind: f?.kind ?? null, failure_phase: f ? (f.phase ?? "call") : null, exception_type: f?.exceptionType ?? null,
    failure_message: f?.message ?? null, failure_location: f?.location ?? null,
    defect_fingerprint: f?.kind === "flaky_defect" ? (f.defectFingerprint ?? null) : null,
  };
}

export interface DefectRow {
  test_id: string; status: string; cause: string; cause_tests: string[]; minimal_order: string[]; prefix_length: number; seed: number | null;
  fingerprint: string; replay_runs: number; replay_fails: number; identical_fingerprint: boolean; outcome: string;
  exception: { type: string; phase: string; message: string; location: string }; divergence: RunnerDefect["divergence"] | null;
  family_key: string; engine_version: string; language: "python" | "node"; replay_command: string | null;
}

/** A defect bundle as ci_defects stores it. */
export function defectRow(d: RunnerDefect, projectLanguage: string): DefectRow {
  const causeTests = causeTestsOf(d);
  return {
    test_id: d.testId, status: d.status, cause: causeOf(d.kind), cause_tests: causeTests, minimal_order: d.order,
    prefix_length: d.prefixLength ?? 0, seed: d.seed ?? null, fingerprint: d.fingerprint,
    replay_runs: d.replay.runs, replay_fails: d.replay.fails, identical_fingerprint: d.replay.identicalFingerprint,
    outcome: d.outcome ?? "failed", exception: d.exception, divergence: d.divergence ?? null, family_key: familyKeyOf(causeTests),
    engine_version: d.engineVersion ?? "", language: d.language ?? (projectLanguage === "node" ? "node" : "python"),
    replay_command: d.replayCommand ?? null,
  };
}

export function receiptRow(r: RunnerReceipt) {
  return {
    test_id: r.testId, cache_key: r.cacheKey, reused_engine_run_id: r.reusedEngineRunId, fingerprint: r.fingerprint,
    reused_duration_ms: r.reusedDurationMs, code: r.code ?? [], modules: r.modules ?? [], files_read: r.filesRead ?? [], env_read: r.envRead ?? [],
    runtime: r.runtime ?? {}, config: r.config ?? {}, changed_files_proven: r.changedFilesProven ?? 0,
  };
}

export function auditRow(a: RunnerAuditRerun) {
  return { test_id: a.testId, cache_key: a.cacheKey, outcome: a.outcome, untrusted: a.untrusted ?? false, detail: a.detail ?? "" };
}

/** The last of several items with the same key (a chunk sent again after another, a test listed twice). */
function lastBy<T>(items: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of items) { const k = key(x); m.delete(k); m.set(k, x); }
  return [...m.values()];
}

// ---------------------------------------------------------------- defects

/**
 * Upserts defect bundles by (project, test, fingerprint). For a run (`runId`): occurrences + 1 the first time the
 * run brings the defect (not when the same run's results are applied again), last seen / last run move forward only.
 * For an exploration (`runId` null) occurrences do not change: an exploration is not a run.
 * Returns the defects with whether each was inserted now.
 */
export async function upsertDefects(c: Client, projectId: string, defects: DefectRow[], o: { runId: string | null; seenAt: Date }): Promise<{ id: string; test_id: string; fingerprint: string; inserted: boolean }[]> {
  const rows = lastBy(defects, (d) => `${d.test_id}\u0000${d.fingerprint}`);
  if (!rows.length) return [];
  const r = await c.query<{ id: string; test_id: string; fingerprint: string; inserted: boolean }>(
    `insert into ci_defects as d (workspace_id, project_id, test_id, status, cause, cause_tests, minimal_order, prefix_length, seed, fingerprint,
       replay_runs, replay_fails, identical_fingerprint, outcome, exception, divergence, family_key, first_seen_at, last_seen_at, first_run_id,
       last_run_id, occurrences, engine_version, language, replay_command)
     select public.cp_workspace(), $1, x.test_id, x.status, x.cause, x.cause_tests, x.minimal_order, x.prefix_length, x.seed, x.fingerprint,
       x.replay_runs, x.replay_fails, x.identical_fingerprint, x.outcome, x.exception, x.divergence, x.family_key, $3, $3, $2::uuid,
       $2::uuid, 1, x.engine_version, x.language, x.replay_command
     from jsonb_to_recordset($4::jsonb) as x(test_id text, status text, cause text, cause_tests text[], minimal_order text[], prefix_length int,
       seed bigint, fingerprint text, replay_runs int, replay_fails int, identical_fingerprint boolean, outcome text, exception jsonb,
       divergence jsonb, family_key text, engine_version text, language text, replay_command text)
     on conflict (project_id, test_id, fingerprint) do update set
       status = excluded.status, cause = excluded.cause, cause_tests = excluded.cause_tests, minimal_order = excluded.minimal_order,
       prefix_length = excluded.prefix_length, seed = excluded.seed, replay_runs = excluded.replay_runs, replay_fails = excluded.replay_fails,
       identical_fingerprint = excluded.identical_fingerprint, outcome = excluded.outcome, exception = excluded.exception,
       divergence = excluded.divergence, family_key = excluded.family_key,
       engine_version = case when excluded.engine_version <> '' then excluded.engine_version else d.engine_version end,
       replay_command = coalesce(excluded.replay_command, d.replay_command),
       -- seen again: open again (a fix that did not hold)
       state = case when $2::uuid is not null and d.last_run_id is distinct from $2::uuid then 'open' else d.state end,
       occurrences = case
         when $2::uuid is null then d.occurrences
         when d.first_run_id = $2::uuid or d.last_run_id = $2::uuid
           or exists (select 1 from ci_test_results t where t.run_id = $2::uuid and t.defect_id = d.id) then d.occurrences
         else d.occurrences + 1 end,
       first_run_id = coalesce(d.first_run_id, excluded.first_run_id),
       first_seen_at = least(d.first_seen_at, excluded.first_seen_at),
       last_run_id = case when $2::uuid is not null and excluded.last_seen_at >= d.last_seen_at then excluded.last_run_id else d.last_run_id end,
       last_seen_at = greatest(d.last_seen_at, excluded.last_seen_at)
     returning d.id, d.test_id, d.fingerprint, (d.xmax = 0) as inserted`,
    [projectId, o.runId, o.seenAt, JSON.stringify(rows)]);
  return r.rows;
}

// ---------------------------------------------------------------- results chunks of a run

export interface ApplyOutcome {
  /** gh_run_results ids fully applied. */
  applied: number[];
  /** gh_run_results ids left for later (with why): e.g. a test skipped with proof whose receipt has not come yet. */
  pending: { id: number; error: string }[];
}

/**
 * Applies chunks of one job to its run. Receipts and defects of every chunk first, then the per-test outcomes (which
 * point at them), then the audit reruns; then the run's totals are recomputed from everything stored for the job.
 */
export async function applyChunks(c: Client, run: RunTarget, job: JobKey, chunks: StoredChunk[]): Promise<ApplyOutcome> {
  const sorted = [...chunks].sort((a, b) => a.chunk - b.chunk || a.id - b.id);
  const all = <T>(k: "tests" | "receipts" | "defects" | "audit") => sorted.flatMap((ch) => (ch.payload[k] ?? []) as T[]);

  // The run's own values: the first chunk that carries each.
  const first = <K extends keyof RunnerResults>(k: K): RunnerResults[K] | undefined => sorted.find((ch) => ch.payload[k] !== undefined)?.payload[k];
  const engineRunId = first("engineRunId");
  const seed = first("seed");
  const mode = first("mode");
  const missDetails = first("missDetails");
  await c.query(
    `update ci_runs set engine_run_id = coalesce($2, engine_run_id), seed = case when $3::boolean then $4::bigint else seed end,
       mode = coalesce($5, mode), miss_details = coalesce($6::jsonb, miss_details)
     where id = $1`,
    [run.id, engineRunId ?? null, seed !== undefined, seed ?? null, mode ?? null, missDetails ? JSON.stringify(missDetails) : null]);

  // Defects (the per-test outcomes point at them by fingerprint).
  await upsertDefects(c, run.projectId, all<RunnerDefect>("defects").map((d) => defectRow(d, run.language)), { runId: run.id, seenAt: run.seenAt });

  // Receipts. reused_run_id: the project's run whose engine run id is the one the receipt reuses.
  const receipts = lastBy(all<RunnerReceipt>("receipts").map(receiptRow), (r) => r.test_id);
  if (receipts.length) {
    await c.query(
      `insert into ci_skip_receipts (workspace_id, run_id, test_id, cache_key, reused_run_id, reused_engine_run_id, fingerprint, reused_duration_ms,
         code, modules, files_read, env_read, runtime, config, changed_files_proven)
       select public.cp_workspace(), $1, x.test_id, x.cache_key,
         (select r.id from ci_runs r where r.project_id = $2 and r.engine_run_id = x.reused_engine_run_id and r.id <> $1 order by r.number desc limit 1),
         x.reused_engine_run_id, x.fingerprint, x.reused_duration_ms, x.code, x.modules, x.files_read, x.env_read, x.runtime, x.config, x.changed_files_proven
       from jsonb_to_recordset($3::jsonb) as x(test_id text, cache_key text, reused_engine_run_id text, fingerprint text, reused_duration_ms bigint,
         code jsonb, modules jsonb, files_read jsonb, env_read jsonb, runtime jsonb, config jsonb, changed_files_proven int)
       on conflict (run_id, test_id) do update set cache_key = excluded.cache_key, reused_run_id = excluded.reused_run_id,
         reused_engine_run_id = excluded.reused_engine_run_id, fingerprint = excluded.fingerprint, reused_duration_ms = excluded.reused_duration_ms,
         code = excluded.code, modules = excluded.modules, files_read = excluded.files_read, env_read = excluded.env_read,
         runtime = excluded.runtime, config = excluded.config, changed_files_proven = excluded.changed_files_proven`,
      [run.id, run.projectId, JSON.stringify(receipts)]);
  }

  // Per-test outcomes. A test skipped with proof needs its receipt (ci_test_results' check): one whose receipt has not
  // come yet is left out, and its chunk is applied again when more chunks arrive.
  const tests = lastBy(all<RunnerTestOutcome>("tests").map(testRow), (t) => t.test_id);
  const skipped = tests.filter((t) => t.outcome === "skipped_with_proof").map((t) => t.test_id);
  const withReceipt = new Set(skipped.length
    ? (await c.query<{ test_id: string }>("select test_id from ci_skip_receipts where run_id = $1 and test_id = any($2::text[])", [run.id, skipped])).rows.map((r) => r.test_id)
    : []);
  const ready = tests.filter((t) => t.outcome !== "skipped_with_proof" || withReceipt.has(t.test_id));
  if (ready.length) {
    await c.query(
      `insert into ci_test_results (run_id, workspace_id, test_id, outcome, duration_ms, failure_kind, failure_phase, exception_type, failure_message,
         failure_location, defect_id, receipt_id)
       select $1, public.cp_workspace(), x.test_id, x.outcome, x.duration_ms, x.failure_kind, x.failure_phase, x.exception_type, x.failure_message,
         x.failure_location,
         case when x.failure_kind = 'flaky_defect' then (
           select d.id from ci_defects d where d.project_id = $2 and d.test_id = x.test_id
             and (d.fingerprint = x.defect_fingerprint or (x.defect_fingerprint is null and d.last_run_id = $1))
           order by d.last_seen_at desc limit 1) end,
         case when x.outcome = 'skipped_with_proof' then (select r.id from ci_skip_receipts r where r.run_id = $1 and r.test_id = x.test_id) end
       from jsonb_to_recordset($3::jsonb) as x(test_id text, outcome text, duration_ms bigint, failure_kind text, failure_phase text, exception_type text,
         failure_message text, failure_location text, defect_fingerprint text)
       on conflict (run_id, test_id) do update set outcome = excluded.outcome, duration_ms = excluded.duration_ms, failure_kind = excluded.failure_kind,
         failure_phase = excluded.failure_phase, exception_type = excluded.exception_type, failure_message = excluded.failure_message,
         failure_location = excluded.failure_location, defect_id = coalesce(excluded.defect_id, ci_test_results.defect_id),
         receipt_id = excluded.receipt_id`,
      [run.id, run.projectId, JSON.stringify(ready)]);
  }
  // A flaky failure whose bundle came in a later chunk: linked now.
  await c.query(
    `update ci_test_results t set defect_id = d.id from ci_defects d
     where t.run_id = $1 and t.defect_id is null and t.failure_kind = 'flaky_defect' and d.project_id = $2 and d.test_id = t.test_id and d.last_run_id = $1`,
    [run.id, run.projectId]);

  // Audit reruns.
  const audits = lastBy(all<RunnerAuditRerun>("audit").map(auditRow), (a) => a.test_id);
  if (audits.length) {
    await c.query(
      `insert into ci_audit_reruns (workspace_id, run_id, test_id, cache_key, outcome, untrusted, detail)
       select public.cp_workspace(), $1, x.test_id, x.cache_key, x.outcome, x.untrusted, x.detail
       from jsonb_to_recordset($2::jsonb) as x(test_id text, cache_key text, outcome text, untrusted boolean, detail text)
       on conflict (run_id, test_id) do update set cache_key = excluded.cache_key, outcome = excluded.outcome, untrusted = excluded.untrusted,
         detail = excluded.detail`,
      [run.id, JSON.stringify(audits)]);
  }

  // Totals, from everything stored: audit reruns of the run; shadow mode's "would have skipped" from every chunk of the job.
  await c.query(
    `update ci_runs set
       audit_rerun = (select count(*) from ci_audit_reruns a where a.run_id = $1),
       audit_wrong_skips = (select count(*) from ci_audit_reruns a where a.run_id = $1 and a.outcome = 'wrong_skip'),
       (would_skip_tests, would_save_ms) = (
         select count(*), coalesce(sum(greatest(0, (t->>'durationMs')::bigint)), 0)
         from (select distinct on (t->>'testId') t
               from gh_run_results g
               cross join lateral jsonb_array_elements(case when jsonb_typeof(g.payload->'tests') = 'array' then g.payload->'tests' else '[]'::jsonb end) t
               where g.repository_id = $2 and g.run_id = $3 and g.run_attempt = $4 and g.runner_name = $5) w
         where (w.t->>'wouldSkip')::boolean is true)
     where id = $1`,
    [run.id, job.repositoryId, job.runId, job.runAttempt, job.runnerName]);

  // Which chunks are done.
  const waiting = new Set(skipped.filter((id) => !withReceipt.has(id)));
  const out: ApplyOutcome = { applied: [], pending: [] };
  for (const ch of sorted) {
    const missing = (ch.payload.tests ?? []).filter((t) => t.outcome === "skipped_with_proof" && waiting.has(t.testId)).length;
    if (missing) out.pending.push({ id: ch.id, error: `${missing} test${missing === 1 ? "" : "s"} skipped with proof without a receipt yet` });
    else out.applied.push(ch.id);
  }
  return out;
}

// ---------------------------------------------------------------- explorations

/**
 * One night of exploration: its defects upserted (not counted as occurrences: no run), then the exploration row,
 * once per (project, start, commit) (sent again: updated). new_defect_ids: the defects this exploration inserted.
 */
export async function applyExploration(c: Client, projectId: string, language: string, e: RunnerExploration): Promise<{ id: string; newDefectIds: string[] }> {
  const defects = await upsertDefects(c, projectId, (e.defects ?? []).map((d) => defectRow(d, language)), { runId: null, seenAt: new Date(e.finishedAt) });
  const newIds = defects.filter((d) => d.inserted).map((d) => d.id);
  const values = [projectId, e.startedAt, e.finishedAt, e.commitSha, e.branch, e.seeds, e.runs, e.collected, e.seconds,
    JSON.stringify(e.flakyFailing ?? []), JSON.stringify(e.alwaysFailing ?? []), JSON.stringify(e.notReproduced ?? []),
    JSON.stringify(e.familiesByPolluter ?? {}), JSON.stringify(e.seedsLog ?? [])];
  const existing = (await c.query<{ id: string; new_defect_ids: string[] }>(
    "select id, new_defect_ids from ci_explorations where project_id = $1 and started_at = $2 and commit_sha = $3 order by id limit 1 for update",
    [projectId, e.startedAt, e.commitSha])).rows[0];
  if (existing) {
    const ids = [...new Set([...(existing.new_defect_ids ?? []), ...newIds])];
    await c.query(
      `update ci_explorations set finished_at = $3, branch = $5, seeds = $6, runs = $7, collected = $8, seconds = $9, flaky_failing = $10,
         always_failing = $11, not_reproduced = $12, families_by_polluter = $13, seeds_log = $14, new_defect_ids = $15
       where id = $16 and project_id = $1 and started_at = $2 and commit_sha = $4`,
      [...values, JSON.stringify(ids), existing.id]);
    return { id: existing.id, newDefectIds: ids };
  }
  const r = await c.query<{ id: string }>(
    `insert into ci_explorations (workspace_id, project_id, started_at, finished_at, commit_sha, branch, seeds, runs, collected, seconds, flaky_failing,
       always_failing, not_reproduced, families_by_polluter, seeds_log, new_defect_ids)
     values (public.cp_workspace(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
    [...values, JSON.stringify(newIds)]);
  return { id: r.rows[0]!.id, newDefectIds: newIds };
}
