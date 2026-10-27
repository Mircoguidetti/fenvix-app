import { BrowserRouter, Navigate, Route, Routes, Link } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { SessionProvider, useSession } from "./session/SessionProvider";
import { SignInPage } from "./pages/SignIn";
import { Shell } from "./components/Shell";
import { PageHeader } from "./components/PageHeader";
import { OverviewPage } from "./pages/Overview";
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
      <PageHeader title="Page not found" description="The page you asked for does not exist." />
      <p>
        <Link to="/databases" className="row-link">
          Back to databases
        </Link>
      </p>
    </>
  );
}

function Routed() {
  const { status, user } = useSession();
  if (status === "loading") return null;
  if (!user) return <SignInPage />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/databases" element={<DatabasesPage />} />
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

// BrowserRouter: real URLs (/overview, /databases/…). The host must answer every path with index.html (see vercel.json).
// Signed-out visitors see the sign-in page on every route.
export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SessionProvider>
          <Routed />
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
