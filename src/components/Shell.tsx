import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChartColumn, CreditCard, Database, KeyRound, LayoutDashboard, Menu, Settings, Users, X } from "lucide-react";
import { Logo } from "./Logo";
import { AccountMenu, useCurrentOrg } from "./AccountMenu";
import { useFocusTrap } from "../lib/useFocusTrap";
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
  const drawer = useRef<HTMLElement>(null);
  const current = useCurrentOrg();

  useEffect(() => setOpen(false), [pathname]);
  // Widening the window past the breakpoint leaves no drawer behind.
  useEffect(() => {
    const m = window.matchMedia("(min-width: 900px)");
    const on = () => m.matches && setOpen(false);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  useFocusTrap(drawer, open, () => setOpen(false));

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
      <aside ref={drawer} className="drawer" role="dialog" aria-modal="true" aria-label="Navigation drawer" hidden={!open}>
        <div className="sidebar-top">
          <Logo />
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close navigation">
            <X size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <SideNav onNavigate={() => setOpen(false)} />
        <div className="sidebar-bottom">
          <AccountMenu />
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <span className="topbar-logo">
            <Logo />
          </span>
          {current.status === "ready" && <span className="topbar-org">{current.name}</span>}
          <button type="button" className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open} style={current.status === "ready" ? undefined : { marginLeft: "auto" }}>
            <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <main id="main" tabIndex={-1}>
          <ReadOnlyNote />
          {children}
        </main>
      </div>
    </div>
  );
}
