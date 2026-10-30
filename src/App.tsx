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
import { MembersPage } from "./pages/Members";
import { STYLEGUIDE_ON, StyleguidePage } from "./pages/Styleguide";
import { OrgProvider, useOrg } from "./session/OrgProvider";
import { InviteScreen, NameOrgScreen, NoOrgScreen } from "./components/OrgScreens";
import { usePendingInvite } from "./lib/invite";

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

/**
 * Between sign-in and the dashboard: an invitation link first, then a person with no organization (they can only
 * join one by invitation: the dashboard offers no way to create one), then an owner whose organization name was never
 * chosen (name it: a brand-new account). Someone who joined by invitation is not its owner and
 * never sees the name screen. These screens only guide: every rule is the server's.
 */
function Gated() {
  const org = useOrg();
  const invite = usePendingInvite();
  if (invite) return <InviteScreen token={invite} />;
  if (org.status === "loading") return null;
  if (org.status === "ready" && org.orgs.length === 0) return <NoOrgScreen />;
  if (org.current?.role === "owner" && !org.current.nameConfirmed) return <NameOrgScreen key={org.current.id} />;
  return <Dashboard key={org.current?.id ?? "default"} />;
}

function Routed() {
  const { status, user } = useSession();
  if (status === "loading") return null;
  if (!user) return <SignInPage />;
  return (
    <OrgProvider key={user.id}>
      <Gated />
    </OrgProvider>
  );
}

/** Keyed by the organization: switching remounts every screen, so nothing of the previous one stays on show. */
function Dashboard() {
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
        <Route path="/settings/members" element={<MembersPage />} />
        {STYLEGUIDE_ON && <Route path="/styleguide" element={<StyleguidePage />} />}
        <Route path="/invite" element={<Navigate to="/overview" replace />} />
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
