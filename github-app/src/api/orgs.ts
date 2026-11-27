/*
 * Organizations (the `workspaces` table), members and invitations, ported from the earlier control plane
 * (docs/organizations.md). Roles always come from the membership row, never from a request:
 *  - owner: everything, including admins and other owners. The last owner can neither leave, be removed nor demoted.
 *  - admin: invitations of members, the members whose role is member, the organization's settings and projects.
 *           Not other admins, not owners, not themselves.
 *  - member: reads.
 */
import { createHash, randomBytes } from "node:crypto";
import { type Handler, orgOf, Reply, type Role } from "./context.ts";
import type { Tx } from "./db.ts";
import { ApiError, conflict, forbidden, notFound, validation } from "./errors.ts";

export const LIMITS = {
  organizationNameMinLength: 2,
  organizationNameMaxLength: 64,
  maxMembersPerOrganization: 50,
  invitationsPerOrganizationPerDay: 20,
  invitationTtlDays: 7,
  maxOrganizationsPerUser: 50,
} as const;

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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** sha256 hex of the token: only the hash is stored. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** An organization name: trimmed, plain text, 2 to 64 characters (code points, as Postgres counts them). */
export function parseOrgName(value: unknown, field = "name"): string {
  const { organizationNameMinLength: min, organizationNameMaxLength: max } = LIMITS;
  const msg = `Use ${min} to ${max} characters for the organization name.`;
  if (typeof value !== "string") throw validation(msg, field);
  const name = value.trim();
  const n = [...name].length;
  if (n < min || n > max) throw validation(msg, field);
  if (BAD_NAME_CHARS.test(name)) throw validation("Use letters, numbers, spaces and punctuation only, on one line.", field);
  return name;
}

export function parseEmail(value: unknown, field = "email"): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length < 3 || email.length > 254 || !EMAIL_RE.test(email)) throw validation("Enter a valid e-mail address.", field);
  return email;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

/** Membership changes in one organization happen one at a time (a transaction-scoped lock: fine behind the pooler). */
const lockOrg = (t: Tx, ws: string) => t.q("select pg_advisory_xact_lock(hashtext('fenvix-organization:' || $1))", [ws]);

async function owners(t: Tx, ws: string): Promise<number> {
  return Number((await t.one<{ n: number }>("select count(*)::int as n from public.workspace_members where workspace_id = $1 and role = 'owner'", [ws]))!.n);
}

async function memberRole(t: Tx, ws: string, userId: string): Promise<Role | null> {
  return ((await t.one<{ role: Role }>("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, userId]))?.role) ?? null;
}

/** The person's organizations, oldest membership first. */
export async function membershipsOf(t: Tx, userId: string) {
  const rows = await t.q<{ id: string; name: string; role: Role; name_confirmed: boolean }>(
    `select w.id, w.name, m.role, w.name_confirmed from public.workspace_members m join public.workspaces w on w.id = m.workspace_id
      where m.user_id = $1 order by m.created_at, w.id`, [userId]);
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, nameConfirmed: r.name_confirmed }));
}

// ---------------------------------------------------------------- the person and their organizations

export const getMe: Handler = async (ctx) => {
  const me = await ctx.t.one<{ user_id: string; email: string | null; name: string | null }>("select * from public.api_me()");
  if (!me) throw new ApiError(401, "unauthenticated", "Your account no longer exists. Sign in again.");
  return { user: { id: me.user_id, email: me.email ?? "", name: me.name ?? "" }, organizations: await membershipsOf(ctx.t, ctx.userId) };
};

export const listOrganizations: Handler = async (ctx) => ({ items: await membershipsOf(ctx.t, ctx.userId) });

export const createOrganization: Handler = async (ctx) => {
  const name = parseOrgName(ctx.body.name);
  const r = await ctx.t.one<{ id: string }>("select public.api_create_organization($1, $2) as id", [name, LIMITS.maxOrganizationsPerUser]);
  return new Reply(201, { organization: { id: r!.id, name, role: "owner", nameConfirmed: true } });
};

// ---------------------------------------------------------------- the organization of the request

export const getOrganization: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const n = await ctx.t.one<{ n: number }>("select count(*)::int as n from public.workspace_members where workspace_id = $1", [o.id]);
  return {
    id: o.id, name: o.name, role: o.role, nameConfirmed: o.nameConfirmed, region: o.region, members: n!.n,
    limits: { maxMembers: LIMITS.maxMembersPerOrganization, invitationsPerDay: LIMITS.invitationsPerOrganizationPerDay },
  };
};

export const renameOrganization: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const name = parseOrgName(ctx.body.name);
  await ctx.t.q("update public.workspaces set name = $2, name_confirmed = true where id = $1", [o.id, name]);
  return { id: o.id, name, role: o.role, nameConfirmed: true };
};

async function removeMembership(t: Tx, ws: string, userId: string): Promise<void> {
  const role = await memberRole(t, ws, userId);
  if (!role) throw notFound(MEMBER_NOT_FOUND);
  if (role === "owner" && (await owners(t, ws)) <= 1) throw conflict(LAST_OWNER);
  await t.q("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, userId]);
}

export const leaveOrganization: Handler = async (ctx) => {
  const o = orgOf(ctx);
  await lockOrg(ctx.t, o.id);
  await removeMembership(ctx.t, o.id, ctx.userId);
  return new Reply(204, null);
};

/**
 * Deletes the organization (the OWNER only: the contract's admin marker lets admins through, so this checks the owner
 * role itself, and api_delete_organization checks it again). One transaction: the organization and everything of it
 * (on delete cascade), and the caller's own login when they belong to no other organization. After the commit, one
 * "uninstall_installation" per GitHub App installation the organization had connected.
 */
export const deleteOrganization: Handler = async (ctx) => {
  const o = orgOf(ctx);
  if (o.role !== "owner") throw forbidden("Only an owner can delete the organization.");
  await lockOrg(ctx.t, o.id);
  const r = await ctx.t.one<{ installation_ids: (number | string)[]; login_deleted: boolean }>("select * from public.api_delete_organization()");
  if (!r) throw forbidden("Only an owner can delete the organization.");
  for (const id of r.installation_ids ?? []) {
    const installationId = Number(id);
    ctx.afterCommit(() => ctx.queue.enqueue({ kind: "uninstall_installation", installationId }));
  }
  return new Reply(204, null);
};

// ---------------------------------------------------------------- members

export const listMembers: Handler = async (ctx) => {
  orgOf(ctx);
  const rows = await ctx.t.q<{ user_id: string; role: Role; joined_at: Date | null; email: string | null; name: string | null }>("select * from public.api_members()");
  return {
    items: rows.map((r) => ({ userId: r.user_id, name: r.name ?? "", email: r.email ?? "", role: r.role, joinedAt: iso(r.joined_at), you: r.user_id === ctx.userId })),
    limit: LIMITS.maxMembersPerOrganization,
  };
};

export const changeMemberRole: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const id = String(ctx.params.userId).toLowerCase();
  const to = ctx.body.role as Role;
  await lockOrg(ctx.t, o.id);
  const from = await memberRole(ctx.t, o.id, id);
  if (!from) throw notFound(MEMBER_NOT_FOUND);
  if (o.role !== "owner") {
    // An admin: never themselves, never an admin or owner, never to admin or owner.
    if (id === ctx.userId) throw forbidden("You cannot change your own role. Ask an owner.");
    if (from !== "member" || to !== "member") throw forbidden(OWNERS_ONLY);
  }
  if (from === to) return { userId: id, role: to };
  if (from === "owner" && (await owners(ctx.t, o.id)) <= 1) throw conflict(LAST_OWNER);
  await ctx.t.q("update public.workspace_members set role = $3 where workspace_id = $1 and user_id = $2", [o.id, id, to]);
  return { userId: id, role: to };
};

export const removeMember: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const id = String(ctx.params.userId).toLowerCase();
  await lockOrg(ctx.t, o.id);
  if (id !== ctx.userId) {
    const role = await memberRole(ctx.t, o.id, id);
    if (!role) throw notFound(MEMBER_NOT_FOUND);
    if (o.role !== "owner" && role !== "member") throw forbidden(OWNERS_ONLY);
  }
  await removeMembership(ctx.t, o.id, id);
  return new Reply(204, null);
};

// ---------------------------------------------------------------- invitations

interface InviteRow { id: string; email: string; role: "admin" | "member"; created_at: Date; expires_at: Date }
const viewInvite = (r: InviteRow) => ({ id: String(r.id), email: r.email, role: r.role, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at) });
const PENDING = "accepted_at is null and revoked_at is null and expires_at > now()";

export const listInvitations: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const rows = await ctx.t.q<InviteRow>(`select * from public.workspace_invites where workspace_id = $1 and ${PENDING} order by created_at desc, id`, [o.id]);
  return { items: rows.map(viewInvite) };
};

export const createInvitation: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const email = parseEmail(ctx.body.email);
  const role = (ctx.body.role ?? "member") as "admin" | "member";
  if (role === "admin" && o.role !== "owner") throw forbidden("Only an owner can invite admins.");
  const L = LIMITS;
  await lockOrg(ctx.t, o.id);
  // 20 a day, counted in the database so that a restart or another Lambda does not reset it.
  const recent = (await ctx.t.one<{ n: number; oldest: Date | null }>(
    "select count(*)::int as n, min(created_at) as oldest from public.workspace_invites where workspace_id = $1 and created_at > now() - interval '1 day'", [o.id]))!;
  if (recent.n >= L.invitationsPerOrganizationPerDay) {
    const retry = Math.max(1, Math.ceil(((recent.oldest ? recent.oldest.getTime() : Date.now()) + DAY_MS - Date.now()) / 1000));
    throw new ApiError(429, "rate_limited", `This organization has sent ${L.invitationsPerOrganizationPerDay} invitations in the last 24 hours. Try again later.`, undefined, { "retry-after": String(retry) });
  }
  const members = await ctx.t.q<{ email: string | null }>("select email from public.api_members()");
  if (members.some((m) => m.email === email)) throw conflict("That person is already a member of this organization.", "email");
  const pending = await ctx.t.q<{ email: string }>(`select email from public.workspace_invites where workspace_id = $1 and ${PENDING}`, [o.id]);
  if (pending.some((p) => p.email === email)) throw conflict("There is already a pending invitation for that e-mail. Revoke it to send a new one.", "email");
  if (members.length + pending.length >= L.maxMembersPerOrganization) {
    throw conflict(`An organization can have ${L.maxMembersPerOrganization} members, counting pending invitations. Remove someone or revoke an invitation first.`);
  }
  const token = randomBytes(32).toString("base64url");
  const row = (await ctx.t.one<InviteRow>(
    `insert into public.workspace_invites (workspace_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning *`,
    [o.id, email, role, hashToken(token), ctx.userId, L.invitationTtlDays]))!;
  // The token is after `#`: it never reaches a server log or a Referer header.
  return new Reply(201, { invitation: viewInvite(row), link: `${ctx.cfg.dashboardUrl}/invite#token=${token}` });
};

export const revokeInvitation: Handler = async (ctx) => {
  const o = orgOf(ctx);
  await lockOrg(ctx.t, o.id);
  const r = await ctx.t.one<InviteRow>(`select * from public.workspace_invites where workspace_id = $1 and id = $2 and ${PENDING}`, [o.id, String(ctx.params.id).toLowerCase()]);
  if (!r) throw notFound(INVITE_NOT_FOUND);
  if (r.role === "admin" && o.role !== "owner") throw forbidden(OWNERS_ONLY);
  await ctx.t.q("update public.workspace_invites set revoked_at = now(), revoked_by = $3 where workspace_id = $1 and id = $2", [o.id, r.id, ctx.userId]);
  return viewInvite(r);
};

/**
 * Accepts an invitation for the signed-in person. Every refusal (unknown, malformed, expired, used or revoked token,
 * another e-mail, an unverified e-mail) is the same 404 with the same words: the answer says nothing about whether
 * the invitation exists. The person joins that organization only, with the invitation's role; a member keeps theirs.
 */
export const acceptInvitation: Handler = async (ctx) => {
  const token = typeof ctx.body.token === "string" ? ctx.body.token : "";
  // The lookup runs whatever the token looks like (a malformed one hashes to nothing stored).
  const hash = hashToken(token);
  const r = await ctx.t.one<{ workspace_id: string; role: Role; already_member: boolean }>("select * from public.api_accept_invitation($1, $2)", [hash, LIMITS.maxMembersPerOrganization]);
  if (!r || !TOKEN_RE.test(token)) throw notFound(INVITE_INVALID);
  const w = await ctx.t.one<{ name: string; name_confirmed: boolean }>("select name, name_confirmed from public.workspaces where id = $1", [r.workspace_id]);
  return { organization: { id: r.workspace_id, name: w?.name ?? "", role: r.role, nameConfirmed: !!w?.name_confirmed } };
};

// ---------------------------------------------------------------- settings

export const getSettings: Handler = async (ctx) => {
  const o = orgOf(ctx);
  return { workspaceName: o.name, emailNotices: o.emailNotices, region: o.region };
};

export const saveSettings: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const name = parseOrgName(ctx.body.workspaceName, "workspaceName");
  const emailNotices = ctx.body.emailNotices === true;
  const region = ctx.body.region === "eu" ? "eu" : "us";
  // A new name counts as chosen; an unchanged one keeps its state.
  await ctx.t.q("update public.workspaces set name = $2, name_confirmed = name_confirmed or name <> $2, email_notices = $3, region = $4 where id = $1",
    [o.id, name, emailNotices, region]);
  return { workspaceName: name, emailNotices, region };
};

// ---------------------------------------------------------------- how repositories are onboarded

export const getOnboardingKind: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const r = await ctx.t.one<{ onboarding_kind: string }>("select onboarding_kind from public.workspaces where id = $1", [o.id]);
  return { kind: r?.onboarding_kind === "side_by_side" ? "side_by_side" : "move", sideBySideAvailable: ctx.cfg.sideBySideEnabled };
};

export const setOnboardingKind: Handler = async (ctx) => {
  const o = orgOf(ctx);
  const kind = ctx.body.kind === "side_by_side" ? "side_by_side" : "move";
  if (kind === "side_by_side" && !ctx.cfg.sideBySideEnabled) throw conflict("Side-by-side runs are turned off.");
  await ctx.t.q("update public.workspaces set onboarding_kind = $2 where id = $1", [o.id, kind]);
  return { kind };
};
