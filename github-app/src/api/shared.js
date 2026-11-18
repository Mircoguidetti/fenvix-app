// The dashboard's pure calculations and row mappers (src/data/ci.ts, src/data/ci-rows.ts), shared with its mock: the API
// computes every response with them, so the API and the sample data always agree. Plain JavaScript on purpose: those
// files are type-checked by the dashboard's own tsconfig; shared.d.ts states their types for this package (whose
// stricter settings they are not written for). Node runs the .ts files directly (type stripping) and esbuild bundles them.
export {
  activityFrom, auditFrom, billingFrom, dayStart, daysBetween, familiesOf, median, monthBounds, monthOf, overviewFrom, projectRow,
  setupChange, trialFrom, usageCsv, usageCsvName, usageFrom,
} from "../../../src/data/ci.ts";
export {
  fileOfTest, mapAuditRerun, mapDefect, mapExploration, mapGitHubRepository, mapInstallation, mapPlan, mapProject, mapRate, mapReceipt, mapRun,
  mapTestResult, mapUsageEvent,
} from "../../../src/data/ci-rows.ts";
