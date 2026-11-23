/**
 * The run's status from the job and the runner's summary (docs/data-contract.md, "3. The run summary"). First match
 * wins: the job was cancelled; a summary that came but could not be read (not proven: never green, never red for it);
 * no summary (passed if the job succeeded, else failed); failures or flaky tests; tests not proven identical to the
 * serial run (N > 0, RunSummary.notProven, which also covers a missing exit code); a non-zero exit; else passed. When we
 * are not sure, the run is never green.
 */
import type { RunSummary } from "./summary.ts";

export type FinishedStatus = "passed" | "failed" | "cancelled" | "not_proven";

export function runStatus(jobConclusion: string | null, summary: Pick<RunSummary, "failed" | "flaky" | "notProven" | "exit"> | null, o: { summaryUnreadable?: boolean } = {}): FinishedStatus {
  if (jobConclusion === "cancelled") return "cancelled";
  if (!summary && o.summaryUnreadable) return "not_proven";
  if (!summary) return jobConclusion === "success" ? "passed" : "failed";
  if (summary.failed.length || summary.flaky.length) return "failed";
  if (summary.notProven > 0) return "not_proven";
  if (summary.exit === null) return "not_proven";
  if (summary.exit !== 0) return "failed";
  return "passed";
}
