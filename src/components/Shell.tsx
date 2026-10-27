import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChartColumn, CreditCard, Database, KeyRound, LayoutDashboard, Menu, Settings, X } from "lucide-react";
import { client } from "../data";
import { Logo } from "./Logo";
import { UserMenu } from "./UserMenu";
import { useAsync } from "../lib/useAsync";
import { useWorkspaceVersion } from "../lib/workspace";

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

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function Workspace() {
  const version = useWorkspaceVersion();
  const settings = useAsync(() => client.getSettings(), [version]);
  const name = settings.status === "ready" ? settings.data.workspaceName : "";
  return (
    <div className="workspace">
      <span className="avatar" aria-hidden="true">
        {name ? initials(name) : ""}
      </span>
      <span className="workspace-name">
        {name}
        <span className="workspace-sub">Managed plan</span>
      </span>
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
