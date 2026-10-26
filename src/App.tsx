import { HashRouter, Route, Routes, Link } from "react-router-dom";
import { Shell } from "./components/Shell";
import { PageHeader } from "./components/PageHeader";
import { DatabasesPage } from "./pages/Databases";
import { DatabaseDetailPage } from "./pages/DatabaseDetail";
import { BillingPage } from "./pages/Billing";
import { ApiKeysPage } from "./pages/ApiKeys";
import { SettingsPage } from "./pages/Settings";

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p><Link to="/" className="row-link">Back to databases</Link></p>
    </>
  );
}

// HashRouter: the static output works on any file host with no rewrite rules.
// PLACEHOLDER: sign-in. When auth exists, gate these routes here.
export default function App() {
  return (
    <HashRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<DatabasesPage />} />
          <Route path="/databases/:id" element={<DatabaseDetailPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/api-keys" element={<ApiKeysPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Shell>
    </HashRouter>
  );
}
