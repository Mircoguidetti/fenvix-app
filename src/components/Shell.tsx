import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router-dom";
import { BookOpen, Building2, ChartColumn, CreditCard, Database, LayoutDashboard, Menu, Moon, Sun, X, type LucideIcon } from "lucide-react";
import { Logo } from "./Logo";
import { AccountMenu, useCurrentOrg } from "./AccountMenu";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useOrg } from "../session/OrgProvider";
import { useTheme } from "../lib/theme";

/*
 * The console's frame, laid out like the mockups (fenvix-brain sessions/2026-11-10-console-ui):
 * - a top bar with where you are (organization / area / database), the theme button and the account;
 * - a thin bar of area icons that widens over the page while the pointer is on it;
 * - a second bar only where there is a level below the area: one database's sections, or the organization's
 *   settings, with a box at the bottom. It never repeats the icon bar.
 * Below 900px the two bars become one drawer. Only layout changed: every page, route and action is the one it was.
 */

const DOCS_URL = "https://docs.fenvix.dev/";

type Area = { key: string; label: string; icon: LucideIcon; to: string; match: (path: string) => boolean };
const AREAS: Area[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, to: "/overview", match: (p) => p.startsWith("/overview") },
  { key: "databases", label: "Databases", icon: Database, to: "/databases", match: (p) => p.startsWith("/databases") },
  { key: "usage", label: "Usage", icon: ChartColumn, to: "/usage", match: (p) => p.startsWith("/usage") },
  { key: "billing", label: "Billing", icon: CreditCard, to: "/billing", match: (p) => p.startsWith("/billing") },
  { key: "org", label: "Organization", icon: Building2, to: "/settings/members", match: (p) => p.startsWith("/settings") || p.startsWith("/api-keys") },
];

const ORG_PAGES = [
  { to: "/overview", label: "Overview", end: true },
  { to: "/databases", label: "Databases", end: false },
  { to: "/usage", label: "Usage", end: false },
  { to: "/billing", label: "Billing", end: false },
];
const SETTINGS_PAGES = [
  { to: "/settings", label: "General", end: true },
  { to: "/settings/members", label: "Members", end: false },
  { to: "/api-keys", label: "API keys", end: false },
];
const DB_SECTIONS = [
  { tab: "overview", label: "Overview" },
  { tab: "data", label: "Data" },
  { tab: "users", label: "Users" },
  { tab: "network", label: "Network" },
] as const;

/** The open database's name, set by its page so the bars can show it. Layout only. */
const DbTitle = createContext<{ name: string; set: (name: string) => void }>({ name: "", set: () => {} });
export function useDatabaseTitle(name: string | undefined) {
  const { set } = useContext(DbTitle);
  useEffect(() => {
    set(name ?? "");
    return () => set("");
  }, [name, set]);
}

/** A database page: /databases/<id>, not the list and not /databases/new. */
function dbIdOf(path: string): string | null {
  const m = /^\/databases\/([^/]+)/.exec(path);
  return m && m[1] !== "new" ? m[1] : null;
}

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

function ThemeButton() {
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button type="button" className="cx-icon-btn" onClick={toggle} aria-label={label} title={label}>
      {theme === "dark" ? <Sun size={18} strokeWidth={1.75} aria-hidden="true" /> : <Moon size={18} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

function DbSectionLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [params] = useSearchParams();
  const tab = params.get("tab") ?? "overview";
  return (
    <>
      {DB_SECTIONS.map((s) => (
        <Link key={s.tab} to={s.tab === "overview" ? "." : `?tab=${s.tab}`} replace onClick={onNavigate} className="cx-sub-link" aria-current={tab === s.tab ? "page" : undefined}>
          {s.label}
        </Link>
      ))}
    </>
  );
}

function PageLinks({ pages, onNavigate }: { pages: typeof ORG_PAGES; onNavigate?: () => void }) {
  return (
    <>
      {pages.map((p) => (
        <NavLink key={p.to} to={p.to} end={p.end} onClick={onNavigate} className="cx-sub-link">
          {p.label}
        </NavLink>
      ))}
    </>
  );
}

/** The second bar: the pages of what is open, and a box at the bottom. */
function SubNav({ path, orgName, orgSub }: { path: string; orgName: string; orgSub: string }) {
  const { name } = useContext(DbTitle);
  const dbId = dbIdOf(path);
  const settings = path.startsWith("/settings") || path.startsWith("/api-keys");
  // Only a level below the area gets this bar: a database's sections, or the organization's settings. The other areas
  // are one page each and already in the icon bar, so the page takes the whole width and nothing is repeated.
  if (!dbId && !settings) return null;
  return (
    <aside className="cx-sub" aria-label="Pages">
      {dbId ? (
        <>
          <Link to="/databases" className="cx-sub-back">
            ← All databases
          </Link>
          <div className="cx-sub-head">
            <span className="cx-sub-kind">Database</span>
            <span className="cx-sub-title mono">{name || dbId}</span>
          </div>
          <nav aria-label="Database sections" className="cx-sub-nav">
            <DbSectionLinks />
          </nav>
        </>
      ) : (
        <>
          <div className="cx-sub-head">
            <span className="cx-sub-kind">Organization settings</span>
            <span className="cx-sub-title">{orgName || " "}</span>
            {orgSub && <span className="cx-sub-meta">{orgSub}</span>}
          </div>
          <nav aria-label="Organization settings" className="cx-sub-nav">
            <PageLinks pages={SETTINGS_PAGES} />
          </nav>
        </>
      )}
      <span className="cx-sub-fill" />
      <div className="cx-sub-box">
        {settings ? (
          <>
            <span className="cx-sub-box-title">People</span>
            <span className="cx-sub-box-text">Invite teammates and choose what they can change.</span>
            <Link to="/settings/members" className="btn btn-primary btn-sm">
              Manage members
            </Link>
          </>
        ) : (
          <>
            <span className="cx-sub-box-title">Connect</span>
            <span className="cx-sub-box-text">The connection string and the database users are in Overview and Users.</span>
            <Link to="?tab=users" replace className="btn btn-primary btn-sm">
              Database users
            </Link>
          </>
        )}
      </div>
    </aside>
  );
}

/** The thin bar of area icons. It widens over the page while the pointer is on it. */
function Rail({ path }: { path: string }) {
  const [wide, setWide] = useState(false);
  return (
    <nav className="cx-rail" aria-label="Areas" data-wide={wide || undefined} onMouseEnter={() => setWide(true)} onMouseLeave={() => setWide(false)}>
      <div className="cx-rail-inner">
        {AREAS.map((a) => (
          <Link key={a.key} to={a.to} className="cx-rail-link" aria-current={a.match(path) ? "page" : undefined} title={a.label}>
            <a.icon size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="cx-rail-label">{a.label}</span>
          </Link>
        ))}
        <span className="cx-rail-fill" />
        <span className="cx-rail-rule" />
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className="cx-rail-link" title="Documentation">
          <BookOpen size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="cx-rail-label">Documentation</span>
        </a>
      </div>
    </nav>
  );
}

/** Below 900px: one drawer with every area and its pages. */
function Drawer({ path, onClose }: { path: string; onClose: () => void }) {
  const { name } = useContext(DbTitle);
  const dbId = dbIdOf(path);
  return (
    <>
      <div className="cx-drawer-top">
        <Logo />
        <button type="button" className="cx-icon-btn" onClick={onClose} aria-label="Close navigation">
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {dbId && (
        <nav aria-label="Database sections" className="cx-drawer-group">
          <p className="cx-drawer-label">
            Database <span className="mono">{name || dbId}</span>
          </p>
          <DbSectionLinks onNavigate={onClose} />
        </nav>
      )}
      <nav aria-label="Organization pages" className="cx-drawer-group">
        <p className="cx-drawer-label">Organization</p>
        <PageLinks pages={ORG_PAGES} onNavigate={onClose} />
      </nav>
      <nav aria-label="Organization settings" className="cx-drawer-group">
        <p className="cx-drawer-label">Settings</p>
        <PageLinks pages={SETTINGS_PAGES} onNavigate={onClose} />
      </nav>
      <span className="cx-rail-fill" />
      <a href={DOCS_URL} target="_blank" rel="noreferrer" className="cx-sub-link cx-drawer-docs">
        <BookOpen size={18} strokeWidth={1.75} aria-hidden="true" />
        Documentation
      </a>
      <div className="cx-drawer-account">
        <AccountMenu />
      </div>
    </>
  );
}

function Crumbs({ path, orgName }: { path: string; orgName: string }) {
  const { name } = useContext(DbTitle);
  const area = AREAS.find((a) => a.match(path));
  const dbId = dbIdOf(path);
  const items: { label: string; to?: string; mono?: boolean }[] = [];
  if (orgName) items.push({ label: orgName, to: "/overview" });
  if (area) items.push({ label: area.label, to: area.to });
  if (dbId) items.push({ label: name || dbId, mono: true });
  return (
    <nav aria-label="Where you are" className="cx-crumbs">
      {items.map((c, i) => (
        <span key={i} className="cx-crumb">
          {i > 0 && (
            <span className="cx-crumb-sep" aria-hidden="true">
              /
            </span>
          )}
          {c.to && i < items.length - 1 ? (
            <Link to={c.to} className={c.mono ? "mono" : undefined}>
              {c.label}
            </Link>
          ) : (
            <span aria-current="page" className={c.mono ? "mono" : undefined}>
              {c.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [dbName, setDbName] = useState("");
  const { pathname } = useLocation();
  const drawer = useRef<HTMLElement>(null);
  const current = useCurrentOrg();
  const orgName = current.status === "ready" ? current.name : "";
  const orgSub = current.status === "ready" ? current.sub : "";

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
    <DbTitle.Provider value={{ name: dbName, set: setDbName }}>
      <div className="shell cx-shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>

        <header className="cx-top">
          <button type="button" className="cx-icon-btn cx-menu" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <Link to="/overview" className="cx-logo" aria-label="FENVIX, overview">
            <Logo />
          </Link>
          <Crumbs path={pathname} orgName={orgName} />
          <span className="cx-top-fill" />
          <ThemeButton />
          <div className="cx-account">
            <AccountMenu />
          </div>
        </header>

        <div className="cx-body">
          <Rail path={pathname} />
          <SubNav path={pathname} orgName={orgName} orgSub={orgSub} />
          <div className="cx-content">
            <main id="main" tabIndex={-1}>
              <ReadOnlyNote />
              {children}
            </main>
          </div>
        </div>

        {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
        <aside ref={drawer} className="cx-drawer" role="dialog" aria-modal="true" aria-label="Navigation" hidden={!open}>
          <Drawer path={pathname} onClose={() => setOpen(false)} />
        </aside>
      </div>
    </DbTitle.Provider>
  );
}
