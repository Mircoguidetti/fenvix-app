import type { ReactNode } from "react";

/**
 * Loading states drawn as the shapes of the real layout (F-007): the KPI row, card outlines, chart and list blocks in
 * `--surface-2`, instead of a line of text. They pulse gently, and not at all when the person asked for reduced motion.
 * The words stay for screen readers: each skeleton has a "Loading …" status, and its shapes are hidden from them.
 */
const Bar = ({ w, h = 12 }: { w: string; h?: number }) => <span className="sk-block" style={{ width: w, height: h }} aria-hidden="true" />;

function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="sr-only" role="status">
        {label}
      </span>
      {children}
    </>
  );
}

export function KpiSkeleton({ count = 6, label = "Loading the numbers" }: { count?: number; label?: string }) {
  return (
    <Loading label={label}>
      <div className={count === 4 ? "kpis kpis-4" : "kpis"} aria-hidden="true" data-skeleton="">
        {Array.from({ length: count }, (_, i) => (
          <div className="kpi sk-kpi" key={i}>
            <Bar w="55%" h={13} />
            <Bar w="40%" h={28} />
            <Bar w="70%" h={11} />
          </div>
        ))}
      </div>
    </Loading>
  );
}

export function ChartSkeleton({ height = 240, label = "Loading the chart" }: { height?: number; label?: string }) {
  return (
    <Loading label={label}>
      <span className="sk-block sk-chart" style={{ height }} aria-hidden="true" data-skeleton="" />
    </Loading>
  );
}

export function ListSkeleton({ rows = 5, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <Loading label={label}>
      <div className="sk-list" aria-hidden="true" data-skeleton="">
        {Array.from({ length: rows }, (_, i) => (
          <Bar key={i} w={`${92 - ((i * 17) % 30)}%`} h={14} />
        ))}
      </div>
    </Loading>
  );
}

/** A card outline: the heading, a line of description, and a body block. */
export function CardSkeleton({ body = 160 }: { body?: number }) {
  return (
    <div className="card sk-card" aria-hidden="true" data-skeleton="">
      <Bar w="30%" h={17} />
      <Bar w="55%" h={12} />
      <span className="sk-block" style={{ height: body }} />
    </div>
  );
}

/** A whole page while its data loads: a header, the KPI row and card outlines. */
export function PageSkeleton({ kpis = 6, cards = 2, label = "Loading" }: { kpis?: number; cards?: number; label?: string }) {
  return (
    <div className="sk-page" data-skeleton="">
      <span className="sr-only" role="status">
        {label}
      </span>
      <div className="page-header" aria-hidden="true">
        <div className="page-header-main">
          <Bar w="120px" h={12} />
          <Bar w="220px" h={28} />
        </div>
      </div>
      {kpis > 0 && (
        <div className={kpis === 4 ? "kpis kpis-4" : "kpis"} aria-hidden="true">
          {Array.from({ length: kpis }, (_, i) => (
            <div className="kpi sk-kpi" key={i}>
              <Bar w="55%" h={13} />
              <Bar w="40%" h={28} />
              <Bar w="70%" h={11} />
            </div>
          ))}
        </div>
      )}
      {Array.from({ length: cards }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}
