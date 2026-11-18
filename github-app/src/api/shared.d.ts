// Types of shared.js: the signatures of src/data/ci.ts and src/data/ci-rows.ts, over the contract's schemas
// (src/api/schema.d.ts, generated from openapi/fenvix-api.yaml). tests/api/unit.test.ts checks that each name exists.
import type { components } from "../../../src/api/schema.d.ts";

type S = components["schemas"];
type Row = Record<string, unknown>;
export type Project = S["Project"];
export type ProjectRow = S["ProjectRow"];
export type Run = S["Run"];
export type Defect = S["Defect"];
export type DefectFamily = S["DefectFamily"];
export type Plan = S["Plan"];
export type GitHubRate = S["GitHubRate"];
export type Trial = S["Trial"];
export type Overview = S["Overview"];
export type UsageReport = S["UsageReport"];
export type BillingOverview = S["BillingOverview"];
export type AuditRerun = S["AuditRerun"];
export type AuditSummary = S["AuditSummary"];
export type Exploration = S["Exploration"];
export type ActivityItem = S["ActivityItem"];
export type SetupChange = S["SetupChange"];
export type TestResult = S["TestResult"];
export type SkipReceipt = S["SkipReceipt"];
export type Installation = S["Installation"];
export type GitHubRepository = S["GitHubRepository"];

export interface UsageEvent { projectId: string | null; occurredAt: string; billable: boolean; baselineMinutes: number }
export interface TrialDates { startedAt: string; endsAt: string }

export function median(values: number[]): number | null;
export function monthOf(iso: string | Date): string;
export function monthBounds(month: string): { start: Date; end: Date };
export function dayStart(d: Date): Date;
export function daysBetween(from: Date, to: Date): string[];
export function projectRow(project: Project, runs: Run[], defects: Defect[], now: Date): ProjectRow;
export function overviewFrom(projects: Project[], runs: Run[], defects: Defect[], plan: Plan | null, rate: GitHubRate, now: Date, events?: UsageEvent[], trial?: Trial | null): Overview;
export function usageFrom(month: string, projects: Project[], runs: Run[], plan: Plan | null, rate: GitHubRate, events?: UsageEvent[]): UsageReport;
export function usageCsv(report: UsageReport): string;
export function usageCsvName(month: string): string;
export function billingFrom(plans: Plan[], projects: Project[], events: UsageEvent[], trial: Trial | null, now: Date): BillingOverview;
export function trialFrom(dates: TrialDates | null, runs: Run[], events: UsageEvent[], now: Date): Trial | null;
export function auditFrom(runs: Run[], reruns: AuditRerun[], from: Date, to: Date): AuditSummary;
export function familiesOf(defects: Defect[]): DefectFamily[];
export function setupChange(project: Pick<Project, "language">): SetupChange;
export function activityFrom(projects: Project[], runs: Run[], defects: Defect[], explorations: Exploration[], limit?: number): ActivityItem[];

export function fileOfTest(testId: string): string;
export function mapPlan(r: Row, currentId: string | null): Plan;
export function mapRate(r: Row | null | undefined): GitHubRate;
export function mapProject(r: Row): Project;
export function mapRun(r: Row): Run;
export function mapExploration(r: Row): Exploration;
export function mapTestResult(r: Row): TestResult;
export function mapDefect(r: Row, project: { fullName: string; testRunner: Project["testRunner"] } | undefined): Defect;
export function mapReceipt(r: Row, reusedRunNumber: number | null): SkipReceipt;
export function mapAuditRerun(r: Row): AuditRerun;
export function mapUsageEvent(r: Row): UsageEvent;
export function mapInstallation(r: Row): Installation;
export function mapGitHubRepository(r: Row): GitHubRepository;
