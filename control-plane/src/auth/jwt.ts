import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface SessionClaims {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  expiresAt: number;
}

export type VerifyResult = { ok: true; claims: SessionClaims } | { ok: false; reason: "expired" | "invalid" };

/** Verifies Supabase session tokens against the project's published signing keys (JWKS). */
export class JwtVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(supabaseUrl: string, jwksUrl: string, keys?: JWTVerifyGetKey) {
    this.keys = keys ?? createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    this.issuer = `${supabaseUrl}/auth/v1`;
  }

  async verify(token: string): Promise<VerifyResult> {
    try {
      // Only asymmetric algorithms: a token signed with a shared secret, or with "none", is never accepted.
      const { payload } = await jwtVerify(token, this.keys, { issuer: this.issuer, audience: "authenticated", algorithms: ["ES256", "RS256", "EdDSA"] });
      const sub = payload.sub;
      if (typeof sub !== "string" || !/^[0-9a-f-]{36}$/i.test(sub)) return { ok: false, reason: "invalid" };
      const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
      const email = typeof payload.email === "string" ? payload.email : "";
      const named = [meta.full_name, meta.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
      const avatar = [meta.avatar_url, meta.picture].find((v): v is string => typeof v === "string" && v !== "");
      return {
        ok: true,
        claims: { userId: sub, email, name: named?.trim() ?? (email.split("@")[0] || "Account"), avatarUrl: avatar ?? null, expiresAt: payload.exp ?? 0 },
      };
    } catch (e) {
      return { ok: false, reason: e instanceof errors.JWTExpired ? "expired" : "invalid" };
    }
  }
}
