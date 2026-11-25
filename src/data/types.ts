/*
 * The dashboard's domain: CI test runs made deterministic on `runs-on: fenvix`.
 *
 * Every record the screens show is a schema of the API description, openapi/fenvix-api.yaml, re-exported here from the
 * generated src/api/schema.d.ts (`npm run api:generate`). Changing a field there breaks this build until the screens
 * follow. Only shapes that never cross the API (queries, file downloads) are written by hand below.
 * docs/data-contract.md says where each field comes from.
 */
import type { components } from "../api/schema";

type S = components["schemas"];

export type Language = S["Language"];
export type TestRunner = S["TestRunner"];
export type RunTrigger = S["RunTrigger"];
export type RunStatus = S["RunStatus"];
export type RunMode = S["RunMode"];
export type SetupState = S["SetupState"];
export type TestOutcome = S["TestOutcome"];
export type MissKind = S["MissKind"];
export type Region = S["Region"];

export type SetupPullRequest = S["SetupPullRequest"];
/** "Before fenvix": measured from the repository's GitHub Actions history when it was connected. */
export type Baseline = S["Baseline"];
export type ProjectSettings = S["ProjectSettings"];
export type Project = S["Project"];
/** A project with its numbers for the current month, for lists. */
export type ProjectRow = S["ProjectRow"];
/** Minutes that add up on screen: ran + skipped + other = total (largest-remainder rounding). */
export type MinuteBreakdown = S["MinuteBreakdown"];
export type RunTests = S["RunTests"];
export type RunProgress = S["RunProgress"];
/** The run's test command ran in parallel lanes. Proven: no conflict between parallel lanes in what the engine recorded for each test; files in conflict ran again in one lane. */
export type RunProof = S["RunProof"];
/** skipMisses is keyed by the reason a test was not reused. */
export type Run = Omit<S["Run"], "skipMisses"> & { skipMisses: Partial<Record<MissKind, number>> };
export type RunDetail = { run: Run; project: Project };
export type Exploration = S["Exploration"];
export type RunFile = S["RunFile"];
export type ActivityItem = S["ActivityItem"];
export type TestFailure = S["TestFailure"];
export type TestResult = S["TestResult"];
export type TestPage = S["TestPage"];
export type SkipReceipt = S["SkipReceipt"];
export type AuditRerun = S["AuditRerun"];
export type AuditSummary = S["AuditSummary"];
export type DefectCause = S["DefectCause"];
export type Defect = S["Defect"];
export type DefectFamily = Omit<S["DefectFamily"], "defects"> & { defects: Defect[] };
export type GitHubRate = S["GitHubRate"];
export type Plan = S["Plan"];
export type DayPoint = S["DayPoint"];
export type Trial = S["Trial"];
export type Overview = Omit<S["Overview"], "projects" | "recentDefects"> & { projects: ProjectRow[]; recentDefects: Defect[] };
export type UsageTotals = S["UsageTotals"];
export type UsageProjectRow = S["UsageProjectRow"];
export type UsageReport = S["UsageReport"];
export type BillingOverview = S["BillingOverview"];
export type Settings = S["Settings"];
export type InstallationStatus = S["InstallationStatus"];
export type Installation = S["Installation"];
export type GitHubConnection = S["GitHubConnection"];
export type OnboardingState = S["OnboardingState"];
/** A repository an installation of the fenvix GitHub App gives access to, with its onboarding state. */
export type GitHubRepository = S["GitHubRepository"];
export type WarmCache = S["WarmCache"];
export type WarmupStatus = S["WarmupStatus"];
export type Warmup = S["Warmup"];
/** What the setup pull request changes. */
export type SetupChange = S["SetupChange"];
export type SkipSharePoint = S["SkipSharePoint"];
/** One result of the ⌘K search (GET /search): a run or an open defect. */
export type SearchResult = S["SearchResult"];

/** One page of a list. Pages are numbered from 1. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** A file the browser can download. */
export interface ExportResult {
  filename: string;
  mimeType: string;
  downloadUrl: string;
}

export interface TestQuery {
  outcome?: TestOutcome | "all";
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface DefectQuery {
  projectId?: string;
  state?: "open" | "fixed" | "all";
}
