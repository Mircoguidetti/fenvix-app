import { useEffect, useState, type FormEvent } from "react";
import { client, type Settings } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../session/SessionProvider";
import { useToast } from "../components/Toast";

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
    setSaved(true);
  }

  return (
    <>
      <PageHeader title="Settings" description="Workspace and appearance." />

      <Card id="workspace" title="Workspace">
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
              <span role="status" className="muted">{saved ? "Saved (sample data, nothing is stored)" : ""}</span>
            </div>
          </form>
        )}
      </Card>

      <Card id="account" title="Account">
        <dl className="facts">
          <div>
            <dt>Name</dt>
            <dd>{user?.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user?.email}</dd>
          </div>
        </dl>
        <div className="row-actions">
          <button type="button" className="btn" onClick={async () => (await signOut(), toast("Signed out"))}>
            Sign out
          </button>
        </div>
      </Card>
    </>
  );
}
