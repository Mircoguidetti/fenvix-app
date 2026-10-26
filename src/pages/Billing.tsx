import { client } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { useAsync } from "../lib/useAsync";
import { formatCount, formatMoney } from "../lib/format";
import { Link } from "react-router-dom";

export function BillingPage() {
  const data = useAsync(() => client.getBilling(), []);

  return (
    <>
      <PageHeader title="Usage and billing" description="Usage per database and the total for the period. All amounts below are fake and are not a price list." />
      {data.status === "loading" && <Message>Loading usage</Message>}
      {data.status === "error" && <Message role="alert">{data.message}</Message>}
      {data.status === "ready" && (
        <>
          <div className="stats">
            <div className="stat card">
              <span className="muted">Total (sample)</span>
              <strong className="mono stat-value">{formatMoney(data.data.total, data.data.currency)}</strong>
              <span className="muted small">{data.data.periodLabel}</span>
            </div>
            <div className="stat card">
              <span className="muted">Requests</span>
              <strong className="mono stat-value">{formatCount(data.data.lines.reduce((s, l) => s + l.requests, 0))}</strong>
              <span className="muted small">All databases</span>
            </div>
            <div className="stat card">
              <span className="muted">Awake hours</span>
              <strong className="mono stat-value">{formatCount(data.data.lines.reduce((s, l) => s + l.awakeHours, 0))}</strong>
              <span className="muted small">All databases</span>
            </div>
          </div>

          <Card id="per-db" title="Per database">
            <div className="table-card flush">
              <table className="data responsive">
                <caption className="sr-only">Usage and sample amount per database</caption>
                <thead>
                  <tr>
                    <th scope="col">Database</th>
                    <th scope="col" className="num">Requests</th>
                    <th scope="col" className="num">Awake hours</th>
                    <th scope="col" className="num">Storage (GB-hours)</th>
                    <th scope="col" className="num">Amount (sample)</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.data.lines].sort((a, b) => b.amount - a.amount).map((l) => (
                    <tr key={l.databaseId}>
                      <td data-label="Database">
                        <Link to={`/databases/${l.databaseId}`} className="row-link mono">{l.name}</Link>
                      </td>
                      <td data-label="Requests" className="num mono">{formatCount(l.requests)}</td>
                      <td data-label="Awake hours" className="num mono">{formatCount(l.awakeHours)}</td>
                      <td data-label="Storage (GB-hours)" className="num mono">{formatCount(l.storageGbHours)}</td>
                      <td data-label="Amount (sample)" className="num mono">{formatMoney(l.amount, data.data.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" data-label="Total">Total</th>
                    <td data-label="Requests" className="num mono">{formatCount(data.data.lines.reduce((s, l) => s + l.requests, 0))}</td>
                    <td data-label="Awake hours" className="num mono">{formatCount(data.data.lines.reduce((s, l) => s + l.awakeHours, 0))}</td>
                    <td data-label="Storage (GB-hours)" className="num mono">{formatCount(data.data.lines.reduce((s, l) => s + l.storageGbHours, 0))}</td>
                    <td data-label="Amount (sample)" className="num mono">{formatMoney(data.data.total, data.data.currency)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
