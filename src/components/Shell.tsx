import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, BookOpen, Building2, ChartColumn, Check, ChevronDown, FolderGit2, LayoutDashboard, Menu, Moon, PanelLeftClose, PanelLeftOpen, Play, Search, ShieldCheck, SlidersHorizontal, Sun, X, type LucideIcon } from "lucide-react";
import { Logo } from "./Logo";
import { AccountMenu, OrgAvatar, useCurrentOrg } from "./AccountMenu";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useOrg } from "../session/OrgProvider";
import { useTheme } from "../lib/theme";
import { client, type GitHubRepository, type ProjectRow, type SearchResult } from "../data";
import { isSettingUp, setupPath, setupTag } from "../lib/setup";
import { setupSnippet } from "../data/ci";
import { CopyButton } from "./CopyButton";
import { ROLE_NAMES } from "../data/orgs";
import { PROJECT_SOON } from "./ComingSoon";

/*
 * The console's frame, laid out like the mockup (fenvix-brain, Fenvix console 3):
 * - a top bar: the logo, where you are as switchers (Org ▾ / Project), "Search or jump to", the theme and the account;
 * - a thin bar of icons on the left that widens over the page on hover, or stays open when pinned: the open project's
 *   sections on top (Runs, Defects, Setup, Settings), the organization's areas below;
 * - a second bar with what is open (a project, the organization or its settings), its pages written out and a box at
 *   the bottom, like the dashboard drawn in the landing (founder, 2026-11-17).
 * Below 900px the bars become one drawer. Every page, route and action is the one it was.
 */

const DOCS_URL = "https://docs.fenvix.dev/";
const RAIL_KEY = "fenvix-rail-open";

/**
 * The rail's icons are the areas; the second bar is the open area's own sub-menu, never a copy of the rail
 * (founder, 2026-11-17). Overview has no sub-menu, so the second bar is not shown there.
 */
type AreaKey = "overview" | "projects" | "usage" | "org";
type Area = { key: AreaKey; label: string; icon: LucideIcon; to: string; match: (path: string) => boolean };
const AREAS: Area[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, to: "/overview", match: (p) => p.startsWith("/overview") },
  { key: "projects", label: "Projects", icon: FolderGit2, to: "/projects", match: (p) => p.startsWith("/projects") || p.startsWith("/defects") },
  { key: "usage", label: "Usage", icon: ChartColumn, to: "/usage", match: (p) => p.startsWith("/usage") || p.startsWith("/billing") },
  { key: "org", label: "Organization", icon: Building2, to: "/settings", match: (p) => p.startsWith("/settings") || p.startsWith("/api-keys") },
];
const areaOf = (path: string): AreaKey | null => AREAS.find((a) => a.match(path))?.key ?? null;

// Plans and billing is hidden until the price is decided (22 Dec): the /billing route and its page stay, with no link.
const USAGE_PAGES = [{ to: "/usage", label: "Usage", end: false }];
const SETTINGS_PAGES = [
  { to: "/settings", label: "General", end: true },
  { to: "/settings/members", label: "Members", end: false },
  { to: "/api-keys", label: "API keys", end: false },
];
const PROJECTS_PAGES = [
  { to: "/projects", label: "All projects", end: true },
  { to: "/projects/connect", label: "Connect a project", end: false },
];
/**
 * The project's sections, as in the dashboard drawn in the landing (founder, 2026-11-17): the icons of the rail and the
 * first links of the second bar.
 */
type SectionKey = "runs" | "parallel" | "defects" | "skip" | "nightly" | "ttg" | "settings";
type Section = { key: SectionKey; label: string; icon: LucideIcon; to: (id: string) => string; soon?: boolean };
const PROJECT_SECTIONS: Section[] = [
  { key: "runs", label: "Runs", icon: Play, to: (id) => `/projects/${id}` },
  { key: "parallel", label: "Parallel with proof", icon: ShieldCheck, to: (id) => `/projects/${id}/parallel-with-proof` },
  { key: "skip", label: "Cache with proof", icon: Check, to: (id) => `/projects/${id}/skip-with-proof` },
  // Live-list features not built yet: each opens its coming-soon page (src/components/ComingSoon.tsx).
  { key: "nightly", label: PROJECT_SOON.nightly.label, icon: Moon, to: (id) => `/projects/${id}/${PROJECT_SOON.nightly.path}`, soon: true },
  { key: "settings", label: "Settings", icon: SlidersHorizontal, to: (id) => `/projects/${id}/settings` },
];
const SECTION_OF: Record<string, SectionKey> = { "parallel-with-proof": "parallel", defects: "defects", "skip-with-proof": "skip", nightly: "nightly", "time-to-green": "ttg", settings: "settings", runs: "runs" };
const LAST_PROJECT = "fenvix-last-project";
export function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    /* private window */
  }
}
export function rememberedProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

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

/** The full name of the project the open page is about ("" elsewhere), for the browser tab's title. */
export function useOpenProjectName(): string {
  return useContext(ProjectTitle).info.name;
}

/** The organization's projects, loaded once for the frame (switcher, the project the frame shows). */
const ProjectsList = createContext<ProjectRow[] | null>(null);
/**
 * Repositories in setup (setup pull request open, or merged with no project yet): listed as "Setting up" (founder,
 * 28 Nov). Read once when the Projects area is entered; the pages that read the repository list themselves (Connect,
 * a setup page) hand it over with `update`, so the list follows a setup without asking again.
 */
type SettingUp = { list: GitHubRepository[]; update: (repos: GitHubRepository[]) => void };
const SettingUpList = createContext<SettingUp>({ list: [], update: () => undefined });
export const useSettingUp = () => useContext(SettingUpList);

/** The project the frame is about: the one in the address (a project page, or the defects filtered to one project). */
function useProjectContext(): { projectId: string | null; section: SectionKey | null; runId: string | null } {
  const { pathname, search } = useLocation();
  const m = /^\/projects\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/.exec(pathname);
  if (m && m[1] !== "connect") return { projectId: m[1], section: SECTION_OF[m[2] ?? "runs"] ?? "runs", runId: m[2] === "runs" ? (m[3] ?? null) : null };
  const only = pathname === "/defects" ? new URLSearchParams(search).get("project") : null;
  return only ? { projectId: only, section: "defects", runId: null } : { projectId: null, section: null, runId: null };
}

/** The open project's name and runner: from its page when it set them, otherwise read once from the project list. */
function useProjectInfo(projectId: string | null): ProjectInfo {
  const { info: pageInfo } = useContext(ProjectTitle);
  const list = useContext(ProjectsList);
  const listed = list?.find((p) => p.id === projectId);
  const info = pageInfo.name ? pageInfo : listed ? { name: listed.fullName, runner: listed.testRunner, snippet: setupSnippet(listed) } : pageInfo;
  const [loaded, setLoaded] = useState<ProjectRow | null>(null);
  useEffect(() => {
    if (!projectId || info.name) return;
  rememberProject(projectId);
    let live = true;
    client.getProject(projectId).then((p) => live && setLoaded(p), () => live && setLoaded(null));
    return () => {
      live = false;
    };
  }, [projectId, info.name]);
  if (info.name || !loaded || loaded.id !== projectId) return info;
  return { name: loaded.fullName, runner: loaded.testRunner, snippet: setupSnippet(loaded) };
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

function ProjectSectionLinks({ projectId, onNavigate, keys }: { projectId: string; onNavigate?: () => void; keys?: SectionKey[] }) {
  const { section } = useProjectContext();
  return (
    <>
      {PROJECT_SECTIONS.filter((s) => !keys || keys.includes(s.key)).map((s) => (
        <Link key={s.key} to={s.to(projectId)} onClick={onNavigate} className={section === s.key ? "cx-sub-link active" : "cx-sub-link"} aria-current={section === s.key ? "page" : undefined}>
          {s.label}
          {s.soon && <span className="cx-soon">Soon</span>}
        </Link>
      ))}
    </>
  );
}

function PageLinks({ pages, onNavigate }: { pages: { to: string; label: string; end: boolean }[]; onNavigate?: () => void }) {
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

/** The second bar: the sub-menu of the open area. Nothing on the Overview, which has no sub-menu. */
function SubNav({ path, orgName }: { path: string; orgName: string }) {
  const area = areaOf(path);
  const { projectId } = useProjectContext();
  const info = useProjectInfo(projectId);
  const list = useContext(ProjectsList) ?? [];
  const settingUp = useContext(SettingUpList).list;
  if (area === null || area === "overview") return null;
  return (
    <aside className="cx-sub" aria-label="Pages">
      {area === "projects" && projectId ? (
        <>
          <Link to="/projects" className="cx-sub-back">
            <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
            All projects
          </Link>
          <div className="cx-sub-head">
            <span className="cx-sub-kind">Project</span>
            <span className="cx-sub-title">
              <span className="break-anywhere">{info.name || " "}</span>
              <span className="cx-sub-dot" aria-hidden="true" />
            </span>
            {info.runner && <span className="cx-sub-meta">GitHub Actions · {info.runner}</span>}
          </div>
          <nav aria-label="Project sections" className="cx-sub-nav">
            <ProjectSectionLinks projectId={projectId} />
          </nav>
        </>
      ) : area === "projects" ? (
        <>
          <div className="cx-sub-head">
            <span className="cx-sub-kind">Projects</span>
            <span className="cx-sub-title">{orgName || " "}</span>
          </div>
          <nav aria-label="Projects" className="cx-sub-nav">
            <PageLinks pages={PROJECTS_PAGES} />
          </nav>
          {(list.length > 0 || settingUp.length > 0) && (
            <nav aria-label="Your projects" className="cx-sub-nav cx-sub-nav-more">
              <span className="cx-sub-kind cx-sub-group">Your projects</span>
              <PageLinks pages={list.map((p) => ({ to: `/projects/${p.id}`, label: p.fullName, end: false }))} />
              {settingUp.map((r) => (
                <NavLink key={r.repositoryId} to={setupPath(r)} className="cx-sub-link cx-sub-setup">
                  <span className="break-anywhere">{r.fullName}</span>
                  <span className="cx-sub-setup-tag">{setupTag(r)}</span>
                </NavLink>
              ))}
            </nav>
          )}
        </>
      ) : (
        <>
          <div className="cx-sub-head">
            <span className="cx-sub-kind">{area === "usage" ? "Usage" : "Organization"}</span>
            <span className="cx-sub-title">{orgName || " "}</span>
          </div>
          <nav aria-label={area === "usage" ? "Usage" : "Organization settings"} className="cx-sub-nav">
            <PageLinks pages={area === "usage" ? USAGE_PAGES : SETTINGS_PAGES} />
          </nav>
        </>
      )}
      <span className="cx-sub-fill" />
      {area === "projects" && projectId && info.snippet && (
        <div className="cx-sub-box">
          <span className="cx-sub-box-title">Run on fenvix</span>
          <span className="cx-sub-box-text">
            One line in the test job: <span className="mono">runs-on: fenvix</span>
          </span>
          <span className="cx-sub-copy">
            <CopyButton value={info.snippet} what="setup snippet" text="Copy the test job" />
          </span>
        </div>
      )}
    </aside>
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
  // `open` is the temporary overlay (pointer or keyboard); `pinned` keeps the rail open beside the page.
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  // The open rail is an overlay; where a second bar sits beside it, the overlay covers that bar too.
  const area = areaOf(path);
  const hasSub = area !== null && area !== "overview";
  const [pinned, setPinned] = useState(readPinned);
  const wide = pinned || open;
  const close = () => {
    setOpen(false);
    // A clicked link or button keeps focus; without this the rail would stay open after the pointer has left.
    const nav = navRef.current;
    if (nav && nav.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };
  // Clicking outside the open rail, or Escape from anywhere, closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node | null)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const togglePin = () =>
    setPinned((p) => {
      try {
        localStorage.setItem(RAIL_KEY, p ? "0" : "1");
      } catch {
        /* private window: the pin lasts for this page only */
      }
      setOpen(false);
      return !p;
    });
  return (
    <nav
      ref={navRef}
      className="cx-rail"
      aria-label="Areas"
      data-wide={wide || undefined}
      data-open={pinned || undefined}
      data-sub={hasSub || undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={(e) => {
        // Only keyboard focus opens it; a click's focus must not keep it open.
        if (e.target.matches(":focus-visible")) setOpen(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) close();
      }}
    >
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
function Drawer({ onClose }: { path: string; onClose: () => void }) {
  const { projectId } = useProjectContext();
  const info = useProjectInfo(projectId);
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
        <nav aria-label="Overview" className="cx-drawer-group">
          <PageLinks pages={[{ to: "/overview", label: "Overview", end: true }]} onNavigate={onClose} />
        </nav>
        <nav aria-label="Projects" className="cx-drawer-group">
          <p className="cx-drawer-label">Projects</p>
          <PageLinks pages={PROJECTS_PAGES} onNavigate={onClose} />
        </nav>
        {projectId && (
          <nav aria-label="Project sections" className="cx-drawer-group">
            <p className="cx-drawer-label">
              Project <span className="cx-drawer-label-name">{info.name}</span>
            </p>
            <ProjectSectionLinks projectId={projectId} onNavigate={onClose} />
          </nav>
        )}
        <nav aria-label="Usage" className="cx-drawer-group">
          <p className="cx-drawer-label">Usage</p>
          <PageLinks pages={USAGE_PAGES} onNavigate={onClose} />
        </nav>
        <nav aria-label="Organization settings" className="cx-drawer-group">
          <p className="cx-drawer-label">Organization</p>
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
      <button type="button" className="cx-crumb-btn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        <span className="cx-crumb-kind">Org</span>
        <span className="cx-crumb-name">{name}</span>
        <span className="sr-only">: switch organization</span>
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

/**
 * "Project <name> ▾": the name goes to the project, the arrow opens the organization's projects to switch to (the same
 * section stays open).
 */
function ProjectCrumb({ projectId, name }: { projectId: string; name: string }) {
  const list = useContext(ProjectsList) ?? [];
  const { section } = useProjectContext();
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
  const target = PROJECT_SECTIONS.find((s) => s.key === (section ?? "runs")) ?? PROJECT_SECTIONS[0];
  return (
    <span className="cx-crumb-menu" ref={ref}>
      <Link to={`/projects/${projectId}`} className="cx-crumb-btn cx-crumb-link" title={name}>
        <span className="cx-crumb-kind">Project</span>
        <span className="cx-crumb-name cx-crumb-db">{name}</span>
      </Link>
      <button type="button" className="cx-crumb-btn cx-crumb-chevron" aria-expanded={open} aria-controls={listId} aria-label="Switch project" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div id={listId} className="cx-pop" role="group" aria-label="Switch project">
          {list.map((p) => (
            <Link key={p.id} to={target.to(p.id)} className="org-item" aria-current={p.id === projectId ? "true" : undefined} onClick={() => setOpen(false)}>
              <span className="org-item-text">
                <span className="org-item-name mono">{p.fullName}</span>
                <span className="org-item-role">{p.testRunner}</span>
              </span>
            </Link>
          ))}
          <Link to="/projects" className="org-item" onClick={() => setOpen(false)}>
            <span className="org-item-text">
              <span className="org-item-name">All projects</span>
            </span>
          </Link>
          <Link to="/projects/connect" className="org-item" onClick={() => setOpen(false)}>
            <span className="org-item-text">
              <span className="org-item-name">Connect a project</span>
            </span>
          </Link>
        </div>
      )}
    </span>
  );
}

const Sep = () => (
  <span className="cx-crumb-sep" aria-hidden="true">
    /
  </span>
);

/** The pages of an area, and the one the address is on (the longest address that matches), for the last crumb. */
function pageOf(area: AreaKey, path: string): { to: string; label: string } | null {
  const pages = area === "projects" ? PROJECTS_PAGES : area === "usage" ? USAGE_PAGES : area === "org" ? SETTINGS_PAGES : [];
  const hit = pages.filter((p) => path === p.to || path.startsWith(`${p.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];
  return hit ?? null;
}

/**
 * Where you are, clickable at every level: Org / Projects / <project> / <section> inside a project, otherwise
 * Org / <area> / <page>. The current level is marked aria-current; each level before it goes back one click.
 */
function Crumbs({ path, orgName }: { path: string; orgName: string }) {
  const { projectId, section, runId } = useProjectContext();
  const info = useProjectInfo(projectId);
  const area = AREAS.find((x) => x.match(path));
  const sectionDef = PROJECT_SECTIONS.find((s) => s.key === section);
  const inProject = !!(projectId && info.name);
  const page = area && !inProject ? pageOf(area.key, path) : null;
  const sectionHere = !runId;
  return (
    <nav aria-label="Where you are" className="cx-crumbs">
      {orgName && <OrgCrumb name={orgName} />}
      {area && (
        <>
          <Sep />
          <Link to={area.to} className="cx-crumb-btn cx-crumb-area" aria-current={!inProject && !page && path === area.to ? "page" : undefined}>
            <span className="cx-crumb-name">{area.label}</span>
          </Link>
        </>
      )}
      {inProject && projectId && (
        <>
          <Sep />
          <ProjectCrumb projectId={projectId} name={info.name.split("/").pop() ?? info.name} />
          {sectionDef && (
            <>
              <Sep />
              <Link to={sectionDef.to(projectId)} className="cx-crumb-btn cx-crumb-area" aria-current={sectionHere ? "page" : undefined}>
                <span className="cx-crumb-name">{sectionDef.label}</span>
              </Link>
            </>
          )}
          {runId && (
            <>
              <Sep />
              <span className="cx-crumb-btn" aria-current="page">
                <span className="cx-crumb-name">Run</span>
              </span>
            </>
          )}
        </>
      )}
      {page && area && page.to !== area.to && (
        <>
          <Sep />
          <Link to={page.to} className="cx-crumb-btn cx-crumb-area" aria-current={path === page.to ? "page" : undefined}>
            <span className="cx-crumb-name">{page.label}</span>
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
  { label: "Usage", to: "/usage" },
  { label: "Organization settings", to: "/settings" },
  { label: "Members", to: "/settings/members" },
  { label: "API keys", to: "/api-keys" },
];

/**
 * "Search or jump to": pages and projects by name, and from 2 characters on (debounced) runs by number or commit and
 * open defects by test name (GET /search, F-004). Each run and defect names its project. ⌘K or Ctrl+K puts the cursor in it.
 */
function JumpSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const term = q.trim().toLowerCase();
  const [found, setFound] = useState<{ q: string; items: SearchResult[] } | null>(null);
  useEffect(() => {
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      client.search(term).then((items) => live && setFound({ q: term, items }), () => live && setFound({ q: term, items: [] }));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term]);
  const hits = term.length >= 2 && found?.q === term ? found.items : [];
  const searching = term.length >= 2 && found?.q !== term;

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
        ...hits.filter((h) => h.kind === "run").map((h) => ({ key: `run-${h.id}`, label: `${h.label} · ${h.sublabel}`, kind: "Run", to: `/projects/${h.projectId}/runs/${h.id}` })),
        ...hits.filter((h) => h.kind === "defect").map((h) => ({ key: `defect-${h.id}`, label: `${h.label} · ${h.sublabel}`, kind: "Defect", to: `/defects/${h.id}` })),
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
        <ul id={listId} role="listbox" className="cx-pop cx-search-list" aria-label="Pages, projects, runs and defects">
          {items.length === 0 && (
            <li className="cx-search-none" role="presentation">
              {searching ? "Searching runs and defects…" : "Nothing matches"}
            </li>
          )}
          {items.map((it, i) => (
            <li key={it.key} id={`${listId}-${i}`} role="option" aria-selected={i === active} className="cx-search-item" onMouseDown={(e) => (e.preventDefault(), go(it.to))} onMouseEnter={() => setActive(i)}>
              <span className={it.kind === "Project" || it.kind === "Defect" ? "mono ellipsis" : "ellipsis"}>{it.label}</span>
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
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  useEffect(() => {
    let live = true;
    client.listProjects().then((p) => live && setProjects(p), () => live && setProjects([]));
    return () => {
      live = false;
    };
  }, []);
  const { pathname } = useLocation();
  // Read when the Projects area is entered (not on every page of it); pages that read the list hand it over.
  const [settingUp, setSettingUp] = useState<GitHubRepository[]>([]);
  // A repository that leaves "Setting up" has usually just become a project: the project list is read again then, so
  // it moves to "Your projects" instead of leaving the sidebar until a reload.
  const shownIds = useRef<Set<number>>(new Set());
  const updateSettingUp = useCallback((repos: GitHubRepository[]) => {
    const next = repos.filter(isSettingUp);
    const ids = new Set(next.map((r) => r.repositoryId));
    const left = [...shownIds.current].some((id) => !ids.has(id));
    shownIds.current = ids;
    setSettingUp(next);
    if (left) client.listProjects().then(setProjects, () => undefined);
  }, []);
  const inProjects = pathname.startsWith("/projects");
  useEffect(() => {
    if (!inProjects) return;
    let live = true;
    client.listGitHubRepositories().then((rs) => live && updateSettingUp(rs), () => undefined);
    return () => {
      live = false;
    };
  }, [inProjects, updateSettingUp]);
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
    <ProjectsList.Provider value={projects}>
    <SettingUpList.Provider value={{ list: settingUp, update: updateSettingUp }}>
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
          <span className="cx-top-where">{projectInfo.name || orgName}</span>
          <JumpSearch />
          <ThemeButton />
          <div className="cx-account">
            <AccountMenu />
          </div>
        </header>

        <div className="cx-body">
          <Rail path={pathname} />
          <SubNav path={pathname} orgName={orgName} />
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
    </SettingUpList.Provider>
    </ProjectsList.Provider>
  );
}
