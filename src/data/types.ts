/*
 * The dashboard's domain: CI test runs made deterministic on `runs-on: fenvix`. Every shape here follows
 * docs/data-contract.md (the contract between the fenvix runner and the dashboard). Read that file first.
 */

export type Language = "python" | "node" | "go";
export type TestRunner = "pytest" | "vitest" | "jest" | "go test";
export type RunTrigger = "push" | "pull_request" | "merge_group" | "schedule" | "workflow_dispatch";
export type RunStatus = "running" | "passed" | "failed" | "cancelled";
export type SetupState = "app_installed" | "pr_open" | "active";
export type TestOutcome = "passed" | "failed" | "skipped_with_proof";

/** A file the browser can download. */
export interface ExportResult {
  filename: string;
  mimeType: string;
  downloadUrl: string;
}

/** One page of a list. Pages are numbered from 1. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SetupPullRequest {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
}

/** "Before fenvix": measured from the repository's GitHub Actions history when it was connected. */
export interface Baseline {
  medianTimeToGreenS: number;
  medianJobMinutes: number;
  runsSampled: number;
  from: string;
  to: string;
}

export interface ProjectSettings {
  skipWithProof: boolean;
  commentOnPullRequests: boolean;
  nightlyExploration: boolean;
  /** The test command the runner wraps, for example "pytest tests". Empty: the job's own command. */
  testCommand: string;
}

export interface Project {
  id: string;
  /** owner/name on GitHub. */
  fullName: string;
  language: Language;
  testRunner: TestRunner;
  defaultBranch: string;
  installationId: number;
  setupState: SetupState;
  setupPullRequest: SetupPullRequest | null;
  connectedAt: string;
  baseline: Baseline | null;
  settings: ProjectSettings;
}

/** A project with its numbers for the current month, for lists. */
export interface ProjectRow extends Project {
  runsThisMonth: number;
  /** Median share of test time skipped with proof over this month's finished runs, 0 to 1. Null without runs. */
  medianSkipShare: number | null;
  openDefects: number;
  /** This month, whole minutes that add up: testMinutesRan + minutesSaved + otherStepMinutes = githubEquivalentMinutes. */
  minutesThisMonth: MinuteBreakdown;
  /** Same as minutesThisMonth.skipped. */
  minutesSavedThisMonth: number;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
}

/**
 * Minutes of CI time, split so the parts add up on screen: ran + skipped + other = total. Each part is rounded with
 * the largest-remainder rule, so the displayed parts always sum to the displayed total.
 */
export interface MinuteBreakdown {
  /** Test minutes that ran. */
  ran: number;
  /** Test minutes skipped with proof: the minutes saved. */
  skipped: number;
  /** Other steps that still run: checkout, dependency install, build. */
  other: number;
  /** The same job on a GitHub-hosted runner without fenvix. */
  total: number;
}

export interface RunTests {
  total: number;
  ran: number;
  passed: number;
  failed: number;
  skippedWithProof: number;
  /** The part of `failed` that is a reproducible flaky defect. */
  flakyDefects: number;
}

export interface Run {
  id: string;
  projectId: string;
  number: number;
  engineRunId: string | null;
  commitSha: string;
  commitMessage: string;
  branch: string;
  pullRequest: number | null;
  trigger: RunTrigger;
  status: RunStatus;
  pushedAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  tests: RunTests;
  testTimeMs: { ran: number; skipped: number };
  /** Share of test time skipped with proof, 0 to 1. */
  skipShare: number;
  /** Test minutes skipped with proof (testTimeMs.skipped). fenvix skips nothing else, so this is all it saves. */
  minutesSaved: number;
  /** The job's other steps that still run on fenvix: checkout, dependency install, build. */
  otherStepMinutes: number;
  /**
   * What the job would take on a GitHub-hosted runner without fenvix: test minutes run + test minutes skipped with
   * proof + other steps.
   */
  githubEquivalentMinutes: number;
  engineVersion: string;
  seed: number | null;
}

export interface TestFailure {
  kind: "real" | "flaky_defect";
  phase: string;
  exceptionType: string;
  message: string;
  location: string;
  defectId: string | null;
}

export interface TestResult {
  runId: string;
  testId: string;
  file: string;
  outcome: TestOutcome;
  durationMs: number;
  failure: TestFailure | null;
  receiptId: string | null;
}

export interface TestQuery {
  outcome?: TestOutcome | "all";
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface TestPage extends Page<TestResult> {
  /** Tests of the run per outcome, whatever the filter. */
  counts: Record<TestOutcome, number>;
}

/** Why a test could be skipped: everything it depends on was checked and is unchanged since a passing run. */
export interface SkipReceipt {
  id: string;
  runId: string;
  testId: string;
  cacheKey: string;
  reusedRunId: string | null;
  reusedEngineRunId: string;
  reusedRunNumber: number | null;
  reusedOutcome: "passed";
  fingerprint: string;
  reusedDurationMs: number;
  code: { path: string; qualname: string; digest: string }[];
  modules: { path: string; kind: "content" | "skeleton" | "hooks"; digest: string }[];
  filesRead: { path: string; dep: string }[];
  envRead: { name: string; digest: string }[];
  runtime: { digest: string; interpreter: string; system: string; machine: string; libc: string; distributions: number };
  config: { digest: string; runner: string; engine: string; inifile: string; options: string };
  changedFilesProven: number;
}

export type DefectCause = "polluter" | "state_setter" | "fails_alone";

export interface Defect {
  id: string;
  projectId: string;
  projectName: string;
  testId: string;
  status: "reproduced" | "replay_unstable";
  state: "open" | "fixed";
  cause: DefectCause;
  /** The polluters (cause "polluter") or the state setters (cause "state_setter"). */
  causeTests: string[];
  /** order.txt: the target test last. */
  minimalOrder: string[];
  prefixLength: number;
  seed: number | null;
  fingerprint: string;
  replays: { runs: number; fails: number; identicalFingerprint: boolean };
  outcome: string;
  exception: { type: string; phase: string; message: string; location: string };
  divergence: { index: number; reason: string; description: string } | null;
  familyKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  firstRunId: string | null;
  lastRunId: string | null;
  occurrences: number;
  engineVersion: string;
  language: "python" | "node";
  testRunner: TestRunner;
}

/** Defects that share a cause: the same polluter or state setter. */
export interface DefectFamily {
  key: string;
  projectId: string;
  projectName: string;
  cause: DefectCause;
  causeTests: string[];
  defects: Defect[];
}

export interface DefectQuery {
  projectId?: string;
  state?: "open" | "fixed" | "all";
}

export interface GitHubRate {
  usdPerMinute: number;
  runner: string;
  source: string;
  checkedOn: string;
}

export interface Plan {
  id: string;
  name: string;
  description: string;
  /** Null: no limit. */
  runsPerMonth: number | null;
  maxProjects: number | null;
  /** Null: the price is not set yet. */
  priceUsdMonth: number | null;
  features: string[];
  current: boolean;
}

export interface DayPoint {
  /** ISO start of the day (UTC). */
  at: string;
  value: number;
}

export interface Overview {
  month: string;
  runs: { thisMonth: number; lastMonthSameDays: number; perDay: DayPoint[] };
  minutesSaved: { thisMonth: number; perDay: DayPoint[] };
  /** Median seconds from push to the first green run. */
  timeToGreen: { beforeMedianS: number | null; withMedianS: number | null; commits: number };
  /** Median share of test time skipped with proof per day. */
  skipShare: { median: number | null; perDay: DayPoint[] };
  /** This month's minutes, the same numbers as the Usage page. */
  minutes: MinuteBreakdown;
  cost: { githubEquivalentUsd: number; githubEquivalentMinutes: number; plan: Plan | null; rate: GitHubRate };
  projects: ProjectRow[];
  openDefects: number;
  recentDefects: Defect[];
}

export interface UsageProjectRow {
  projectId: string;
  fullName: string;
  runs: number;
  /** testMinutesRan + minutesSaved + otherStepMinutes = githubEquivalentMinutes, in whole minutes. */
  testMinutesRan: number;
  minutesSaved: number;
  otherStepMinutes: number;
  githubEquivalentMinutes: number;
  githubEquivalentUsd: number;
}

export interface UsageReport {
  month: string;
  plan: Plan | null;
  runsUsed: number;
  runsIncluded: number | null;
  totals: Omit<UsageProjectRow, "projectId" | "fullName">;
  rows: UsageProjectRow[];
  /** Runs per day, one series per project. */
  daily: { days: string[]; series: { label: string; values: number[] }[] };
  rate: GitHubRate;
}

export interface BillingOverview {
  currency: string;
  plan: Plan | null;
  period: { start: string; end: string };
  runsUsed: number;
  runsIncluded: number | null;
  projects: number;
  /** Runs per month over the last three full months, for sizing. */
  averageMonthlyRuns: number;
  /** The smallest plan that fits the projects and the runs. */
  suggestedPlanId: string | null;
}

export interface Settings {
  workspaceName: string;
  /** Emails about usage, new defects and account notices. */
  emailNotices: boolean;
}

/** A repository the GitHub App can see, for onboarding. */
export interface GitHubRepository {
  fullName: string;
  private: boolean;
  language: Language;
  testRunner: TestRunner;
  /** Already a fenvix project. */
  connected: boolean;
}

export interface GitHubConnection {
  /** The GitHub account the app is installed on, or null when it is not installed yet. */
  account: string | null;
  /** Where the browser goes to install the app (GitHub's page), or null when the app is not set up for this deployment. */
  installUrl: string | null;
}

/** What the setup pull request changes. */
export interface SetupChange {
  path: string;
  job: string;
  before: string;
  after: string;
}

export type { CreatedPublicKey, NewPublicKey, PublicApiKey, PublicKeyPage, PublicKeyRole, PublicKeyStatus } from "./public-keys";
