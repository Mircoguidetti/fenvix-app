import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink } from "react-router-dom";
import { client, type Settings } from "../data";
import { orgs } from "../data/orgs-client";
import { ROLE_NAMES, orgNameProblem } from "../data/orgs";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../session/SessionProvider";
import { useOrg } from "../session/OrgProvider";
import { useToast } from "../components/Toast";
import { workspaceChanged } from "../lib/workspace";

/** General and Members, as two pages under Settings. */
export function SettingsTabs() {
  return (
    <nav className="seg settings-tabs" aria-label="Settings sections">
      <NavLink to="/settings" end className={({ isActive }) => (isActive ? "seg-link active" : "seg-link")}>
        General
      </NavLink>
      <NavLink to="/settings/members" className={({ isActive }) => (isActive ? "seg-link active" : "seg-link")}>
        Members
      </NavLink>
    </nav>
  );
}

/** Rename the organization: owner and admin. The name is plain text, 2 to 64 characters. */
function OrganizationCard() {
  const org = useOrg();
  const toast = useToast();
  const [name, setName] = useState(org.current?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(org.current?.name ?? ""), [org.current?.id, org.current?.name]);
  if (!org.current) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    const problem = orgNameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await orgs.renameOrganization(name.trim());
      await org.refresh();
      toast("Organization renamed", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the organization. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="organization" title="Organization" description={org.canManage ? "Its name, as everyone in it sees it." : "Only an owner or admin can rename it."}>
      {org.canManage ? (
        <form onSubmit={save} className="stack" noValidate>
          <div className="field">
            <label htmlFor="org-rename">Organization name</label>
            <input id="org-rename" value={name} maxLength={200} onChange={(e) => (setName(e.target.value), setError(null))} aria-invalid={error ? true : undefined} aria-describedby={error ? "org-rename-error" : undefined} />
            {error && (
              <p id="org-rename-error" className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === org.current.name}>
              Rename
            </button>
          </div>
        </form>
      ) : (
        <dl className="facts facts-fill">
          <div>
            <dt>Name</dt>
            <dd className="break-anywhere">{org.current.name}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const loaded = useAsync(() => client.getSettings(), []);
  const { user, signOut } = useSession();
  const org = useOrg();
  const toast = useToast();
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !org.canManage;
  // With the organizations API the name has its own card; without it, it stays in this form as before.
  const nameHere = org.status !== "ready";

  useEffect(() => {
    if (loaded.status === "ready") setForm(loaded.data);
  }, [loaded.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || readOnly) return;
    if (nameHere && !form.workspaceName.trim()) return setError("Enter a workspace name.");
    setError(null);
    try {
      await client.saveSettings({ ...form, workspaceName: nameHere ? form.workspaceName.trim() : (org.current?.name ?? form.workspaceName).trim() });
      workspaceChanged();
      setSaved(true);
      toast("Settings saved", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the settings. Try again.");
    }
  }

  return (
    <>
      <PageHeader title="Settings" description="Your organization, its members and your account." />
      {org.status === "ready" && <SettingsTabs />}

      <div className="grid-2 even">
        {org.status === "ready" && <OrganizationCard />}

        <Card id="workspace" title="Databases" description={readOnly ? "Only an owner or admin can change these." : "How new databases behave in this organization."}>
          {loaded.status === "loading" && <Message>Loading settings</Message>}
          {loaded.status === "error" && <Message role="alert">{loaded.message}</Message>}
          {form && (
            <form onSubmit={save} className="stack" noValidate>
              <fieldset disabled={readOnly} className="plain-fieldset stack">
                {nameHere && (
                  <div className="field">
                    <label htmlFor="ws-name">Workspace name</label>
                    <input id="ws-name" value={form.workspaceName} maxLength={60} onChange={(e) => { setSaved(false); setForm({ ...form, workspaceName: e.target.value }); }} aria-invalid={error ? true : undefined} aria-describedby={error ? "ws-error" : undefined} />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="ws-idle">Sleep after idle</label>
                  <select id="ws-idle" value={form.idleMinutes} onChange={(e) => { setSaved(false); setForm({ ...form, idleMinutes: Number(e.target.value) }); }}>
                    {[1, 5, 15, 60].map((m) => (
                      <option key={m} value={m}>{m === 60 ? "1 hour" : `${m} ${m === 1 ? "minute" : "minutes"}`}</option>
                    ))}
                  </select>
                  <p className="muted small">New databases sleep after this much time with no requests.</p>
                </div>
                <label className="check">
                  <input type="checkbox" checked={form.emailNotices} onChange={(e) => { setSaved(false); setForm({ ...form, emailNotices: e.target.checked }); }} />
                  Email me about usage and account notices
                </label>
              </fieldset>
              {error && <p id="ws-error" className="error" role="alert">{error}</p>}
              {!readOnly && (
                <div className="row-actions">
                  <button type="submit" className="btn btn-primary">Save changes</button>
                  <span role="status" className="muted">{saved ? "Saved" : ""}</span>
                </div>
              )}
            </form>
          )}
        </Card>

        <Card id="account" title="Account" description="You are signed in on this device.">
          <dl className="facts facts-fill">
            <div>
              <dt>Name</dt>
              <dd>{user?.name}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd className="ellipsis">{user?.email}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>
                <Link to="/billing" className="row-link">
                  Managed
                </Link>
              </dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{org.role ? ROLE_NAMES[org.role] : "Owner"}</dd>
            </div>
          </dl>
          <div className="row-actions">
            <button type="button" className="btn" onClick={async () => (await signOut(), toast("Signed out", "success"))}>
              Sign out
            </button>
            <span className="muted small">Signing out affects this browser only.</span>
          </div>
        </Card>
      </div>
    </>
  );
}
