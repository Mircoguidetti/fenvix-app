import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, LogOut } from "lucide-react";
import { client } from "../data";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { orgs } from "../data/orgs-client";
import { ROLE_NAMES, type Organization } from "../data/orgs";
import { useOrg } from "../session/OrgProvider";
import { useSession } from "../session/SessionProvider";
import { useAsync } from "../lib/useAsync";
import { useWorkspaceVersion } from "../lib/workspace";
import { workspaceInitial } from "../lib/avatar";

/** The plan every workspace is on today; shown in place of a role when the organizations API is not set up. */
const PLAN = "Managed";

const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

/** Black square with the white initial of the name. */
export function OrgAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className="workspace-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {workspaceInitial(name)}
    </span>
  );
}

/** The organization shown under the person's name: from the organizations API, or the workspace settings without it. */
function useCurrentOrg(): { status: "loading" | "ready"; name: string; sub: string } {
  const org = useOrg();
  const version = useWorkspaceVersion();
  const api = org.status === "ready" || org.status === "loading";
  const settings = useAsync(() => (api ? Promise.resolve(null) : client.getSettings()), [version, api]);
  if (org.status === "ready" && org.current) return { status: "ready", name: org.current.name, sub: ROLE_NAMES[org.current.role] };
  if (!api && settings.status === "ready" && settings.data) return { status: "ready", name: settings.data.workspaceName.trim() || "Workspace", sub: PLAN };
  if (!api && settings.status === "error") return { status: "ready", name: "Workspace", sub: PLAN };
  return { status: "loading", name: "", sub: "" };
}

/**
 * The one block at the bottom of the navigation: the person, with their organization and role under the name. It
 * opens a menu with their email, the organizations to switch to, "Leave organization" (anyone but an owner) and
 * "Sign out". Switching is only a preference sent to the server, which checks the membership on every request.
 */
export function AccountMenu() {
  const { user, signOut } = useSession();
  const org = useOrg();
  const current = useCurrentOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

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

  if (!user) return null;
  const switcher = org.status === "ready" && org.current ? org.current : null;

  function pick(o: Organization) {
    setOpen(false);
    if (o.id === switcher?.id) return;
    org.switchTo(o.id);
    navigate("/overview");
    toast(`Switched to ${o.name}`, "success");
  }

  async function leave() {
    setBusy(true);
    try {
      const left = switcher!.name;
      await orgs.leaveOrganization();
      await org.refresh();
      setLeaving(false);
      navigate("/overview");
      toast(`You left ${left}`, "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not leave the organization. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const label = current.status === "ready" ? `${user.name}. Organization: ${current.name}, ${current.sub}. Account and organizations` : `${user.name}. Account`;

  return (
    <div className="account workspace-slot" data-state={current.status} ref={ref}>
      <button type="button" className="user-btn account-btn" aria-expanded={open} aria-controls={panelId} aria-label={label} title={current.status === "ready" ? `${user.name} · ${current.name}` : user.name} onClick={() => setOpen((o) => !o)}>
        {user.avatarUrl ? (
          <img className="avatar avatar-photo" src={user.avatarUrl} alt="" width={32} height={32} referrerPolicy="no-referrer" />
        ) : (
          <span className="avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
        )}
        <span className="workspace-text" aria-hidden="true">
          <span className="account-name">{user.name}</span>
          {current.status === "ready" && (
            <span className="account-org">
              <span className="workspace-name">{current.name}</span>
              <span className="account-dot">·</span>
              <span className="workspace-sub">{current.sub}</span>
            </span>
          )}
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" className="workspace-chevron" />
      </button>

      {open && (
        <div id={panelId} className="account-panel" role="group" aria-label="Account and organizations">
          <div className="account-who">
            <p className="user-full">{user.name}</p>
            <p className="muted small user-email">{user.email}</p>
          </div>
          {switcher && (
            <div className="org-panel">
              <p className="account-label">Organizations</p>
              <ul className="org-list">
                {org.orgs.map((o) => (
                  <li key={o.id}>
                    <button type="button" className="org-item" aria-current={o.id === switcher.id ? "true" : undefined} onClick={() => pick(o)} title={o.name}>
                      <OrgAvatar name={o.name} size={26} />
                      <span className="org-item-text">
                        <span className="org-item-name">{o.name}</span>
                        <span className="org-item-role">{ROLE_NAMES[o.role]}</span>
                      </span>
                      {o.id === switcher.id && <Check size={16} aria-label="Current organization" />}
                    </button>
                  </li>
                ))}
              </ul>
              {switcher.role !== "owner" && (
                <button type="button" className="org-item" onClick={() => (setOpen(false), setError(null), setLeaving(true))}>
                  <LogOut size={16} aria-hidden="true" />
                  Leave organization
                </button>
              )}
            </div>
          )}
          <div className="account-actions">
            <button
              type="button"
              className="org-item"
              onClick={async () => {
                setOpen(false);
                await signOut();
                toast("Signed out", "success");
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      )}

      {switcher && (
        <ConfirmDialog danger open={leaving} title="Leave this organization?" confirmLabel="Leave organization" busy={busy} onConfirm={leave} onCancel={() => setLeaving(false)}>
          <p>
            You will lose access to <strong className="break-anywhere">{switcher.name}</strong> and its databases. To come back, someone has to invite you again.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
