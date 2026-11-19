import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { client, type Plan } from "../data";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { TRIAL_DESCRIPTION, TrialSummary } from "../components/Trial";
import { useAsync } from "../lib/useAsync";
import { useOrg } from "../session/OrgProvider";
import { formatCount, formatDate, formatPrice } from "../lib/format";
import { UNIT_NOTE, UnitsMeter } from "./Usage";

const priceText = (p: Plan) => (p.priceUsdMonth === null ? "Price not set yet" : formatPrice(p.priceUsdMonth));
const units = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
const limitText = (p: Plan) =>
  `${p.unitsIncluded === null ? "Run units included: not set yet" : `${formatCount(p.unitsIncluded)} run units a month`} · ${p.maxProjects === null ? "any number of projects" : p.maxProjects === 1 ? "1 project" : `up to ${p.maxProjects} projects`}`;

/** Monthly plans by run units, sized by project; the Nightly exploration add-on; the shadow trial while it runs. */
export function BillingPage() {
  const toast = useToast();
  const org = useOrg();
  const billing = useAsync(() => client.getBilling(), []);
  const plans = useAsync(() => client.listPlans(), []);

  return (
    <>
      <PageHeader back={<Kicker />} title="Billing" description="A monthly plan sized by your projects and your run units. A run unit is 10 baseline minutes of a fenvix machine, timed by GitHub, so a job fenvix makes faster costs less." />

      {billing.status === "loading" && <Message>Loading billing</Message>}
      {billing.status === "error" && <Message role="alert">{billing.message}</Message>}
      {billing.status === "ready" && (() => {
        const b = billing.data;
        const list = plans.status === "ready" ? plans.data.filter((p) => p.kind === "plan") : [];
        const suggested = list.find((p) => p.id === b.suggestedPlanId);
        const addons = b.addons;
        return (
          <>
            {b.trial && (
              <Card id="trial" title={b.trial.status === "active" ? `Shadow trial: ${b.trial.daysLeft} ${b.trial.daysLeft === 1 ? "day" : "days"} left` : "Shadow trial: ended"} description={TRIAL_DESCRIPTION}>
                <TrialSummary trial={b.trial} />
              </Card>
            )}
            <div className="grid-2">
              <Card id="current" title={b.plan ? `${b.plan.name} plan` : "No plan yet"} description={`This month: ${formatDate(b.period.start)} to ${formatDate(new Date(new Date(b.period.end).getTime() - 1).toISOString())}.`}>
                <strong className={b.plan?.priceUsdMonth != null ? "big-number mono" : "big-number"}>{b.plan ? priceText(b.plan) : b.trial?.status === "active" ? "In trial" : "–"}</strong>
                <UnitsMeter used={b.unitsUsed} included={b.unitsIncluded} />
                <p className="muted small">
                  {formatCount(b.runsUsed)} billable {b.runsUsed === 1 ? "run" : "runs"} this month. {UNIT_NOTE}
                </p>
                {b.plan && <p className="muted small">{b.plan.maxProjects === null ? "Any number of projects." : `Up to ${b.plan.maxProjects} ${b.plan.maxProjects === 1 ? "project" : "projects"}.`}</p>}
              </Card>
              <Card id="sizing" title="Sized for you" description="From your projects and your run units over the last three months.">
                <dl className="facts">
                  <div>
                    <dt>Projects</dt>
                    <dd className="mono">{formatCount(b.projects)}</dd>
                  </div>
                  <div>
                    <dt>Run units a month</dt>
                    <dd className="mono">{units(b.averageMonthlyUnits)}</dd>
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
                    "The run units each plan includes are not set yet, so no plan is suggested. Talk to us about the one that fits."
                  )}
                </p>
              </Card>
            </div>

            <Card id="plans" title="Plans" description="Every plan includes skip with proof and flaky tests turned into defects. A run is one test job on runs-on: fenvix, counted in run units.">
              {plans.status === "ready" && (
                <ul className="plans">
                  {list.map((p) => (
                    <li key={p.id} className={`plan ${p.current ? "plan-current" : ""}`}>
                      <div className="plan-head">
                        <h3>{p.name}</h3>
                        {p.current && <span className="tag">Current plan</span>}
                      </div>
                      <p className="plan-price">
                        <strong className={p.priceUsdMonth === null ? undefined : "mono"}>{priceText(p)}</strong>
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
                        {p.current ? "Your plan" : `Choose ${p.name}`}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card id="addons" title="Add-ons" description="Paid on top of any plan.">
              {addons.length === 0 ? (
                <p className="muted">No add-ons yet.</p>
              ) : (
                <ul className="addon-list">
                  {addons.map((a) => (
                    <li key={a.id} className="addon">
                      <div className="plan-head">
                        <h3>{a.name}</h3>
                        {a.current ? <span className="tag">Added</span> : <span className="tag">Not added</span>}
                      </div>
                      <p className="small">
                        <strong>{priceText(a)}</strong>
                        {a.priceUsdMonth !== null && <span className="muted"> / month</span>}
                      </p>
                      <p className="muted small">{a.description}</p>
                      <ul className="plan-features">
                        {a.features.map((f) => (
                          <li key={f}>
                            <Check size={14} aria-hidden="true" />
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                      {!a.current && (
                        <div className="row-actions">
                          <button type="button" className="btn" disabled={!org.canManage} onClick={() => toast(`We will be in touch about the ${a.name} add-on`)}>
                            Add {a.name}
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card id="payment" title="Payment" description="Charged monthly, at the start of the month.">
              <p className="muted">
                No payment method yet: nothing is charged until one is added. <Link to="/usage" className="row-link">See this month's usage</Link>.
              </p>
            </Card>
          </>
        );
      })()}
    </>
  );
}
