import { apiUrl } from "../lib/env";
import { call } from "./explorer-http";
import type { CreatedInvitation, Invitation, Member, Organization, OrgsClient } from "./orgs";

/** Organizations over HTTP, to the control plane at VITE_API_URL (the header of the chosen organization is added by `call`). */
export const httpOrgs: OrgsClient = {
  available: apiUrl !== "",
  listOrganizations: async () => (await call<{ items: Organization[] }>("GET", "/organizations")).items,
  createOrganization: async (name) => (await call<{ organization: Organization }>("POST", "/organizations", { name })).organization,
  renameOrganization: (name) => call<Organization>("PUT", "/organization", { name }),
  async leaveOrganization() {
    await call("POST", "/organization/leave");
  },
  listMembers: () => call<{ items: Member[]; limit: number }>("GET", "/organization/members"),
  async changeRole(userId, role) {
    await call("PUT", `/organization/members/${encodeURIComponent(userId)}`, { role });
  },
  async removeMember(userId) {
    await call("DELETE", `/organization/members/${encodeURIComponent(userId)}`);
  },
  listInvitations: async () => (await call<{ items: Invitation[] }>("GET", "/organization/invitations")).items,
  createInvitation: (email, role) => call<CreatedInvitation>("POST", "/organization/invitations", { email, role }),
  async revokeInvitation(id) {
    await call("POST", `/organization/invitations/${encodeURIComponent(id)}/revoke`);
  },
  acceptInvitation: async (token) => (await call<{ organization: Organization }>("POST", "/invitations/accept", { token })).organization,
};
