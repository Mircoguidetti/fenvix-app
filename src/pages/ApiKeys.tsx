import { KeyRound } from "lucide-react";
import { PageHeader, Kicker } from "../components/PageHeader";

/**
 * API keys for scripts and coding agents. The public API they would call does not exist yet, so the page only says
 * so (founder, 2026-11-18): no key list and no form until it does. The navigation keeps the entry.
 */
export function ApiKeysPage() {
  return (
    <>
      <PageHeader back={<Kicker>Organization</Kicker>} title="API keys" description="Keys for your scripts and coding agents to read runs and defects, and to pull defect bundles." />
      <section className="empty coming-soon" aria-labelledby="keys-soon">
        <KeyRound size={28} strokeWidth={1.6} aria-hidden="true" />
        <h2 id="keys-soon">Coming soon</h2>
        <p className="muted">API keys arrive with the public fenvix API. Until then, everything is here in the dashboard, and the replay command of each defect works from your terminal.</p>
      </section>
    </>
  );
}
