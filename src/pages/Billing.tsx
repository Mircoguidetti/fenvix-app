import { Check, Download } from "lucide-react";
import { client } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { MonthBars } from "../components/charts";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { download } from "../lib/download";
import { formatDate, formatMoney } from "../lib/format";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shortMonth = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

export function BillingPage() {
  const toast = useToast();
  const billing = useAsync(() => client.getBilling(), []);
  const invoices = useAsync(() => client.listInvoices(), []);
  const plans = useAsync(() => client.listPlans(), []);

  async function getInvoice(id: string, number: string) {
    try {
      download(await client.downloadInvoice(id));
      toast(`Downloaded invoice ${number}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Download failed.");
    }
  }

  const currency = billing.status === "ready" ? billing.data.currency : "USD";
  const months =
    billing.status === "ready" && invoices.status === "ready"
      ? [
          ...[...invoices.data.items].reverse().map((i) => ({ label: shortMonth(i.month), value: i.amount })),
          { label: "Oct", value: billing.data.monthToDate.total, partial: true },
        ]
      : [];

  return (
    <>
      <PageHeader title="Billing" description="What you pay FENVIX: this month so far, your invoices, your payment method and your plan." />

      {billing.status === "loading" && <Message>Loading billing</Message>}
      {billing.status === "error" && <Message role="alert">{billing.message}</Message>}
      {billing.status === "ready" && (
        <>
          <div className="grid-2">
            <Card id="mtd" title="Month to date" description={billing.data.monthToDate.periodLabel}>
              <strong className="big-number mono">{formatMoney(billing.data.monthToDate.total, currency)}</strong>
              <div className="table-card flush">
                <table className="data responsive">
                  <caption className="sr-only">What makes up this month's cost</caption>
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Quantity</th>
                      <th scope="col">Rate</th>
                      <th scope="col" className="num">
                        Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.data.monthToDate.lines.map((l) => (
                      <tr key={l.label}>
                        <td data-label="Item">{l.label}</td>
                        <td data-label="Quantity" className="mono">
                          {l.quantity}
                        </td>
                        <td data-label="Rate" className="muted">
                          {l.rate}
                        </td>
                        <td data-label="Cost" className="num mono">
                          {formatMoney(l.cost, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" data-label="Total">
                        Total
                      </th>
                      <td className="hide-narrow" />
                      <td className="hide-narrow" />
                      <td data-label="Cost" className="num mono">
                        {formatMoney(billing.data.monthToDate.total, currency)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>

            <Card id="payment" title="Payment method" description="Charged on the first working day of the month.">
              <div className="pay-card">
                <span className="pay-brand mono">{billing.data.paymentMethod.brand}</span>
                <span className="pay-number mono">•••• •••• •••• {billing.data.paymentMethod.last4}</span>
                <span className="muted small">Expires {billing.data.paymentMethod.expires}</span>
              </div>
              <div className="row-actions">
                <button type="button" className="btn" onClick={() => toast("Payment details are managed by your card provider")}>
                  Update card
                </button>
              </div>
              <dl className="facts facts-tight">
                <div>
                  <dt>Billing email</dt>
                  <dd className="ellipsis">billing@northwind.cloud</dd>
                </div>
                <div>
                  <dt>Currency</dt>
                  <dd>{currency}</dd>
                </div>
              </dl>
            </Card>
          </div>

          <Card id="by-month" title="Cost by month" description="The last six months, with October so far.">
            {months.length > 0 ? <MonthBars months={months} format={(n) => `$${Math.round(n)}`} /> : <Message>Loading the chart</Message>}
            <p className="muted chart-summary">
              Billed monthly in arrears. October is charged on 1 November.
            </p>
          </Card>

          <Card id="invoices" title="Invoices" description="Every invoice is a PDF you can hand to your finance team.">
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
                        <th scope="col" className="num">
                          Amount
                        </th>
                        <th scope="col">
                          <span className="sr-only">Download</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.data.items.map((i) => (
                        <tr key={i.id}>
                          <td data-label="Invoice" className="mono">
                            {i.number}
                          </td>
                          <td data-label="Month">{monthLabel(i.month)}</td>
                          <td data-label="Issued" className="muted">
                            {formatDate(i.issuedAt)}
                          </td>
                          <td data-label="Status">{i.status === "paid" ? "Paid" : "Open"}</td>
                          <td data-label="Amount" className="num mono">
                            {formatMoney(i.amount, i.currency)}
                          </td>
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

          <Card id="plan" title="Plan" description="Change plan at any time. Usage is charged on top of the plan fee.">
            {plans.status === "ready" && (
              <ul className="plans">
                {plans.data.map((p) => (
                  <li key={p.id} className={`plan ${p.current ? "plan-current" : ""}`}>
                    <div className="plan-head">
                      <h3>{p.name}</h3>
                      {p.current && <span className="tag">Current plan</span>}
                    </div>
                    <p className="plan-price">
                      <strong>{p.price}</strong>
                      {p.period && <span className="muted"> {p.period}</span>}
                    </p>
                    <p className="muted small plan-desc">{p.description}</p>
                    <ul className="plan-features">
                      {p.features.map((f) => (
                        <li key={f}>
                          <Check size={14} aria-hidden="true" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="btn btn-block" disabled={p.current} onClick={() => toast(`We will be in touch about the ${p.name} plan`)}>
                      {p.current ? "Your plan" : p.price === "Custom" ? "Contact us" : `Switch to ${p.name}`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}
