import type { FastifyReply, FastifyRequest } from "fastify";
import type { Caller } from "../context.ts";
import { ApiError, forbidden, notFound, unauthenticated, validation } from "../errors.ts";
import { type Deps, ORG_NOT_FOUND, WORKSPACE_HEADER, authenticate, clientIp } from "../http.ts";
import { type KeyRole, TOKEN_PREFIX, TOKEN_RE, auditFailedAuth, hashToken, knownKeys, resolveKey } from "../services/apikeys.ts";

/**
 * Who is calling the public API (docs/public-api.md, "Authentication").
 *
 *  - `Authorization: Bearer fvx_...`: a public API key. Resolved to its organization and role; the role becomes the
 *    caller's organization role, so every route makes the SAME check the dashboard makes for a person: an `admin` key
 *    is an organization admin, a `read_only` key is a member (reading only). The organization always comes from the key.
 *  - A dashboard session (cookie or Supabase JWT), only where the route allows it (`session: true`, the key management
 *    routes, so the first key can be made). That is http.ts's authenticate(), unchanged: same membership check, same
 *    origin check for cookies, same rate limits; and the organization must be named with X-Fenvix-Workspace.
 *  - Anything else, including the dashboard's `fnx_` keys, is a 401.
 */

export interface PublicCaller {
  caller: Caller;
  /** The key, when the caller is one. */
  key: { id: string; role: KeyRole } | null;
}

const INVALID = "That API key is not valid, has expired or has been revoked.";

export const roleOfKey = (r: KeyRole): Caller["role"] => (r === "admin" ? "admin" : "member");

/**
 * Lookups an address may still make, per minute, for keys this instance knows to be valid once it has used up its
 * budget of failures (`anon:<ip>`). Higher than that budget, so a working key behind a busy NAT keeps working.
 */
export const KNOWN_KEY_LOOKUPS_PER_MINUTE = 600;

export async function authenticatePublic(d: Deps, req: FastifyRequest, reply: FastifyReply, opts: { session: boolean }): Promise<PublicCaller> {
  const { s } = d;
  const ip = clientIp(req);
  // Failures count against the address (`anon:<ip>`, shared with the dashboard's failed sign-ins), so guessing is slow,
  // and once an address is over that budget a key is refused BEFORE any database lookup, unless this instance knows it
  // to be valid (it made it, or saw it work in the last 15 minutes); those go on, on their own higher per-address
  // counter (`pubauth:<ip>`), so failed or anonymous traffic from the same address (a NAT, a CI runner) cannot lock out
  // a working key. Valid keys then have their own limits below.
  const fail = (message = INVALID): never => {
    d.limiter.hit(`anon:${ip}`, s.cfg.rateLimitAnonPerMinute);
    throw unauthenticated(message);
  };

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
    const token = auth.slice(7).trim();
    // Malformed: refused without a lookup, and counted.
    if (!TOKEN_RE.test(token)) return fail();
    const hash = hashToken(token);
    try {
      d.limiter.check(`anon:${ip}`, s.cfg.rateLimitAnonPerMinute);
    } catch (e) {
      // Over the failure budget: no lookup for a key that is not known to be valid.
      if (!(e instanceof ApiError) || !knownKeys(s).has(hash)) throw e;
      d.limiter.hit(`pubauth:${ip}`, KNOWN_KEY_LOOKUPS_PER_MINUTE);
    }
    const r = await resolveKey(s, token);
    if (!r.ok) {
      knownKeys(s).delete(hash);
      if (r.reason === "revoked" || r.reason === "expired") {
        await auditFailedAuth(s, r, { id: req.id, ip, method: req.method, path: req.url.split("?")[0]! });
      }
      // The reason is in the log line and the audit log, never the key or any part of it.
      req.log.info({ reason: r.reason }, "public API key refused");
      return fail();
    }
    knownKeys(s).add(hash);
    // A key belongs to one organization; naming another one is a mistake, not a way in (same answer as http.ts).
    const picked = req.headers[WORKSPACE_HEADER];
    if (picked !== undefined && (typeof picked !== "string" || picked.toLowerCase() !== r.workspaceId)) throw notFound(ORG_NOT_FOUND);
    const caller: Caller = { workspaceId: r.workspaceId, actor: { type: "api_key", id: r.keyId }, role: roleOfKey(r.role), requestId: req.id, ip };
    d.limiter.hit(`pkey:${r.keyId}`, s.cfg.publicApiRateLimitPerMinute);
    d.limiter.hit(`ws:${caller.workspaceId}`, s.cfg.rateLimitPerMinute);
    req.log = req.log.child({ workspaceId: caller.workspaceId, actor: caller.actor });
    req.log.info("request authenticated");
    return { caller, key: { id: r.keyId, role: r.role } };
  }

  if (!opts.session) {
    // The dashboard's keys and sessions are for the dashboard routes.
    if (typeof auth === "string" && auth.startsWith("Bearer fnx_")) return fail("Dashboard API keys (fnx_) do not work on the public API. Create a public API key (fvx_).");
    return fail("Send a public API key: Authorization: Bearer fvx_...");
  }
  if (typeof auth === "string" && auth.startsWith("Bearer fnx_")) throw forbidden("Dashboard API keys (fnx_) cannot manage public API keys.");
  // A person in the dashboard, with the dashboard's own checks; managing keys needs owner or admin there too.
  const caller = await authenticate(d, req, reply, { apiKey: false, role: "admin" });
  // The organization must be named: a key is never made (or listed, or revoked) in the oldest membership by default.
  if (req.headers[WORKSPACE_HEADER] === undefined) {
    throw validation("Name the organization with the X-Fenvix-Workspace header (its id) to manage its API keys.", "X-Fenvix-Workspace");
  }
  return { caller, key: null };
}
