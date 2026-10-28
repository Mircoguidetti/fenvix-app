import { useState, type FormEvent } from "react";
import { Card, Message, PageHeader } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyButton } from "../components/CopyButton";
import { useToast } from "../components/Toast";
import { SettingsTabs } from "./Settings";
import { orgs } from "../data/orgs-client";
import { ROLE_NAMES, memberActions, type CreatedInvitation, type Invitation, type InviteRole, type Member, type OrgRole } from "../data/orgs";
import { useOrg } from "../session/OrgProvider";
import { useAsync } from "../lib/useAsync";
import { formatDate } from "../lib/format";

/** The link of a new invitation, shown once: only its hash is kept. */
function LinkDialog({ created, onClose }: { created: CreatedInvitation | null; onClose: () => void }) {
  return (
    <ConfirmDialog open={created !== null} title="Invitation link" confirmLabel="Done" onConfirm={onClose} onCancel={onClose} hideCancel>
      {created && (
        <div className="secret-once stack wide">
          <p>
            Send this link to <strong className="break-anywhere">{created.invitation.email}</strong>. It works once, for that email address only, until{" "}
            {created.invitation.expiresAt ? formatDate(created.invitation.expiresAt) : "it expires"}.
          </p>
          <div className="field">
            <label htmlFor="invite-link">Link</label>
            <input id="invite-link" className="mono" readOnly value={created.link} onFocus={(e) => e.currentTarget.select()} />
          </div>
          <div className="row-actions">
            <CopyButton value={created.link} label="Copy link" what="invitation link" />
          </div>
          <p className="muted small">This is the only time the link is shown. If it is lost, make a new one from the pending invitations.</p>
        </div>
      )}
    </ConfirmDialog>
  );
}

export function MembersPage() {
  const org = useOrg();
  const toast = useToast();
  const role = org.role;
  const members = useAsync(() => orgs.listMembers(), [org.current?.id]);
  const [invitesVersion, setInvitesVersion] = useState(0);
  const invites = useAsync(() => (org.canManage ? orgs.listInvitations() : Promise.resolve([] as Invitation[])), [org.current?.id, invitesVersion, org.canManage]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!orgs.available || !org.current || !role) {
    return (
      <>
        <PageHeader title="Settings" description="Your organization, its members and your account." />
        <SettingsTabs />
        <Message>Members need the FENVIX API, which this dashboard is not set up for (VITE_API_URL).</Message>
      </>
    );
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) return setFormError("Enter a valid email address.");
    setBusy(true);
    setFormError(null);
    try {
      const made = await orgs.createInvitation(email.trim(), inviteRole);
      setCreated(made);
      setEmail("");
      setInvitesVersion((v) => v + 1);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the invitation. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(m: Member, next: OrgRole) {
    setActionError(null);
    try {
      await orgs.changeRole(m.userId, next);
      members.reload();
      toast(`${m.name} is now ${ROLE_NAMES[next].toLowerCase()}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not change the role. Try again.");
      members.reload();
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setActionError(null);
    try {
      await orgs.removeMember(removing.userId);
      toast(`Removed ${removing.name}`);
      setRemoving(null);
      members.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not remove the member. Try again.");
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setActionError(null);
    try {
      await orgs.revokeInvitation(revoking.id);
      toast(`Revoked the invitation for ${revoking.email}`);
      setRevoking(null);
      setInvitesVersion((v) => v + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not revoke the invitation. Try again.");
      setRevoking(null);
    } finally {
      setBusy(false);
    }
  }

  /** The link exists only once, so "copy link" of a pending invitation is a new link: revoke, then invite again. */
  async function newLink(i: Invitation) {
    setActionError(null);
    try {
      await orgs.revokeInvitation(i.id);
      const made = await orgs.createInvitation(i.email, i.role);
      setCreated(made);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not make a new link. Try again.");
    } finally {
      setInvitesVersion((v) => v + 1);
    }
  }

  const count = members.status === "ready" ? members.data.items.length : null;
  const limit = members.status === "ready" ? members.data.limit : null;

  return (
    <>
      <PageHeader title="Settings" description="Your organization, its members and your account." />
      <SettingsTabs />

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {org.canManage && (
        <Card id="invite" title="Invite" description={role === "owner" ? "Invite someone as an admin or a member. They need an account with this email address." : "Invite someone as a member. They need an account with this email address. Only an owner can invite admins."}>
          <form onSubmit={invite} className="inline-form" noValidate>
            <div className="field grow">
              <label htmlFor="invite-email">Email</label>
              <input id="invite-email" type="email" autoComplete="off" value={email} maxLength={254} onChange={(e) => (setEmail(e.target.value), setFormError(null))} aria-invalid={formError ? true : undefined} aria-describedby={formError ? "invite-error" : undefined} />
            </div>
            <div className="field">
              <label htmlFor="invite-role">Role</label>
              <select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as InviteRole)}>
                <option value="member">Member: can view, cannot change</option>
                {role === "owner" && <option value="admin">Admin: can manage databases and members</option>}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Invite
            </button>
          </form>
          {formError && (
            <p id="invite-error" className="error" role="alert">
              {formError}
            </p>
          )}
          <p className="muted small">No email is sent: you get a link to pass on. It works once and expires after 7 days.</p>
        </Card>
      )}

      <Card id="members" title="Members" description={count !== null && limit !== null ? `${count} of ${limit} members.` : undefined}>
        {!org.canManage && <Message>You can see who is in this organization. Only an owner or admin can change it.</Message>}
        {members.status === "loading" && <Message>Loading members</Message>}
        {members.status === "error" && <Message role="alert">{members.message}</Message>}
        {members.status === "ready" && (
          <div className="table-card">
            <table className="data responsive members-table">
              <caption className="sr-only">Members of {org.current.name}</caption>
              <thead>
                <tr>
                  <th scope="col" className="col-name">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col" className="col-role">Role</th>
                  <th scope="col" className="col-date">Joined</th>
                  <th scope="col" className="col-act1">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data.items.map((m) => {
                  const can = memberActions(role, m);
                  return (
                    <tr key={m.userId}>
                      <td data-label="Name">
                        <span className="member-name">
                          <span className="cell-text" title={m.name}>
                            {m.name}
                          </span>
                          {m.you && <span className="tag">You</span>}
                        </span>
                      </td>
                      <td data-label="Email" className="muted">
                        <span className="cell-text" title={m.email}>
                          {m.email}
                        </span>
                      </td>
                      <td data-label="Role">
                        {can.roles.length > 0 ? (
                          <select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => void changeRole(m, e.target.value as OrgRole)} className="select-sm">
                            {can.roles.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_NAMES[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ROLE_NAMES[m.role]
                        )}
                      </td>
                      <td data-label="Joined" className="muted">
                        {m.joinedAt ? formatDate(m.joinedAt) : "—"}
                      </td>
                      <td className="actions-cell">
                        {can.remove && (
                          <button type="button" className="btn btn-sm" onClick={() => setRemoving(m)} aria-label={`Remove ${m.name}`}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {org.canManage && (
        <Card id="pending" title="Pending invitations" description="Invitations that have not been accepted yet.">
          {invites.status === "loading" && <Message>Loading invitations</Message>}
          {invites.status === "error" && <Message role="alert">{invites.message}</Message>}
          {invites.status === "ready" && invites.data.length === 0 && <Message>No pending invitations.</Message>}
          {invites.status === "ready" && invites.data.length > 0 && (
            <div className="table-card">
              <table className="data responsive members-table">
                <caption className="sr-only">Pending invitations</caption>
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col" className="col-role">Role</th>
                    <th scope="col" className="col-date">Expires</th>
                    <th scope="col" className="col-act2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invites.data.map((i) => {
                    const allowed = role === "owner" || i.role === "member";
                    return (
                      <tr key={i.id}>
                        <td data-label="Email">
                          <span className="cell-text" title={i.email}>
                            {i.email}
                          </span>
                        </td>
                        <td data-label="Role">{ROLE_NAMES[i.role]}</td>
                        <td data-label="Expires" className="muted">
                          {i.expiresAt ? formatDate(i.expiresAt) : "—"}
                        </td>
                        <td className="actions-cell">
                          {allowed && (
                            <div className="row-actions">
                              <button type="button" className="btn btn-sm" onClick={() => void newLink(i)} aria-label={`Copy a new link for ${i.email}`}>
                                Copy link
                              </button>
                              <button type="button" className="btn btn-sm" onClick={() => setRevoking(i)} aria-label={`Revoke the invitation for ${i.email}`}>
                                Revoke
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">A link is shown only once. Copy link makes a new one and the old one stops working.</p>
        </Card>
      )}

      <LinkDialog created={created} onClose={() => setCreated(null)} />

      <ConfirmDialog open={removing !== null} title="Remove this member?" confirmLabel="Remove member" busy={busy} onConfirm={remove} onCancel={() => setRemoving(null)}>
        <p>
          <strong className="break-anywhere">{removing?.name}</strong> will lose access to this organization and its databases.
        </p>
      </ConfirmDialog>

      <ConfirmDialog open={revoking !== null} title="Revoke this invitation?" confirmLabel="Revoke invitation" busy={busy} onConfirm={revoke} onCancel={() => setRevoking(null)}>
        <p>
          The link sent to <strong className="break-anywhere">{revoking?.email}</strong> will stop working.
        </p>
      </ConfirmDialog>
    </>
  );
}
