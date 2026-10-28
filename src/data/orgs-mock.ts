// In-memory organizations for VITE_DATA_BACKEND=mock (the Playwright checks). Every name is made up. Kept in
// sessionStorage so an invitation survives signing out and in again in the same tab, as it would on a server.
import { activeOrgId, setActiveOrgId } from "../lib/org";
import { mockCurrentUser } from "../session/mock";
import { type Invitation, type InviteRole, type Member, type Organization, type OrgRole, type OrgsClient, canManage, orgNameProblem } from "./orgs";

const KEY = "fenvix-mock-orgs";
const DAY = 86_400_000;
const MAX_MEMBERS = 50;
const INVITES_PER_DAY = 20;
const INVALID = "This invitation link is not valid. It may have expired or been used. Ask the person who invited you for a new link.";
export const READ_ONLY = "Your role in this organization is read only. Ask an owner or admin to do this.";

interface MockMember { userId: string; name: string; email: string; role: OrgRole; joinedAt: string }
interface MockOrg { id: string; name: string; nameConfirmed: boolean; members: MockMember[] }
interface MockInvite { id: string; orgId: string; email: string; role: InviteRole; createdAt: string; expiresAt: string; tokenHash: string; acceptedAt: string | null; revokedAt: string | null }
interface State { orgs: MockOrg[]; invites: MockInvite[]; provisioned: string[] }

const SEED: State = {
  orgs: [
    {
      id: "org_northwind", name: "Northwind Cloud", nameConfirmed: true,
      members: [
        { userId: "usr_1", name: "Elena Marsh", email: "elena.marsh@northwind.cloud", role: "owner", joinedAt: "2026-03-02T09:00:00Z" },
        { userId: "usr_3", name: "Priya Natarajan", email: "priya.natarajan@northwind.cloud", role: "admin", joinedAt: "2026-04-11T14:20:00Z" },
        { userId: "usr_4", name: "Tom Becker", email: "tom.becker@northwind.cloud", role: "member", joinedAt: "2026-06-23T08:45:00Z" },
      ],
    },
    {
      id: "org_harbor", name: "Harbor Analytics", nameConfirmed: true,
      members: [
        { userId: "usr_5", name: "Jonas Weber", email: "jonas.weber@harbor-analytics.io", role: "owner", joinedAt: "2026-01-15T10:00:00Z" },
        { userId: "usr_1", name: "Elena Marsh", email: "elena.marsh@northwind.cloud", role: "member", joinedAt: "2026-05-04T16:30:00Z" },
      ],
    },
  ],
  invites: [],
  provisioned: ["usr_1", "usr_3", "usr_4", "usr_5"],
};

const later = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

function load(): State {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    /* storage unavailable */
  }
  return structuredClone(SEED);
}
let state = load();
function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* memory only */
  }
}

function me() {
  const u = mockCurrentUser();
  if (!u) throw new Error("Sign in to continue.");
  return u;
}

/** What the sign-up trigger does: a first organization, named after the person, not confirmed yet. */
function provision() {
  const u = me();
  if (state.provisioned.includes(u.id)) return;
  state.provisioned.push(u.id);
  if (!state.orgs.some((o) => o.members.some((m) => m.userId === u.id))) {
    state.orgs.push({ id: `org_${u.id}_${Date.now().toString(36)}`, name: u.name, nameConfirmed: false, members: [{ userId: u.id, name: u.name, email: u.email, role: "owner", joinedAt: new Date().toISOString() }] });
  }
  save();
}

const mine = () => {
  const u = me();
  return state.orgs.filter((o) => o.members.some((m) => m.userId === u.id));
};
const view = (o: MockOrg): Organization => ({ id: o.id, name: o.name, nameConfirmed: o.nameConfirmed, role: o.members.find((m) => m.userId === me().id)!.role });

/** The organization the request acts for, checked like the server does: the chosen one if the person is in it. */
function current(): { org: MockOrg; role: OrgRole } {
  const list = mine();
  const picked = activeOrgId();
  const org = picked ? list.find((o) => o.id === picked) : list[0];
  if (!org) throw new Error(picked ? "That organization does not exist, or you are not a member of it." : "Your account is not part of an organization. Create one or accept an invitation.");
  return { org, role: org.members.find((m) => m.userId === me().id)!.role };
}

/** For the other mocks: the role of the signed-in person in the chosen organization, or null. */
export function mockRole(): OrgRole | null {
  try {
    return current().role;
  } catch {
    return null;
  }
}

/** For the other mocks: refuses a change to a member, as the control plane answers 403. */
export function assertMockCanManage(): void {
  if (!canManage(mockRole())) throw Object.assign(new Error(READ_ONLY), { status: 403 });
}

/** For the settings mock: the name of the chosen organization. */
export function mockOrgName(): string | null {
  try {
    return current().org.name;
  } catch {
    return null;
  }
}

function checkName(name: string): string {
  const problem = orgNameProblem(name);
  if (problem) throw new Error(problem);
  return name.trim();
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function token(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const pending = (orgId: string) => state.invites.filter((i) => i.orgId === orgId && !i.acceptedAt && !i.revokedAt && Date.parse(i.expiresAt) > Date.now());
const toInvitation = (i: MockInvite): Invitation => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt });

export const mockOrgs: OrgsClient = {
  available: true,

  async listOrganizations() {
    provision();
    return later(mine().map(view));
  },

  async createOrganization(name) {
    const clean = checkName(name);
    const u = me();
    const org: MockOrg = { id: `org_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, nameConfirmed: true, members: [{ userId: u.id, name: u.name, email: u.email, role: "owner", joinedAt: new Date().toISOString() }] };
    state.orgs.push(org);
    save();
    return later(view(org));
  },

  async renameOrganization(name) {
    const clean = checkName(name);
    const { org, role } = current();
    if (!canManage(role)) throw new Error(READ_ONLY);
    org.name = clean;
    org.nameConfirmed = true;
    save();
    return later(view(org));
  },

  async leaveOrganization() {
    const { org, role } = current();
    if (role === "owner" && org.members.filter((m) => m.role === "owner").length <= 1) throw new Error("You are the only owner. Make someone else an owner before you leave.");
    org.members = org.members.filter((m) => m.userId !== me().id);
    save();
    setActiveOrgId(null);
    await later(null);
  },

  async listMembers() {
    const { org } = current();
    const items: Member[] = org.members.map((m) => ({ ...m, you: m.userId === me().id }));
    return later({ items, limit: MAX_MEMBERS });
  },

  async changeRole(userId, role) {
    const { org, role: mineRole } = current();
    const t = org.members.find((m) => m.userId === userId);
    if (!t) throw new Error("That member does not exist.");
    if (mineRole === "member") throw new Error(READ_ONLY);
    if (mineRole === "admin" && (t.userId === me().id || t.role !== "member" || role !== "member")) throw new Error("Only an owner can manage admins and owners.");
    if (t.role === "owner" && role !== "owner" && org.members.filter((m) => m.role === "owner").length <= 1) throw new Error("An organization needs at least one owner. Make someone else an owner first.");
    t.role = role;
    save();
    await later(null);
  },

  async removeMember(userId) {
    const { org, role } = current();
    const t = org.members.find((m) => m.userId === userId);
    if (!t) throw new Error("That member does not exist.");
    if (role === "member") throw new Error(READ_ONLY);
    if (role === "admin" && t.role !== "member") throw new Error("Only an owner can manage admins and owners.");
    if (t.role === "owner" && org.members.filter((m) => m.role === "owner").length <= 1) throw new Error("An organization needs at least one owner. Make someone else an owner first.");
    org.members = org.members.filter((m) => m.userId !== userId);
    save();
    await later(null);
  },

  async listInvitations() {
    const { org, role } = current();
    if (!canManage(role)) throw new Error(READ_ONLY);
    return later(pending(org.id).map(toInvitation).reverse());
  },

  async createInvitation(rawEmail, role) {
    const { org, role: mineRole } = current();
    if (!canManage(mineRole)) throw new Error(READ_ONLY);
    if (role === "admin" && mineRole !== "owner") throw new Error("Only an owner can invite admins.");
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw new Error("Enter a valid email address.");
    const today = state.invites.filter((i) => i.orgId === org.id && Date.parse(i.createdAt) > Date.now() - DAY);
    if (today.length >= INVITES_PER_DAY) throw new Error(`This organization has sent ${INVITES_PER_DAY} invitations in the last 24 hours. Try again later.`);
    if (org.members.some((m) => m.email === email)) throw new Error("That person is already a member of this organization.");
    if (pending(org.id).some((i) => i.email === email)) throw new Error("There is already a pending invitation for that email. Revoke it to send a new one.");
    if (org.members.length + pending(org.id).length >= MAX_MEMBERS) throw new Error(`An organization can have ${MAX_MEMBERS} members, counting pending invitations. Remove someone or revoke an invitation first.`);
    const t = token();
    const now = new Date();
    const inv: MockInvite = {
      id: `inv_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, orgId: org.id, email, role,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * DAY).toISOString(), tokenHash: await sha256(t), acceptedAt: null, revokedAt: null,
    };
    state.invites.push(inv);
    save();
    return later({ invitation: toInvitation(inv), link: `${window.location.origin}/invite#token=${t}` });
  },

  async revokeInvitation(id) {
    const { org, role } = current();
    if (!canManage(role)) throw new Error(READ_ONLY);
    const inv = pending(org.id).find((i) => i.id === id);
    if (!inv) throw new Error("That invitation does not exist or is no longer pending.");
    if (inv.role === "admin" && role !== "owner") throw new Error("Only an owner can manage admins and owners.");
    inv.revokedAt = new Date().toISOString();
    save();
    await later(null);
  },

  async acceptInvitation(t) {
    const u = me();
    const hash = await sha256(String(t));
    const inv = state.invites.find((i) => i.tokenHash === hash);
    if (!inv || inv.acceptedAt || inv.revokedAt || Date.parse(inv.expiresAt) <= Date.now() || inv.email !== u.email.toLowerCase()) {
      await later(null);
      throw new Error(INVALID);
    }
    const org = state.orgs.find((o) => o.id === inv.orgId)!;
    if (!org.members.some((m) => m.userId === u.id)) {
      if (org.members.length >= MAX_MEMBERS) throw new Error(`This organization already has ${MAX_MEMBERS} members. Ask an owner to make room.`);
      org.members.push({ userId: u.id, name: u.name, email: u.email.toLowerCase(), role: inv.role, joinedAt: new Date().toISOString() });
    }
    inv.acceptedAt = new Date().toISOString();
    save();
    return later(view(org));
  },
};
