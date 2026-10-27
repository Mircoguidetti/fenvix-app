import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChartColumn, CreditCard, Database, KeyRound, Menu, Moon, Settings, Sun, X } from "lucide-react";
import { Logo } from "./Logo";
import { UserMenu } from "./UserMenu";
import { SampleLabel } from "./Tags";
import { useTheme } from "../lib/theme";

const NAV = [
  { to: "/", label: "Databases", icon: Database, end: true },
  { to: "/usage", label: "Usage", icon: ChartColumn, end: false },
  { to: "/billing", label: "Billing", icon: CreditCard, end: false },
  { to: "/api-keys", label: "API keys", icon: KeyRound, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
];

function ThemeToggle() {
  const { resolved, setChoice } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button type="button" className="icon-btn" onClick={() => setChoice(next)} aria-label={`Switch to ${next} theme`}>
      {resolved === "dark" ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="nav">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} onClick={onNavigate} className="nav-link">
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{label}</span>
        </NavLink>
      ))}
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
        <div className="sidebar-top">
          <Logo />
        </div>
        <div className="workspace">
          <span className="avatar" aria-hidden="true">
            S
          </span>
          <span className="workspace-name">Sample workspace</span>
        </div>
        <SideNav />
        <div className="sidebar-bottom">
          <UserMenu />
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
          <div className="topbar-right">
            <span className="topbar-sample">
              <SampleLabel />
            </span>
            <ThemeToggle />
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
