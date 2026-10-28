import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Caller, Services } from "../context.ts";
import { type Client, iso } from "../db.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { ApiError, conflict, forbidden, notFound, validation } from "../errors.ts";
import { type Membership, type UserCaller, membershipsOf } from "../http.ts";
import { isUuid, parseEmail, parseEnum } from "../validate.ts";

/**
 * Organizations (the `workspaces` table), their members and invitations (docs/organizations.md).
 *
 * Roles, always taken from the membership row, never from a request:
 *  - owner: everything, including admins and other owners. The last owner can neither leave, be removed nor demoted.
 *  - admin: databases, database users, API keys, invitations of members and the members whose role is member.
 *           Not other admins, not owners, not themselves, not billing, not deleting the organization.
 *  - member: reads. Every changing route answers 403 (http.ts makes "admin" the default for changes).
 */

export type Role = "owner" | "admin" | "member";

/** The same answer for every invitation that cannot be used, whatever the reason: it must not tell them apart. */
export const INVITE_INVALID = "This invitation link is not valid. It may have expired or been used. Ask the person who invited you for a new link.";
const MEMBER_NOT_FOUND = "That member does not exist.";
const INVITE_NOT_FOUND = "That invitation does not exist or is no longer pending.";
const OWNERS_ONLY = "Only an owner can manage admins and owners.";
const LAST_OWNER = "An organization needs at least one owner. Make someone else an owner first.";

const DAY_MS = 86_400_000;
/** Base64url of 32 random bytes. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Characters an organization name may not hold: control characters, line breaks and text-direction overrides. */
const BAD_NAME_CHARS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** An organization name: trimmed, plain text, 2 to 64 characters (code points, as Postgres counts them). */
export function parseOrgName(value: unknown, s: Pick<Services, "cfg">, field = "name"): string {
  const { organizationNameMinLength: min, organizationNameMaxLength: max } = s.cfg.limits;
  const msg = `Use ${min} to ${max} characters for the organization name.`;
  if (typeof value !== "string" || value.length > max * 8) throw validation(msg, field);
  const name = value.trim();
  const n = [...name].length;
  if (n < min || n > max) throw validation(msg, field);
  if (BAD_NAME_CHARS.test(name)) throw validation("Use letters, numbers, spaces and punctuation only, on one line.", field);
  return name;
}

export const viewOrg = (m: Membership) => ({ id: m.workspaceId, name: m.name, role: m.role, nameConfirmed: m.nameConfirmed });

// ---------------------------------------------------------------- the person's organizations

export async function listOrganizations(s: Services, user: UserCaller) {
  return { items: (await membershipsOf(s, user.userId)).map(viewOrg) };
}

export async function createOrganization(s: Services, user: UserCaller, rawName: unknown) {
  const name = parseOrgName(rawName, s);
  const L = s.cfg.limits;
  if ((await membershipsOf(s, user.userId)).length >= L.maxOrganizationsPerUser) {
    throw conflict(`You are a member of ${L.maxOrganizationsPerUser} organizations, the most there can be. Leave one before creating another.`);
  }
  const id = randomUUID();
  await s.db.tx(id, async (c) => {
    await c.query("insert into public.workspaces (id, name, name_confirmed) values ($1, $2, true)", [id, name]);
    await c.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [id, user.userId]);
    await c.query("insert into public.workspace_settings (workspace_id) values ($1) on conflict (workspace_id) do nothing", [id]);
    await writeAudit(c, { workspaceId: id, actor: { type: "user", id: user.userId }, requestId: user.requestId, ip: user.ip }, { action: "organization.create", targetType: "organization", targetId: id });
  });
  return { organization: { id, name, role: "owner" as Role, nameConfirmed: true } };
}

// ---------------------------------------------------------------- the current organization

/** Locks the organization's row: membership changes in one organization happen one at a time. */
async function lockOrg(c: Client, ws: string): Promise<{ name: string; nameConfirmed: boolean }> {
  const r = (await c.query("select name, name_confirmed from public.workspaces where id = $1 for update", [ws])).rows[0];
  if (!r) throw notFound("That organization does not exist, or you are not a member of it.");
  return { name: String(r.name), nameConfirmed: Boolean(r.name_confirmed) };
}

async function memberCount(c: Client, ws: string): Promise<number> {
  return Number((await c.query("select count(*)::int as n from public.workspace_members where workspace_id = $1", [ws])).rows[0].n);
}

export async function getOrganization(s: Services, caller: Caller) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const w = (await c.query("select name, name_confirmed from public.workspaces where id = $1", [caller.workspaceId])).rows[0];
    if (!w) throw notFound("That organization does not exist, or you are not a member of it.");
    return {
      id: caller.workspaceId, name: String(w.name), role: caller.role, nameConfirmed: Boolean(w.name_confirmed),
      members: await memberCount(c, caller.workspaceId),
      limits: { maxMembers: s.cfg.limits.maxMembersPerOrganization, invitationsPerDay: s.cfg.limits.invitationsPerOrganizationPerDay },
    };
  });
}

/** Renames the organization and marks its name as chosen. Owner or admin (checked by the route). */
export async function renameOrganization(s: Services, caller: Caller, rawName: unknown) {
  const name = parseOrgName(rawName, s);
  await s.db.tx(caller.workspaceId, async (c) => {
    await lockOrg(c, caller.workspaceId);
    await c.query("update public.workspaces set name = $2, name_confirmed = true where id = $1", [caller.workspaceId, name]);
    await writeAudit(c, auditWho(caller), { action: "organization.rename", targetType: "organization", targetId: caller.workspaceId });
  });
  return getOrganization(s, caller);
}

/** The caller leaves the current organization. The last owner cannot. */
export async function leaveOrganization(s: Services, caller: Caller): Promise<void> {
  if (caller.actor.type !== "user") throw forbidden("API keys cannot do this. Sign in to the dashboard.");
  await s.db.tx(caller.workspaceId, async (c) => {
    await lockOrg(c, caller.workspaceId);
    await removeMembership(c, caller.workspaceId, caller.actor.id);
    await writeAudit(c, auditWho(caller), { action: "organization.leave", targetType: "member", targetId: caller.actor.id, metadata: { role: caller.role } });
  });
}

async function removeMembership(c: Client, ws: string, userId: string): Promise<void> {
  const row = (await c.query("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, userId])).rows[0] as { role: Role } | undefined;
  if (!row) throw notFound(MEMBER_NOT_FOUND);
  if (row.role === "owner") {
    const owners = Number((await c.query("select count(*)::int as n from public.workspace_members where workspace_id = $1 and role = 'owner'", [ws])).rows[0].n);
    if (owners <= 1) throw conflict(LAST_OWNER);
  }
  await c.query("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, userId]);
}

// ---------------------------------------------------------------- members

export async function listMembers(s: Services, caller: Caller) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const rows = (await c.query("select * from public.fenvix_cp_members()")).rows;
    return {
      items: rows.map((r) => ({
        userId: String(r.user_id), name: String(r.name ?? ""), email: String(r.email ?? ""), role: r.role as Role, joinedAt: iso(r.joined_at),
        you: String(r.user_id) === caller.actor.id,
      })),
      limit: s.cfg.limits.maxMembersPerOrganization,
    };
  });
}

/** Who may give `target` (now `from`) the role `to`. Throws 403/409 with the reason. */
function checkRoleChange(caller: Caller, targetId: string, from: Role, to: Role): void {
  if (caller.role === "owner") return;
  // An admin: never themselves, never an admin or owner, never to admin or owner.
  if (targetId === caller.actor.id) throw forbidden("You cannot change your own role. Ask an owner.");
  if (from !== "member" || to !== "member") throw forbidden(OWNERS_ONLY);
}

export async function changeRole(s: Services, caller: Caller, targetId: unknown, body: unknown) {
  if (!isUuid(targetId)) throw notFound(MEMBER_NOT_FOUND);
  const to = parseEnum((body as { role?: unknown } | null)?.role, ["owner", "admin", "member"] as const, "role");
  const id = targetId.toLowerCase();
  return s.db.tx(caller.workspaceId, async (c) => {
    await lockOrg(c, caller.workspaceId);
    const row = (await c.query("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [caller.workspaceId, id])).rows[0] as { role: Role } | undefined;
    if (!row) throw notFound(MEMBER_NOT_FOUND);
    checkRoleChange(caller, id, row.role, to);
    if (row.role === to) return { userId: id, role: to };
    if (row.role === "owner") {
      const owners = Number((await c.query("select count(*)::int as n from public.workspace_members where workspace_id = $1 and role = 'owner'", [caller.workspaceId])).rows[0].n);
      if (owners <= 1) throw conflict(LAST_OWNER);
    }
    await c.query("update public.workspace_members set role = $3 where workspace_id = $1 and user_id = $2", [caller.workspaceId, id, to]);
    await writeAudit(c, auditWho(caller), { action: "member.role_change", targetType: "member", targetId: id, metadata: { from: row.role, to } });
    return { userId: id, role: to };
  });
}

export async function removeMember(s: Services, caller: Caller, targetId: unknown): Promise<void> {
  if (!isUuid(targetId)) throw notFound(MEMBER_NOT_FOUND);
  const id = targetId.toLowerCase();
  if (id === caller.actor.id) return leaveOrganization(s, caller);
  await s.db.tx(caller.workspaceId, async (c) => {
    await lockOrg(c, caller.workspaceId);
    const row = (await c.query("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [caller.workspaceId, id])).rows[0] as { role: Role } | undefined;
    if (!row) throw notFound(MEMBER_NOT_FOUND);
    if (caller.role !== "owner" && row.role !== "member") throw forbidden(OWNERS_ONLY);
    await removeMembership(c, caller.workspaceId, id);
    await writeAudit(c, auditWho(caller), { action: "member.remove", targetType: "member", targetId: id, metadata: { role: row.role } });
  });
}

// ---------------------------------------------------------------- invitations

interface InviteRow { id: string; email: string; role: Role; created_at: Date; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null; workspace_id: string }
const viewInvite = (r: InviteRow) => ({ id: String(r.id), email: r.email, role: r.role, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at) });

export async function listInvites(s: Services, caller: Caller) {
  return s.db.tx(caller.workspaceId, async (c) => ({
    items: ((await c.query(
      `select * from public.workspace_invites
        where workspace_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
        order by created_at desc, id`, [caller.workspaceId])).rows as InviteRow[]).map(viewInvite),
  }));
}

/** Where the invited person opens the link. The token is after `#`, so it never reaches a server log or a Referer. */
function inviteLink(s: Services, token: string): string {
  return `${s.cfg.dashboardOrigins[0] ?? ""}/invite#token=${token}`;
}

export async function createInvite(s: Services, caller: Caller, body: unknown) {
  const b = (body ?? {}) as { email?: unknown; role?: unknown };
  const email = parseEmail(b.email);
  const role = parseEnum(b.role, ["admin", "member"] as const, "role", "member");
  if (role === "admin" && caller.role !== "owner") throw forbidden("Only an owner can invite admins.");
  const L = s.cfg.limits;
  const token = randomBytes(32).toString("base64url");
  const row = await s.db.tx(caller.workspaceId, async (c) => {
    await lockOrg(c, caller.workspaceId);
    // 20 a day, counted in the database so a restart or a second instance does not reset it.
    const recent = (await c.query(
      "select count(*)::int as n, min(created_at) as oldest from public.workspace_invites where workspace_id = $1 and created_at > now() - interval '1 day'",
      [caller.workspaceId])).rows[0] as { n: number; oldest: Date | null };
    if (recent.n >= L.invitationsPerOrganizationPerDay) {
      const retry = Math.max(1, Math.ceil(((recent.oldest ? new Date(recent.oldest).getTime() : Date.now()) + DAY_MS - Date.now()) / 1000));
      throw new ApiError("rate_limited", `This organization has sent ${L.invitationsPerOrganizationPerDay} invitations in the last 24 hours. Try again later.`, undefined, { "Retry-After": String(retry) });
    }
    const members = (await c.query("select * from public.fenvix_cp_members()")).rows as { email: string }[];
    if (members.some((m) => m.email === email)) throw conflict("That person is already a member of this organization.", "email");
    const pending = (await c.query(
      "select email from public.workspace_invites where workspace_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()",
      [caller.workspaceId])).rows as { email: string }[];
    if (pending.some((p) => p.email === email)) throw conflict("There is already a pending invitation for that email. Revoke it to send a new one.", "email");
    if (members.length + pending.length >= L.maxMembersPerOrganization) {
      throw conflict(`An organization can have ${L.maxMembersPerOrganization} members, counting pending invitations. Remove someone or revoke an invitation first.`);
    }
    const r = (await c.query(
      `insert into public.workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning *`,
      [caller.workspaceId, email, role, hashToken(token), caller.actor.id, L.invitationTtlDays])).rows[0] as InviteRow;
    await writeAudit(c, auditWho(caller), { action: "invitation.create", targetType: "invitation", targetId: String(r.id), metadata: { role } });
    return r;
  });
  return { invitation: viewInvite(row), link: inviteLink(s, token) };
}

export async function revokeInvite(s: Services, caller: Caller, id: unknown) {
  if (!isUuid(id)) throw notFound(INVITE_NOT_FOUND);
  return s.db.tx(caller.workspaceId, async (c) => {
    await lockOrg(c, caller.workspaceId);
    const r = (await c.query(
      "select * from public.workspace_invites where workspace_id = $1 and id = $2 and accepted_at is null and revoked_at is null and expires_at > now()",
      [caller.workspaceId, id.toLowerCase()])).rows[0] as InviteRow | undefined;
    if (!r) throw notFound(INVITE_NOT_FOUND);
    if (r.role === "admin" && caller.role !== "owner") throw forbidden(OWNERS_ONLY);
    await c.query("update public.workspace_invites set revoked_at = now(), revoked_by = $3 where workspace_id = $1 and id = $2", [caller.workspaceId, r.id, caller.actor.id]);
    await writeAudit(c, auditWho(caller), { action: "invitation.revoke", targetType: "invitation", targetId: String(r.id), metadata: { role: r.role } });
    return viewInvite(r);
  });
}

/**
 * Accepts an invitation for the signed-in person. Every refusal (unknown, malformed, expired, used or revoked token,
 * another e-mail, an unverified e-mail) is the same 404 with the same words, after the same lookups, so the answer
 * says nothing about whether the invitation exists. Adds the person to that organization only, with that role.
 */
export async function acceptInvite(s: Services, user: UserCaller, rawToken: unknown, log: FastifyBaseLogger) {
  const token = typeof rawToken === "string" && rawToken.length <= 128 ? rawToken : "";
  const hash = hashToken(token);
  // Both lookups always run, whatever the token looks like.
  const [found, account] = await Promise.all([
    s.db.system(async (c) => (await c.query("select * from public.fenvix_cp_find_invite($1)", [hash])).rows[0] as { id: string; workspace_id: string } | undefined),
    s.db.system(async (c) => (await c.query("select * from public.fenvix_cp_user_email($1)", [user.userId])).rows[0] as { email: string | null; verified: boolean } | undefined),
  ]);
  const refuse = (): never => { throw notFound(INVITE_INVALID); };
  if (!TOKEN_RE.test(token) || !found) return refuse();

  const ws = String(found.workspace_id);
  const who = { workspaceId: ws, actor: { type: "user" as const, id: user.userId }, requestId: user.requestId, ip: user.ip };
  let reason: string | null = null;
  const out = await s.db.tx(ws, async (c) => {
    const org = await lockOrg(c, ws);
    const inv = (await c.query("select * from public.workspace_invites where workspace_id = $1 and id = $2 for update", [ws, found.id])).rows[0] as InviteRow | undefined;
    if (!inv) reason = "missing";
    else if (inv.revoked_at) reason = "revoked";
    else if (inv.accepted_at) reason = "used";
    else if (new Date(inv.expires_at).getTime() <= Date.now()) reason = "expired";
    else if (!account?.email || account.email !== inv.email) reason = "email";
    else if (!account.verified) reason = "unverified";
    if (reason || !inv) return null;

    const existing = (await c.query("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, user.userId])).rows[0] as { role: Role } | undefined;
    let role: Role = inv.role;
    if (existing) {
      // Already a member: the invitation is used up, the role they have stays (an invitation never changes a role).
      role = existing.role;
    } else {
      if ((await memberCount(c, ws)) >= s.cfg.limits.maxMembersPerOrganization) {
        throw conflict(`This organization already has ${s.cfg.limits.maxMembersPerOrganization} members. Ask an owner to make room.`);
      }
      await c.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.userId, inv.role]);
    }
    await c.query("update public.workspace_invites set accepted_at = now(), accepted_by = $3 where workspace_id = $1 and id = $2", [ws, inv.id, user.userId]);
    await writeAudit(c, who, { action: "invitation.accept", targetType: "invitation", targetId: String(inv.id), metadata: { role, alreadyMember: Boolean(existing) } });
    return { id: ws, name: org.name, role, nameConfirmed: org.nameConfirmed };
  });
  if (!out) {
    // Recorded for the organization that sent it (no token, no e-mail), then the same answer as for any other refusal.
    await s.db.tx(ws, (c) => writeAudit(c, who, { action: "invitation.accept", targetType: "invitation", targetId: String(found.id), outcome: "denied", metadata: { reason } }))
      .catch((e) => log.error({ err: e instanceof Error ? e.message : String(e) }, "could not record a refused invitation"));
    return refuse();
  }
  return { organization: out };
}
