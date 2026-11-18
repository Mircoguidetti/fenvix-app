/**
 * Organizations, their members and invitations. The browser only talks to the fenvix API (`/me`, `/organizations`,
 * `/organization...`, `/invitations/accept`); every rule (who may do what, limits, which organization) is enforced
 * there and in row level security. The screens hide what a role cannot do, but that is a courtesy, not the protection.
 * The records are the API's own schemas (src/api/schema.d.ts).
 */
import type { components } from "../api/schema";

type S = components["schemas"];
export type OrgRole = S["OrgRole"];
export type InviteRole = S["InviteRole"];
export type Organization = S["Organization"];
export type Member = S["Member"];
export type Invitation = S["Invitation"];
/** `link` holds the token. Shown once. */
export type CreatedInvitation = S["CreatedInvitation"];
export type Me = S["Me"];

export interface OrgsClient {
  /** False when this dashboard has no API address (VITE_API_URL): no switcher, members or name screen. */
  readonly available: boolean;
  /** The signed-in person and their organizations (GET /me). */
  me(): Promise<Me>;
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

/** The server's rule for a name, to explain a problem before sending. */
export function orgNameProblem(raw: string): string | null {
  const name = raw.trim();
  const n = [...name].length;
  if (n < 2 || n > 64) return "Use 2 to 64 characters for the organization name.";
  if (/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)) return "Use letters, numbers, spaces and punctuation only, on one line.";
  return null;
}

/**
 * The name to start the "Name your organization" field with: the name guessed at sign-up, with spaces tidied and a
 * name written twice over ("Spazio Milano Spazio Milano", from a profile whose first and last name are both the
 * business name) shown once.
 */
export function suggestedOrgName(raw: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const half = words.length / 2;
  if (words.length >= 2 && Number.isInteger(half)) {
    const a = words.slice(0, half).join(" ");
    if (a.toLowerCase() === words.slice(half).join(" ").toLowerCase()) return a;
  }
  return words.join(" ");
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
