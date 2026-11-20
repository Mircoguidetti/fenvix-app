import type { Client } from "../db.ts";
import {
  causeOf, causeTestsOf, familyKeyOf, type RunnerAuditRerun, type RunnerDefect, type RunnerExploration, type RunnerReceipt, type RunnerResults,
  type RunnerTestOutcome,
} from "./runner-records.ts";

/**
 * Writes what the runner sent (src/results/runner-records.ts) into the dashboard's tables, as fenvix_github_app in a
 * transaction that names the run's organization (row level security keeps every other organization out):
 * ci_test_results, ci_skip_receipts, ci_defects, ci_audit_reruns, ci_explorations and the run's own columns
 * (engine run id, seed, miss details, shadow-mode and audit totals). Not the run's mode: the App decides it when the
 * job starts (review R-016 F4); a `mode` in the results is ignored.
 *
 * Bounds (review R-016 F4): a test's duration is at most the job's own duration (GitHub's timings), and the run's
 * would-have-saved time is at most its own test time (run + skipped), so a share computed from it stays within 0 to 1.
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
  /** The job's duration in ms (GitHub's timings), once finished: no test lasts longer. Null or 0: no bound known. */
  maxTestMs?: number | null;
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
  fingerprint: string | null; replay_runs: number; replay_fails: number; identical_fingerprint: boolean; outcome: string;
  exception: { type: string; phase: string; message: string; location: string }; divergence: RunnerDefect["divergence"] | null;
  family_key: string; engine_version: string; language: "python" | "node"; replay_command: string | null;
}

/**
 * A defect bundle as ci_defects stores it. A bundle that does not say its language gets the project's; a project in a
 * language fenvix does not run (anything but Python and Node) never has its defects labelled Python (G-0194): they are
 * left out (null) and the caller logs them.
 */
export function defectRowOrNull(d: RunnerDefect, projectLanguage: string): DefectRow | null {
  const language = d.language ?? (projectLanguage === "node" ? "node" : projectLanguage === "python" ? "python" : null);
  return language ? defectRow({ ...d, language }, projectLanguage) : null;
}

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

/** Where a defect was seen: a run (its commit, branch and pull request come from the run row) or an exploration. */
export type Sighting = { runId: string; seenAt: Date } | { explorationId: string; seenAt: Date };

/**
 * Upserts defects by (project, test): ONE defect per flaky test of a project, whatever its fingerprint, the engine
 * version or the order (G-1701, G-1808). The newest bundle's facts replace the older ones; a bundle never gives way to
 * a bare report from the summary (status 'reported'). Every sighting is a row of ci_defect_occurrences (one per run, one
 * per exploration) with the fingerprint and the divergent event of that time, and whether the fingerprint changed
 * since the defect's previous sighting (the service compares them, G-1749). `occurrences` is the number of runs that
 * saw it (an exploration is not a run). Seen again in a new run: a fixed defect opens again (a fix that did not hold);
 * a muted one stays muted. Returns the defects with whether each was inserted now.
 */
const KEEP = "(excluded.status = 'reported' and d.status <> 'reported') or excluded.last_seen_at < d.last_seen_at";
const KEEP_SET = ["status", "cause", "cause_tests", "minimal_order", "prefix_length", "seed", "fingerprint", "replay_runs", "replay_fails",
  "identical_fingerprint", "outcome", "exception", "divergence", "family_key"].map((k) => `${k} = case when ${KEEP} then d.${k} else excluded.${k} end`).join(", ") + ",";

export async function upsertDefects(c: Client, projectId: string, defects: DefectRow[], o: Sighting): Promise<{ id: string; test_id: string; fingerprint: string | null; inserted: boolean }[]> {
  const rows = lastBy(defects, (d) => d.test_id);
  if (!rows.length) return [];
  const runId = "runId" in o ? o.runId : null;
  const explorationId = "explorationId" in o ? o.explorationId : null;
  const r = await c.query<{ id: string; test_id: string; fingerprint: string | null; inserted: boolean }>(
    `insert into ci_defects as d (workspace_id, project_id, test_id, status, cause, cause_tests, minimal_order, prefix_length, seed, fingerprint,
       replay_runs, replay_fails, identical_fingerprint, outcome, exception, divergence, family_key, first_seen_at, last_seen_at, first_run_id,
       last_run_id, occurrences, engine_version, language, replay_command)
     select public.cp_workspace(), $1, x.test_id, x.status, x.cause, x.cause_tests, x.minimal_order, x.prefix_length, x.seed, x.fingerprint,
       x.replay_runs, x.replay_fails, x.identical_fingerprint, x.outcome, x.exception, x.divergence, x.family_key, $3, $3, $2::uuid,
       $2::uuid, 0, x.engine_version, x.language, x.replay_command
     from jsonb_to_recordset($4::jsonb) as x(test_id text, status text, cause text, cause_tests text[], minimal_order text[], prefix_length int,
       seed bigint, fingerprint text, replay_runs int, replay_fails int, identical_fingerprint boolean, outcome text, exception jsonb,
       divergence jsonb, family_key text, engine_version text, language text, replay_command text)
     on conflict (project_id, test_id) do update set
       -- A bundle's facts win over a bare report; among bundles (or among reports), the newest wins.
       ${KEEP_SET}
       engine_version = case when excluded.engine_version <> '' and excluded.last_seen_at >= d.last_seen_at then excluded.engine_version else d.engine_version end,
       replay_command = case when excluded.status = 'reported' and d.status <> 'reported' then d.replay_command
                             else coalesce(excluded.replay_command, d.replay_command) end,
       -- seen again in another run: open again (a fix that did not hold); muted stays muted
       state = case when $2::uuid is not null and d.state = 'fixed' and d.last_run_id is distinct from $2::uuid then 'open' else d.state end,
       state_reason = case when $2::uuid is not null and d.state = 'fixed' and d.last_run_id is distinct from $2::uuid
                           then 'seen again after it was fixed' else d.state_reason end,
       first_run_id = coalesce(d.first_run_id, excluded.first_run_id),
       first_seen_at = least(d.first_seen_at, excluded.first_seen_at),
       last_run_id = case when $2::uuid is not null and excluded.last_seen_at >= d.last_seen_at then excluded.last_run_id else d.last_run_id end,
       last_seen_at = greatest(d.last_seen_at, excluded.last_seen_at)
     returning d.id, d.test_id, d.fingerprint, (d.xmax = 0) as inserted`,
    [projectId, runId, o.seenAt, JSON.stringify(rows)]);
  // The sightings, then the counts.
  const byTest = new Map(rows.map((x) => [x.test_id, x]));
  const sightings = r.rows.map((d) => {
    const x = byTest.get(d.test_id)!;
    return { defect_id: d.id, fingerprint: x.fingerprint, divergence: x.divergence, seed: x.seed, engine_version: x.engine_version, status: x.status };
  });
  await c.query(
    `insert into ci_defect_occurrences as o (workspace_id, defect_id, run_id, exploration_id, source, commit_sha, branch, pull_request, fingerprint,
       fingerprint_changed, divergence, seed, engine_version, status, seen_at)
     select public.cp_workspace(), x.defect_id, $1::uuid, $2::uuid, case when $1::uuid is not null then 'run' else 'exploration' end,
       coalesce(r.commit_sha, e.commit_sha), coalesce(r.branch, e.branch), r.pull_request, x.fingerprint,
       coalesce(x.fingerprint is not null and x.fingerprint is distinct from (
         select p.fingerprint from ci_defect_occurrences p where p.defect_id = x.defect_id and p.fingerprint is not null
           and p.seen_at <= $3 and not (p.run_id is not distinct from $1::uuid and p.exploration_id is not distinct from $2::uuid)
         order by p.seen_at desc, p.id desc limit 1)
         and exists (select 1 from ci_defect_occurrences p where p.defect_id = x.defect_id and p.fingerprint is not null
           and not (p.run_id is not distinct from $1::uuid and p.exploration_id is not distinct from $2::uuid)), false),
       x.divergence, x.seed, coalesce(x.engine_version, ''), x.status, $3
     from jsonb_to_recordset($4::jsonb) as x(defect_id uuid, fingerprint text, divergence jsonb, seed bigint, engine_version text, status text)
     left join ci_runs r on r.id = $1::uuid
     left join ci_explorations e on e.id = $2::uuid
     on conflict ${runId ? "(defect_id, run_id) where run_id is not null" : "(defect_id, exploration_id) where exploration_id is not null"} do update set
       fingerprint = coalesce(excluded.fingerprint, o.fingerprint), divergence = coalesce(excluded.divergence, o.divergence),
       seed = coalesce(excluded.seed, o.seed), engine_version = case when excluded.engine_version <> '' then excluded.engine_version else o.engine_version end,
       status = case when excluded.status = 'reported' then o.status else excluded.status end,
       fingerprint_changed = o.fingerprint_changed or excluded.fingerprint_changed`,
    [runId, explorationId, o.seenAt, JSON.stringify(sightings)]);
  await c.query(
    `update ci_defects d set occurrences = (select count(*) from ci_defect_occurrences o where o.defect_id = d.id and o.source = 'run')
     where d.id = any($1::uuid[])`, [r.rows.map((x) => x.id)]);
  return r.rows;
}

/**
 * The flaky tests the run's summary names (failed in the suite, passed alone) that no bundle of this run covers: each is
 * a defect too, status 'reported', cause 'unknown', with the summary's replay command, so a run never counts a flaky
 * defect the defect list does not show (G-0184). A bundle that arrives later for the same test replaces the report.
 */
export async function recordReportedFlaky(c: Client, run: RunTarget, flaky: { nodeid: string; replay: string }[]): Promise<number> {
  if (!flaky.length) return 0;
  const covered = new Set((await c.query<{ test_id: string }>(
    `select d.test_id from ci_defect_occurrences o join ci_defects d on d.id = o.defect_id
     where o.run_id = $1 and o.status <> 'reported'`, [run.id])).rows.map((x) => x.test_id));
  if (run.language !== "python" && run.language !== "node") return 0;
  const rows: DefectRow[] = lastBy(flaky, (f) => f.nodeid).filter((f) => !covered.has(f.nodeid)).map((f) => ({
    test_id: f.nodeid, status: "reported", cause: "unknown", cause_tests: [], minimal_order: [f.nodeid], prefix_length: 0, seed: null,
    fingerprint: null, replay_runs: 0, replay_fails: 0, identical_fingerprint: false, outcome: "failed",
    exception: { type: "", phase: "call", message: "", location: "" }, divergence: null, family_key: "<none>", engine_version: "",
    language: run.language === "node" ? "node" : "python", replay_command: f.replay.slice(0, 4000),
  }));
  await upsertDefects(c, run.projectId, rows, { runId: run.id, seenAt: run.seenAt });
  await c.query(
    `update ci_test_results t set defect_id = d.id from ci_defects d
     where t.run_id = $1 and t.defect_id is null and t.outcome = 'failed' and d.project_id = $2 and d.test_id = t.test_id`, [run.id, run.projectId]);
  return rows.length;
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
  const missDetails = first("missDetails");
  await c.query(
    `update ci_runs set engine_run_id = coalesce($2, engine_run_id), seed = case when $3::boolean then $4::bigint else seed end,
       miss_details = coalesce($5::jsonb, miss_details)
     where id = $1`,
    [run.id, engineRunId ?? null, seed !== undefined, seed ?? null, missDetails ? JSON.stringify(missDetails) : null]);
  const cap = run.maxTestMs && run.maxTestMs > 0 ? Math.round(run.maxTestMs) : null;

  // Defects (the per-test outcomes point at them by fingerprint).
  await upsertDefects(c, run.projectId, all<RunnerDefect>("defects").flatMap((d) => defectRowOrNull(d, run.language) ?? []), { runId: run.id, seenAt: run.seenAt });

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
  const tests = lastBy(all<RunnerTestOutcome>("tests").map(testRow), (t) => t.test_id)
    .map((t) => (cap !== null && t.duration_ms > cap ? { ...t, duration_ms: cap } : t));
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
           select d.id from ci_defects d where d.project_id = $2 and d.test_id = x.test_id) end,
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
     where t.run_id = $1 and t.defect_id is null and t.failure_kind = 'flaky_defect' and d.project_id = $2 and d.test_id = t.test_id`,
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
    // A wrong skip stops skipping for the project until an owner or admin resumes it (G-1757): the next machines get no
    // shared cache, so every test runs; the project and its runs say why.
    const wrong = audits.filter((a) => a.outcome === "wrong_skip");
    if (wrong.length) {
      await c.query(
        `update ci_projects set skip_paused_at = coalesce(skip_paused_at, now()),
           skip_paused_reason = coalesce(skip_paused_reason, $2) where id = $1`,
        [run.projectId, `An audit rerun found a wrong skip: ${wrong[0]!.test_id} failed although its receipt said it could be skipped. Skipping is paused for this project.`.slice(0, 500)]);
    }
  }

  // Totals, from everything stored: audit reruns of the run; shadow mode's "would have skipped" from every chunk of the
  // job, each test's time at most the job's duration ($6), the sum at most the run's own test time.
  await c.query(
    `update ci_runs set
       audit_rerun = (select count(*) from ci_audit_reruns a where a.run_id = $1),
       audit_wrong_skips = (select count(*) from ci_audit_reruns a where a.run_id = $1 and a.outcome = 'wrong_skip'),
       (would_skip_tests, would_save_ms) = (
         select count(*), least(coalesce(sum(least(greatest(0, (t->>'durationMs')::bigint), coalesce($6::bigint, 9223372036854775807))), 0),
                                greatest(0, ci_runs.test_time_ran_ms + ci_runs.test_time_skipped_ms))
         from (select distinct on (t->>'testId') t
               from gh_run_results g
               cross join lateral jsonb_array_elements(case when jsonb_typeof(g.payload->'tests') = 'array' then g.payload->'tests' else '[]'::jsonb end) t
               where g.repository_id = $2 and g.run_id = $3 and g.run_attempt = $4 and g.runner_name = $5) w
         where (w.t->>'wouldSkip')::boolean is true)
     where id = $1`,
    [run.id, job.repositoryId, job.runId, job.runAttempt, job.runnerName, cap]);

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
export async function applyExploration(c: Client, projectId: string, language: string, e: RunnerExploration, jobId: string | null = null): Promise<{ id: string; newDefectIds: string[] }> {
  const values = [projectId, e.startedAt, e.finishedAt, e.commitSha, e.branch, e.seeds, e.runs, e.collected, e.seconds,
    JSON.stringify(e.flakyFailing ?? []), JSON.stringify(e.alwaysFailing ?? []), JSON.stringify(e.notReproduced ?? []),
    JSON.stringify(e.familiesByPolluter ?? {}), JSON.stringify(e.seedsLog ?? [])];
  const existing = (await c.query<{ id: string; new_defect_ids: string[] }>(
    "select id, new_defect_ids from ci_explorations where project_id = $1 and started_at = $2 and commit_sha = $3 order by id limit 1 for update",
    [projectId, e.startedAt, e.commitSha])).rows[0];
  let id: string;
  let known: string[] = [];
  if (existing) {
    id = existing.id;
    known = existing.new_defect_ids ?? [];
    await c.query(
      `update ci_explorations set finished_at = $3, branch = $5, seeds = $6, runs = $7, collected = $8, seconds = $9, flaky_failing = $10,
         always_failing = $11, not_reproduced = $12, families_by_polluter = $13, seeds_log = $14, job_id = coalesce($16::uuid, job_id)
       where id = $15 and project_id = $1 and started_at = $2 and commit_sha = $4`,
      [...values, id, jobId]);
  } else {
    id = (await c.query<{ id: string }>(
      `insert into ci_explorations (workspace_id, project_id, started_at, finished_at, commit_sha, branch, seeds, runs, collected, seconds, flaky_failing,
         always_failing, not_reproduced, families_by_polluter, seeds_log, new_defect_ids, job_id)
       values (public.cp_workspace(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, '[]'::jsonb, $15) returning id`,
      [...values, jobId])).rows[0]!.id;
  }
  const defects = await upsertDefects(c, projectId, (e.defects ?? []).flatMap((d) => defectRowOrNull(d, language) ?? []), { explorationId: id, seenAt: new Date(e.finishedAt) });
  const ids = [...new Set([...known, ...defects.filter((d) => d.inserted).map((d) => d.id)])];
  await c.query("update ci_explorations set new_defect_ids = $2 where id = $1", [id, JSON.stringify(ids)]);
  return { id, newDefectIds: ids };
}
