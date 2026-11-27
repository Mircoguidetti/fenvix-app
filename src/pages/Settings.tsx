import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { client, type Region, type Settings } from "../data";
import { orgs } from "../data/orgs-client";
import { ROLE_NAMES, orgNameProblem } from "../data/orgs";
import { Card, Message, PageHeader, Kicker } from "../components/PageHeader";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../session/SessionProvider";
import { useOrg } from "../session/OrgProvider";
import { useToast } from "../components/Toast";
import { TypedConfirmDialog } from "../components/TypedConfirmDialog";
import { workspaceChanged } from "../lib/workspace";

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

export const REGIONS: Record<Region, { name: string; where: string }> = {
  us: { name: "United States", where: "fenvix machines in the United States" },
  eu: { name: "European Union", where: "fenvix machines in the European Union" },
};

/**
 * Where the organization's jobs run: US or EU. Owners and admins choose it; members see it. It applies from the next
 * job on: a job that already started finishes where it is.
 */
function RegionCard({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const org = useOrg();
  const toast = useToast();
  const [region, setRegion] = useState<Region>(settings.region);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRegion(settings.region), [settings.region]);
  const readOnly = !org.canManage;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.saveSettings({ ...settings, workspaceName: (org.current?.name ?? settings.workspaceName).trim(), region });
      onSaved(next);
      toast(`Region saved: ${REGIONS[next.region].name}`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the region. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="region" title="Region" description="Where your test jobs run. It decides which fenvix machines run them, and where their data is processed.">
      {readOnly ? (
        <>
          <dl className="facts facts-fill">
            <div>
              <dt>Jobs run in</dt>
              <dd>{REGIONS[settings.region].name}</dd>
            </div>
          </dl>
          <p className="muted small">Only an owner or admin can change the region.</p>
        </>
      ) : (
        <form onSubmit={save} className="stack" noValidate>
          <fieldset className="plain-fieldset stack region-choices" aria-describedby="region-help">
            <legend className="label">Jobs run in</legend>
            {(Object.keys(REGIONS) as Region[]).map((r) => (
              <label key={r} className="choice" data-on={region === r || undefined}>
                <input type="radio" name="region" value={r} checked={region === r} onChange={() => setRegion(r)} />
                <span>
                  <span className="choice-title">{REGIONS[r].name}</span>
                  <span className="muted small">{REGIONS[r].where}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p id="region-help" className="help">
            A change applies from the next job on: a job that already started finishes where it is.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || region === settings.region}>
              Save region
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * The owner only: deletes the organization and everything of it. The typed organization name enables the button.
 * After it the console signs out (the person's sign-in may be gone) and lands on the sign-in page.
 */
function DeleteAccountCard() {
  const org = useOrg();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = org.current?.name ?? "";
  if (!org.current || org.role !== "owner") return null;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await orgs.deleteOrganization();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the account. Try again.");
      setBusy(false);
      return;
    }
    setOpen(false);
    // The sign-in may already be gone with the account: signing out here only clears this browser.
    await signOut().catch(() => undefined);
    navigate("/", { replace: true });
  }

  return (
    <Card id="delete-account" title="Delete account" description="Delete this organization and everything fenvix stores for it. Only an owner can do this.">
      <div className="row-actions">
        <button type="button" className="btn btn-danger" onClick={() => (setError(null), setOpen(true))}>
          Delete account
        </button>
      </div>
      <TypedConfirmDialog
        open={open}
        title={`Delete ${name}?`}
        expected={name}
        what="the organization name"
        confirmLabel="Delete account"
        busy={busy}
        error={error}
        onConfirm={remove}
        onCancel={() => !busy && setOpen(false)}
      >
        <div>
          <p className="label">What goes, for good</p>
          <ul className="consequences">
            <li>The organization {name}, every project, run, defect and skip receipt.</li>
            <li>Every member's access, API key, invitation and usage record.</li>
            <li>The fenvix GitHub App is uninstalled from every GitHub account this organization connected.</li>
            <li>Your own sign-in, unless you belong to another organization.</li>
          </ul>
        </div>
        <div>
          <p className="label">What stays</p>
          <ul className="consequences">
            <li>Other members keep their sign-in and lose access to this organization.</li>
            <li>Your repositories and workflows on GitHub are not changed.</li>
          </ul>
        </div>
      </TypedConfirmDialog>
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
  const current = loaded.status === "ready" ? loaded.data : null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form || readOnly) return;
    if (nameHere && !form.workspaceName.trim()) return setError("Enter a workspace name.");
    setError(null);
    try {
      const next = await client.saveSettings({ ...form, workspaceName: nameHere ? form.workspaceName.trim() : (org.current?.name ?? form.workspaceName).trim(), region: current?.region ?? form.region });
      loaded.setData(next);
      workspaceChanged();
      setSaved(true);
      toast("Settings saved", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the settings. Try again.");
    }
  }

  return (
    <>
      <PageHeader back={<Kicker>Organization</Kicker>} title="Settings" description="Your organization, its members and your account." />

      <div className="grid-2 even">
        {org.status === "ready" && <OrganizationCard />}

        <Card id="workspace" title={nameHere ? "Workspace" : "Notifications"} description={readOnly ? "Only an owner or admin can change these." : "Emails FENVIX sends about this organization."}>
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
                <label className="check">
                  <input type="checkbox" checked={form.emailNotices} onChange={(e) => { setSaved(false); setForm({ ...form, emailNotices: e.target.checked }); }} />
                  Email me about new defects, run units nearing what the plan includes, and account notices
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

        {current && <RegionCard settings={current} onSaved={(next) => (loaded.setData(next), setForm((f) => (f ? { ...f, region: next.region } : next)))} />}

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
                  See billing
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
      {org.status === "ready" && org.role === "owner" && <DeleteAccountCard />}
    </>
  );
}
