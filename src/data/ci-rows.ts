/*
 * Postgres rows (supabase/migrations/0011_ci_runs.sql, snake_case) to the contract's records (camelCase). Pure, so
 * tests/unit/ci.test.ts covers it without a database.
 */
import type { AuditRerun, Exploration, Defect, GitHubRate, GitHubRepository, Installation, OnboardingState, Plan, Project, Run, RunProgress, SkipReceipt, TestResult, TestRunner, WarmCache, WarmupStatus } from "./types";
import { familyKeyOf, type UsageEvent } from "./ci.ts";

export type Row = Record<string, unknown>;

/** Text; a Date (node-postgres gives timestamptz as Date) becomes ISO 8601. */
const str = (v: unknown, d = "") => (typeof v === "string" ? v : v instanceof Date ? v.toISOString() : v === null || v === undefined ? d : String(v));
const num = (v: unknown, d = 0) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : str(v));
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

/** `currentId`: the organization's plan id; an add-on is current when `currentId` is its id too (pass it per add-on). */
export function mapPlan(r: Row, currentId: string | null): Plan {
  return {
    id: str(r.id), name: str(r.name), description: str(r.description), kind: str(r.kind) === "addon" ? "addon" : "plan",
    unitsIncluded: numOrNull(r.units_included), maxProjects: numOrNull(r.max_projects), priceUsdMonth: numOrNull(r.price_usd_month),
    features: arr<string>(r.features), current: str(r.id) === currentId,
  };
}

export function mapRate(r: Row | null | undefined): GitHubRate {
  return { usdPerMinute: num(r?.usd_per_minute, 0.008), runner: str(r?.runner, "GitHub-hosted Linux, 2 cores"), source: str(r?.source, "not set"), checkedOn: str(r?.checked_on) };
}

const WARMUP_STATUSES = new Set<WarmupStatus>(["pending", "dispatched", "running", "succeeded", "failed", "unsupported", "covered", "superseded", "cancelled"]);
const WARMING = new Set<WarmupStatus>(["pending", "dispatched", "running"]);
const SHA40 = /^[0-9a-f]{40}$/;

/**
 * The repository's shared cache (supabase/migrations/0015_warm_cache.sql): gh_repositories.cache_warm_* and its latest
 * warm-up, read by the API as warmup_status, warmup_sha, warmup_detail, warmup_updated_at. Warming while a warm-up is
 * pending or running; else warm once a commit's proofs are in the cache; else cold.
 */
export function mapWarmCache(r: Row): WarmCache {
  const sha = SHA40.test(str(r.cache_warm_sha)) ? str(r.cache_warm_sha) : null;
  const status = str(r.warmup_status) as WarmupStatus;
  const warmup = WARMUP_STATUSES.has(status) && SHA40.test(str(r.warmup_sha))
    ? { status, commitSha: str(r.warmup_sha), detail: str(r.warmup_detail), updatedAt: iso(r.warmup_updated_at) }
    : null;
  const source = str(r.cache_warm_source);
  return {
    state: warmup && WARMING.has(warmup.status) ? "warming" : sha ? "warm" : "cold",
    commitSha: sha, warmAt: sha && r.cache_warm_at ? iso(r.cache_warm_at) : null,
    source: sha && (source === "warmup" || source === "run") ? source : null,
    warmup,
  };
}

/** A ci_projects row; `repository_id` (GitHub's id) when the query joined gh_repositories (and its cache state). */
export function mapProject(r: Row): Project {
  const ttg = numOrNull(r.baseline_median_ttg_s);
  return {
    id: str(r.id), fullName: str(r.full_name), language: str(r.language) as Project["language"], testRunner: str(r.test_runner) as TestRunner,
    defaultBranch: str(r.default_branch, "main"), installationId: num(r.installation_id), repositoryId: numOrNull(r.repository_id), setupState: str(r.setup_state, "app_installed") as Project["setupState"],
    setupPullRequest: r.setup_pr_number ? { number: num(r.setup_pr_number), url: str(r.setup_pr_url), state: (str(r.setup_pr_state, "open") as "open" | "merged" | "closed") } : null,
    connectedAt: str(r.connected_at),
    baseline: ttg === null ? null : { medianTimeToGreenS: ttg, medianJobMinutes: num(r.baseline_median_job_minutes), runsSampled: num(r.baseline_runs_sampled), from: str(r.baseline_from), to: str(r.baseline_to) },
    settings: { skipWithProof: r.skip_with_proof !== false, commentOnPullRequests: r.comment_on_pull_requests !== false, nightlyExploration: r.nightly_exploration === true, testCommand: str(r.test_command) },
    warmCache: mapWarmCache(r),
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
    skipShare: num(r.skip_share), minutesSaved: num(r.minutes_saved), otherStepMinutes: num(r.other_step_minutes), githubEquivalentMinutes: num(r.github_equivalent_minutes),
    engineVersion: str(r.engine_version), seed: numOrNull(r.seed),
    skipMisses: obj(r.skip_misses) as Run["skipMisses"], missDetails: arr(r.miss_details),
    mode: str(r.mode) === "shadow" ? "shadow" : "enforce", wouldSkipTests: num(r.would_skip_tests), wouldSaveMs: num(r.would_save_ms),
    audit: { rerun: num(r.audit_rerun), wrongSkips: num(r.audit_wrong_skips) },
    region: r.region === "us" || r.region === "eu" ? r.region : null,
    progress: str(r.status) === "running" && r.progress ? mapProgress(obj(r.progress), r.progress_at) : null,
  };
}

const PHASES = new Set(["setup", "collecting", "testing", "reporting"]);

/** ci_runs.progress (the runner's latest record, docs/data-contract.md "Run progress"). */
export function mapProgress(p: Row, at: unknown): RunProgress {
  return {
    phase: (PHASES.has(str(p.phase)) ? str(p.phase) : "setup") as RunProgress["phase"],
    testsTotal: numOrNull(p.testsTotal), testsDone: num(p.testsDone), passed: num(p.passed), failed: num(p.failed), skippedWithProof: num(p.skippedWithProof),
    currentTest: typeof p.currentTest === "string" ? p.currentTest : null, elapsedMs: num(p.elapsedMs),
    updatedAt: at instanceof Date ? at.toISOString() : str(at),
  };
}

export function mapExploration(r: Row): Exploration {
  const fam = obj(r.families_by_polluter);
  return {
    id: str(r.id), projectId: str(r.project_id), startedAt: str(r.started_at), finishedAt: str(r.finished_at), commitSha: str(r.commit_sha), branch: str(r.branch),
    seeds: num(r.seeds), runs: num(r.runs), collected: num(r.collected), seconds: num(r.seconds),
    flakyFailing: arr(r.flaky_failing), alwaysFailing: arr(r.always_failing), notReproduced: arr(r.not_reproduced), newDefectIds: arr(r.new_defect_ids),
    familiesByPolluter: Object.entries(fam).map(([key, v]) => ({ key, tests: Array.isArray(v) ? v.length : num(v) })),
    seedsLog: arr<Row>(r.seeds_log).map((x) => ({ seed: num(x.seed), seconds: num(x.seconds), failing: Array.isArray(x.failing) ? x.failing.length : num(x.failing) })),
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
    replayCommand: r.replay_command ? str(r.replay_command) : null,
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

/** ci_audit_reruns, with the number of its run. */
export function mapAuditRerun(r: Row): AuditRerun {
  return {
    runId: str(r.run_id), runNumber: num(r.run_number), testId: str(r.test_id), cacheKey: str(r.cache_key),
    outcome: str(r.outcome) === "wrong_skip" ? "wrong_skip" : "confirmed", untrusted: r.untrusted === true, detail: str(r.detail), at: iso(r.at),
  };
}

/** ci_usage_events. */
export function mapUsageEvent(r: Row): UsageEvent {
  return { projectId: r.project_id ? str(r.project_id) : null, occurredAt: iso(r.occurred_at), billable: r.billable === true, baselineMinutes: num(r.baseline_minutes) };
}

/** gh_installations, with `repositories` counted by the query. */
export function mapInstallation(r: Row): Installation {
  return {
    installationId: num(r.installation_id), account: str(r.account_login), accountType: (["User", "Organization", "Enterprise"].includes(str(r.account_type)) ? str(r.account_type) : "User") as Installation["accountType"],
    status: r.deleted_at ? "deleted" : r.suspended_at ? "suspended" : "active",
    repositorySelection: str(r.repository_selection) === "all" ? "all" : "selected", linkedAt: r.linked_at ? iso(r.linked_at) : null, repositories: num(r.repositories),
  };
}

const ONBOARDING = new Set(["pending", "pr_open", "merged", "closed", "no_workflow", "no_test_job", "already_fenvix", "unsupported", "failed"]);

/** gh_repositories: the 9 onboarding states as they are, the setup pull request when there is one. */
export function mapGitHubRepository(r: Row): GitHubRepository {
  const state = (ONBOARDING.has(str(r.onboarding_state)) ? str(r.onboarding_state) : "pending") as OnboardingState;
  const prState = state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
  const lang = str(r.detected_language);
  const runner = str(r.detected_test_runner);
  return {
    repositoryId: num(r.repository_id), installationId: num(r.installation_id), fullName: str(r.full_name), private: r.private !== false, removed: !!r.removed_at,
    language: lang === "python" || lang === "node" || lang === "go" ? lang : null,
    testRunner: runner === "pytest" || runner === "vitest" || runner === "jest" || runner === "go test" ? runner : null,
    onboardingState: state, onboardingDetail: str(r.onboarding_detail), workflowPath: r.onboarding_workflow_path ? str(r.onboarding_workflow_path) : null,
    job: r.onboarding_job ? str(r.onboarding_job) : null,
    setupPullRequest: r.setup_pr_number ? { number: num(r.setup_pr_number), url: str(r.setup_pr_url), state: prState } : null,
    projectId: r.project_id ? str(r.project_id) : null,
    warmCache: mapWarmCache(r),
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
