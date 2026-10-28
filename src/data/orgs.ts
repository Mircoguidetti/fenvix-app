/**
 * Organizations, their members and invitations. The browser only talks to the control plane (`/v1/organization...`);
 * every rule (who may do what, limits, which organization) is enforced there and in row level security. The screens
 * hide what a role cannot do, but that is a courtesy, not the protection.
 */
export type OrgRole = "owner" | "admin" | "member";
export type InviteRole = "admin" | "member";

export interface Organization {
  id: string;
  name: string;
  role: OrgRole;
  nameConfirmed: boolean;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string | null;
  you: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  role: InviteRole;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface CreatedInvitation {
  invitation: Invitation;
  /** Holds the token. Shown once. */
  link: string;
}

export interface OrgsClient {
  /** False when this dashboard cannot reach the control plane (no VITE_API_URL): no switcher, members or name screen. */
  readonly available: boolean;
  listOrganizations(): Promise<Organization[]>;
  createOrganization(name: string): Promise<Organization>;
  /** Renames the current organization and confirms its name. */
  renameOrganization(name: string): Promise<Organization>;
  leaveOrganization(): Promise<void>;
  listMembers(): Promise<{ items: Member[]; limit: number }>;
  changeRole(userId: string, role: OrgRole): Promise<void>;
  removeMember(userId: string): Promise<void>;
  listInvitations(): Promise<Invitation[]>;
  createInvitation(email: string, role: InviteRole): Promise<CreatedInvitation>;
  revokeInvitation(id: string): Promise<void>;
  acceptInvitation(token: string): Promise<Organization>;
}

export const ROLE_NAMES: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** The control plane's rule (control-plane/src/services/orgs.ts), to explain a problem before sending. */
export function orgNameProblem(raw: string): string | null {
  const name = raw.trim();
  const n = [...name].length;
  if (n < 2 || n > 64) return "Use 2 to 64 characters for the organization name.";
  if (/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)) return "Use letters, numbers, spaces and punctuation only, on one line.";
  return null;
}

/** Owner and admin manage; a member reads. */
export const canManage = (role: OrgRole | null | undefined) => role === "owner" || role === "admin";

/** What the person signed in as `actor` may do to `target` (the server checks the same). */
export function memberActions(actor: OrgRole, target: Member): { roles: OrgRole[]; remove: boolean } {
  if (target.you) return { roles: [], remove: false };
  if (actor === "owner") return { roles: ["owner", "admin", "member"], remove: true };
  if (actor === "admin" && target.role === "member") return { roles: [], remove: true };
  return { roles: [], remove: false };
}
