import { HashRouter, Route, Routes, Link } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { SessionProvider, useSession } from "./session/SessionProvider";
import { SignInPage } from "./pages/SignIn";
import { Shell } from "./components/Shell";
import { PageHeader } from "./components/PageHeader";
import { DatabasesPage } from "./pages/Databases";
import { CreateDatabasePage } from "./pages/CreateDatabase";
import { DatabaseDetailPage } from "./pages/DatabaseDetail";
import { UsagePage } from "./pages/Usage";
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

function Routed() {
  const { status, user } = useSession();
  if (status === "loading") return <p className="message boot" role="status">Loading</p>;
  if (!user) return <SignInPage />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DatabasesPage />} />
        <Route path="/databases/new" element={<CreateDatabasePage />} />
        <Route path="/databases/:id" element={<DatabaseDetailPage />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/api-keys" element={<ApiKeysPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}

// HashRouter: the static output works on any file host with no rewrite rules.
// Signed-out visitors see the sign-in page on every route.
export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <SessionProvider>
          <Routed />
        </SessionProvider>
      </ToastProvider>
    </HashRouter>
  );
}
