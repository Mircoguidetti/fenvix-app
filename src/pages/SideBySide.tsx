import { useEffect, useState } from "react";
import { client, type ProjectRow, type SideBySidePair, type SideBySideResult } from "../data";
import { Card } from "../components/PageHeader";
import { ListSkeleton } from "../components/Skeleton";
import { Pagination } from "../components/Pagination";
import { StatusPill } from "../components/StateBadge";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatDuration, shortSha } from "../lib/format";

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n < 0.1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const usdRange = (r: { min: number; max: number } | null | undefined) => (!r ? "—" : r.min === r.max ? usd(r.min) : `${usd(r.min)}–${usd(r.max).slice(1)}`);
const dur = (s: number | null | undefined) => (s === null || s === undefined ? "—" : formatDuration(s * 1000));

const RESULT: Record<SideBySideResult, { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  same: { label: "Same result", tone: "ok" },
  different: { label: "Different", tone: "danger" },
  not_comparable: { label: "Not comparable", tone: "neutral" },
  not_proven: { label: "Not proven", tone: "warn" },
  waiting: { label: "Waiting", tone: "neutral" },
};

function Event({ p }: { p: SideBySidePair }) {
  return <span className="muted small">{p.event === "pull_request" && p.prNumber ? `pull request #${p.prNumber}` : (p.event ?? "event unknown")}</span>;
}

/**
 * Side-by-side runs (spec 20261126-side-by-side-runs, item 22): "Today" (his own test job, the last 30 days) and
 * "Side by side" (per commit and event, his job beside ours, and whether the results agree). Nothing for a project
 * that does not run side by side. No price offer.
 */
export function SideBySideCards({ project }: { project: ProjectRow }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [project.id]);
  const data = useAsync(() => client.getSideBySide(project.id, page), [project.id, page]);
  if (data.status === "loading") return <ListSkeleton rows={3} label="Loading side by side" />;
  // An optional card: a failed request shows nothing (the Runs tab stays as it is for every project).
  if (data.status === "error") return null;
  const d = data.data;
  if (!d.available || !d.today) return null;
  const t = d.today;
  return (
    <div className="side-by-side">
      <Card id="today" title="Today" description={`Your own test job ${d.repository?.jobName ? `(${d.repository.jobName}) ` : ""}on ${t.runnerLabel ?? "its runner"}, the last 30 days.`}>
        <div className="kpis kpis-4">
          <div className="kpi"><span className="kpi-label">Runs per day</span><span className="kpi-value">{t.runsPerDay ?? "—"}</span><span className="muted small">average over 30 days</span></div>
          <div className="kpi"><span className="kpi-label">Median duration</span><span className="kpi-value">{dur(t.medianSeconds)}</span></div>
          <div className="kpi"><span className="kpi-label">Cost per run</span><span className="kpi-value">{usdRange(t.costPerRun)}</span><span className="muted small">{t.price}</span></div>
          <div className="kpi"><span className="kpi-label">Cost per month</span><span className="kpi-value">{usdRange(t.costPerMonth)}</span></div>
        </div>
        <ul className="muted small sbs-notes">
          {t.notes.map((n) => <li key={n}>{n}</li>)}
          {t.history === "reading" && <li>Still reading your last 30 days of runs from GitHub.</li>}
        </ul>
      </Card>
      <Card
        id="side-by-side"
        title="Side by side"
        description={d.header && d.header.pairs
          ? `Last ${d.header.pairs} comparable pairs, medians: yours ${dur(d.header.hisSeconds)} at ${usd(d.header.hisCost)}; ours ${dur(d.header.oursSeconds)}, ${d.header.oursVcpuMinutes ?? "—"} vCPU-minutes, ${usd(d.header.oursMachineCost)} of machine. ${d.header.same} of ${d.header.pairs} gave the same result.`
          : "Per commit and event: your job beside ours on fenvix. Your workflow decides green or red; ours never gates."}
      >
        {d.items.length === 0 && <p className="muted">No pair yet. The first one arrives after the next push or pull request once the side-by-side pull request is merged.</p>}
        {d.items.length > 0 && (
          <>
            <div className="table-card flush">
              <table className="data responsive sbs-table">
                <caption className="sr-only">Side by side</caption>
                <thead>
                  <tr>
                    <th scope="col">Commit</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="num">Yours</th>
                    <th scope="col" className="num">Ours</th>
                    <th scope="col" className="num">Tests run</th>
                    <th scope="col" className="num">Cache would skip</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((p) => (
                    <tr key={`${p.headSha}-${p.event}-${p.prNumber}`}>
                      <td data-label="Commit">
                        <span className="name-cell">
                          <span className="mono">{shortSha(p.headSha)}{p.ours?.checkoutSha && p.ours.checkoutSha !== p.headSha ? ` (tested ${shortSha(p.ours.checkoutSha)})` : ""}</span>
                          <Event p={p} />
                        </span>
                      </td>
                      <td data-label="Result">
                        <span className="name-cell">
                          <StatusPill tone={RESULT[p.result].tone}>{RESULT[p.result].label}</StatusPill>
                          <span className="muted small">{p.detail}</span>
                          {p.notes.map((n) => <span key={n} className="muted small">{n}</span>)}
                        </span>
                      </td>
                      <td data-label="Yours" className="num">
                        <span className="name-cell">{dur(p.his?.seconds)}<span className="muted small">{p.his ? usdRange(p.his.cost) : "not seen"}</span></span>
                      </td>
                      <td data-label="Ours" className="num">
                        <span className="name-cell">{dur(p.ours?.seconds)}<span className="muted small">{p.ours ? `${p.ours.vcpuMinutes} vCPU-min · ${usd(p.ours.machineCost)}` : "not seen"}</span></span>
                      </td>
                      <td data-label="Tests run" className="num">{p.ours ? formatCount(p.ours.testsRan) : "—"}</td>
                      <td data-label="Cache would skip" className="num">
                        {p.ours ? <span className="name-cell">{formatCount(p.ours.wouldSkipTests)}<span className="muted small">{formatDuration(p.ours.wouldSaveMs)}</span></span> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
