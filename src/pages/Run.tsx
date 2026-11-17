import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { client, type SkipReceipt, type TestOutcome } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { OutcomePill, triggerLabel } from "../components/ci";
import { RunStatusPill } from "../components/StateBadge";
import { Pagination } from "../components/Pagination";
import { Segmented } from "../components/Segmented";
import { SearchInput } from "../components/SearchInput";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useProjectTitle } from "../components/Shell";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatDateTime, formatDuration, formatMinutes, formatPercent, shortSha } from "../lib/format";
import { setupSnippet } from "../data/ci";
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

export function RunPage() {
  const { projectId = "", runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const outcome = (["passed", "failed", "skipped_with_proof"].includes(params.get("outcome") ?? "") ? params.get("outcome") : "all") as TestOutcome | "all";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const receiptId = params.get("receipt");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const data = useAsync(() => client.getRun(runId), [runId]);
  const q = params.get("q") ?? "";
  const tests = useAsync(() => client.listTestResults(runId, { outcome, search: q, page, pageSize: PAGE_SIZE }), [runId, outcome, q, page]);
  const receipt = useAsync(() => (receiptId ? client.getSkipReceipt(receiptId) : Promise.resolve(null)), [receiptId]);
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

  if (data.status === "loading") return <Message>Loading run</Message>;
  if (data.status === "error") return <Message role="alert">{data.message}</Message>;
  if (!data.data || data.data.run.projectId !== projectId)
    return (
      <div className="empty not-found">
        <h1>Run not found</h1>
        <Link to={`/projects/${projectId}`} className="btn btn-primary">
          Back to the project
        </Link>
      </div>
    );
  const { run } = data.data;
  const counts = tests.status === "ready" ? tests.data.counts : null;

  return (
    <>
      <PageHeader
        back={
          <Link to={`/projects/${projectId}`} className="back-link">
            ← {data.data.project.fullName}
          </Link>
        }
        title={`Run #${run.number}`}
        meta={<RunStatusPill status={run.status} />}
        description={
          <>
            <span className="mono">{shortSha(run.commitSha)}</span> {run.commitMessage}
          </>
        }
      />

      <div className="kpis">
        <div className="kpi">
          <strong className="kpi-value">{formatCount(run.tests.total)}</strong>
          <span className="kpi-label">Tests</span>
          <span className="kpi-sub muted small">in the suite</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatCount(run.tests.ran)}</strong>
          <span className="kpi-label">Ran</span>
          <span className="kpi-sub muted small">{formatCount(run.tests.passed)} passed</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatCount(run.tests.skippedWithProof)}</strong>
          <span className="kpi-label">Skipped with proof</span>
          <span className="kpi-sub muted small">{formatPercent(run.skipShare)} of test time</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatCount(run.tests.failed)}</strong>
          <span className="kpi-label">Failed</span>
          <span className="kpi-sub muted small">{run.tests.flakyDefects ? `${run.tests.flakyDefects} flaky, reproducible` : run.tests.failed ? "real failures" : "none"}</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatDuration(run.durationMs)}</strong>
          <span className="kpi-label">Duration</span>
          <span className="kpi-sub muted small">{formatMinutes(run.githubEquivalentMinutes)} before fenvix</span>
        </div>
        <div className="kpi">
          <strong className="kpi-value">{formatMinutes(run.minutesSaved)}</strong>
          <span className="kpi-label">Saved</span>
          <span className="kpi-sub muted small">test time not run again</span>
        </div>
      </div>

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
        </dl>
      </Card>

      <Card
        id="tests"
        title="Tests"
        description="Every test of the run: it ran (passed or failed) or it was skipped with proof. Open a receipt to see what was checked."
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
              ]}
            />
          </div>
        }
      >
        <SearchInput aria-label="Search tests" placeholder="Search by test id" value={search} onChange={(e) => setSearch(e.target.value)} />
        {tests.status === "loading" && <Message>Loading tests</Message>}
        {tests.status === "error" && <Message role="alert">{tests.message}</Message>}
        {tests.status === "ready" && (
          <>
            {tests.data.items.length === 0 ? (
              <p className="muted">No test matches.</p>
            ) : (
              <ul className="test-list">
                {tests.data.items.map((t) => (
                  <li key={t.testId} className="test-row" data-outcome={t.outcome}>
                    <div className="test-main">
                      <span className="mono break-anywhere test-id">{t.testId}</span>
                      <span className="test-meta">
                        <OutcomePill outcome={t.outcome} flaky={t.failure?.kind === "flaky_defect"} />
                        <span className="muted small mono">{formatDuration(t.durationMs)}</span>
                        {t.receiptId && (
                          <button type="button" className="btn btn-xs" onClick={() => set({ receipt: t.receiptId })} aria-label={`Receipt for ${t.testId}`}>
                            Receipt
                          </button>
                        )}
                      </span>
                    </div>
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
