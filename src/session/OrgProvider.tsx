import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { orgs } from "../data/orgs-client";
import { canManage, type Organization, type OrgRole } from "../data/orgs";
import { activeOrgId, setActiveOrgId, useActiveOrgId } from "../lib/org";
import { workspaceChanged } from "../lib/workspace";

export interface OrgState {
  /** "unavailable": this dashboard cannot reach the control plane, so it shows one organization by name only. */
  status: "loading" | "ready" | "unavailable" | "error";
  orgs: Organization[];
  current: Organization | null;
  role: OrgRole | null;
  /** Owner or admin. Only decides what the screens offer: the server refuses the rest anyway. */
  canManage: boolean;
  error: string | null;
  /** Reloads the list; `select` makes that organization the current one. */
  refresh(select?: string): Promise<void>;
  switchTo(id: string): void;
}

const Ctx = createContext<OrgState>({
  status: "loading", orgs: [], current: null, role: null, canManage: false, error: null, refresh: async () => {}, switchTo: () => {},
});

/** The person's organizations and the one the dashboard shows. Loaded once signed in. */
export function OrgProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<{ status: OrgState["status"]; items: Organization[]; error: string | null }>({
    status: orgs.available ? "loading" : "unavailable", items: [], error: null,
  });
  const active = useActiveOrgId();

  const refresh = useCallback(async (select?: string) => {
    if (!orgs.available) return;
    try {
      const items = await orgs.listOrganizations();
      const want = select ?? activeOrgId();
      const pick = items.find((o) => o.id === want) ?? items[0] ?? null;
      setActiveOrgId(pick?.id ?? null);
      setList({ status: "ready", items, error: null });
      workspaceChanged();
    } catch (e) {
      setList((l) => ({ status: l.status === "ready" ? "ready" : "error", items: l.items, error: e instanceof Error ? e.message : "Could not load your organizations." }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchTo = useCallback((id: string) => {
    setActiveOrgId(id);
    workspaceChanged();
  }, []);

  const value = useMemo<OrgState>(() => {
    const current = list.items.find((o) => o.id === active) ?? null;
    const role = current?.role ?? null;
    // Without the control plane the role is not known here; the server and row level security still decide.
    const manage = list.status === "ready" ? canManage(role) : list.status !== "loading";
    return { status: list.status, orgs: list.items, current, role, canManage: manage, error: list.error, refresh, switchTo };
  }, [list, active, refresh, switchTo]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useOrg = () => useContext(Ctx);
