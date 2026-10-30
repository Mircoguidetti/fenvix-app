import { useState, type FormEvent } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useOrg } from "../session/OrgProvider";
import { client, type CreatedPublicKey, type PublicApiKey, type PublicKeyRole } from "../data";
import {
  EXPIRY_OPTIONS, MAX_ACTIVE_KEYS, NAME_MAX, PUBLIC_API_NOT_SET_UP, ROLE_HELP, ROLE_LABELS, curlExample, expiresAtFor, keyErrorMessage, keyStatus,
  nameProblem, openApiUrl, type ExpiryChoice,
} from "../data/public-keys";
import { apiUrl, backend } from "../lib/env";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { Select } from "../components/Select";
import { KeyStatus } from "../components/StateBadge";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatRelative } from "../lib/format";

const DESCRIPTION = "Your code uses these keys to call the FENVIX API and manage databases. Each key is shown in full only once.";

/** The documented address of the API, for the example when the dashboard runs on the mock (which has no API address). */
const DOCUMENTED_API_URL = "https://api.fenvix.cloud/v1";
const exampleApiUrl = apiUrl || DOCUMENTED_API_URL;

export function ApiKeysPage() {
  const { canManage } = useOrg();
  if (!canManage) {
    return (
      <>
        <PageHeader title="API keys" description={DESCRIPTION} />
        <Message>Only an owner or admin of this organization can see and manage API keys.</Message>
      </>
    );
  }
  // The same rule as src/data/index.ts: public keys exist on the control plane only (and in the mock).
  if (backend !== "mock" && !apiUrl) {
    return (
      <>
        <PageHeader title="API keys" description={DESCRIPTION} />
        <Message>{PUBLIC_API_NOT_SET_UP}</Message>
      </>
    );
  }
  return <ApiKeysManager />;
}

function ApiKeysManager() {
  const org = useOrg();
  const [pages, setPages] = useState<string[]>([]);
  const keys = useAsync(() => loadAll(pages), [org.current?.id, pages.join(",")]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<PublicKeyRole>("read_only");
  const [expiry, setExpiry] = useState<ExpiryChoice>("90");
  const [error, setError] = useState<{ message: string; field: "name" | null } | null>(null);
  const [created, setCreated] = useState<CreatedPublicKey | null>(null);
  const [target, setTarget] = useState<PublicApiKey | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = client.now();

  /** The first page, and the further pages asked for with "Show more" (cursors kept in order). */
  async function loadAll(cursors: string[]) {
    const items: PublicApiKey[] = [];
    let next: string | null = null;
    for (const cursor of [null, ...cursors]) {
      const page = await client.listPublicApiKeys(cursor);
      items.push(...page.items);
      next = page.nextCursor;
    }
    return { items, next };
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const problem = nameProblem(name);
    if (problem) return setError({ message: problem, field: "name" });
    setError(null);
    setBusy(true);
    try {
      const res = await client.createPublicApiKey({ name: name.trim(), role, expiresAt: expiresAtFor(expiry, client.now()) });
      setCreated(res);
      setName("");
      keys.reload();
    } catch (err) {
      const field = (err as { field?: string }).field === "name" ? "name" : null;
      setError({ message: keyErrorMessage(err, "create"), field });
      keys.reload();
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!target) return;
    setBusy(true);
    try {
      await client.revokePublicApiKey(target.id);
      setRevokeError(null);
    } catch (err) {
      setRevokeError(keyErrorMessage(err, "revoke"));
    } finally {
      setTarget(null);
      setBusy(false);
      keys.reload();
    }
  }

  const expiryNote = expiry === "never" ? "The key works until it is revoked." : `The key stops working on ${formatDate(expiresAtFor(expiry, now)!)}.`;
  const nameError = error?.field === "name";
  const list = keys.status === "ready" ? keys.data.items : [];
  const active = list.filter((k) => keyStatus(k, now) === "active").length;

  return (
    <>
      <PageHeader title="API keys" description={DESCRIPTION} />

      <Card id="create" title="Create a key" description={`An organization can have up to ${MAX_ACTIVE_KEYS} active keys. Revoked and expired keys do not count.`}>
        <form onSubmit={create} className="inline-form" noValidate>
          <div className="field grow">
            <label htmlFor="key-name">Key name</label>
            <input
              id="key-name"
              value={name}
              onChange={(e) => (setName(e.target.value), nameError && setError(null))}
              maxLength={NAME_MAX + 20}
              placeholder="For example: CI pipeline"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={error ? "key-error" : undefined}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="key-role">Role</label>
            <Select id="key-role" value={role} onChange={(v) => setRole(v as PublicKeyRole)} aria-describedby="key-role-help" options={[{ value: "read_only", label: ROLE_LABELS.read_only }, { value: "admin", label: ROLE_LABELS.admin }]} />
          </div>
          <div className="field">
            <label htmlFor="key-expiry">Expires</label>
            <Select id="key-expiry" value={expiry} onChange={(v) => setExpiry(v as ExpiryChoice)} aria-describedby="key-expiry-help" options={EXPIRY_OPTIONS} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Create key
          </button>
        </form>
        {error && (
          <p id="key-error" className="error" role="alert">
            {error.message}
          </p>
        )}
        <div id="key-role-help" className="muted small">
          <p>
            <strong>{ROLE_LABELS.read_only}:</strong> {ROLE_HELP.read_only}
          </p>
          <p>
            <strong>{ROLE_LABELS.admin}:</strong> {ROLE_HELP.admin}
          </p>
        </div>
        <p id="key-expiry-help" className="muted small">
          {expiryNote}
        </p>
        {created && <CreatedKey created={created} onDismiss={() => setCreated(null)} />}
      </Card>

      {revokeError && <Message role="alert">{revokeError}</Message>}
      {keys.status === "loading" && <Message>Loading keys</Message>}
      {keys.status === "error" && <Message role="alert">{keys.message}</Message>}
      {keys.status === "ready" && list.length === 0 && (
        <div className="empty">
          <h2>No API keys yet</h2>
          <p className="muted">
            A key lets your code, scripts and CI create and manage databases through the FENVIX API, without signing in. Give it a name above, pick a role and create
            your first key.
          </p>
        </div>
      )}
      {keys.status === "ready" && list.length > 0 && (
        <>
          {!keys.data.next && (
            <p className="muted small">
              {active} of {MAX_ACTIVE_KEYS} active keys in use.
            </p>
          )}
          <div className="table-card">
            <table className="data responsive">
              <caption className="sr-only">API keys</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((k) => {
                  const status = keyStatus(k, now);
                  return (
                    <tr key={k.id}>
                      <td data-label="Name" className="break-anywhere">{k.name}</td>
                      <td data-label="Key" className="mono muted">
                        {k.prefix}…
                      </td>
                      <td data-label="Role">{ROLE_LABELS[k.role]}</td>
                      <td data-label="Status">
                        <KeyStatus status={status} />
                      </td>
                      <td data-label="Created" className="muted">{formatDate(k.createdAt)}</td>
                      <td data-label="Last used" className="muted">{k.lastUsedAt ? formatRelative(k.lastUsedAt, now) : "Never"}</td>
                      <td data-label="Expires" className="muted">{k.expiresAt ? formatDate(k.expiresAt) : "Never"}</td>
                      <td className="actions-cell">
                        {status !== "revoked" && (
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => setTarget(k)} aria-label={`Revoke key ${k.name}`}>
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {keys.data.next && (
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => keys.status === "ready" && keys.data.next && setPages([...pages, keys.data.next])}>
                Show more keys
              </button>
            </div>
          )}
        </>
      )}

      <p className="muted small">
        The full API reference is the OpenAPI document at{" "}
        <a href={openApiUrl(exampleApiUrl)} target="_blank" rel="noreferrer" className="mono">
          {openApiUrl(exampleApiUrl)}
        </a>
        .
      </p>

      <ConfirmDialog danger open={!!target} title="Revoke this key?" confirmLabel="Revoke key" busy={busy} onConfirm={revoke} onCancel={() => setTarget(null)}>
        <p>
          “{target?.name}” ({target?.prefix}…) stops working immediately: anything using it gets errors from its next request until you give it a new key. Keys
          that were created with this key are revoked with it. This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}

/** The new key, the only time it is shown, with a first call to try it. Nothing here is stored by the dashboard. */
function CreatedKey({ created, onDismiss }: { created: CreatedPublicKey; onDismiss: () => void }) {
  const example = curlExample(exampleApiUrl);
  return (
    <div className="callout callout-success" role="status">
      <p className="callout-row">
        <CircleCheck size={16} aria-hidden="true" />
        <span>
          <strong>Key “{created.key.name}” created.</strong> {ROLE_LABELS[created.key.role]}
          {created.key.expiresAt ? `, expires on ${formatDate(created.key.expiresAt)}` : ", does not expire"}.
        </span>
      </p>
      <p className="once-warning" role="note">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>
          <strong>Copy the key now.</strong> It will not be shown again. FENVIX keeps only a fingerprint of it: if it is lost, revoke it and create a new one.
        </span>
      </p>
      <code className="secret mono">{created.token}</code>
      <div className="row-actions">
        <CopyButton value={created.token} what="new key" />
      </div>
      <div className="field">
        <label htmlFor="key-example">Try it: list your databases</label>
        <textarea id="key-example" className="code" readOnly rows={3} wrap="off" value={example} onFocus={(e) => e.currentTarget.select()} />
        <div className="row-actions">
          <CopyButton value={example} label="Copy example" what="curl example" />
          <button type="button" className="btn btn-quiet" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
