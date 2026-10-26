import { useEffect, useRef, useState } from "react";
import type { UsagePoint, UsageRange } from "../data";
import { formatCompact, formatCount, formatStorage } from "../lib/format";

export type Metric = "requests" | "storageMb";

function label(at: string, range: UsageRange) {
  const d = new Date(at);
  return range === "24h"
    ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Bar chart in plain SVG. Sized from its container so text stays readable at 390 px. */
export function UsageChart({ points, metric, range }: { points: UsagePoint[]; metric: Metric; range: UsageRange }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, Math.floor(el.clientWidth))));
    ro.observe(el);
    setWidth(Math.max(240, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const values = points.map((p) => p[metric]);
  const max = niceMax(Math.max(0, ...values));
  const fmt = metric === "requests" ? formatCompact : (n: number) => formatStorage(n);
  const fmtFull = metric === "requests" ? (n: number) => `${formatCount(n)} requests` : formatStorage;

  const h = 220;
  const m = { top: 12, right: 8, bottom: 28, left: metric === "requests" ? 44 : 56 };
  const iw = width - m.left - m.right;
  const ih = h - m.top - m.bottom;
  const step = iw / Math.max(points.length, 1);
  const barW = Math.max(2, step * 0.7);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const labelEvery = Math.ceil(points.length / Math.max(2, Math.floor(iw / 70)));

  const total = values.reduce((a, b) => a + b, 0);
  const peak = Math.max(0, ...values);
  const summary =
    metric === "requests"
      ? `Requests over the last ${range}: ${formatCount(total)} in total, peak ${formatCount(peak)} per bucket.`
      : `Storage over the last ${range}: from ${formatStorage(values[0] ?? 0)} to ${formatStorage(values[values.length - 1] ?? 0)}.`;

  return (
    <div>
      <div ref={wrap} className="chart">
        <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} role="img" aria-label={summary}>
          <title>{summary}</title>
          {ticks.map((t) => {
            const y = m.top + ih - (t / max) * ih;
            return (
              <g key={t}>
                <line x1={m.left} x2={width - m.right} y1={y} y2={y} className="chart-grid" />
                <text x={m.left - 8} y={y + 4} textAnchor="end" className="chart-text">
                  {fmt(t)}
                </text>
              </g>
            );
          })}
          {points.map((p, i) => {
            const bh = (p[metric] / max) * ih;
            const x = m.left + i * step + (step - barW) / 2;
            return (
              <g key={p.at}>
                <rect x={x} y={m.top + ih - bh} width={barW} height={Math.max(bh, p[metric] > 0 ? 1 : 0)} rx={1.5} className="chart-bar">
                  <title>{`${label(p.at, range)}: ${fmtFull(p[metric])}`}</title>
                </rect>
                {i % labelEvery === 0 && (
                  <text x={x + barW / 2} y={h - 8} textAnchor="middle" className="chart-text">
                    {label(p.at, range)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="muted chart-summary">{summary}</p>
      <button type="button" className="btn btn-quiet" aria-expanded={showTable} onClick={() => setShowTable((s) => !s)}>
        {showTable ? "Hide data table" : "Show data table"}
      </button>
      {showTable && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Chart data">
          <table className="plain">
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col" className="num">
                  {metric === "requests" ? "Requests" : "Storage"}
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.at}>
                  <td>{label(p.at, range)}</td>
                  <td className="num mono">{metric === "requests" ? formatCount(p.requests) : formatStorage(p.storageMb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
