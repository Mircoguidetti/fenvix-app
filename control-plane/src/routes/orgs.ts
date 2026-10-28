import type { FastifyInstance } from "fastify";
import { type Deps, authenticateUser, routeHelpers } from "../http.ts";
import { asObject } from "../validate.ts";
import * as orgs from "../services/orgs.ts";

/**
 * Organizations, members and invitations (docs/organizations.md).
 *
 *  - /organizations, /invitations/accept: about the signed-in person, whatever organization they are in (or none).
 *  - /organization/...: the organization the request acts for (header X-Fenvix-Workspace, checked against the
 *    membership on every request; the oldest membership when absent). API keys cannot use any of them.
 */
export function orgRoutes(app: FastifyInstance, d: Deps): void {
  const { s } = d;
  const { read, write } = routeHelpers(app, d);
  const L = s.cfg.limits;

  // ---------------------------------------------------------------- the person's organizations

  app.get("/organizations", async (req, reply) => {
    const user = await authenticateUser(d, req, reply);
    return orgs.listOrganizations(s, user);
  });

  app.post("/organizations", async (req, reply) => {
    const user = await authenticateUser(d, req, reply);
    const name = asObject(req.body).name;
    orgs.parseOrgName(name, s);
    d.limiter.hit(`org-create:${user.userId}`, L.organizationsCreatedPerUserPerDay, 86_400_000);
    return reply.code(201).send(await orgs.createOrganization(s, user, name));
  });

  app.post("/invitations/accept", async (req, reply) => {
    const user = await authenticateUser(d, req, reply);
    // Wrong tokens count too, so guessing is slow.
    d.limiter.hit(`invite-accept:${user.userId}`, L.invitationAcceptsPerMinute);
    const token = typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? (req.body as { token?: unknown }).token : undefined;
    return orgs.acceptInvite(s, user, token, req.log);
  });

  // ---------------------------------------------------------------- the current organization

  read("/organization", { apiKey: false }, async ({ caller }) => orgs.getOrganization(s, caller));

  write("PUT", "/organization", { apiKey: false, role: "admin", idem: "skip" }, async ({ caller, body }) =>
    ({ status: 200, body: await orgs.renameOrganization(s, caller, asObject(body).name) }));

  write("POST", "/organization/leave", { apiKey: false, role: "any", idem: "skip" }, async ({ caller }) => {
    await orgs.leaveOrganization(s, caller);
    return { status: 200, body: {} };
  });

  read("/organization/members", { apiKey: false }, async ({ caller }) => orgs.listMembers(s, caller));

  write("PUT", "/organization/members/:userId", { apiKey: false, role: "admin", idem: "skip" }, async ({ caller, params, body }) =>
    ({ status: 200, body: await orgs.changeRole(s, caller, params.userId, asObject(body)) }));

  write("DELETE", "/organization/members/:userId", { apiKey: false, role: "admin", idem: "skip" }, async ({ caller, params }) => {
    await orgs.removeMember(s, caller, params.userId);
    return { status: 200, body: {} };
  });

  read("/organization/invitations", { apiKey: false, role: "admin" }, async ({ caller }) => orgs.listInvites(s, caller));

  // The link (with the token) is in this one answer only: a repeat with the same Idempotency-Key is refused.
  write("POST", "/organization/invitations", { apiKey: false, role: "admin", idem: "no-replay" }, async ({ caller, body, reply }) => {
    reply.header("Pragma", "no-cache");
    return { status: 201, body: await orgs.createInvite(s, caller, asObject(body)) };
  });

  write("POST", "/organization/invitations/:id/revoke", { apiKey: false, role: "admin", idem: "skip" }, async ({ caller, params }) =>
    ({ status: 200, body: await orgs.revokeInvite(s, caller, params.id) }));
}
