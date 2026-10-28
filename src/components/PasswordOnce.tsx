import { useEffect, useId, useRef } from "react";
import { TriangleAlert } from "lucide-react";
import { CopyButton } from "./CopyButton";

/**
 * A database user's password, shown the one time it exists outside the engine: right after the user was created or
 * its password was reset. Nothing here is stored by the dashboard; once this closes, the password is gone for good.
 * Every value is React text, never HTML.
 */
export function SecretOnce({ username, password, connectionString, idPrefix }: { username: string; password: string; connectionString: string | null; idPrefix: string }) {
  return (
    <div className="stack secret-once">
      <p className="once-warning" role="note">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>
          <strong>Copy the password now.</strong> This is the only time it is shown. FENVIX does not keep it: if it is lost, reset the password.
        </span>
      </p>
      <dl className="facts facts-tight">
        <div>
          <dt>User</dt>
          <dd className="mono ellipsis">{username}</dd>
        </div>
      </dl>
      <div className="field">
        <label htmlFor={`${idPrefix}-password`}>Password</label>
        <code id={`${idPrefix}-password`} className="secret mono" data-testid="once-password">
          {password}
        </code>
        <div className="row-actions">
          <CopyButton value={password} what="password" />
        </div>
      </div>
      {connectionString && (
        <div className="field">
          <label htmlFor={`${idPrefix}-conn`}>Connection string with this password</label>
          <textarea id={`${idPrefix}-conn`} className="code" readOnly rows={3} value={connectionString} onFocus={(e) => e.currentTarget.select()} />
          <div className="row-actions">
            <CopyButton value={connectionString} what="connection string with password" />
          </div>
        </div>
      )}
    </div>
  );
}

/** The same, in a modal that only closes on purpose (Escape asks the browser to close it, which counts as purpose). */
export function PasswordDialog({ title, secret, onClose }: { title: string; secret: { username: string; password: string; connectionString: string | null } | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const idPrefix = useId().replace(/:/g, "");
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (secret && !d.open) d.showModal();
    if (!secret && d.open) d.close();
  }, [secret]);
  return (
    <dialog ref={ref} className="dialog dialog-wide" aria-labelledby={titleId} onClose={() => secret && onClose()}>
      {secret && (
        <form method="dialog" onSubmit={(e) => (e.preventDefault(), onClose())}>
          <h2 id={titleId}>{title}</h2>
          <div className="dialog-body">
            <SecretOnce username={secret.username} password={secret.password} connectionString={secret.connectionString} idPrefix={idPrefix} />
          </div>
          <div className="dialog-actions">
            <button type="submit" className="btn btn-primary">
              I have saved it
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
