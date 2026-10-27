import { Download } from "lucide-react";
import { client } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { download } from "../lib/download";
import { formatDate, formatMoney } from "../lib/format";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function BillingPage() {
  const toast = useToast();
  const billing = useAsync(() => client.getBilling(), []);
  const invoices = useAsync(() => client.listInvoices(), []);

  async function getInvoice(id: string, number: string) {
    try {
      download(await client.downloadInvoice(id));
      toast(`Downloaded invoice ${number}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Download failed.");
    }
  }

  return (
    <>
      <PageHeader title="Billing" description="What you pay FENVIX: your plan, this month's cost so far, invoices and payment method." />
      {billing.status === "loading" && <Message>Loading billing</Message>}
      {billing.status === "error" && <Message role="alert">{billing.message}</Message>}
      {billing.status === "ready" && (
        <>
          <div className="grid-2 billing-top">
            <Card id="mtd" title="Month to date" description={billing.data.monthToDate.periodLabel}>
              <strong className="mono stat-value">{formatMoney(billing.data.monthToDate.total, billing.data.currency)}</strong>
              <div className="table-card flush">
                <table className="data responsive">
                  <caption className="sr-only">Cost breakdown this month</caption>
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Quantity</th>
                      <th scope="col">Rate</th>
                      <th scope="col" className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.data.monthToDate.lines.map((l) => (
                      <tr key={l.label}>
                        <td data-label="Item">{l.label}</td>
                        <td data-label="Quantity" className="mono">{l.quantity}</td>
                        <td data-label="Rate" className="muted">{l.rate}</td>
                        <td data-label="Cost" className="num mono">{formatMoney(l.cost, billing.data.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" data-label="Total">Total</th>
                      <td className="hide-narrow" />
                      <td className="hide-narrow" />
                      <td data-label="Cost" className="num mono">{formatMoney(billing.data.monthToDate.total, billing.data.currency)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
            <div className="stack wide">
              <Card id="plan" title="Current plan">
                <strong className="plan-name">{billing.data.plan.name}</strong>
                <p className="muted">{billing.data.plan.description}</p>
              </Card>
              <Card id="payment" title="Payment method">
                <p>
                  <span className="mono">{billing.data.paymentMethod.brand} ending {billing.data.paymentMethod.last4}</span>
                </p>
                <p className="muted small">Expires {billing.data.paymentMethod.expires}</p>
              </Card>
            </div>
          </div>
        </>
      )}

      <Card id="invoices" title="Invoices">
        {invoices.status === "loading" && <Message>Loading invoices</Message>}
        {invoices.status === "error" && <Message role="alert">{invoices.message}</Message>}
        {invoices.status === "ready" && (
          <div className="table-card flush">
            <table className="data responsive">
              <caption className="sr-only">Invoices</caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Month</th>
                  <th scope="col">Issued</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col"><span className="sr-only">Download</span></th>
                </tr>
              </thead>
              <tbody>
                {invoices.data.items.map((i) => (
                  <tr key={i.id}>
                    <td data-label="Invoice" className="mono">{i.number}</td>
                    <td data-label="Month">{monthLabel(i.month)}</td>
                    <td data-label="Issued" className="muted">{formatDate(i.issuedAt)}</td>
                    <td data-label="Status">{i.status === "paid" ? "Paid" : "Open"}</td>
                    <td data-label="Amount" className="num mono">{formatMoney(i.amount, i.currency)}</td>
                    <td className="actions-cell">
                      <button type="button" className="btn btn-sm" onClick={() => getInvoice(i.id, i.number)} aria-label={`Download invoice ${i.number}`}>
                        <Download size={15} aria-hidden="true" />
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
