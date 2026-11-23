import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { client, type Run, type RunFile, type RunProof, type SkipReceipt, type TestOutcome } from "../data";
import { BadgeCheck, Check, ShieldQuestion, X } from "lucide-react";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { ChartSkeleton, ListSkeleton, PageSkeleton } from "../components/Skeleton";
import { MinuteSum, NO_CAUSE, OutcomePill, SAVED_NOTE, triggerLabel } from "../components/ci";
import { RunStatusPill } from "../components/StateBadge";
import { Pagination } from "../components/Pagination";
import { Segmented } from "../components/Segmented";
import { SearchInput } from "../components/SearchInput";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useProjectTitle } from "../components/Shell";
import { useAsync } from "../lib/useAsync";
import { useLiveRun } from "../lib/useLiveRun";
import { REGIONS } from "./Settings";
import { formatCount, formatDateTime, formatDuration, formatMinutes, formatPercent, shortSha } from "../lib/format";
import { runMinutes, setupSnippet } from "../data/ci";
import { languageLabel } from "./Projects";

const PAGE_SIZE = 50;

function Hash({ value }: { value: string }) {
  return (
    <code className="hash mono" title={value}>
      {value}
    </code>
  );
}

/** Everything that was checked before a test was skipped, with the hashes. */
export function ReceiptBody({ r, projectId }: { r: SkipReceipt; projectId: string }) {
  return (
    <div className="receipt">
      <p>
        Reused the passing result of{" "}
        {r.reusedRunId ? (
          <Link to={`/projects/${projectId}/runs/${r.reusedRunId}`} className="row-link">
            run #{r.reusedRunNumber}
          </Link>
        ) : (
          <span className="mono">{r.reusedEngineRunId}</span>
        )}{" "}
        ({formatDuration(r.reusedDurationMs)} of test time not run again). Everything below was checked and is unchanged.
      </p>
      <dl className="receipt-ids">
        <div>
          <dt>Cache key</dt>
          <dd>
            <Hash value={r.cacheKey} />
          </dd>
        </div>
        <div>
          <dt>Fingerprint of the reused run</dt>
          <dd>
            <Hash value={r.fingerprint} />
          </dd>
        </div>
      </dl>
      <section aria-label="Code executed">
        <h3>Code executed · {r.code.length} functions</h3>
        <ul className="receipt-list">
          {r.code.map((c, i) => (
            <li key={i}>
              <span className="mono break-anywhere">
                {c.path}::{c.qualname}
              </span>
              <Hash value={c.digest} />
            </li>
          ))}
          {r.modules.map((m, i) => (
            <li key={`m${i}`}>
              <span className="mono break-anywhere">
                {m.path} <span className="muted">({m.kind === "hooks" ? "test hooks" : m.kind === "skeleton" ? "module level" : "whole file"})</span>
              </span>
              <Hash value={m.digest} />
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Files read">
        <h3>Files read · {r.filesRead.length}</h3>
        {r.filesRead.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul className="receipt-list">
            {r.filesRead.map((f, i) => (
              <li key={i}>
                <span className="mono break-anywhere">{f.path}</span>
                {f.dep === "missing" ? <span className="muted small">absent, still absent</span> : <Hash value={f.dep} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Environment variables read">
        <h3>Environment variables read · {r.envRead.length}</h3>
        {r.envRead.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul className="receipt-list">
            {r.envRead.map((e, i) => (
              <li key={i}>
                <span className="mono">{e.name}</span>
                {e.digest === "-" ? <span className="muted small">unset, still unset</span> : <Hash value={e.digest} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Runtime and configuration">
        <h3>Runtime and configuration</h3>
        <ul className="receipt-list">
          <li>
            <span>
              {r.runtime.interpreter} · {r.runtime.system} {r.runtime.machine} · {r.runtime.libc} · {formatCount(r.runtime.distributions)} installed packages
            </span>
            <Hash value={r.runtime.digest} />
          </li>
          <li>
            <span>
              {r.config.runner} · {r.config.engine} · {r.config.inifile} · <span className="mono">{r.config.options}</span>
            </span>
            <Hash value={r.config.digest} />
          </li>
        </ul>
      </section>
      <p className="muted small">{r.changedFilesProven} files changed since that run were proven not to matter to this test.</p>
    </div>
  );
}

/** The run's test suite as squares, one per test file: ran, skipped with proof, failed. The brand colour marks no state. */
function SuiteSquares({ files }: { files: RunFile[] }) {
  const ran = files.filter((f) => f.failed === 0 && f.ran > 0).length;
  const skipped = files.filter((f) => f.ran === 0 && f.failed === 0).length;
  const failed = files.filter((f) => f.failed > 0).length;
  const tests = files.reduce((a, f) => a + f.tests, 0);
  return (
    <>
      <div className="suite" role="img" aria-label={`${files.length} test files: ${ran} ran, ${skipped} skipped with proof, ${failed} with a failure.`}>
        {files.map((f) => (
          <span key={f.file} className="suite-sq" data-state={f.failed ? "failed" : f.ran ? "ran" : "skipped"} title={`${f.file}: ${f.tests} tests, ${f.failed ? `${f.failed} failed` : f.ran ? "ran" : "skipped with proof"}`} />
        ))}
      </div>
      <ul className="suite-legend">
        <li>
          <span className="suite-sq" data-state="ran" aria-hidden="true" />
          <Check size={13} strokeWidth={2.4} aria-hidden="true" /> {formatCount(ran)} ran
        </li>
        <li>
          <span className="suite-sq" data-state="skipped" aria-hidden="true" />
          <BadgeCheck size={13} strokeWidth={2.2} aria-hidden="true" /> {formatCount(skipped)} skipped with proof
        </li>
        <li>
          <span className="suite-sq" data-state="failed" aria-hidden="true" />
          <X size={13} strokeWidth={2.4} aria-hidden="true" /> {formatCount(failed)} with a failure
        </li>
        <li className="muted">
          {formatCount(files.length)} files · {formatCount(tests)} tests
        </li>
      </ul>
    </>
  );
}

/** "read a file outside the project": the engine's cause as the verb phrase of a sentence about tests. */
const CAUSE_PHRASES: Record<string, string> = {
  "file read outside the project": "read a file outside the project",
  "environment variable read outside any test": "read an environment variable outside any test",
};

const testCount = (n: number) => `${formatCount(n)} ${n === 1 ? "test" : "tests"}`;

/** After the sentence: what the run did with them. The run exits non-zero only when the summary said so. */
function exitClause(run: Pick<Run, "exitCode">): string {
  return `Their serial result is reported; ${run.exitCode !== null && run.exitCode !== 0 ? `the run exits ${run.exitCode}` : "the check on GitHub is marked failed"}.`;
}

/** One sentence about the tests not proven, from the largest cause the runner reported. */
export function notProvenSentence(run: Pick<Run, "exitCode" | "tests">, proof: Pick<RunProof, "notProvenCauses"> | null): string {
  const n = run.tests.notProven;
  const top = proof ? [...proof.notProvenCauses].sort((a, b) => b.tests - a.tests)[0] : undefined;
  if (!top) return `${testCount(n)} ${n === 1 ? "was" : "were"} not proven identical. ${NO_CAUSE}. ${exitClause(run)}`;
  const what = CAUSE_PHRASES[top.cause] ?? `were not proven (${top.cause})`;
  return `${testCount(top.tests)} ${what}, so the parallel result could not be proven equal to the serial one. ${exitClause(run)}`;
}

/**
 * The run's test command ran in parallel lanes, then each test was checked against the serial run (the summary's
 * proof). Not shown while running (the proof exists once the run has finished) nor for a serial run.
 */
function ProofCard({ run, proof, testsLink }: { run: Run; proof: RunProof; testsLink: string }) {
  const n = proof.notProven;
  return (
    <Card id="proof" title="Parallel with proof" description="Ran in parallel, then checked test by test against the serial run.">
      <dl className="facts facts-4">
        <div>
          <dt>Result</dt>
          <dd>{n === 0 ? "Identical to the serial run" : `Not proven for ${testCount(n)}`}</dd>
        </div>
        <div>
          <dt>Workers</dt>
          <dd className="mono">{formatCount(proof.workers)}</dd>
        </div>
        <div>
          <dt>Proven</dt>
          <dd className="mono">
            {formatCount(proof.proven)} of {formatCount(proof.proven + proof.notProven)}
          </dd>
        </div>
        <div>
          <dt>Re-run in one lane</dt>
          <dd className="mono">{formatCount(proof.rerunOneLane)}</dd>
        </div>
        <div>
          <dt>Not proven</dt>
          <dd className="mono">{formatCount(n)}</dd>
        </div>
        <div>
          <dt>Parallel time</dt>
          <dd className="mono">{formatDuration(proof.parallelMs)}</dd>
        </div>
        {proof.serialMsEstimate !== null && (
          <div>
            <dt>Serial time (estimate)</dt>
            <dd className="mono">{formatDuration(proof.serialMsEstimate)}</dd>
          </div>
        )}
        <div>
          <dt>Order digest</dt>
          <dd className="mono break-anywhere">{proof.orderDigest ?? "Not reported"}</dd>
        </div>
      </dl>
      {n > 0 && (
        <div className="callout callout-warning" role="note" id="not-proven-note">
          <p className="callout-row">
            <ShieldQuestion size={16} aria-hidden="true" />
            <span>
              {notProvenSentence({ ...run, tests: { ...run.tests, notProven: n } }, proof)}{" "}
              <Link to={testsLink} className="row-link">
                See the {testCount(n)}
              </Link>
            </span>
          </p>
        </div>
      )}
      <p className="small">
        <a href="#tests" className="row-link">
          How this was proven
        </a>
      </p>
    </Card>
  );
}

const PHASES: Record<NonNullable<Run["progress"]>["phase"], string> = { setup: "Setting up the machine", collecting: "Collecting tests", testing: "Running tests", reporting: "Reporting results" };

/** The runner's latest progress record of a running run, refreshed by the live view. */
function LiveProgress({ run, polling }: { run: Run; polling: boolean }) {
  const p = run.progress;
  if (!p) return <Message>Running: waiting for the first progress report from the machine.</Message>;
  const total = p.testsTotal;
  const share = total ? Math.min(1, p.testsDone / total) : 0;
  return (
    <div className="live">
      <div className="live-head">
        <strong>{PHASES[p.phase]}</strong>
        <span className="muted small" aria-live="polite">
          {total === null ? `${formatCount(p.testsDone)} tests done, collecting` : `${formatCount(p.testsDone)} of ${formatCount(total)} tests done (${formatPercent(share)})`}
        </span>
      </div>
      <div className="meter" role="progressbar" aria-label="Tests done" aria-valuemin={0} aria-valuemax={total ?? undefined} aria-valuenow={total === null ? undefined : p.testsDone}>
        <span className="meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
      <dl className="facts facts-4 live-facts">
        <div>
          <dt>Passed</dt>
          <dd className="mono">{formatCount(p.passed)}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd className={p.failed ? "mono fail-count" : "mono"}>{formatCount(p.failed)}</dd>
        </div>
        <div>
          <dt>Skipped with proof</dt>
          <dd className="mono">{formatCount(p.skippedWithProof)}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd className="mono">{formatDuration(p.elapsedMs)}</dd>
        </div>
      </dl>
      <p className="small break-anywhere">
        <span className="muted">Now running: </span>
        {p.currentTest ? <span className="mono">{p.currentTest}</span> : <span className="muted">no test (between steps)</span>}
      </p>
      <p className="muted small">
        Last report from the machine {formatDateTime(p.updatedAt)}. {polling ? "This page checks for news every few seconds while it is open." : "Updates pause while this page is hidden."}
      </p>
    </div>
  );
}

export function RunPage() {
  const { projectId = "", runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const outcome = (["passed", "failed", "skipped_with_proof", "not_proven"].includes(params.get("outcome") ?? "") ? params.get("outcome") : "all") as TestOutcome | "all";
  const location = useLocation();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const receiptId = params.get("receipt");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const data = useAsync(() => client.getRun(runId), [runId]);
  const live = useLiveRun(runId, data.status === "ready" ? data.data : null);
  const status = live.detail?.run.status ?? null;
  const q = params.get("q") ?? "";
  // The per-test results and the files arrive once the run has finished: asked again when its status changes.
  const tests = useAsync(() => client.listTestResults(runId, { outcome, search: q, page, pageSize: PAGE_SIZE }), [runId, outcome, q, page, status]);
  const receipt = useAsync(() => (receiptId ? client.getSkipReceipt(receiptId) : Promise.resolve(null)), [receiptId]);
  const files = useAsync(() => client.listRunFiles(runId), [runId, status]);
  // A run not proven without a proof block: "See the N tests" only when it has per-test not_proven rows.
  const unproven = live.detail && !live.detail.run.proof && live.detail.run.tests.notProven > 0 && status !== "running";
  const unprovenRows = useAsync(() => (unproven ? client.listTestResults(runId, { outcome: "not_proven", pageSize: 1 }).then((p) => p.total) : Promise.resolve(0)), [runId, unproven, status]);
  // "See the N tests" and "How this was proven" lead to the tests table.
  useEffect(() => {
    if (location.hash === "#tests" && data.status === "ready") document.getElementById("tests")?.scrollIntoView();
  }, [location.hash, location.search, data.status]);
  const project = data.status === "ready" && data.data ? data.data.project : null;
  useProjectTitle(project?.fullName, project ? { language: languageLabel(project.language), runner: project.testRunner, snippet: setupSnippet(project) } : undefined);

  const set = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(changes)) v ? n.set(k, v) : n.delete(k);
        return n;
      },
      { replace: true },
    );
  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== q) set({ q: search.trim() || null, page: null });
    }, 250);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  if (data.status === "loading") return <PageSkeleton kpis={6} cards={3} label="Loading run" />;
  if (data.status === "error") return <Message role="alert">{data.message}</Message>;
  if (!data.data || !live.detail || data.data.run.projectId !== projectId)
    return (
      <div className="empty not-found">
        <h1>Run not found</h1>
        <Link to={`/projects/${projectId}`} className="btn btn-primary">
          Back to the project
        </Link>
      </div>
    );
  const { run } = live.detail;
  const running = run.status === "running";
  const shadow = run.mode === "shadow";
  const counts = tests.status === "ready" ? tests.data.counts : null;
  const testsLink = `/projects/${projectId}/runs/${run.id}?outcome=not_proven#tests`;

  return (
    <>
      <PageHeader
        back={
          <Link to={`/projects/${projectId}`} className="back-link">
            ← {data.data.project.fullName}
          </Link>
        }
        title={`Run #${run.number}`}
        meta={<RunStatusPill status={run.status} count={run.tests.notProven} />}
        description={
          <>
            <span className="mono">{shortSha(run.commitSha)}</span> {run.commitMessage}
          </>
        }
      />

      {shadow && (
        <p className="callout shadow-note" role="note">
          <span>
            <strong>
              Shadow run: nothing was skipped; {formatCount(run.wouldSkipTests)} {run.wouldSkipTests === 1 ? "test" : "tests"} would have been.
            </strong>{" "}
            Every test ran, as during the trial. With skipping on, they would have saved {formatDuration(run.wouldSaveMs)} of test time.
          </span>
        </p>
      )}

      {running ? (
        <Card id="live" title="Live" description="The run is still going. Its tests, receipts and minutes arrive when it finishes.">
          <LiveProgress run={run} polling={live.polling} />
        </Card>
      ) : (
        <div className="kpis">
          <div className="kpi">
            <strong className="kpi-value">{formatCount(run.tests.total)}</strong>
            <span className="kpi-label">Tests</span>
            <span className="kpi-sub muted small">in the suite</span>
          </div>
          <div className="kpi">
            <strong className="kpi-value">{formatCount(run.tests.ran)}</strong>
            <span className="kpi-label">Ran</span>
            <span className="kpi-sub muted small">
              {formatCount(run.tests.passed)} passed{run.tests.notProven ? ` · ${formatCount(run.tests.notProven)} not proven` : ""}
            </span>
          </div>
          {shadow ? (
            <div className="kpi">
              <strong className="kpi-value">{formatCount(run.wouldSkipTests)}</strong>
              <span className="kpi-label">Would have skipped</span>
              <span className="kpi-sub muted small">shadow run: none skipped</span>
            </div>
          ) : (
            <div className="kpi">
              <strong className="kpi-value">{formatCount(run.tests.skippedWithProof)}</strong>
              <span className="kpi-label">Skipped with proof</span>
              <span className="kpi-sub muted small">{formatPercent(run.skipShare)} of test time</span>
            </div>
          )}
          <div className="kpi">
            <strong className="kpi-value">{formatCount(run.tests.failed)}</strong>
            <span className="kpi-label">Failed</span>
            <span className="kpi-sub muted small">{run.tests.flakyDefects ? `${run.tests.flakyDefects} flaky, reproducible` : run.tests.failed ? "real failures" : "none"}</span>
          </div>
          <div className="kpi">
            <strong className="kpi-value">{formatDuration(run.durationMs)}</strong>
            <span className="kpi-label">Duration</span>
            <span className="kpi-sub muted small">on fenvix</span>
          </div>
          <div className="kpi">
            <strong className="kpi-value">{formatMinutes(runMinutes(run).skipped)}</strong>
            <span className="kpi-label">Saved</span>
            <span className="kpi-sub muted small">skipped tests only</span>
          </div>
        </div>
      )}

      {!running && !run.proof && run.tests.notProven > 0 && (
        <div className="callout callout-warning" role="note" id="not-proven-note">
          <p className="callout-row">
            <ShieldQuestion size={16} aria-hidden="true" />
            <span>
              {notProvenSentence(run, null)}
              {unprovenRows.status === "ready" && unprovenRows.data > 0 && (
                <>
                  {" "}
                  <Link to={testsLink} className="row-link">
                    See the {testCount(run.tests.notProven)}
                  </Link>
                </>
              )}
            </span>
          </p>
        </div>
      )}

      {!running && run.proof && <ProofCard run={run} proof={run.proof} testsLink={testsLink} />}

      <Card id="facts" title="Run" description="Where it came from and how it ran.">
        <dl className="facts facts-4">
          <div>
            <dt>Commit</dt>
            <dd className="mono">{shortSha(run.commitSha)}</dd>
          </div>
          <div>
            <dt>{run.pullRequest ? "Pull request" : "Branch"}</dt>
            <dd className="mono break-anywhere">{run.pullRequest ? `#${run.pullRequest} · ${run.branch}` : run.branch}</dd>
          </div>
          <div>
            <dt>Trigger</dt>
            <dd>{triggerLabel(run.trigger)}</dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{formatDateTime(run.startedAt)}</dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd className="mono">{run.seed ?? "collection order"}</dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd className="mono">{run.engineVersion}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{shadow ? "Shadow (trial): every test runs" : "Skip with proof"}</dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{run.region ? REGIONS[run.region].name : "Not recorded"}</dd>
          </div>
          {!running && !shadow && (
            <div>
              <dt>Audit reruns</dt>
              <dd>
                {run.audit.rerun === 0 ? (
                  "None in this run"
                ) : (
                  <>
                    {formatCount(run.audit.rerun)} skipped {run.audit.rerun === 1 ? "test" : "tests"} ran again,{" "}
                    <span className={run.audit.wrongSkips ? "fail-count" : undefined}>
                      {formatCount(run.audit.wrongSkips)} wrong {run.audit.wrongSkips === 1 ? "skip" : "skips"}
                    </span>
                  </>
                )}
              </dd>
            </div>
          )}
        </dl>
        {!running && (
          <>
            <p className="minute-line" id="run-minutes">
              On a GitHub-hosted runner: <MinuteSum m={runMinutes(run)} decimals={1} />
            </p>
            <p className="muted small">{SAVED_NOTE}</p>
          </>
        )}
      </Card>

      <Card id="suite" title="Test suite" description="Each square is a test file.">
        {running ? <p className="muted">The files of the suite show once the run has finished.</p> : files.status === "ready" ? files.data.length ? <SuiteSquares files={files.data} /> : <p className="muted">No tests recorded for this run.</p> : <ChartSkeleton height={120} />}
      </Card>

      <Card
        id="tests"
        title="Tests"
        description={`Every test of the run: it ran (passed or failed${run.tests.notProven ? ", or not proven identical to the serial run" : ""}) or it was skipped with proof. Open a receipt to see what was checked.`}
        actions={
          <div className="card-controls">
            <Segmented
              label="Outcome"
              value={outcome}
              onChange={(v) => set({ outcome: v === "all" ? null : v, page: null })}
              className="seg-sm"
              options={[
                { value: "all", label: "All" },
                { value: "failed", label: "Failed", count: counts ? formatCount(counts.failed) : undefined },
                { value: "passed", label: "Passed", count: counts ? formatCount(counts.passed) : undefined },
                { value: "skipped_with_proof", label: "Skipped", count: counts ? formatCount(counts.skipped_with_proof) : undefined },
                { value: "not_proven", label: "Not proven", count: counts ? formatCount(counts.not_proven) : undefined },
              ]}
            />
          </div>
        }
      >
        <SearchInput aria-label="Search tests" placeholder="Search by test id" value={search} onChange={(e) => setSearch(e.target.value)} />
        {tests.status === "loading" && <ListSkeleton rows={8} />}
        {tests.status === "error" && <Message role="alert">{tests.message}</Message>}
        {tests.status === "ready" && (
          <>
            {running ? (
              <p className="muted">Per-test results arrive when the run finishes.</p>
            ) : tests.data.items.length === 0 ? (
              <p className="muted">No test matches.</p>
            ) : (
              <ul className="test-list">
                {tests.data.items.map((t) => (
                  <li key={t.testId} className="test-row" data-outcome={t.outcome}>
                    <div className="test-main">
                      <span className="mono break-anywhere test-id">{t.testId}</span>
                      <span className="test-meta">
                        <OutcomePill outcome={t.outcome} flaky={t.failure?.kind === "flaky_defect"} cause={t.notProvenCause} />
                        <span className="muted small mono">{formatDuration(t.durationMs)}</span>
                        {t.receiptId && (
                          <button type="button" className="btn btn-xs" onClick={() => set({ receipt: t.receiptId })} aria-label={`Receipt for ${t.testId}`}>
                            Receipt
                          </button>
                        )}
                      </span>
                    </div>
                    {t.outcome === "not_proven" && (
                      <p className="small muted test-cause">
                        Not proven identical to the serial run: {t.notProvenCause ?? `${NO_CAUSE.toLowerCase()}`}. Its serial result is the one reported.
                      </p>
                    )}
                    {t.failure && (
                      <div className="test-failure">
                        <p className="mono small break-anywhere">
                          {t.failure.message} <span className="muted">({t.failure.phase}, {t.failure.location})</span>
                        </p>
                        {t.failure.kind === "flaky_defect" && t.failure.defectId ? (
                          <p className="small">
                            Flaky, and reproducible:{" "}
                            <Link to={`/defects/${t.failure.defectId}`} className="row-link">
                              open the defect and its replay command
                            </Link>
                          </p>
                        ) : (
                          <p className="small muted">A real failure: it fails on this commit in every order fenvix tried.</p>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Pagination page={page} pageSize={PAGE_SIZE} total={tests.data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>

      <ConfirmDialog open={!!receiptId} title="Skipped with proof" confirmLabel="Close" hideCancel wide onConfirm={() => set({ receipt: null })} onCancel={() => set({ receipt: null })}>
        {receipt.status === "loading" && <Message>Loading the receipt</Message>}
        {receipt.status === "error" && <Message role="alert">{receipt.message}</Message>}
        {receipt.status === "ready" && receipt.data && (
          <>
            <p className="mono break-anywhere receipt-test">{receipt.data.testId}</p>
            <ReceiptBody r={receipt.data} projectId={projectId} />
          </>
        )}
        {receipt.status === "ready" && !receipt.data && <Message role="alert">This receipt does not exist.</Message>}
      </ConfirmDialog>
    </>
  );
}
