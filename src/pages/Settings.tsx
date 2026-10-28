import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { client, type Settings } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { GitHubMark, GoogleMark } from "../components/marks";
import { useAsync } from "../lib/useAsync";
import { session, type AuthProvider, type LinkedIdentity } from "../session";
import { providerLabel, takeLinkResult } from "../session/redirect";
import { useSession } from "../session/SessionProvider";
import { useToast } from "../components/Toast";
import { workspaceChanged } from "../lib/workspace";

const LINKABLE: AuthProvider[] = ["github", "google"];

/** GitHub, Google and the email link: add one, or remove one while another remains. */
function SignInMethods() {
  const toast = useToast();
  const [list, setList] = useState<LinkedIdentity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<LinkedIdentity | null>(null);

  const load = useCallback(() => {
    session.listIdentities().then(setList, (e: unknown) => setError(e instanceof Error ? e.message : "Could not load your sign-in methods."));
  }, []);

  useEffect(() => {
    load();
    // Back from the provider after "Link GitHub" / "Link Google".
    const r = takeLinkResult();
    if (r?.ok) toast(r.message);
    else if (r) setError(r.message);
  }, [load, toast]);

  async function link(p: AuthProvider) {
    setBusy(true);
    setError(null);
    try {
      await session.linkProvider(p); // the real one leaves the page; the mock links at once
      toast(`${providerLabel(p)} is linked. You can sign in with it from now on.`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start linking. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await session.unlinkIdentity(target.id);
      toast(`${providerLabel(target.provider)} removed`);
      setTarget(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove it. Try again.");
      setTarget(null);
    } finally {
      setBusy(false);
    }
  }

  const only = (list?.length ?? 0) < 2;
  return (
    <Card id="sign-in" title="Sign-in methods" description="Every way in opens this same account and workspace.">
      {!list && !error && <Message>Loading sign-in methods</Message>}
      {list && (
        <ul className="stack identity-list">
          {list.map((i) => (
            <li key={i.id} className="row-actions identity">
              <span className="identity-name">
                {i.provider === "github" ? <GitHubMark /> : i.provider === "google" ? <GoogleMark /> : null}
                <strong>{providerLabel(i.provider)}</strong>
                {i.email && <span className="muted ellipsis"> {i.email}</span>}
              </span>
              <button type="button" className="btn btn-sm" disabled={busy || only} onClick={() => setTarget(i)} aria-label={`Remove ${providerLabel(i.provider)}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {list && only && <p className="muted small">This is your only way to sign in, so it cannot be removed.</p>}
      {list && (
        <div className="row-actions">
          {LINKABLE.filter((p) => !list.some((i) => i.provider === p)).map((p) => (
            <button key={p} type="button" className="btn" disabled={busy} onClick={() => link(p)}>
              {p === "github" ? <GitHubMark /> : <GoogleMark />}
              Link {providerLabel(p)}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <ConfirmDialog open={!!target} title={`Remove ${target ? providerLabel(target.provider) : ""}?`} confirmLabel="Remove" busy={busy} onConfirm={unlink} onCancel={() => setTarget(null)}>
        <p>You will no longer be able to sign in with it. Your workspace and data are not affected.</p>
      </ConfirmDialog>
    </Card>
  );
}

export function SettingsPage() {
  const loaded = useAsync(() => client.getSettings(), []);
  const { user, signOut } = useSession();
  const toast = useToast();
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded.status === "ready") setForm(loaded.data);
  }, [loaded.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    if (!form.workspaceName.trim()) return setError("Enter a workspace name.");
    setError(null);
    await client.saveSettings({ ...form, workspaceName: form.workspaceName.trim() });
    workspaceChanged();
    setSaved(true);
    toast("Settings saved");
  }

  return (
    <>
      <PageHeader title="Settings" description="Your workspace and your account." />

      <div className="grid-2 even">
      <Card id="workspace" title="Workspace" description="Everyone in this workspace sees these settings.">
        {loaded.status === "loading" && <Message>Loading settings</Message>}
        {loaded.status === "error" && <Message role="alert">{loaded.message}</Message>}
        {form && (
          <form onSubmit={save} className="stack" noValidate>
            <div className="field">
              <label htmlFor="ws-name">Workspace name</label>
              <input id="ws-name" value={form.workspaceName} maxLength={60} onChange={(e) => { setSaved(false); setForm({ ...form, workspaceName: e.target.value }); }} aria-invalid={error ? true : undefined} aria-describedby={error ? "ws-error" : undefined} />
              {error && <p id="ws-error" className="error" role="alert">{error}</p>}
            </div>
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
            <div className="row-actions">
              <button type="submit" className="btn btn-primary">Save changes</button>
              <span role="status" className="muted">{saved ? "Saved" : ""}</span>
            </div>
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
            <dd>Owner</dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>March 2026</dd>
          </div>
        </dl>
        <div className="row-actions">
          <button type="button" className="btn" onClick={async () => (await signOut(), toast("Signed out"))}>
            Sign out
          </button>
          <span className="muted small">Signing out affects this browser only.</span>
        </div>
      </Card>
      </div>

      <SignInMethods />
    </>
  );
}
