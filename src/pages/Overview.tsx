import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { client, type UsageRange } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { AwakeAreaChart, CostLineChart, HBars, Sparkline, TimeBarsChart } from "../components/charts";
import { useAsync } from "../lib/useAsync";
import { useWorkspaceVersion } from "../lib/workspace";
import { formatCompact, formatCount, formatMoney, formatRelative } from "../lib/format";

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
];

const gb = (n: number) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: n >= 100 ? 0 : 1 }).format(n)} GB`;

function Kpi({ label, value, sub, spark }: { label: string; value: string; sub: string; spark: number[] }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value mono">{value}</strong>
      <span className="kpi-sub muted small">{sub}</span>
      <div className="kpi-spark">
        <Sparkline values={spark} />
      </div>
    </div>
  );
}

export function OverviewPage() {
  const [params, setParams] = useSearchParams();
  const range = (RANGES.find((r) => r.value === params.get("range"))?.value ?? "7d") as UsageRange;
  const [tagKey, setTagKey] = useState("customer");
  const [metric, setMetric] = useState<"requests" | "storageGb">("requests");

  const version = useWorkspaceVersion();
  const settings = useAsync(() => client.getSettings(), [version]);
  const data = useAsync(() => client.getOverview(range), [range]);
  const tags = useAsync(() => client.listTags(), []);
  const breakdown = useAsync(() => client.getTagBreakdown(tagKey, 8), [tagKey]);
  const tagKeys = useMemo(() => (tags.status === "ready" ? [...new Set(tags.data.map((t) => t.key))] : []), [tags]);
  const now = client.now();

  const setRange = (next: UsageRange) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "7d") p.delete("range");
        else p.set("range", next);
        return p;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader
        title={settings.status === "ready" ? settings.data.workspaceName : "Overview"}
        description="Your fleet right now: what is awake, what it serves and what it costs."
        actions={
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.value} type="button" aria-pressed={range === r.value} onClick={() => setRange(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      {data.status === "loading" && <Message>Loading overview</Message>}
      {data.status === "error" && <Message role="alert">{data.message}</Message>}
      {data.status === "ready" && (
        <>
          <div className="kpis">
            <Kpi label="Databases" value={formatCount(data.data.totals.databases)} sub="in this workspace" spark={data.data.sparks.databases} />
            <Kpi label="Awake now" value={formatCount(data.data.totals.awake)} sub={`${100 - data.data.totals.asleepPercent}% of the fleet`} spark={data.data.sparks.awake} />
            <Kpi label="Asleep" value={formatCount(data.data.totals.asleep)} sub={`${data.data.totals.asleepPercent}% of the fleet`} spark={data.data.sparks.awake.map((v) => data.data.totals.databases - v)} />
            <Kpi label="Requests" value={formatCompact(data.data.totals.requests)} sub={`last ${range === "24h" ? "24 hours" : range === "7d" ? "7 days" : "30 days"}`} spark={data.data.sparks.requests} />
            <Kpi label="Storage" value={gb(data.data.totals.storageGb)} sub="across the fleet" spark={data.data.sparks.storageGb} />
            <Kpi label="Month to date" value={formatMoney(data.data.totals.costMtd, data.data.totals.currency)} sub="October so far" spark={data.data.sparks.cost} />
          </div>

          <div className="grid-2 even">
            <Card id="awake" title="Awake databases" description="How much of the fleet is serving requests at any moment.">
              <AwakeAreaChart points={data.data.awakeSeries} range={range} />
            </Card>
            <Card id="requests" title="Requests" description="Requests answered across the fleet.">
              <TimeBarsChart points={data.data.requestSeries.map((p) => ({ at: p.at, value: p.requests }))} range={range} valueLabel={(n) => `${formatCount(n)} requests`} />
            </Card>
          </div>

          <div className="grid-2 even">
            <Card id="cost" title="Cost this month" description="Running total against the same days of September.">
              <CostLineChart points={data.data.costSeries} format={(n) => formatMoney(n, data.data.totals.currency)} axisFormat={(n) => `$${formatCount(Math.round(n))}`} />
            </Card>
            <Card
              id="by-tag"
              title="By tag"
              description="Which part of the fleet uses what."
              actions={
                <div className="card-controls">
                  <label className="sr-only" htmlFor="ov-key">
                    Tag key
                  </label>
                  <select id="ov-key" value={tagKey} onChange={(e) => setTagKey(e.target.value)}>
                    {tagKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <div className="seg seg-sm" role="group" aria-label="Metric">
                    <button type="button" aria-pressed={metric === "requests"} onClick={() => setMetric("requests")}>
                      Requests
                    </button>
                    <button type="button" aria-pressed={metric === "storageGb"} onClick={() => setMetric("storageGb")}>
                      Storage
                    </button>
                  </div>
                </div>
              }
            >
              {breakdown.status === "ready" && breakdown.data.length > 0 ? (
                <HBars
                  labelWidth={128}
                  rows={breakdown.data.map((r) => ({
                    label: <span className="mono">{r.value}</span>,
                    sort: metric === "requests" ? r.requests : r.storageGb,
                    value: metric === "requests" ? formatCompact(r.requests) : gb(r.storageGb),
                  }))}
                />
              ) : (
                <Message>Loading tags</Message>
              )}
            </Card>
          </div>

          <div className="grid-2 even">
            <Card id="top" title="Top databases" description="Busiest databases in the last 24 hours.">
              <HBars
                labelWidth={170}
                rows={data.data.topDatabases.map((d) => ({
                  label: (
                    <Link to={`/databases/${d.id}`} className="row-link mono">
                      {d.name}
                    </Link>
                  ),
                  sort: d.requests,
                  value: formatCompact(d.requests),
                }))}
              />
            </Card>
            <Card id="wakeups" title="Recent wake-ups" description="Databases that woke on a request, and how long that first request waited.">
              <div className="table-card flush">
                <table className="data responsive">
                  <caption className="sr-only">Recent wake-ups</caption>
                  <thead>
                    <tr>
                      <th scope="col">Database</th>
                      <th scope="col">Woke</th>
                      <th scope="col" className="num">
                        First request
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.recentWakeUps.map((w) => (
                      <tr key={w.id}>
                        <td data-label="Database">
                          <Link to={`/databases/${w.id}`} className="row-link mono">
                            {w.name}
                          </Link>
                        </td>
                        <td data-label="Woke" className="muted">
                          {formatRelative(w.at, now)}
                        </td>
                        <td data-label="First request" className="num mono">
                          {w.latencyMs} ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
