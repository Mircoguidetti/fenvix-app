import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Bug, BookOpen, Building2, ChartColumn, ChevronDown, CreditCard, FolderGit2, LayoutDashboard, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, X, type LucideIcon } from "lucide-react";
import { Logo } from "./Logo";
import { AccountMenu, OrgAvatar, useCurrentOrg } from "./AccountMenu";
import { useToast } from "./Toast";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useOrg } from "../session/OrgProvider";
import { useTheme } from "../lib/theme";
import { client, type ProjectRow } from "../data";
import { ROLE_NAMES } from "../data/orgs";

/*
 * The console's frame, laid out like the mockup (fenvix-brain, Fenvix console 3):
 * - a top bar: the logo, where you are as switchers (Org ▾ / Project), "Search or jump to", the theme and the account;
 * - a thin bar of area icons on the left that widens over the page on hover, or stays open when pinned. There is no
 *   second bar (removed 2026-11-17, founder): a project's and the settings' sections are tabs on their pages.
 * Below 900px the bars become one drawer. Every page, route and action is the one it was.
 */

const DOCS_URL = "https://docs.fenvix.dev/";
const RAIL_KEY = "fenvix-rail-open";

type Area = { key: string; label: string; icon: LucideIcon; to: string; match: (path: string) => boolean };
const AREAS: Area[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, to: "/overview", match: (p) => p.startsWith("/overview") },
  { key: "projects", label: "Projects", icon: FolderGit2, to: "/projects", match: (p) => p.startsWith("/projects") },
  { key: "defects", label: "Defects", icon: Bug, to: "/defects", match: (p) => p.startsWith("/defects") },
  { key: "usage", label: "Usage", icon: ChartColumn, to: "/usage", match: (p) => p.startsWith("/usage") },
  { key: "billing", label: "Billing", icon: CreditCard, to: "/billing", match: (p) => p.startsWith("/billing") },
  { key: "org", label: "Organization", icon: Building2, to: "/settings/members", match: (p) => p.startsWith("/settings") || p.startsWith("/api-keys") },
];

const ORG_PAGES = [
  { to: "/overview", label: "Overview", end: true },
  { to: "/projects", label: "Projects", end: false },
  { to: "/defects", label: "Defects", end: false },
  { to: "/usage", label: "Usage", end: false },
  { to: "/billing", label: "Billing", end: false },
];
const SETTINGS_PAGES = [
  { to: "/settings", label: "General", end: true },
  { to: "/settings/members", label: "Members", end: false },
  { to: "/api-keys", label: "API keys", end: false },
];
const PROJECT_SECTIONS = [
  { tab: "runs", label: "Runs" },
  { tab: "setup", label: "Setup" },
  { tab: "settings", label: "Settings" },
] as const;

/** What the frame shows about the open project. Set by its pages; layout only. */
export type ProjectInfo = { name: string; language?: string; runner?: string; snippet?: string };
const ProjectTitle = createContext<{ info: ProjectInfo; set: (info: ProjectInfo) => void }>({ info: { name: "" }, set: () => {} });
export function useProjectTitle(name: string | undefined, more?: Omit<ProjectInfo, "name">) {
  const { set } = useContext(ProjectTitle);
  const key = JSON.stringify(more ?? {});
  useEffect(() => {
    set({ name: name ?? "", ...(JSON.parse(key) as Omit<ProjectInfo, "name">) });
    return () => set({ name: "" });
  }, [name, key, set]);
}

/** A project page: /projects/<id> and its runs, not the list and not /projects/connect. */
function projectIdOf(path: string): string | null {
  const m = /^\/projects\/([^/]+)/.exec(path);
  return m && m[1] !== "connect" ? m[1] : null;
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

/** The mock backend is on: every number is sample data, and the screens say so. */
function SampleNote() {
  if (!client.sample) return null;
  return (
    <p className="sample-note" role="note">
      <span className="sample-badge">Sample data</span>
      <span className="muted small">Made up from the shapes fenvix measured on real repositories. Connect a project to see your own runs.</span>
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

function ProjectSectionLinks({ projectId, onNavigate }: { projectId: string; onNavigate?: () => void }) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const onRun = pathname.includes("/runs/");
  const tab = onRun ? "runs" : (params.get("tab") ?? "runs");
  return (
    <>
      {/* The frame sits outside the routes, so the project's own path is given in full. */}
      {PROJECT_SECTIONS.map((s) => (
        <Link key={s.tab} to={s.tab === "runs" ? `/projects/${projectId}` : `/projects/${projectId}?tab=${s.tab}`} onClick={onNavigate} className={tab === s.tab ? "cx-sub-link active" : "cx-sub-link"} aria-current={tab === s.tab && !onRun ? "page" : undefined}>
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

function readPinned() {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The thin bar of area icons. It widens over the page while the pointer is on it and closes when the pointer leaves;
 * "Keep this menu open" pins it open beside the page (remembered in this browser only).
 */
function Rail({ path }: { path: string }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(readPinned);
  const wide = pinned || hover;
  const togglePin = () =>
    setPinned((p) => {
      try {
        localStorage.setItem(RAIL_KEY, p ? "0" : "1");
      } catch {
        /* private window: the pin lasts for this page only */
      }
      if (p) setHover(false);
      return !p;
    });
  return (
    <nav className="cx-rail" aria-label="Areas" data-wide={wide || undefined} data-open={pinned || undefined} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
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
        <button type="button" className="cx-rail-link" aria-pressed={pinned} onClick={togglePin} title={pinned ? "Let this menu close" : "Keep this menu open"}>
          {pinned ? <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" /> : <PanelLeftOpen size={18} strokeWidth={1.75} aria-hidden="true" />}
          <span className="cx-rail-label">Keep this menu open</span>
        </button>
      </div>
    </nav>
  );
}

/** Below 900px: one drawer with every area and its pages. */
function Drawer({ path, onClose }: { path: string; onClose: () => void }) {
  const { info } = useContext(ProjectTitle);
  const projectId = projectIdOf(path);
  return (
    <>
      <div className="cx-drawer-top">
        <Logo />
        <span className="cx-top-fill" />
        <ThemeButton />
        <button type="button" className="cx-icon-btn cx-icon-plain" onClick={onClose} aria-label="Close navigation">
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <div className="cx-drawer-body">
        {projectId && (
          <nav aria-label="Project sections" className="cx-drawer-group">
            <p className="cx-drawer-label">
              Project <span className="cx-drawer-label-name">{info.name}</span>
            </p>
            <ProjectSectionLinks projectId={projectId} onNavigate={onClose} />
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
      </div>
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

/** "Org <name> ▾": the organizations to switch to, when there is more than one place to be. */
function OrgCrumb({ name }: { name: string }) {
  const org = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);
  const many = org.status === "ready" && org.orgs.length > 1 && org.current;
  if (!many)
    return (
      <Link to="/overview" className="cx-crumb-btn">
        <span className="cx-crumb-kind">Org</span>
        <span className="cx-crumb-name">{name}</span>
      </Link>
    );
  return (
    <span className="cx-crumb-menu" ref={ref}>
      <button type="button" className="cx-crumb-btn" aria-expanded={open} aria-controls={listId} aria-label={`Organization: ${name}. Switch organization`} onClick={() => setOpen((o) => !o)}>
        <span className="cx-crumb-kind">Org</span>
        <span className="cx-crumb-name">{name}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div id={listId} className="cx-pop" role="group" aria-label="Switch organization">
          {org.orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              className="org-item"
              aria-current={o.id === org.current?.id ? "true" : undefined}
              onClick={() => {
                setOpen(false);
                if (o.id === org.current?.id) return;
                org.switchTo(o.id);
                navigate("/overview");
                toast(`Switched to ${o.name}`, "success");
              }}
            >
              <OrgAvatar name={o.name} size={24} />
              <span className="org-item-text">
                <span className="org-item-name">{o.name}</span>
                <span className="org-item-role">{ROLE_NAMES[o.role]}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function Crumbs({ path, orgName }: { path: string; orgName: string }) {
  const { info } = useContext(ProjectTitle);
  const projectId = projectIdOf(path);
  const area = AREAS.find((a) => a.match(path));
  return (
    <nav aria-label="Where you are" className="cx-crumbs">
      {orgName && <OrgCrumb name={orgName} />}
      {area && (
        <>
          <span className="cx-crumb-sep" aria-hidden="true">
            /
          </span>
          {projectId ? (
            <Link to="/projects" className="cx-crumb-btn cx-crumb-area">
              <span className="cx-crumb-name">{area.label}</span>
            </Link>
          ) : (
            <span className="cx-crumb-btn cx-crumb-area" aria-current="page">
              <span className="cx-crumb-name">{area.label}</span>
            </span>
          )}
        </>
      )}
      {projectId && info.name && (
        <>
          <span className="cx-crumb-sep" aria-hidden="true">
            /
          </span>
          <Link to={`/projects/${projectId}`} className="cx-crumb-btn" aria-current={path === `/projects/${projectId}` ? "page" : undefined}>
            <span className="cx-crumb-kind">Project</span>
            <span className="cx-crumb-name cx-crumb-db">{info.name}</span>
          </Link>
        </>
      )}
    </nav>
  );
}

const JUMP_PAGES = [
  { label: "Overview", to: "/overview" },
  { label: "Projects", to: "/projects" },
  { label: "Connect a project", to: "/projects/connect" },
  { label: "Defects", to: "/defects" },
  { label: "Usage", to: "/usage" },
  { label: "Billing", to: "/billing" },
  { label: "Organization settings", to: "/settings" },
  { label: "Members", to: "/settings/members" },
  { label: "API keys", to: "/api-keys" },
];

/** "Search or jump to": pages and projects by name. ⌘K or Ctrl+K puts the cursor in it. */
function JumpSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const term = q.trim().toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The projects are loaded once, the first time someone types.
  useEffect(() => {
    if (!term || projects) return;
    let live = true;
    client
      .listProjects()
      .then((p) => live && setProjects(p))
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, [term, projects]);

  const items = term
    ? [
        ...JUMP_PAGES.filter((p) => p.label.toLowerCase().includes(term)).map((p) => ({ key: p.to, label: p.label, kind: "Page", to: p.to })),
        ...(projects ?? []).filter((p) => p.fullName.toLowerCase().includes(term)).slice(0, 6).map((p) => ({ key: p.id, label: p.fullName, kind: "Project", to: `/projects/${p.id}` })),
      ]
    : [];
  const show = open && term.length > 0;
  const go = useCallback(
    (to: string) => {
      setOpen(false);
      setQ("");
      input.current?.blur();
      navigate(to);
    },
    [navigate],
  );

  return (
    <div className="cx-search">
      <Search size={15} strokeWidth={1.75} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search or jump to"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && items[active] ? `${listId}-${active}` : undefined}
        placeholder="Search or jump to…"
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setActive(0))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, items.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          else if (e.key === "Enter" && items[active]) (e.preventDefault(), go(items[active].to));
          else if (e.key === "Escape") (setOpen(false), setQ(""));
        }}
      />
      <kbd className="cx-kbd" aria-hidden="true">
        ⌘K
      </kbd>
      {show && (
        <ul id={listId} role="listbox" className="cx-pop cx-search-list" aria-label="Pages and projects">
          {items.length === 0 && (
            <li className="cx-search-none" role="presentation">
              Nothing matches
            </li>
          )}
          {items.map((it, i) => (
            <li key={it.key} id={`${listId}-${i}`} role="option" aria-selected={i === active} className="cx-search-item" onMouseDown={(e) => (e.preventDefault(), go(it.to))} onMouseEnter={() => setActive(i)}>
              <span className={it.kind === "Project" ? "mono ellipsis" : "ellipsis"}>{it.label}</span>
              <span className="cx-search-kind">{it.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo>({ name: "" });
  const { pathname } = useLocation();
  const drawer = useRef<HTMLElement>(null);
  const current = useCurrentOrg();
  const orgName = current.status === "ready" ? current.name : "";

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
    <ProjectTitle.Provider value={{ info: projectInfo, set: setProjectInfo }}>
      <div className="shell cx-shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>

        <header className="cx-top">
          <button type="button" className="cx-icon-btn cx-menu cx-icon-plain" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <Link to="/overview" className="cx-logo" aria-label="FENVIX, overview">
            <Logo />
          </Link>
          <Crumbs path={pathname} orgName={orgName} />
          <span className="cx-top-fill" />
          <span className="cx-top-where">{projectInfo.name && projectIdOf(pathname) ? projectInfo.name : orgName}</span>
          <JumpSearch />
          <ThemeButton />
          <div className="cx-account">
            <AccountMenu />
          </div>
        </header>

        <div className="cx-body">
          <Rail path={pathname} />
          <div className="cx-content">
            <main id="main" tabIndex={-1}>
              <SampleNote />
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
    </ProjectTitle.Provider>
  );
}
