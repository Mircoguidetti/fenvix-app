/**
 * The run's status from the job and the runner's summary (docs/data-contract.md, "3. The run summary"). First match
 * wins: the job was cancelled; a summary that came but could not be read (not proven: never green, never red for it);
 * no summary: per-test not_proven rows stored for the run (`notProvenRows` > 0) make a succeeded job not_proven, else
 * passed if the job succeeded, else failed; failures or flaky tests; tests not proven (no conflict between parallel
 * lanes in what each test touched could not be shown: N > 0, RunSummary.notProven, which also covers a missing exit
 * code); a non-zero exit; else passed. When we are not sure, the run is never green.
 */
import type { RunSummary } from "./summary.ts";

export type FinishedStatus = "passed" | "failed" | "cancelled" | "not_proven";

export function runStatus(jobConclusion: string | null, summary: Pick<RunSummary, "failed" | "flaky" | "notProven" | "exit"> | null, o: { summaryUnreadable?: boolean; notProvenRows?: number } = {}): FinishedStatus {
  if (jobConclusion === "cancelled") return "cancelled";
  if (!summary && o.summaryUnreadable) return "not_proven";
  if (!summary) return jobConclusion !== "success" ? "failed" : (o.notProvenRows ?? 0) > 0 ? "not_proven" : "passed";
  if (summary.failed.length || summary.flaky.length) return "failed";
  if (summary.notProven > 0) return "not_proven";
  if (summary.exit === null) return "not_proven";
  if (summary.exit !== 0) return "failed";
  return "passed";
}
