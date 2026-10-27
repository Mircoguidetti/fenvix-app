import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { client, type UsageRange } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { CopyButton } from "../components/CopyButton";
import { StateBadge } from "../components/StateBadge";
import { UsageChart, type Metric } from "../components/UsageChart";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatDate, formatDateTime, formatRelative, formatStorage } from "../lib/format";

const RANGES: UsageRange[] = ["24h", "7d", "30d"];
const METRICS: { value: Metric; label: string }[] = [
  { value: "requests", label: "Requests" },
  { value: "storageMb", label: "Storage" },
];

export function DatabaseDetailPage() {
  const { id = "" } = useParams();
  const db = useAsync(() => client.getDatabase(id), [id]);
  const [range, setRange] = useState<UsageRange>("7d");
  const [metric, setMetric] = useState<Metric>("requests");
  const usage = useAsync(() => client.getUsage(id, range), [id, range]);

  const back = (
    <Link to="/" className="back-link">
      <ArrowLeft size={16} aria-hidden="true" />
      All databases
    </Link>
  );

  if (db.status === "loading") return <><PageHeader title="Database" back={back} /><Message>Loading database</Message></>;
  if (db.status === "error") return <><PageHeader title="Database" back={back} /><Message role="alert">{db.message}</Message></>;
  if (!db.data) return <><PageHeader title="Database not found" back={back} /><Message>No database with this id in the sample data.</Message></>;

  const d = db.data;
  const now = client.now();

  return (
    <>
      <PageHeader title={<span className="mono">{d.name}</span>} back={back} actions={<StateBadge state={d.state} />} />

      <div className="grid-2">
        <Card id="conn" title="Connection string" description="Use this in your client. Replace the password placeholder with your own.">
          <label htmlFor="conn-string" className="sr-only">
            Connection string
          </label>
          <textarea id="conn-string" className="code" readOnly rows={3} value={d.connectionString} onFocus={(e) => e.currentTarget.select()} />
          <div className="row-actions">
            <CopyButton value={d.connectionString} what="connection string" />
          </div>
        </Card>

        <Card id="status" title="Status">
          <dl className="facts">
            <div>
              <dt>State</dt>
              <dd>
                <StateBadge state={d.state} />
              </dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd className="mono">{formatStorage(d.storageMb)}</dd>
            </div>
            <div>
              <dt>Requests (24 h)</dt>
              <dd className="mono">{formatCount(d.requests24h)}</dd>
            </div>
            <div>
              <dt>Last active</dt>
              <dd title={formatDateTime(d.lastActiveAt)}>{formatRelative(d.lastActiveAt, now)}</dd>
            </div>
            <div>
              <dt>Region</dt>
              <dd className="mono">{d.region}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDate(d.createdAt)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <Card id="usage" title="Usage over time">
        <div className="chart-controls">
          <div className="seg" role="group" aria-label="Metric">
            {METRICS.map((m) => (
              <button key={m.value} type="button" aria-pressed={metric === m.value} onClick={() => setMetric(m.value)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
          </div>
        </div>
        {usage.status === "loading" && <Message>Loading usage</Message>}
        {usage.status === "error" && <Message role="alert">{usage.message}</Message>}
        {usage.status === "ready" && <UsageChart points={usage.data} metric={metric} range={range} />}
      </Card>

      <div className="grid-2">
        <Card id="forks" title="Forks" description="Create an instant copy of this database for a branch, a test or an agent." />
        <Card id="restore" title="Restore" description="Roll this database back to an earlier point in time." />
      </div>
    </>
  );
}
