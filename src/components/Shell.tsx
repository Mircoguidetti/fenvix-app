import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChartColumn, CreditCard, Database, KeyRound, LayoutDashboard, Menu, Settings, Users, X } from "lucide-react";
import { Logo } from "./Logo";
import { AccountMenu } from "./AccountMenu";
import { useOrg } from "../session/OrgProvider";

const NAV = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/databases", label: "Databases", icon: Database, end: false },
  { to: "/usage", label: "Usage", icon: ChartColumn, end: false },
  { to: "/billing", label: "Billing", icon: CreditCard, end: false },
];

const NAV_WORKSPACE = [
  { to: "/api-keys", label: "API keys", icon: KeyRound, end: false },
  { to: "/settings/members", label: "Members", icon: Users, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: true },
];

/** Shown to a member on every page: they can look, not change. The server refuses changes anyway. */
function ReadOnlyNote() {
  const org = useOrg();
  if (org.status !== "ready" || !org.current || org.canManage) return null;
  return (
    <p className="readonly-note" role="note">
      You have view-only access to <strong className="break-anywhere">{org.current.name}</strong>. Ask an owner or admin to make changes.
    </p>
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
      <p className="nav-label">Organization</p>
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
          <SideNav />
          <div className="sidebar-bottom">
            <AccountMenu />
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
        <SideNav onNavigate={() => setOpen(false)} />
        <div className="sidebar-bottom">
          <AccountMenu />
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
          <ReadOnlyNote />
          {children}
        </main>
      </div>
    </div>
  );
}
