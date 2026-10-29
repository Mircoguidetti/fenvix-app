import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, LogOut, Plus } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { orgs } from "../data/orgs-client";
import { ROLE_NAMES, orgNameProblem, type Organization } from "../data/orgs";
import { useOrg } from "../session/OrgProvider";
import { workspaceInitial } from "../lib/avatar";

/** Black square with the white initial of the name. */
export function OrgAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className="workspace-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {workspaceInitial(name)}
    </span>
  );
}

/**
 * The organization box of the sidebar, as a switcher: the person's organizations, "Create organization" and, for
 * anyone but an owner, "Leave organization". The choice is only a preference sent to the server, which checks the
 * membership and the role on every request.
 */
export function OrgSwitcher() {
  const org = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"create" | "leave" | null>(null);
  const [name, setName] = useState("");
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

  const current = org.current;
  if (!current) return <div className="workspace-slot" data-state="loading" />;

  function pick(o: Organization) {
    setOpen(false);
    if (o.id === current!.id) return;
    org.switchTo(o.id);
    navigate("/overview");
    toast(`Switched to ${o.name}`, "success");
  }

  async function create() {
    const problem = orgNameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const made = await orgs.createOrganization(name.trim());
      await org.refresh(made.id);
      setDialog(null);
      navigate("/overview");
      toast(`Created ${made.name}`, "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the organization. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    try {
      const left = current!.name;
      await orgs.leaveOrganization();
      await org.refresh();
      setDialog(null);
      navigate("/overview");
      toast(`You left ${left}`, "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not leave the organization. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-slot" data-state="ready" ref={ref}>
      <button
        type="button"
        className="workspace workspace-btn"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Organization: ${current.name}, ${ROLE_NAMES[current.role]}. Switch organization`}
        title={current.name}
        onClick={() => setOpen((v) => !v)}
      >
        <OrgAvatar name={current.name} />
        <span className="workspace-text" aria-hidden="true">
          <span className="workspace-name">{current.name}</span>
          <span className="workspace-sub">{ROLE_NAMES[current.role]}</span>
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" className="workspace-chevron" />
      </button>
      {open && (
        <div id={panelId} className="org-panel" role="group" aria-label="Organizations">
          <ul className="org-list">
            {org.orgs.map((o) => (
              <li key={o.id}>
                <button type="button" className="org-item" aria-current={o.id === current.id ? "true" : undefined} onClick={() => pick(o)} title={o.name}>
                  <OrgAvatar name={o.name} size={26} />
                  <span className="org-item-text">
                    <span className="org-item-name">{o.name}</span>
                    <span className="org-item-role">{ROLE_NAMES[o.role]}</span>
                  </span>
                  {o.id === current.id && <Check size={16} aria-label="Current organization" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="org-actions">
            <button type="button" className="org-item" onClick={() => (setOpen(false), setName(""), setError(null), setDialog("create"))}>
              <Plus size={16} aria-hidden="true" />
              Create organization
            </button>
            {current.role !== "owner" && (
              <button type="button" className="org-item" onClick={() => (setOpen(false), setError(null), setDialog("leave"))}>
                <LogOut size={16} aria-hidden="true" />
                Leave organization
              </button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog open={dialog === "create"} title="Create organization" confirmLabel="Create organization" busy={busy} onConfirm={create} onCancel={() => setDialog(null)}>
        <div className="field">
          <label htmlFor="new-org-name">Organization name</label>
          <input id="new-org-name" value={name} maxLength={200} onChange={(e) => (setName(e.target.value), setError(null))} aria-invalid={error ? true : undefined} aria-describedby={error ? "new-org-error" : undefined} />
          {error && (
            <p id="new-org-error" className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <p>You will be its owner. You can invite people from Settings.</p>
      </ConfirmDialog>

      <ConfirmDialog danger open={dialog === "leave"} title="Leave this organization?" confirmLabel="Leave organization" busy={busy} onConfirm={leave} onCancel={() => setDialog(null)}>
        <p>
          You will lose access to <strong className="break-anywhere">{current.name}</strong> and its databases. To come back, someone has to invite you again.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
