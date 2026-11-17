import { Check } from "lucide-react";
import { client, type Plan } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useOrg } from "../session/OrgProvider";
import { formatCount, formatDate, formatMoney } from "../lib/format";
import { RunsMeter } from "./Usage";

const priceText = (p: Plan) => (p.priceUsdMonth === null ? "Price not set" : formatMoney(p.priceUsdMonth));
const limitText = (p: Plan) =>
  p.runsPerMonth === null ? "Runs and projects agreed with us" : `Up to ${formatCount(p.runsPerMonth)} runs a month · ${p.maxProjects === null ? "any number of projects" : p.maxProjects === 1 ? "1 project" : `up to ${p.maxProjects} projects`}`;

/** Monthly plans by number of runs, sized by project. Prices are not set yet: every price is null and says so. */
export function BillingPage() {
  const toast = useToast();
  const org = useOrg();
  const billing = useAsync(() => client.getBilling(), []);
  const plans = useAsync(() => client.listPlans(), []);

  return (
    <>
      <PageHeader back={<Kicker />} title="Billing" description="You pay per test run, with a monthly plan sized by your projects and how often you push. Fewer minutes never cost you more." />

      {billing.status === "loading" && <Message>Loading billing</Message>}
      {billing.status === "error" && <Message role="alert">{billing.message}</Message>}
      {billing.status === "ready" && (() => {
        const b = billing.data;
        const suggested = plans.status === "ready" ? plans.data.find((p) => p.id === b.suggestedPlanId) : undefined;
        return (
          <>
            <div className="grid-2">
              <Card id="current" title={b.plan ? `${b.plan.name} plan` : "No plan yet"} description={`This month: ${formatDate(b.period.start)} to ${formatDate(new Date(new Date(b.period.end).getTime() - 1).toISOString())}.`}>
                <strong className={b.plan?.priceUsdMonth != null ? "big-number mono" : "big-number"}>{b.plan ? priceText(b.plan) : "–"}</strong>
                <RunsMeter used={b.runsUsed} included={b.runsIncluded} />
                {b.plan && <p className="muted small">{limitText(b.plan)}.</p>}
              </Card>
              <Card id="sizing" title="Sized for you" description="From your projects and your runs over the last three months.">
                <dl className="facts">
                  <div>
                    <dt>Projects</dt>
                    <dd className="mono">{formatCount(b.projects)}</dd>
                  </div>
                  <div>
                    <dt>Runs a month</dt>
                    <dd className="mono">{formatCount(b.averageMonthlyRuns)}</dd>
                  </div>
                </dl>
                <p className="small">
                  {suggested ? (
                    suggested.current ? (
                      <>Your plan fits. {suggested.name} holds both.</>
                    ) : (
                      <>
                        <strong>{suggested.name}</strong> fits best.
                      </>
                    )
                  ) : (
                    "Talk to us about a plan that fits."
                  )}
                </p>
              </Card>
            </div>

            <Card id="payment" title="Payment" description="Charged monthly, at the start of the month.">
              <p className="muted">No payment method yet. Prices are not set, so nothing is charged.</p>
            </Card>

            <Card id="plans" title="Plans" description="Every plan includes skip with proof and flaky tests turned into defects. A run is one test job on runs-on: fenvix.">
              {plans.status === "ready" && (
                <ul className="plans">
                  {plans.data.map((p) => (
                    <li key={p.id} className={`plan ${p.current ? "plan-current" : ""}`}>
                      <div className="plan-head">
                        <h3>{p.name}</h3>
                        {p.current && <span className="tag">Current plan</span>}
                      </div>
                      <p className="plan-price">
                        <strong>{priceText(p)}</strong>
                        {p.priceUsdMonth !== null && <span className="muted"> / month</span>}
                      </p>
                      <p className="small">{limitText(p)}</p>
                      <p className="muted small plan-desc">{p.description}</p>
                      <ul className="plan-features">
                        {p.features.map((f) => (
                          <li key={f}>
                            <Check size={14} aria-hidden="true" />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                      <button type="button" className="btn btn-block" disabled={p.current || !org.canManage} onClick={() => toast(`We will be in touch about the ${p.name} plan`)}>
                        {p.current ? "Your plan" : p.runsPerMonth === null ? "Contact us" : `Switch to ${p.name}`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        );
      })()}
    </>
  );
}
