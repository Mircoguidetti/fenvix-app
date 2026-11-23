/**
 * Loading states drawn as the shapes of the real layout (F-007): the KPI row, card outlines, chart and list blocks in
 * `--surface-2`, instead of a line of text. They pulse gently, and not at all when the person asked for reduced motion.
 * The words stay for screen readers ("Loading …", role status).
 */
const Bar = ({ w, h = 12 }: { w: string; h?: number }) => <span className="sk-block" style={{ width: w, height: h }} aria-hidden="true" />;

export function KpiSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={count === 4 ? "kpis kpis-4" : "kpis"} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="kpi sk-kpi" key={i}>
          <Bar w="55%" h={13} />
          <Bar w="40%" h={28} />
          <Bar w="70%" h={11} />
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return <span className="sk-block sk-chart" style={{ height }} aria-hidden="true" />;
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="sk-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Bar key={i} w={`${92 - ((i * 17) % 30)}%`} h={14} />
      ))}
    </div>
  );
}

/** A card outline: the heading, a line of description, and a body block. */
export function CardSkeleton({ body = 160 }: { body?: number }) {
  return (
    <div className="card sk-card" aria-hidden="true">
      <Bar w="30%" h={17} />
      <Bar w="55%" h={12} />
      <span className="sk-block" style={{ height: body }} />
    </div>
  );
}

/** A whole page while its data loads: a header, the KPI row and card outlines. */
export function PageSkeleton({ kpis = 6, cards = 2, label = "Loading" }: { kpis?: number; cards?: number; label?: string }) {
  return (
    <div className="sk-page" role="status" data-skeleton="">
      <span className="sr-only">{label}</span>
      <div className="page-header" aria-hidden="true">
        <div className="page-header-main">
          <Bar w="120px" h={12} />
          <Bar w="220px" h={28} />
        </div>
      </div>
      {kpis > 0 && <KpiSkeleton count={kpis} />}
      {Array.from({ length: cards }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}
