import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { formatCompact, formatCount } from "../lib/format";

/** The time span of a chart: hourly buckets for "24h", daily ticks otherwise. */
export type UsageRange = "24h" | "7d" | "30d";

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
  return (n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p;
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
  tip,
}: {
  width: number;
  height: number;
  label: string;
  children: ReactNode;
  summary?: ReactNode;
  tip?: ReactNode;
}) {
  return (
    <div className="chart">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {children}
      </svg>
      {tip}
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

/**
 * Drops any label that would sit on top of the one before it. Two day boundaries can fall a
 * bucket apart when a series starts just before midnight, and both would land in the same place.
 */
export function spaceOut<T>(items: T[], at: (item: T) => number, width: (item: T) => number): T[] {
  const out: T[] = [];
  let lastRight = -Infinity;
  for (const item of items) {
    const half = width(item) / 2;
    if (at(item) - half < lastRight + 8) continue;
    out.push(item);
    lastRight = at(item) + half;
  }
  return out;
}

const labelWidth = (label: string) => label.length * 6.7;

/** X labels, with the first and last pulled inside the box so they are never cut off. */
function axis(ticks: { index: number; label: string }[], count: number, inner: { x: number; y: number; w: number; h: number }, height: number, band: boolean) {
  const step = inner.w / Math.max(count, 1);
  const placed = ticks.map((t) => {
    const x = inner.x + t.index * step + (band ? step / 2 : 0);
    const half = labelWidth(t.label) / 2;
    const anchor: "start" | "end" | "middle" = x - half < inner.x - 6 ? "start" : x + half > inner.x + inner.w + 6 ? "end" : "middle";
    const at = anchor === "start" ? Math.max(x - half, inner.x - 6) + half : anchor === "end" ? Math.min(x + half, inner.x + inner.w + 6) - half : x;
    return { ...t, at, anchor };
  });
  return spaceOut(placed, (t) => t.at, (t) => labelWidth(t.label)).map((t) => (
    <text key={t.index} x={t.anchor === "start" ? t.at - labelWidth(t.label) / 2 : t.anchor === "end" ? t.at + labelWidth(t.label) / 2 : t.at} y={height - 8} textAnchor={t.anchor} className="chart-text">
      {t.label}
    </text>
  ));
}

/**
 * The light silver fill under a chart line: mid grey at the top fading through light grey to nothing. A gradient needs
 * an id, so each chart draws its own. The stops take their colours from the silver tokens in styles.css.
 */
function useSilverFill(): [ReactNode, { fill: string }] {
  const id = `silver-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const defs = (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className="silver-stop-1" />
        <stop offset="0.55" className="silver-stop-2" />
        <stop offset="1" className="silver-stop-3" />
      </linearGradient>
    </defs>
  );
  return [defs, { fill: `url(#${id})` }];
}

const PAD: Plot = { left: 52, top: 12, right: 14, bottom: 26 };

/** What a tooltip shows: a heading (the time or the bucket) and one row per value. */
export interface Tip {
  title: string;
  rows: { label?: string; value: string; swatch?: string; dash?: boolean }[];
}

type Inner = { x: number; y: number; w: number; h: number };

/**
 * Hover for a chart, the way every dashboard does it: move over the chart (or tap it on a phone) and the nearest point is
 * marked and its values show in a small card. `band` is for bars, where each point owns a slot; otherwise points sit on
 * the slot edges, as on a line.
 */
export function useChartHover(count: number, inner: Inner, band: boolean) {
  const [active, setActive] = useState<number | null>(null);
  const pick = (e: React.PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg || count === 0) return;
    const r = svg.getBoundingClientRect();
    const scale = r.width > 0 ? svg.viewBox.baseVal.width / r.width : 1;
    const px = (e.clientX - r.left) * scale - inner.x;
    const i = band ? Math.floor((px / inner.w) * count) : Math.round((px / inner.w) * (count - 1));
    setActive(Math.max(0, Math.min(count - 1, i)));
  };
  const at = (i: number) => (band ? inner.x + (i + 0.5) * (inner.w / Math.max(count, 1)) : inner.x + (i / Math.max(count - 1, 1)) * inner.w);
  const overlay = (
    <rect
      x={inner.x}
      y={inner.y}
      width={inner.w}
      height={inner.h}
      fill="transparent"
      className="chart-hit"
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={(e) => e.pointerType !== "touch" && setActive(null)}
    />
  );
  const guide = active === null ? null : band ? (
    <rect x={at(active) - inner.w / Math.max(count, 1) / 2} y={inner.y} width={inner.w / Math.max(count, 1)} height={inner.h} className="chart-hover-band" />
  ) : (
    <line x1={at(active)} x2={at(active)} y1={inner.y} y2={inner.y + inner.h} className="chart-guide" />
  );
  return { active, at, overlay, guide };
}

/** The card next to the hovered point. It flips to the left of the point in the right half, so it never leaves the box. */
export function ChartTip({ tip, x, width, top = 8 }: { tip: Tip | null; x: number; width: number; top?: number }) {
  if (!tip) return null;
  const right = x > width / 2;
  return (
    <div className="chart-tip" role="status" style={right ? { right: width - x + 12, top } : { left: x + 12, top }}>
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="chart-tip-row">
          {r.swatch && <span className={r.dash ? "chart-tip-key chart-tip-key-dash" : "chart-tip-key"} style={r.dash ? undefined : { background: r.swatch }} aria-hidden="true" />}
          {r.label && <span className="chart-tip-label">{r.label}</span>}
          <span className="chart-tip-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Filled area for the awake count with the fleet total as a thin line above it. */
export function AwakeAreaChart({ points, range }: { points: { at: string; awake: number; total: number }[]; range: UsageRange }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [silverDefs, silver] = useSilverFill();
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
  const hover = useChartHover(points.length, inner, false);
  const a = hover.active === null ? null : points[hover.active];

  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        tip={a && <ChartTip x={hover.at(hover.active!)} width={width} tip={{ title: pointLabel(a.at, range), rows: [{ label: "Awake", value: formatCount(a.awake), swatch: "var(--chart)" }, { label: "Fleet", value: formatCount(a.total) }] }} />}
        label={`Awake databases over time: between ${low} and ${peak} of ${total}.`}
        summary={`Between ${formatCount(low)} and ${formatCount(peak)} awake, at most ${share}% of the ${formatCount(total)} databases in the fleet.`}
      >
        {grid(max, inner, formatCompact)}
        {silverDefs}
        <path d={area} className="chart-area" style={silver} />
        {hover.guide}
        <path d={points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.awake)}`).join(" ")} className="chart-line" fill="none" />
        {a && <circle cx={x(hover.active!)} cy={y(a.awake)} r="4" className="chart-hover-dot" />}
        {axis(timeTicks(points.map((p) => p.at), range, Math.max(2, Math.floor(inner.w / 80))), points.length - 1, inner, height, false)}
        {hover.overlay}
      </Frame>
    </div>
  );
}

/** A filled area over time, for a value that moves slowly, such as storage. */
export function AreaSeriesChart({ points, range, valueLabel, axisLabel = valueLabel }: { points: { at: string; value: number }[]; range: UsageRange; valueLabel: (n: number) => string; axisLabel?: (n: number) => string }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [silverDefs, silver] = useSilverFill();
  const height = 220;
  const max = niceMax(Math.max(...points.map((p) => p.value), 1));
  const left = leftPad(max, axisLabel);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const x = (i: number) => inner.x + (i / Math.max(points.length - 1, 1)) * inner.w;
  const y = (v: number) => inner.y + inner.h - (v / max) * inner.h;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.value)}`).join(" ");
  const first = points[0]?.value ?? 0;
  const last = points[points.length - 1]?.value ?? 0;
  const hover = useChartHover(points.length, inner, false);
  const a = hover.active === null ? null : points[hover.active];

  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        tip={a && <ChartTip x={hover.at(hover.active!)} width={width} tip={{ title: pointLabel(a.at, range), rows: [{ value: valueLabel(a.value), swatch: "var(--chart)" }] }} />}
        label={`From ${valueLabel(first)} to ${valueLabel(last)} over the period.`}
        summary={`From ${valueLabel(first)} to ${valueLabel(last)} over the period.`}
      >
        {grid(max, inner, axisLabel)}
        {silverDefs}
        <path d={`${line} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} className="chart-area" style={silver} />
        {hover.guide}
        <path d={line} className="chart-line" fill="none" />
        {a && <circle cx={x(hover.active!)} cy={y(a.value)} r="4" className="chart-hover-dot" />}
        {axis(timeTicks(points.map((p) => p.at), range, Math.max(2, Math.floor(inner.w / 80))), points.length - 1, inner, height, false)}
        {hover.overlay}
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
  const barW = Math.max(2, Math.min(12, step * 0.4));
  const total = points.reduce((a, p) => a + p.value, 0);
  const hover = useChartHover(points.length, inner, true);
  const a = hover.active === null ? null : points[hover.active];

  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        tip={a && <ChartTip x={hover.at(hover.active!)} width={width} tip={{ title: pointLabel(a.at, range), rows: [{ value: valueLabel(a.value), swatch: "var(--chart)" }] }} />}
        label={`${valueLabel(total)} in total over the period.`}
        summary={`${valueLabel(total)} in total, peak ${valueLabel(Math.max(...points.map((p) => p.value)))} in one ${bucketNoun ?? (range === "24h" ? "hour" : "day")}.`}
      >
        {grid(max, inner, formatCompact)}
        {hover.guide}
        {points.map((p, i) => {
          const h = (p.value / max) * inner.h;
          return (
            <rect key={p.at} x={inner.x + i * step + (step - barW) / 2} y={inner.y + inner.h - h} width={barW} height={Math.max(h, p.value > 0 ? 1.5 : 0)} rx="2" className="chart-bar" />
          );
        })}
        {axis(timeTicks(points.map((p) => p.at), range, Math.max(2, Math.floor(inner.w / 80))), points.length, inner, height, true)}
        {hover.overlay}
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
  const hover = useChartHover(points.length, inner, false);
  const a = hover.active === null ? null : points[hover.active];
  const costRows: Tip["rows"] = a
    ? [
        ...(a.cost > 0 ? [{ label: "This month", value: format(a.cost), swatch: "var(--chart)" }] : []),
        ...(a.reference !== null ? [{ label: "Month before", value: format(a.reference), swatch: "var(--ink-2)", dash: true }] : []),
      ]
    : [];

  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        tip={a && costRows.length > 0 && <ChartTip x={hover.at(hover.active!)} width={width} tip={{ title: dayLabel(a.at), rows: costRows }} />}
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
        {hover.guide}
        <path d={path(points.map((p) => p.reference))} className="chart-line-dash" fill="none" />
        <path d={path(points.map((p) => (p.cost > 0 ? p.cost : null)))} className="chart-line" fill="none" />
        {last && <circle cx={x(live.length - 1)} cy={y(last.cost)} r="3.5" className="chart-dot" />}
        {a && a.reference !== null && <circle cx={x(hover.active!)} cy={y(a.reference)} r="3.5" className="chart-hover-dot chart-hover-dot-ref" />}
        {a && a.cost > 0 && <circle cx={x(hover.active!)} cy={y(a.cost)} r="4" className="chart-hover-dot" />}
        {axis(timeTicks(points.map((p) => p.at), "30d", Math.max(2, Math.floor(inner.w / 70))), points.length - 1, inner, height, false)}
        {hover.overlay}
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
  const hover = useChartHover(days.length, inner, true);
  const ai = hover.active;

  return (
    <div ref={ref}>
      <div className="chart">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Requests per day split by tag. ${valueLabel(totals.reduce((a, b) => a + b, 0))} in the month.`}>
          {grid(max, inner, formatCompact)}
          {hover.guide}
          {days.map((day, i) => {
            let y = inner.y + inner.h;
            return (
              <g key={day}>
                {series.map((s, si) => {
                  const h = ((s.values[i] ?? 0) / max) * inner.h;
                  y -= h;
                  return <rect key={s.label} x={inner.x + i * step + (step - barW) / 2} y={y} width={barW} height={Math.max(h, 0)} fill={shade(si)} />;
                })}
              </g>
            );
          })}
          {axis(timeTicks(days, "30d", Math.max(2, Math.floor(inner.w / 70))), days.length, inner, height, true)}
          {hover.overlay}
        </svg>
        {ai !== null && (
          <ChartTip
            x={hover.at(ai)}
            width={width}
            tip={{
              title: dayLabel(days[ai]),
              rows: [...series.map((s, si) => ({ label: s.label, value: valueLabel(s.values[ai] ?? 0), swatch: shade(si) })), { label: "Total", value: valueLabel(totals[ai] ?? 0) }],
            }}
          />
        )}
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
  const [ref, width] = useMeasure<HTMLDivElement>(200);
  const awakeCount = points.filter((p) => p.awake).length;
  const share = Math.round((awakeCount / Math.max(points.length, 1)) * 100);
  const [active, setActive] = useState<number | null>(null);
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || points.length === 0) return;
    setActive(Math.max(0, Math.min(points.length - 1, Math.floor(((e.clientX - r.left) / r.width) * points.length))));
  };
  const ap = active === null ? null : points[active];
  const ticks = spaceOut(
    timeTicks(points.map((p) => p.at), range, Math.max(2, Math.floor(width / 90))).map((t) => {
      const pct = (t.index / Math.max(points.length - 1, 1)) * 100;
      const w = t.label.length * 6.7;
      // The first and last labels are pulled inside the box, so place them by their real edges.
      const at = pct < 6 ? w / 2 : pct > 94 ? width - w / 2 : (pct / 100) * width;
      return { ...t, pct, at, w };
    }),
    (t) => t.at,
    (t) => t.w,
  );
  return (
    <div className="timeline" ref={ref}>
      <div className="timeline-wrap">
        <div
          className="timeline-bar"
          role="img"
          aria-label={`Awake for ${share} percent of the last ${range}.`}
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={(e) => e.pointerType !== "touch" && setActive(null)}
        >
          {points.map((p, i) => (
            <span key={p.at} className={p.awake ? "tl-on" : "tl-off"} data-active={i === active || undefined} />
          ))}
        </div>
        {ap && (
          <ChartTip
            x={((active! + 0.5) / points.length) * width}
            width={width}
            top={44}
            tip={{ title: pointLabel(ap.at, range), rows: [{ value: ap.awake ? "Awake" : "Asleep", swatch: ap.awake ? "var(--chart)" : "var(--surface-2)" }] }}
          />
        )}
      </div>
      <div className="timeline-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t.index} style={t.pct < 6 ? { left: 0 } : t.pct > 94 ? { right: 0 } : { left: `${t.pct}%`, transform: "translateX(-50%)" }}>
            {t.label}
          </span>
        ))}
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
  const [silverDefs, silver] = useSilverFill();
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
      {silverDefs}
      <path d={`${line} L${W} ${H} L0 ${H} Z`} className="spark-area" style={silver} />
      <path d={line} className="spark-line" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One bar per month, with the running month marked as not finished yet. */
export function MonthBars({ months, format }: { months: { label: string; value: number; partial?: boolean }[]; format: (n: number) => string }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const height = 230;
  const max = niceMax(Math.max(...months.map((m) => m.value), 1));
  const left = leftPad(max, format);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const step = inner.w / Math.max(months.length, 1);
  const barW = Math.min(64, step * 0.56);
  const hover = useChartHover(months.length, inner, true);
  const a = hover.active === null ? null : months[hover.active];

  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        tip={a && <ChartTip x={hover.at(hover.active!)} width={width} tip={{ title: a.partial ? `${a.label} (so far)` : a.label, rows: [{ label: "Cost", value: format(a.value), swatch: "var(--chart)" }] }} />}
        label={`Cost by month. This month so far ${format(months[months.length - 1]?.value ?? 0)}.`}
      >
        {grid(max, inner, format)}
        {hover.guide}
        {months.map((m, i) => {
          const h = (m.value / max) * inner.h;
          const x = inner.x + i * step + (step - barW) / 2;
          return (
            <g key={m.label}>
              <rect x={x} y={inner.y + inner.h - h} width={barW} height={Math.max(h, 1.5)} rx="2" className={m.partial ? "chart-bar-open" : "chart-bar"} />
              <text x={x + barW / 2} y={height - 8} textAnchor="middle" className="chart-text">
                {m.label}
              </text>
            </g>
          );
        })}
        {hover.overlay}
      </Frame>
    </div>
  );
}

/**
 * Two lines over time: "Before fenvix" (the project's baseline, dashed) and "With fenvix" (each point), as in the
 * landing's "Time to green, per run". `format` writes a value (seconds, for example).
 */
export function BeforeWithChart({ points, before, format }: { points: { at: string; value: number }[]; before: number | null; format: (n: number) => string }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const [silverDefs, silver] = useSilverFill();
  const height = 240;
  const max = niceMax(Math.max(...points.map((p) => p.value), before ?? 0, 1) * 1.1);
  const left = leftPad(max, format);
  const inner = { x: left, y: PAD.top, w: Math.max(40, width - left - PAD.right), h: height - PAD.top - PAD.bottom };
  const x = (i: number) => inner.x + (i / Math.max(points.length - 1, 1)) * inner.w;
  const y = (v: number) => inner.y + inner.h - (v / max) * inner.h;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.value)}`).join(" ");
  const hover = useChartHover(points.length, inner, false);
  const a = hover.active === null ? null : points[hover.active];
  const sorted = [...points.map((p) => p.value)].sort((p, q) => p - q);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return (
    <div ref={ref}>
      <Frame
        width={width}
        height={height}
        tip={a && <ChartTip x={hover.at(hover.active!)} width={width} tip={{ title: pointLabel(a.at, "30d"), rows: [{ label: "With fenvix", value: format(a.value), swatch: "var(--chart)" }, ...(before !== null ? [{ label: "Before fenvix", value: format(before), swatch: "var(--ink-2)", dash: true }] : [])] }} />}
        label={`Time to green per commit: median ${format(med)} with fenvix${before !== null ? `, ${format(before)} before` : ""}.`}
        summary={
          <>
            Median {format(med)} with fenvix{before !== null ? `, ${format(before)} before` : ""}.{" "}
            <span className="legend">
              <span className="key key-line" aria-hidden="true" /> With fenvix
              {before !== null && (
                <>
                  <span className="key key-line-dash" aria-hidden="true" /> Before fenvix
                </>
              )}
            </span>
          </>
        }
      >
        {grid(max, inner, format)}
        {silverDefs}
        {points.length > 1 && <path d={`${line} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} className="chart-area" style={silver} />}
        {before !== null && <path d={`M${inner.x} ${y(before)} L${inner.x + inner.w} ${y(before)}`} className="chart-line-dash" fill="none" />}
        {hover.guide}
        <path d={line} className="chart-line" fill="none" />
        {a && <circle cx={x(hover.active!)} cy={y(a.value)} r="4" className="chart-hover-dot" />}
        {axis(timeTicks(points.map((p) => p.at), "30d", Math.max(2, Math.floor(inner.w / 80))), points.length - 1, inner, height, false)}
        {hover.overlay}
      </Frame>
    </div>
  );
}
