import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Verifies Supabase session tokens against the project's published keys (JWKS), like the control plane does. */
export class SessionVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(supabaseUrl: string, jwksUrl: string, keys?: JWTVerifyGetKey) {
    this.keys = keys ?? createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    this.issuer = `${supabaseUrl}/auth/v1`;
  }

  /** The user id, or null. Only asymmetric algorithms: a token signed with a shared secret, or "none", is refused. */
  async userId(authorization: string | undefined): Promise<string | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!m) return null;
    try {
      const { payload } = await jwtVerify(m[1]!, this.keys, { issuer: this.issuer, audience: "authenticated", algorithms: ["ES256", "RS256", "EdDSA"] });
      return typeof payload.sub === "string" && /^[0-9a-f-]{36}$/i.test(payload.sub) ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

export interface InstallState { workspaceId: string; userId: string; expiresAt: number }

/**
 * The `state` the installation link carries through GitHub and back to /github/setup: which organization and which
 * person asked for it, valid one hour, signed (HMAC-SHA256) so nobody can make one for another organization.
 */
export function signState(key: string, s: { workspaceId: string; userId: string }, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ w: s.workspaceId, u: s.userId, e: Math.floor(now / 1000) + 3600, n: randomBytes(8).toString("hex") })).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyState(key: string, state: string | undefined, now = Date.now()): InstallState | null {
  if (!state || state.length > 1000) return null;
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const o = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { w?: unknown; u?: unknown; e?: unknown };
    if (typeof o.w !== "string" || typeof o.u !== "string" || typeof o.e !== "number") return null;
    if (o.e * 1000 < now) return null;
    return { workspaceId: o.w, userId: o.u, expiresAt: o.e };
  } catch {
    return null;
  }
}

/** Constant-time check of a bearer token against the configured runner tokens. */
export function runnerTokenOk(tokens: string[], authorization: string | undefined): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return false;
  const given = createHmac("sha256", "runner").update(m[1]!).digest();
  let ok = false;
  for (const t of tokens) if (timingSafeEqual(given, createHmac("sha256", "runner").update(t).digest())) ok = true;
  return ok;
}
