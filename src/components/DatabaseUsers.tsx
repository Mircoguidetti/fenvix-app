import { useCallback, useEffect, useState } from "react";
import { useOrg } from "../session/OrgProvider";
import { KeyRound, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { users } from "../data/users-client";
import { type DbUser, type DbUserRole, type DbUserSecret, ROLE_LABELS, usernameProblem } from "../data/users";
import type { Database } from "../data";
import { formatDate } from "../lib/format";
import { Card, Message } from "./PageHeader";
import { ConfirmDialog } from "./ConfirmDialog";
import { PasswordDialog } from "./PasswordOnce";
import { useToast } from "./Toast";

/**
 * The Users tab of a database: the user names and passwords applications connect with ("Database Access").
 *
 * Every value is rendered as React text (never as HTML), user names included. A password exists in this page only
 * while the dialog that shows it is open: it is not kept in state after that, not in storage, not in the URL.
 */
type Dialog = { kind: "add" } | { kind: "reset"; user: DbUser } | { kind: "delete"; user: DbUser } | null;

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
    setName("");
    setRole("readWrite");
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
  const addButton = !canManage ? null : (
    <button type="button" className="btn btn-primary" onClick={() => open({ kind: "add" })} disabled={!list || full}>
      <Plus size={16} aria-hidden="true" />
      Add user
    </button>
  );

  return (
    <>
      <Card
        id="users"
        title="Users"
        description="The user names and passwords your applications connect with. Each user can reach this database only. Passwords are shown once, when a user is created or its password is reset."
        actions={addButton}
      >
        {!list && !loadError && <Message>Loading users</Message>}
        {loadError && (
          <div className="stack">
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
          <div className="empty compact">
            <h2>No users yet</h2>
            <p className="muted">Add a user so an application can connect to this database.</p>
          </div>
        )}
        {list && list.items.length > 0 && (
          <>
            <div className="table-card flat">
              <table className="data responsive">
                <caption className="sr-only">Users of {db.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">User</th>
                    <th scope="col">Access</th>
                    <th scope="col">Created</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((u) => (
                    <tr key={u.username}>
                      <td data-label="User" className="mono">
                        <span className="user-name">{u.username}</span>
                      </td>
                      <td data-label="Access">{ROLE_LABELS[u.role] ?? ROLE_LABELS.other}</td>
                      <td data-label="Created" className="muted">
                        {u.createdAt ? formatDate(u.createdAt) : "Unknown"}
                      </td>
                      <td className="actions-cell">
                        {canManage && <div className="row-actions">
                          <button type="button" className="btn btn-sm" onClick={() => open({ kind: "reset", user: u })} aria-label={`Reset password of ${u.username}`}>
                            <KeyRound size={15} aria-hidden="true" />
                            Reset password
                          </button>
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => open({ kind: "delete", user: u })} aria-label={`Delete user ${u.username}`}>
                            <Trash2 size={15} aria-hidden="true" />
                            Delete
                          </button>
                        </div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              {list.items.length} of {list.limit} users.{full ? " Delete a user to add another." : ""}
            </p>
          </>
        )}
      </Card>

      <ConfirmDialog open={dialog?.kind === "add"} title="Add a user" confirmLabel="Create user" busy={busy} onConfirm={add} onCancel={() => setDialog(null)}>
        <div className="field">
          <label htmlFor="user-name">User name</label>
          <input id="user-name" className="mono" value={name} onChange={(e) => (setName(e.target.value), setDialogError(null))} placeholder="for example: reporting" autoComplete="off" spellCheck={false} maxLength={32} aria-describedby="user-name-help" />
          <p id="user-name-help" className="muted small">
            3 to 32 lowercase letters, numbers, _ or -, starting with a letter.
          </p>
        </div>
        <div className="field">
          <label htmlFor="user-role">Access</label>
          <select id="user-role" value={role} onChange={(e) => setRole(e.target.value as DbUserRole)}>
            <option value="readWrite">{ROLE_LABELS.readWrite}</option>
            <option value="read">{ROLE_LABELS.read}</option>
          </select>
        </div>
        <p>The password is made for you and shown once.</p>
        {dialogError && (
          <p className="error" role="alert">
            {dialogError}
          </p>
        )}
      </ConfirmDialog>

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
