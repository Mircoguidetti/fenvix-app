import type {
  ActivityItem, Exploration, RunFile,
  BillingOverview, Defect, DefectFamily, DefectQuery, ExportResult, GitHubConnection, GitHubRepository, Overview, Page, Plan,
  Project, ProjectRow, ProjectSettings, Run, Settings, SetupChange, SetupPullRequest, SkipReceipt, TestPage, TestQuery, UsageReport,
} from "./types";
import type { CreatedPublicKey, NewPublicKey, PublicApiKey, PublicKeyPage } from "./public-keys";

export interface RunQuery {
  /** "pr" keeps pull request runs, "default" keeps the default branch. */
  scope?: "all" | "pr" | "default";
  status?: "all" | "passed" | "failed";
  page?: number;
  pageSize?: number;
}

/**
 * Everything the dashboard needs from a backend (docs/data-contract.md). The screens only talk to this interface.
 * `./index.ts` picks the implementation: the mock (VITE_DATA_BACKEND=mock) or Supabase.
 */
export interface DataClient {
  /** "now" used for relative times and for "this month". A real client returns the current time. */
  now(): Date;
  /** True when the screens show sample data (the mock): they say so. */
  readonly sample: boolean;

  getOverview(): Promise<Overview>;

  listProjects(): Promise<ProjectRow[]>;
  getProject(id: string): Promise<ProjectRow | null>;
  saveProjectSettings(id: string, settings: ProjectSettings): Promise<Project>;
  /** Newest first. */
  listRuns(projectId: string, query?: RunQuery): Promise<Page<Run>>;
  /** Share of test time skipped with proof per day, median over that day's runs, for the last `days` days. */
  getSkipShareSeries(projectId: string, days: number): Promise<{ at: string; value: number; runs: number }[]>;

  getRun(id: string): Promise<{ run: Run; project: Project } | null>;
  listTestResults(runId: string, query?: TestQuery): Promise<TestPage>;
  getSkipReceipt(id: string): Promise<SkipReceipt | null>;
  /** The run's tests by file: ran, skipped with proof, failed (the suite drawn as squares). */
  listRunFiles(runId: string): Promise<RunFile[]>;

  /** Nights of exploration of a project, newest first. */
  listExplorations(projectId: string): Promise<Exploration[]>;
  /** What happened lately, newest first: for one project, or every project when projectId is left out. */
  listActivity(projectId?: string, limit?: number): Promise<ActivityItem[]>;
  /** Runs since `since` (ISO), newest first, for per-project pages that chart every run. */
  listRunsSince(projectId: string, since: string): Promise<Run[]>;

  listDefects(query?: DefectQuery): Promise<Defect[]>;
  listDefectFamilies(query?: DefectQuery): Promise<DefectFamily[]>;
  getDefect(id: string): Promise<Defect | null>;

  /** Months that have runs, newest first, as "YYYY-MM". */
  listUsageMonths(): Promise<string[]>;
  getUsage(month: string): Promise<UsageReport>;
  exportUsage(month: string): Promise<ExportResult>;

  listPlans(): Promise<Plan[]>;
  getBilling(): Promise<BillingOverview>;

  /* Onboarding: the fenvix GitHub App. Installing happens on GitHub; GitHub sends the browser back with installation_id. */
  getGitHubConnection(): Promise<GitHubConnection>;
  listGitHubRepositories(): Promise<GitHubRepository[]>;
  /** Mock only: stands in for GitHub's own install page, where the person picks repositories. Returns the installation id. */
  installGitHubApp(repositories: string[]): Promise<number>;
  /** After GitHub sent the browser back: the repositories of that installation become projects. */
  completeInstallation(installationId: number): Promise<Project[]>;
  /** The change the setup pull request makes to the test job. */
  getSetupChange(projectId: string): Promise<SetupChange>;
  /** Opens a pull request on the repository that changes the test job to `runs-on: fenvix`. */
  openSetupPullRequest(projectId: string): Promise<SetupPullRequest>;

  /* Public API keys (fvx_), as before. Owner or admin only. */
  listPublicApiKeys(cursor?: string | null): Promise<PublicKeyPage>;
  createPublicApiKey(input: NewPublicKey): Promise<CreatedPublicKey>;
  revokePublicApiKey(id: string): Promise<PublicApiKey>;

  getSettings(): Promise<Settings>;
  saveSettings(next: Settings): Promise<Settings>;
}
