/*
 * Postgres rows (supabase/migrations/0011_ci_runs.sql, snake_case) to the contract's records (camelCase). Pure, so
 * tests/unit/ci.test.ts covers it without a database.
 */
import type { Defect, GitHubRate, Plan, Project, Run, SkipReceipt, TestResult, TestRunner } from "./types";
import { familyKeyOf } from "./ci";

export type Row = Record<string, unknown>;

const str = (v: unknown, d = "") => (typeof v === "string" ? v : v === null || v === undefined ? d : String(v));
const num = (v: unknown, d = 0) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

export function mapPlan(r: Row, currentId: string | null): Plan {
  return {
    id: str(r.id), name: str(r.name), description: str(r.description),
    runsPerMonth: numOrNull(r.runs_per_month), maxProjects: numOrNull(r.max_projects), priceUsdMonth: numOrNull(r.price_usd_month),
    features: arr<string>(r.features), current: str(r.id) === currentId,
  };
}

export function mapRate(r: Row | null | undefined): GitHubRate {
  return { usdPerMinute: num(r?.usd_per_minute, 0.008), runner: str(r?.runner, "GitHub-hosted Linux, 2 cores"), source: str(r?.source, "not set"), checkedOn: str(r?.checked_on) };
}

export function mapProject(r: Row): Project {
  const ttg = numOrNull(r.baseline_median_ttg_s);
  return {
    id: str(r.id), fullName: str(r.full_name), language: str(r.language) as Project["language"], testRunner: str(r.test_runner) as TestRunner,
    defaultBranch: str(r.default_branch, "main"), installationId: num(r.installation_id), setupState: str(r.setup_state, "app_installed") as Project["setupState"],
    setupPullRequest: r.setup_pr_number ? { number: num(r.setup_pr_number), url: str(r.setup_pr_url), state: (str(r.setup_pr_state, "open") as "open" | "merged" | "closed") } : null,
    connectedAt: str(r.connected_at),
    baseline: ttg === null ? null : { medianTimeToGreenS: ttg, medianJobMinutes: num(r.baseline_median_job_minutes), runsSampled: num(r.baseline_runs_sampled), from: str(r.baseline_from), to: str(r.baseline_to) },
    settings: { skipWithProof: r.skip_with_proof !== false, commentOnPullRequests: r.comment_on_pull_requests !== false, nightlyExploration: r.nightly_exploration === true, testCommand: str(r.test_command) },
  };
}

export function mapRun(r: Row): Run {
  return {
    id: str(r.id), projectId: str(r.project_id), number: num(r.number), engineRunId: r.engine_run_id ? str(r.engine_run_id) : null,
    commitSha: str(r.commit_sha), commitMessage: str(r.commit_message), branch: str(r.branch), pullRequest: numOrNull(r.pull_request),
    trigger: str(r.trigger) as Run["trigger"], status: str(r.status) as Run["status"],
    pushedAt: str(r.pushed_at), startedAt: str(r.started_at), finishedAt: r.finished_at ? str(r.finished_at) : null, durationMs: num(r.duration_ms),
    tests: { total: num(r.tests_total), ran: num(r.tests_ran), passed: num(r.tests_passed), failed: num(r.tests_failed), skippedWithProof: num(r.tests_skipped), flakyDefects: num(r.tests_flaky_defects) },
    testTimeMs: { ran: num(r.test_time_ran_ms), skipped: num(r.test_time_skipped_ms) },
    skipShare: num(r.skip_share), minutesSaved: num(r.minutes_saved), githubEquivalentMinutes: num(r.github_equivalent_minutes),
    engineVersion: str(r.engine_version), seed: numOrNull(r.seed),
  };
}

/** The file of a test id: before "::" (pytest) or " > " (Vitest, Jest). */
export const fileOfTest = (testId: string) => testId.split(/::| > /)[0];

export function mapTestResult(r: Row): TestResult {
  const kind = r.failure_kind === "real" || r.failure_kind === "flaky_defect" ? r.failure_kind : null;
  return {
    runId: str(r.run_id), testId: str(r.test_id), file: fileOfTest(str(r.test_id)), outcome: str(r.outcome) as TestResult["outcome"], durationMs: num(r.duration_ms),
    failure: kind ? { kind, phase: str(r.failure_phase, "call"), exceptionType: str(r.exception_type), message: str(r.failure_message), location: str(r.failure_location), defectId: r.defect_id ? str(r.defect_id) : null } : null,
    receiptId: r.receipt_id ? str(r.receipt_id) : null,
  };
}

export function mapDefect(r: Row, project: { fullName: string; testRunner: TestRunner } | undefined): Defect {
  const ex = obj(r.exception);
  const dv = r.divergence ? obj(r.divergence) : null;
  const causeTests = arr<string>(r.cause_tests);
  return {
    id: str(r.id), projectId: str(r.project_id), projectName: project?.fullName ?? "", testId: str(r.test_id),
    status: str(r.status) === "replay_unstable" ? "replay_unstable" : "reproduced", state: str(r.state) === "fixed" ? "fixed" : "open",
    cause: str(r.cause) as Defect["cause"], causeTests, minimalOrder: arr<string>(r.minimal_order), prefixLength: num(r.prefix_length), seed: numOrNull(r.seed),
    fingerprint: str(r.fingerprint), replays: { runs: num(r.replay_runs, 10), fails: num(r.replay_fails, 10), identicalFingerprint: r.identical_fingerprint !== false },
    outcome: str(r.outcome, "failed"), exception: { type: str(ex.type), phase: str(ex.phase, "call"), message: str(ex.message), location: str(ex.location) },
    divergence: dv ? { index: num(dv.index), reason: str(dv.reason), description: str(dv.description) } : null,
    familyKey: str(r.family_key) || familyKeyOf(causeTests), firstSeenAt: str(r.first_seen_at), lastSeenAt: str(r.last_seen_at),
    firstRunId: r.first_run_id ? str(r.first_run_id) : null, lastRunId: r.last_run_id ? str(r.last_run_id) : null, occurrences: num(r.occurrences, 1),
    engineVersion: str(r.engine_version), language: str(r.language) === "node" ? "node" : "python", testRunner: project?.testRunner ?? "pytest",
  };
}

export function mapReceipt(r: Row, reusedRunNumber: number | null): SkipReceipt {
  const rt = obj(r.runtime);
  const cf = obj(r.config);
  return {
    id: str(r.id), runId: str(r.run_id), testId: str(r.test_id), cacheKey: str(r.cache_key), reusedRunId: r.reused_run_id ? str(r.reused_run_id) : null,
    reusedEngineRunId: str(r.reused_engine_run_id), reusedRunNumber, reusedOutcome: "passed", fingerprint: str(r.fingerprint), reusedDurationMs: num(r.reused_duration_ms),
    code: arr(r.code), modules: arr(r.modules), filesRead: arr(r.files_read), envRead: arr(r.env_read),
    runtime: { digest: str(rt.digest), interpreter: str(rt.interpreter), system: str(rt.system), machine: str(rt.machine), libc: str(rt.libc), distributions: num(rt.distributions) },
    config: { digest: str(cf.digest), runner: str(cf.runner), engine: str(cf.engine), inifile: str(cf.inifile), options: str(cf.options) },
    changedFilesProven: num(r.changed_files_proven),
  };
}

/** What a person should read when a call fails, instead of a database error. */
export function friendlyError(err: { message?: string; code?: string; status?: number } | null | undefined): string {
  const message = (err?.message ?? "").trim();
  const code = err?.code ?? "";
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return "Could not reach the server. Check your connection and try again.";
  if (/jwt expired|invalid jwt|not authenticated|no api key/i.test(message) || err?.status === 401) return "Your session has ended. Sign in again.";
  if (code === "42501" || /permission denied|row-level security/i.test(message)) return "Your role in this organization is read only. Ask an owner or admin to do this.";
  if (code === "57014" || /statement timeout/i.test(message)) return "That took too long. Try again.";
  if (!message) return "Something went wrong. Try again.";
  return message;
}
