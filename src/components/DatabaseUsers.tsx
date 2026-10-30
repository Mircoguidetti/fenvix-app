import { useCallback, useEffect, useState } from "react";
import { useOrg } from "../session/OrgProvider";
import { Info, KeyRound, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { users } from "../data/users-client";
import { type DbUser, type DbUserRole, type DbUserSecret, ROLE_LABELS, usernameProblem } from "../data/users";
import type { Database } from "../data";
import { formatDate } from "../lib/format";
import { Message } from "./PageHeader";
import { ConfirmDialog } from "./ConfirmDialog";
import { PasswordDialog } from "./PasswordOnce";
import { useToast } from "./Toast";

/**
 * The Users tab of a database: the user names and passwords applications connect with ("Database Access").
 *
 * Every value is rendered as React text (never as HTML), user names included. A password exists in this page only
 * while the dialog that shows it is open: it is not kept in state after that, not in storage, not in the URL.
 */
type Dialog = { kind: "reset"; user: DbUser } | { kind: "delete"; user: DbUser } | null;

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");

export function DatabaseUsers({ db }: { db: Database }) {
  const { canManage } = useOrg();
  const toast = useToast();
  const [list, setList] = useState<{ items: DbUser[]; limit: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<DbUserRole>("readWrite");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: DbUserSecret } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setList(await users.listUsers(db.id));
    } catch (e) {
      setList(null);
      setLoadError(message(e));
    }
  }, [db.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function open(next: Dialog) {
    setDialogError(null);
    setBusy(false);
    setDialog(next);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setDialogError(null);
    try {
      await work();
      setDialog(null);
      await load();
    } catch (e) {
      setDialogError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const problem = usernameProblem(name);
      if (problem) throw new Error(problem);
      const s = await users.createUser(db.id, name, role);
      setName("");
      setRole("readWrite");
      setSecret({ title: `User ${s.user.username} created`, value: s });
    });
  const reset = (u: DbUser) =>
    run(async () => {
      const s = await users.resetPassword(db.id, u.username);
      setSecret({ title: `New password for ${s.user.username}`, value: s });
    });
  const remove = (u: DbUser) =>
    run(async () => {
      await users.deleteUser(db.id, u.username);
      toast(`Deleted user ${u.username}`, "success");
    });

  const full = !!list && list.items.length >= list.limit;
  const submitNew = (e: React.FormEvent) => {
    e.preventDefault();
    if (!busy && !full) void add();
  };

  return (
    <>
      <div className="ov-grid users-grid">
        <section className="users-card" aria-labelledby="users-h" id="users">
          <div className="users-head">
            <h2 id="users-h">Users</h2>
            <p className="muted card-desc">The user names and passwords your applications connect with. Each user can reach this database only. Passwords are shown once, when a user is created or its password is reset.</p>
          </div>
          {!list && !loadError && <Message>Loading users</Message>}
          {loadError && (
            <div className="stack users-pad">
              <Message role="alert">{loadError}</Message>
              <div className="row-actions">
                <button type="button" className="btn" onClick={() => void load()}>
                  <RefreshCw size={16} aria-hidden="true" />
                  Try again
                </button>
              </div>
            </div>
          )}
          {list && list.items.length === 0 && (
            <div className="empty compact users-pad">
              <h2>No users yet</h2>
              <p className="muted">Add a user so an application can connect to this database.</p>
            </div>
          )}
          {list && list.items.length > 0 && (
            <>
              <table className="data responsive users-table">
                <caption className="sr-only">Users of {db.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Created</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((u) => (
                    <tr key={u.username}>
                      <td data-label="Name" className="mono">
                        <span className="user-name">{u.username}</span>
                      </td>
                      <td data-label="Role">
                        <span className={`role-pill role-${u.role}`}>{ROLE_LABELS[u.role] ?? ROLE_LABELS.other}</span>
                      </td>
                      <td data-label="Created" className="muted">
                        {u.createdAt ? formatDate(u.createdAt) : "Unknown"}
                      </td>
                      <td className="actions-cell">
                        {canManage && (
                          <div className="row-actions icon-actions">
                            <button type="button" className="icon-btn" onClick={() => open({ kind: "reset", user: u })} aria-label={`Reset password of ${u.username}`} title="Reset password">
                              <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                            <button type="button" className="icon-btn icon-danger" onClick={() => open({ kind: "delete", user: u })} aria-label={`Delete user ${u.username}`} title="Delete user">
                              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small users-pad">
                {list.items.length} of {list.limit} users.{full ? " Delete a user to add another." : ""}
              </p>
            </>
          )}
        </section>

        {canManage && (
          <section className="new-user card" aria-labelledby="new-user-h">
            <form onSubmit={submitNew} noValidate className="stack wide">
              <div>
                <h2 id="new-user-h">New user</h2>
                <p className="muted card-desc">For one app or one agent. Access is limited to {db.name}.</p>
              </div>
              <div className="field">
                <label htmlFor="user-name">User name</label>
                <input id="user-name" className="mono" value={name} onChange={(e) => (setName(e.target.value), setDialogError(null))} placeholder="support-agent" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} aria-describedby="user-name-help" />
                <p id="user-name-help" className="help">
                  3 to 32 lowercase letters, numbers, _ or -, starting with a letter.
                </p>
              </div>
              <fieldset className="plain-fieldset role-fieldset">
                <legend>Access</legend>
                {(["read", "readWrite"] as DbUserRole[]).map((r) => (
                  <label key={r} className="choice" data-on={role === r || undefined}>
                    <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
                    <span>
                      <span className="choice-title">{ROLE_LABELS[r]}</span>
                      <span className="help">{r === "read" ? "Can read every collection. Cannot change anything." : "Can read, insert, update and delete documents."}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="note-info">
                <Info size={16} strokeWidth={1.75} aria-hidden="true" />
                <span>The password is made for you and shown once, right after you create the user. Copy it then.</span>
              </p>
              {dialog === null && dialogError && (
                <p className="error" role="alert">
                  {dialogError}
                </p>
              )}
              <div className="form-actions-inline">
                <button type="button" className="btn btn-quiet" onClick={() => (setName(""), setRole("readWrite"), setDialogError(null))}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={!list || full || busy}>
                  Create user
                </button>
              </div>
            </form>
          </section>
        )}
      </div>

      <ConfirmDialog open={dialog?.kind === "reset"} title="Reset this password?" confirmLabel="Reset password" busy={busy} onConfirm={() => dialog?.kind === "reset" && reset(dialog.user)} onCancel={() => setDialog(null)}>
        <p>
          <span className="mono">{dialog?.kind === "reset" ? dialog.user.username : ""}</span> gets a new password, shown once. New connections with the old password are refused from now on. Connections that are already open stay open until they close.
        </p>
        <p className="once-warning" role="note">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>Applications using the old password will stop working.</span>
        </p>
        {dialogError && (
          <p className="error" role="alert">
            {dialogError}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog danger open={dialog?.kind === "delete"} title="Delete this user?" confirmLabel="Delete user" busy={busy} onConfirm={() => dialog?.kind === "delete" && remove(dialog.user)} onCancel={() => setDialog(null)}>
        <p>
          <span className="mono">{dialog?.kind === "delete" ? dialog.user.username : ""}</span> stops working right away, including connections that are open now. Anything using it gets errors until you give it another user. This cannot be undone.
        </p>
        {dialogError && (
          <p className="error" role="alert">
            {dialogError}
          </p>
        )}
      </ConfirmDialog>

      <PasswordDialog
        title={secret?.title ?? ""}
        secret={secret ? { username: secret.value.user.username, password: secret.value.password, connectionString: secret.value.connectionString } : null}
        onClose={() => setSecret(null)}
      />
    </>
  );
}
