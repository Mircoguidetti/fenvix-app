import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChartColumn, CreditCard, Database, KeyRound, LayoutDashboard, Menu, Settings, X } from "lucide-react";
import { client } from "../data";
import { Logo } from "./Logo";
import { UserMenu } from "./UserMenu";
import { useAsync } from "../lib/useAsync";
import { useWorkspaceVersion } from "../lib/workspace";
import { workspaceColor, workspaceInitial } from "../lib/avatar";

const NAV = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/databases", label: "Databases", icon: Database, end: false },
  { to: "/usage", label: "Usage", icon: ChartColumn, end: false },
  { to: "/billing", label: "Billing", icon: CreditCard, end: false },
];

const NAV_WORKSPACE = [
  { to: "/api-keys", label: "API keys", icon: KeyRound, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

/** The plan every workspace is on today; shown under the workspace name. */
const PLAN = "Managed";

/** The workspace this dashboard shows: a coloured avatar with its initial, its name and its plan. */
function Workspace() {
  const version = useWorkspaceVersion();
  const settings = useAsync(() => client.getSettings(), [version]);
  // The slot keeps its height while the name loads, so nothing jumps and no empty avatar is ever drawn.
  if (settings.status !== "ready") return <div className="workspace-slot" data-state={settings.status} />;
  const name = settings.data.workspaceName.trim() || "Workspace";
  return (
    <div className="workspace-slot" data-state="ready">
      <div className="workspace" role="group" aria-label={`Workspace: ${name}, ${PLAN} plan`} title={name}>
        <span className="workspace-avatar" style={{ background: workspaceColor(name) }} aria-hidden="true">
          {workspaceInitial(settings.data.workspaceName)}
        </span>
        <span className="workspace-text" aria-hidden="true">
          <span className="workspace-name">{name}</span>
          <span className="workspace-sub">{PLAN}</span>
        </span>
      </div>
    </div>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const item = ({ to, label, icon: Icon, end }: (typeof NAV)[number]) => (
    <NavLink key={to} to={to} end={end} onClick={onNavigate} className="nav-link">
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
      <span>{label}</span>
    </NavLink>
  );
  return (
    <nav aria-label="Main" className="nav">
      {NAV.map(item)}
      <p className="nav-label">Workspace</p>
      {NAV_WORKSPACE.map(item)}
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar-inner">
          <div className="sidebar-top">
            <Logo />
          </div>
          <Workspace />
          <SideNav />
          <div className="sidebar-bottom">
            <UserMenu />
          </div>
        </div>
      </aside>

      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside className={`drawer ${open ? "drawer-open" : ""}`} aria-label="Navigation drawer" hidden={!open}>
        <div className="sidebar-top">
          <Logo />
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close navigation">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <Workspace />
        <SideNav onNavigate={() => setOpen(false)} />
        <div className="sidebar-bottom">
          <UserMenu />
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Menu size={18} aria-hidden="true" />
          </button>
          <span className="topbar-logo">
            <Logo />
          </span>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
