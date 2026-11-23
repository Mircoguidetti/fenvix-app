/**
 * The run's status from the job and the runner's summary (docs/data-contract.md, "3. The run summary"). First match
 * wins: the job was cancelled; no summary (passed if the job succeeded, else failed); failures or flaky tests; tests
 * not proven identical to the serial run (N > 0, RunSummary.notProven); a non-zero exit; else passed. A run with a test
 * not proven is never green.
 */
import type { RunSummary } from "./summary.ts";

export type FinishedStatus = "passed" | "failed" | "cancelled" | "not_proven";

export function runStatus(jobConclusion: string | null, summary: Pick<RunSummary, "failed" | "flaky" | "notProven" | "exit"> | null): FinishedStatus {
  if (jobConclusion === "cancelled") return "cancelled";
  if (!summary) return jobConclusion === "success" ? "passed" : "failed";
  if (summary.failed.length || summary.flaky.length) return "failed";
  if (summary.notProven > 0) return "not_proven";
  if (summary.exit !== 0) return "failed";
  return "passed";
}
