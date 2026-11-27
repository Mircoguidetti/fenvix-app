import { BrowserRouter, Navigate, Route, Routes, Link, useLocation, useNavigate } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { SessionProvider, useSession } from "./session/SessionProvider";
import { SignInPage } from "./pages/SignIn";
import { Shell } from "./components/Shell";
import { OverviewPage } from "./pages/Overview";
import { ProjectsPage } from "./pages/Projects";
import { ConnectPage } from "./pages/Connect";
import { ProjectPage } from "./pages/Project";
import { RunPage } from "./pages/Run";
import { ParallelWithProofPage, ProjectComingSoon, SkipWithProofPage, TimeToGreenPage } from "./pages/ProjectSections";
import { ComingSoon, PROJECT_SOON, PYTHON_SOON } from "./components/ComingSoon";
import { Kicker } from "./components/PageHeader";
import { client } from "./data";
import { rememberedProject } from "./components/Shell";
import { useEffect, useState } from "react";
import { DefectPage, DefectsPage, ProjectDefectsPage } from "./pages/Defects";
import { UsagePage } from "./pages/Usage";
import { BillingPage } from "./pages/Billing";
import { ApiKeysPage } from "./pages/ApiKeys";
import { SettingsPage } from "./pages/Settings";
import { MembersPage } from "./pages/Members";
import { STYLEGUIDE_ON, StyleguidePage } from "./pages/Styleguide";
import { OrgProvider, useOrg } from "./session/OrgProvider";
import { InviteScreen, NameOrgScreen, NoOrgScreen } from "./components/OrgScreens";
import { usePendingInvite } from "./lib/invite";
import { LoadingScreen } from "./components/LoadingScreen";
import { forgetNext, rememberNext, safeNext, storedNext, welcomeUrl } from "./lib/next";

function NotFound() {
  return (
    <div className="empty not-found">
      <span className="nf-code mono" aria-hidden="true">
        404
      </span>
      <h1>Page not found</h1>
      <p className="muted">The page you asked for does not exist. The link may be old, or the project was disconnected.</p>
      <Link to="/projects" className="btn btn-primary">
        Back to your projects
      </Link>
    </div>
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
  if (org.status === "loading") return <LoadingScreen />;
  if (org.status === "ready" && org.orgs.length === 0) return <NoOrgScreen />;
  if (org.current?.role === "owner" && !org.current.nameConfirmed) return <NameOrgScreen key={org.current.id} />;
  return <Dashboard key={org.current?.id ?? "default"} />;
}

/**
 * Signed out, every console URL goes to /welcome?next=<the path asked for> (replace: Back does not return to the
 * redirect). The mock's one-time email link (?token=…) is carried along so it still signs the browser in.
 */
function SignedOut() {
  const { pathname, search, hash } = useLocation();
  if (pathname === "/welcome") {
    const next = new URLSearchParams(search).get("next");
    if (next) rememberNext(next);
    return <SignInPage welcome />;
  }
  const params = new URLSearchParams(search);
  const token = params.get("token");
  params.delete("token");
  const rest = params.toString();
  const to = welcomeUrl(`${pathname}${rest ? `?${rest}` : ""}${hash}`);
  return <Navigate to={token ? `${to}${to.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : to} replace />;
}

/**
 * Signed in at /welcome (just signed in there, or a visit): go to its `next` (or the one kept in sessionStorage)
 * when it is a same-site path, otherwise to "/".
 */
function WelcomeSignedIn() {
  const { search } = useLocation();
  const to = safeNext(new URLSearchParams(search).get("next") ?? storedNext(), window.location.origin);
  useEffect(forgetNext, []);
  return <Navigate to={to} replace />;
}

/**
 * The first screen after a sign-in that left the site (GitHub or Google come back to the site root): go to the `next`
 * kept in sessionStorage, when it is a same-site path. Runs once per signed-in person.
 */
function SignedInReturn() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [stored] = useState(storedNext);
  useEffect(() => {
    forgetNext();
    if (!stored) return;
    const to = safeNext(stored, window.location.origin);
    if (to !== `${pathname}${search}`) navigate(to, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Routed() {
  const { status, user } = useSession();
  const { pathname } = useLocation();
  if (status === "loading") return <LoadingScreen />;
  if (!user) return <SignedOut />;
  if (pathname === "/welcome") return <WelcomeSignedIn />;
  return (
    <>
      <SignedInReturn key={user.id} />
      <OrgProvider key={user.id}>
        <Gated />
      </OrgProvider>
    </>
  );
}

/**
 * The first screen, as in the landing: the runs of the project opened last in this browser, or of the first project.
 * An organization with no project yet starts on the Overview, which offers to connect one.
 */
function Home() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.listProjects().then(
      (ps) => {
        const id = ps.find((p) => p.id === rememberedProject())?.id ?? ps[0]?.id;
        if (live) setTo(id ? `/projects/${id}` : "/overview");
      },
      () => live && setTo("/overview"),
    );
    return () => {
      live = false;
    };
  }, []);
  return to ? <Navigate to={to} replace /> : <LoadingScreen inline />;
}

/** Keyed by the organization: switching remounts every screen, so nothing of the previous one stays on show. */
function Dashboard() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/connect" element={<ConnectPage />} />
        <Route path="/projects/:id" element={<ProjectPage />} />
        <Route path="/projects/:id/parallel-with-proof" element={<ParallelWithProofPage />} />
        <Route path="/projects/:id/defects" element={<ProjectDefectsPage />} />
        <Route path="/projects/:id/skip-with-proof" element={<SkipWithProofPage />} />
        {(Object.keys(PROJECT_SOON) as (keyof typeof PROJECT_SOON)[]).map((k) => (
          <Route key={k} path={`/projects/:id/${PROJECT_SOON[k].path}`} element={<ProjectComingSoon key={k} item={k} />} />
        ))}
        <Route path={PYTHON_SOON.to} element={<ComingSoon kicker={<Kicker>Projects</Kicker>} title={PYTHON_SOON.label} sentence={PYTHON_SOON.sentence} />} />
        <Route path="/projects/:id/time-to-green" element={<TimeToGreenPage />} />
        <Route path="/projects/:id/settings" element={<ProjectPage section="settings" />} />
        <Route path="/projects/:projectId/runs/:runId" element={<RunPage />} />
        <Route path="/defects" element={<DefectsPage />} />
        <Route path="/defects/:id" element={<DefectPage />} />
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

// BrowserRouter: real URLs (/overview, /projects/…). The host must answer every path with index.html (see vercel.json).
// Signed-out visitors are sent to /welcome?next=<path> (the sign-in page with a welcome line).
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
