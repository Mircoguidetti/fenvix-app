import type {
  ActivityItem, AuditSummary, BillingOverview, Defect, DefectFamily, DefectQuery, Exploration, ExportResult, GitHubConnection, GitHubRepository, Overview, Page,
  Plan, Project, ProjectRow, ProjectSettings, Run, RunDetail, RunFile, Settings, SetupChange, SkipReceipt, SkipSharePoint, TestPage, TestQuery, UsageReport,
} from "./types";

/** GET /projects/{projectId}/runs. With `since` (ISO), every run since then, newest first, on one page. */
export interface RunQuery {
  /** "pr" keeps pull request runs, "default" keeps the default branch. */
  scope?: "all" | "pr" | "default";
  status?: "all" | "passed" | "failed";
  since?: string;
  page?: number;
  pageSize?: number;
}

/** GET /runs/{runId} sent with the last ETag: 304 says nothing changed, 200 gives the run again and its new ETag. */
export type RunLive = { notModified: true } | { notModified: false; detail: RunDetail; etag: string | null };

/**
 * Everything the dashboard reads and changes, one method per operation of the fenvix API (openapi/fenvix-api.yaml,
 * tag dashboard). The screens only talk to this interface. `./index.ts` picks the implementation: the API
 * (src/data/api.ts, the default) or the sample data (VITE_DATA_BACKEND=mock, local development and the checks).
 * Lookups by id resolve to null when the API answers 404.
 */
export interface DataClient {
  /** "now" used for relative times and for "this month". The API client returns the current time. */
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
  getSkipShareSeries(projectId: string, days: number): Promise<SkipSharePoint[]>;
  /** Audit reruns of skipped tests over the last `days` days (Skip with proof). */
  getAudit(projectId: string, days: number): Promise<AuditSummary>;
  /** The change the setup pull request makes to the test job. */
  getSetupChange(projectId: string): Promise<SetupChange>;

  getRun(id: string): Promise<RunDetail | null>;
  /** The live view of a running run: GET /runs/{runId} with If-None-Match. */
  getRunLive(id: string, etag: string | null): Promise<RunLive>;
  listTestResults(runId: string, query?: TestQuery): Promise<TestPage>;
  getSkipReceipt(id: string): Promise<SkipReceipt | null>;
  /** The run's tests by file: ran, skipped with proof, failed (the suite drawn as squares). */
  listRunFiles(runId: string): Promise<RunFile[]>;

  /** Nights of exploration of a project, newest first. */
  listExplorations(projectId: string): Promise<Exploration[]>;
  /** What happened lately, newest first: for one project, or every project when projectId is left out. */
  listActivity(projectId?: string, limit?: number): Promise<ActivityItem[]>;

  listDefects(query?: DefectQuery): Promise<Defect[]>;
  listDefectFamilies(query?: DefectQuery): Promise<DefectFamily[]>;
  getDefect(id: string): Promise<Defect | null>;

  /** Months that have runs, newest first, as "YYYY-MM". */
  listUsageMonths(): Promise<string[]>;
  getUsage(month: string): Promise<UsageReport>;
  exportUsage(month: string): Promise<ExportResult>;

  /** Plans and add-ons, the organization's marked current. */
  listPlans(): Promise<Plan[]>;
  getBilling(): Promise<BillingOverview>;

  /* The fenvix GitHub App: installations on GitHub, the repositories they give, the setup pull request of each. */
  getGitHubConnection(): Promise<GitHubConnection>;
  listGitHubRepositories(): Promise<GitHubRepository[]>;
  /** Where to send the browser to install the App for this organization (owner or admin). */
  createInstallLink(): Promise<string>;
  /**
   * Completes the link after GitHub's return (`?github=confirm#completion=<code>`): the installation is linked to the
   * organization that asked for the link, only if the signed-in person is the one who asked (review R-016 F2).
   */
  completeGitHubInstall(completion: string): Promise<{ organizationId: string; installationId: number; account: string }>;
  /** Queues the setup pull request of a repository, by GitHub's repository id. The answer is the repository as it is now. */
  openSetupPullRequest(repositoryId: number): Promise<GitHubRepository>;

  getSettings(): Promise<Settings>;
  saveSettings(next: Settings): Promise<Settings>;
}
