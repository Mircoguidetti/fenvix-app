import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UsageRange } from "../data";
import { formatCompact, formatCount } from "../lib/format";

/** Width of a container, so charts size themselves instead of guessing. */
export function useMeasure<T extends HTMLElement>(min = 240): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(min);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(min, Math.floor(el.clientWidth)));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, [min]);
  return [ref, width];
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const DAY_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const HOUR_FMT = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

export const dayLabel = (iso: string) => DAY_FMT.format(new Date(iso));
export const hourLabel = (iso: string) => HOUR_FMT.format(new Date(iso));
export const pointLabel = (iso: string, range: UsageRange) => (range === "24h" ? hourLabel(iso) : `${dayLabel(iso)} ${hourLabel(iso)}`);

/**
 * Ticks for a time axis: whole hours within a day, otherwise the first bucket of each day.
 * Every label is used once, so no label is ever repeated on an axis.
 */
export function timeTicks(times: string[], range: UsageRange, maxTicks: number): { index: number; label: string }[] {
  if (times.length === 0) return [];
  const out: { index: number; label: string }[] = [];
  if (range === "24h") {
    times.forEach((t, index) => {
      const d = new Date(t);
      if (d.getUTCMinutes() === 0) out.push({ index, label: hourLabel(t) });
    });
  } else {
    let lastDay = "";
    times.forEach((t, index) => {
      const day = t.slice(0, 10);
      if (day !== lastDay) {
        lastDay = day;
        out.push({ index, label: dayLabel(t) });
      }
    });
  }
  const step = Math.ceil(out.length / maxTicks);
  return out.filter((_, i) => i % step === 0);
}

function Frame({
  width,
  height,
  label,
  children,
  summary,
}: {
  width: number;
  height: number;
  label: string;
  children: ReactNode;
  summary?: ReactNode;
}) {
  return (
    <div className="chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <title>{label}</title>
        {children}
      </svg>
      {summary && <p className="muted chart-summary">{summary}</p>}
    </div>
  );
}

interface Plot {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Left padding wide enough for the longest y-axis label, so no tick is ever clipped. */
function leftPad(max: number, format: (n: number) => string): number {
  const widest = Math.max(...[0, 0.25, 0.5, 0.75, 1].map((f) => format(f * max).length));
  return Math.ceil(widest * 6.7) + 14;
}

function grid(max: number, inner: { x: number; y: number; w: number; h: number }, format: (n: number) => string) {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const value = f * max;
    const y = inner.y + inner.h - f * inner.h;
    return (
      <g key={f}>
        <line x1={inner.x} x2={inner.x + inner.w} y1={y} y2={y} className="chart-grid" />
        <text x={inner.x - 8} y={y + 4} textAnchor="end" className="chart-text">
          {format(value)}
        </text>
      </g>
    );
  });
}

/** X labels, with the first and last pulled inside the box so they are never cut off. */
function axis(ticks: { index: number; label: string }[], count: number, inner: { x: number; y: number; w: number; h: number }, height: number, band: boolean) {
  const step = inner.w / Math.max(count, 1);
  return ticks.map((t) => {
    const x = inner.x + t.index * step + (band ? step / 2 : 0);
    const half = t.label.length * 3.4;
    const anchor = x - half < inner.x - 6 ? "start" : x + half > inner.x + inner.w + 6 ? "end" : "middle";
    return (
      <text key={t.index} x={anchor === "start" ? Math.max(x - half, inner.x - 6) : anchor === "end" ? Math.min(x + half, inner.x + inner.w + 6) : x} y={height - 8} textAnchor={anchor} className="chart-text">
        {t.label}
      </text>
    );
  });
}

const PAD: Plot = { left: 52, top: 12, right: 14, bottom: 26 };

/** Filled area for the awake count with the fleet total as a thin line above it. */
export function AwakeAreaChart({ points, range }: { points: { at: string; awake: number; total: number }[]; range: UsageRange }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const height = 220;
  const max = niceMax(Math.max(...points.map((p) => p.awake), 1) * 1.15);
  const left = leftPad(max, formatCompact);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const x = (i: number) => inner.x + (i / Math.max(points.length - 1, 1)) * inner.w;
  const y = (v: number) => inner.y + inner.h - (v / max) * inner.h;
  const area = `M${x(0)} ${y(0)} ` + points.map((p, i) => `L${x(i)} ${y(p.awake)}`).join(" ") + ` L${x(points.length - 1)} ${y(0)} Z`;
  const peak = Math.max(...points.map((p) => p.awake));
  const low = Math.min(...points.map((p) => p.awake));
  const total = points[points.length - 1]?.total ?? 0;
  const share = Math.round((peak / Math.max(total, 1)) * 100);

  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        label={`Awake databases over time: between ${low} and ${peak} of ${total}.`}
        summary={`Between ${formatCount(low)} and ${formatCount(peak)} awake, at most ${share}% of the ${formatCount(total)} databases in the fleet.`}
      >
        {grid(max, inner, formatCompact)}
        <path d={area} className="chart-area" />
        <path d={points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.awake)}`).join(" ")} className="chart-line" fill="none" />
        {axis(timeTicks(points.map((p) => p.at), range, Math.max(2, Math.floor(inner.w / 80))), points.length - 1, inner, height, false)}
      </Frame>
    </div>
  );
}

/** A filled area over time, for a value that moves slowly, such as storage. */
export function AreaSeriesChart({ points, range, valueLabel, axisLabel = valueLabel }: { points: { at: string; value: number }[]; range: UsageRange; valueLabel: (n: number) => string; axisLabel?: (n: number) => string }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const height = 220;
  const max = niceMax(Math.max(...points.map((p) => p.value), 1));
  const left = leftPad(max, axisLabel);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const x = (i: number) => inner.x + (i / Math.max(points.length - 1, 1)) * inner.w;
  const y = (v: number) => inner.y + inner.h - (v / max) * inner.h;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.value)}`).join(" ");
  const first = points[0]?.value ?? 0;
  const last = points[points.length - 1]?.value ?? 0;

  return (
    <div ref={ref}>
      <Frame width={width} height={height} label={`From ${valueLabel(first)} to ${valueLabel(last)} over the period.`} summary={`From ${valueLabel(first)} to ${valueLabel(last)} over the period.`}>
        {grid(max, inner, axisLabel)}
        <path d={`${line} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} className="chart-area" />
        <path d={line} className="chart-line" fill="none" />
        {axis(timeTicks(points.map((p) => p.at), range, Math.max(2, Math.floor(inner.w / 80))), points.length - 1, inner, height, false)}
      </Frame>
    </div>
  );
}

/** Bars over time. */
export function TimeBarsChart({
  points,
  range,
  height = 220,
  valueLabel,
  bucketNoun,
}: {
  points: { at: string; value: number }[];
  range: UsageRange;
  height?: number;
  valueLabel: (n: number) => string;
  bucketNoun?: string;
}) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const max = niceMax(Math.max(...points.map((p) => p.value), 1));
  const left = leftPad(max, formatCompact);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const step = inner.w / Math.max(points.length, 1);
  const barW = Math.max(2, Math.min(28, step * 0.62));
  const total = points.reduce((a, p) => a + p.value, 0);

  return (
    <div ref={ref}>
      <Frame width={width} height={height} label={`${valueLabel(total)} in total over the period.`} summary={`${valueLabel(total)} in total, peak ${valueLabel(Math.max(...points.map((p) => p.value)))} in one ${bucketNoun ?? (range === "24h" ? "hour" : "day")}.`}>
        {grid(max, inner, formatCompact)}
        {points.map((p, i) => {
          const h = (p.value / max) * inner.h;
          return (
            <rect key={p.at} x={inner.x + i * step + (step - barW) / 2} y={inner.y + inner.h - h} width={barW} height={Math.max(h, p.value > 0 ? 1.5 : 0)} rx="2" className="chart-bar">
              <title>{`${pointLabel(p.at, range)}: ${valueLabel(p.value)}`}</title>
            </rect>
          );
        })}
        {axis(timeTicks(points.map((p) => p.at), range, Math.max(2, Math.floor(inner.w / 80))), points.length, inner, height, true)}
      </Frame>
    </div>
  );
}

/** Two lines: the running total this month and the month before for reference. */
export function CostLineChart({ points, format, axisFormat }: { points: { at: string; cost: number; reference: number | null }[]; format: (n: number) => string; axisFormat: (n: number) => string }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const height = 220;
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.cost, p.reference ?? 0)), 1));
  const left = leftPad(max, axisFormat);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const x = (i: number) => inner.x + (i / Math.max(points.length - 1, 1)) * inner.w;
  const y = (v: number) => inner.y + inner.h - (v / max) * inner.h;
  const live = points.filter((p) => p.cost > 0);
  const path = (values: (number | null)[]) =>
    values
      .map((v, i) => (v === null ? "" : `${i === 0 || values[i - 1] === null ? "M" : "L"}${x(i)} ${y(v)}`))
      .join(" ")
      .trim();
  const last = live[live.length - 1];

  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        label={`Cost so far this month: ${format(last?.cost ?? 0)}, against the month before.`}
        summary={
          <>
            {format(last?.cost ?? 0)} so far this month.{" "}
            <span className="legend">
              <span className="key key-line" aria-hidden="true" /> This month
              <span className="key key-line-dash" aria-hidden="true" /> Month before
            </span>
          </>
        }
      >
        {grid(max, inner, axisFormat)}
        <path d={path(points.map((p) => p.reference))} className="chart-line-dash" fill="none" />
        <path d={path(points.map((p) => (p.cost > 0 ? p.cost : null)))} className="chart-line" fill="none" />
        {last && <circle cx={x(live.length - 1)} cy={y(last.cost)} r="3.5" className="chart-dot" />}
        {axis(timeTicks(points.map((p) => p.at), "30d", Math.max(2, Math.floor(inner.w / 70))), points.length - 1, inner, height, false)}
      </Frame>
    </div>
  );
}

/** Horizontal bars with a label and a value on each row. */
export function HBars({ rows, format, labelWidth = 150 }: { rows: { id?: string; label: ReactNode; sort: number; value: string }[]; format?: never; labelWidth?: number }) {
  void format;
  const max = Math.max(...rows.map((r) => r.sort), 1);
  return (
    <ul className="hbars" style={{ ["--label-w" as string]: `${labelWidth}px` }}>
      {rows.map((r, i) => (
        <li key={i}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track" aria-hidden="true">
            <span className="hbar-fill" style={{ width: `${Math.max(2, (r.sort / max) * 100)}%` }} />
          </span>
          <span className="hbar-value mono">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Stacked bars: one bar per day, split by series. Greys run from dark to light. */
export function StackedBars({ days, series, valueLabel }: { days: string[]; series: { label: string; values: number[] }[]; valueLabel: (n: number) => string }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const height = 240;
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const left = leftPad(max, formatCompact);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const step = inner.w / Math.max(days.length, 1);
  const barW = Math.max(3, Math.min(26, step * 0.68));
  const shade = (i: number) => `var(--stack-${Math.min(i, 5)})`;

  return (
    <div ref={ref}>
      <div className="chart">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Requests per day split by tag. ${valueLabel(totals.reduce((a, b) => a + b, 0))} in the month.`}>
          <title>{`Requests per day split by tag. ${valueLabel(totals.reduce((a, b) => a + b, 0))} in the month.`}</title>
          {grid(max, inner, formatCompact)}
          {days.map((day, i) => {
            let y = inner.y + inner.h;
            return (
              <g key={day}>
                {series.map((s, si) => {
                  const h = ((s.values[i] ?? 0) / max) * inner.h;
                  y -= h;
                  return <rect key={s.label} x={inner.x + i * step + (step - barW) / 2} y={y} width={barW} height={Math.max(h, 0)} fill={shade(si)}><title>{`${dayLabel(day)}, ${s.label}: ${valueLabel(s.values[i] ?? 0)}`}</title></rect>;
                })}
              </g>
            );
          })}
          {axis(timeTicks(days, "30d", Math.max(2, Math.floor(inner.w / 70))), days.length, inner, height, true)}
        </svg>
      </div>
      <ul className="legend-list">
        {series.map((s, i) => (
          <li key={s.label}>
            <span className="key key-block" style={{ background: shade(i) }} aria-hidden="true" />
            <span className="mono">{s.label}</span>
            <span className="muted">{valueLabel(s.values.reduce((a, b) => a + b, 0))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Awake and asleep stretches over the range, as one bar. */
export function WakeTimeline({ points, range }: { points: { at: string; awake: boolean }[]; range: UsageRange }) {
  const awakeCount = points.filter((p) => p.awake).length;
  const share = Math.round((awakeCount / Math.max(points.length, 1)) * 100);
  const ticks = timeTicks(points.map((p) => p.at), range, 6);
  return (
    <div className="timeline">
      <div className="timeline-bar" role="img" aria-label={`Awake for ${share} percent of the last ${range}.`}>
        {points.map((p) => (
          <span key={p.at} className={p.awake ? "tl-on" : "tl-off"} title={`${pointLabel(p.at, range)}: ${p.awake ? "awake" : "asleep"}`} />
        ))}
      </div>
      <div className="timeline-axis" aria-hidden="true">
        {ticks.map((t) => {
          const pct = (t.index / Math.max(points.length - 1, 1)) * 100;
          // Keep the first and last labels inside the box instead of hanging over the edge.
          const style = pct < 6 ? { left: 0 } : pct > 94 ? { right: 0 } : { left: `${pct}%`, transform: "translateX(-50%)" };
          return (
            <span key={t.index} style={style}>
              {t.label}
            </span>
          );
        })}
      </div>
      <p className="muted chart-summary">
        Awake {share}% of the last {range === "24h" ? "24 hours" : range === "7d" ? "7 days" : "30 days"}, asleep the rest of the time.
      </p>
    </div>
  );
}

/** Small line for a number card. No axes, no labels. */
/** Fills the width it is given. The stroke keeps its weight however far it is stretched. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 100;
  const H = 30;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - min) / span) * (H - 5);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={`${line} L${W} ${H} L0 ${H} Z`} className="spark-area" />
      <path d={line} className="spark-line" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
