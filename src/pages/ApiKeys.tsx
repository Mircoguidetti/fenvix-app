import { useState, type FormEvent } from "react";
import { useOrg } from "../session/OrgProvider";
import { client, type ApiKey } from "../data";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { KeyStatus } from "../components/StateBadge";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatRelative } from "../lib/format";

export function ApiKeysPage() {
  const { canManage } = useOrg();
  if (!canManage) {
    return (
      <>
        <PageHeader title="API keys" description="Your code uses these keys to manage databases." />
        <Message>Only an owner or admin of this organization can see and manage API keys.</Message>
      </>
    );
  }
  return <ApiKeysManager />;
}

function ApiKeysManager() {
  const keys = useAsync(() => client.listApiKeys(), []);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [target, setTarget] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const now = client.now();

  async function create(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter a name for the key.");
    if (trimmed.length > 60) return setError("Use 60 characters or fewer.");
    setError(null);
    setBusy(true);
    try {
      const res = await client.createApiKey(trimmed);
      setCreated({ name: res.key.name, secret: res.secret });
      setName("");
      keys.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the key.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!target) return;
    setBusy(true);
    try {
      await client.revokeApiKey(target.id);
      keys.reload();
      setTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the key.");
      setTarget(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="API keys" description="Your code uses these keys to manage databases. Each key is shown in full only once." />

      <Card id="create" title="Create a key">
        <form onSubmit={create} className="inline-form" noValidate>
          <div className="field grow">
            <label htmlFor="key-name">Key name</label>
            <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="For example: CI pipeline" aria-invalid={error ? true : undefined} aria-describedby={error ? "key-error" : undefined} autoComplete="off" />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>Create key</button>
        </form>
        {error && <p id="key-error" className="error" role="alert">{error}</p>}
        {created && (
          <div className="callout" role="status">
            <p><strong>Key “{created.name}” created.</strong> Copy it now. It is never shown again.</p>
            <code className="secret mono">{created.secret}</code>
            <div className="row-actions">
              <CopyButton value={created.secret} what="new key" />
              <button type="button" className="btn btn-quiet" onClick={() => setCreated(null)}>Dismiss</button>
            </div>
          </div>
        )}
      </Card>

      {keys.status === "loading" && <Message>Loading keys</Message>}
      {keys.status === "error" && <Message role="alert">{keys.message}</Message>}
      {keys.status === "ready" && (
        <div className="table-card">
          <table className="data responsive">
            <caption className="sr-only">API keys</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Key</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td data-label="Name">{k.name}</td>
                  <td data-label="Key" className="mono muted">••••••••{k.hint}</td>
                  <td data-label="Status"><KeyStatus revoked={!!k.revokedAt} /></td>
                  <td data-label="Created" className="muted">{formatDate(k.createdAt)}</td>
                  <td data-label="Last used" className="muted">{k.lastUsedAt ? formatRelative(k.lastUsedAt, now) : "Never"}</td>
                  <td className="actions-cell">
                    {!k.revokedAt && (
                      <button type="button" className="btn btn-sm" onClick={() => setTarget(k)} aria-label={`Revoke key ${k.name}`}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog open={!!target} title="Revoke this key?" confirmLabel="Revoke key" busy={busy} onConfirm={revoke} onCancel={() => setTarget(null)}>
        <p>
          “{target?.name}” (ending {target?.hint}) will stop working right away. Anything using it will get errors until you give it a new key. This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
