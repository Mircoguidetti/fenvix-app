import { createHash, randomUUID } from "node:crypto";
import { type AuthGateway, GatewayError, type Provider, type Tokens } from "../../src/auth/gateway.ts";
import type { Signer } from "./harness.ts";

interface U { id: string; email: string; name: string }

/** Stands in for Supabase Auth: PKCE codes, one-time email tokens, refresh tokens. */
export class FakeGateway implements AuthGateway {
  private readonly signer: Signer;
  private readonly users = new Map<string, U>();
  private readonly codes = new Map<string, { challenge: string; user: U }>();
  private readonly emailTokens = new Map<string, { user: U; expires: number }>();
  private readonly refreshTokens = new Map<string, U>();
  readonly sentEmails: { email: string; redirectTo: string }[] = [];
  readonly signedOut: string[] = [];
  accessLifetime: string | number = "1h";
  failSending = false;

  constructor(signer: Signer) { this.signer = signer; }

  register(u: U): void { this.users.set(u.email, u); }

  /** What the provider would do after the person approves: returns the callback `code`. */
  approve(u: U, authorizeUrl: string): string {
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge")!;
    const code = randomUUID();
    this.codes.set(code, { challenge, user: u });
    return code;
  }

  authorizeUrl(a: { provider: Provider; redirectTo: string; codeChallenge: string }): string {
    const q = new URLSearchParams({ provider: a.provider, redirect_to: a.redirectTo, code_challenge: a.codeChallenge, code_challenge_method: "s256" });
    return `https://project.supabase.invalid/auth/v1/authorize?${q}`;
  }

  private async mint(u: U): Promise<Tokens> {
    const refreshToken = randomUUID();
    this.refreshTokens.set(refreshToken, u);
    return { accessToken: await this.signer.token(u, { expiresIn: this.accessLifetime }), refreshToken, expiresIn: 3600 };
  }

  async exchangeCode(a: { code: string; codeVerifier: string }): Promise<Tokens> {
    const c = this.codes.get(a.code);
    this.codes.delete(a.code);
    if (!c || createHash("sha256").update(a.codeVerifier).digest("base64url") !== c.challenge) throw new GatewayError("invalid flow state", 400);
    return this.mint(c.user);
  }

  async sendEmailLink(a: { email: string; redirectTo: string }): Promise<void> {
    if (this.failSending) throw new GatewayError("smtp down", 500);
    this.sentEmails.push(a);
    const user = this.users.get(a.email) ?? { id: randomUUID(), email: a.email, name: a.email.split("@")[0]! };
    this.users.set(a.email, user);
    this.emailTokens.set(`hash-${a.email}-${this.sentEmails.length}`, { user, expires: Date.now() + 15 * 60_000 });
  }

  /** The token_hash of the latest link sent to an address. */
  latestToken(email: string): string {
    const k = [...this.emailTokens.keys()].filter((x) => x.startsWith(`hash-${email}-`)).pop();
    if (!k) throw new Error("no link sent");
    return k;
  }

  expireToken(token: string): void { const t = this.emailTokens.get(token); if (t) t.expires = Date.now() - 1; }

  async verifyEmailToken(tokenHash: string): Promise<Tokens> {
    const t = this.emailTokens.get(tokenHash);
    this.emailTokens.delete(tokenHash);
    if (!t || t.expires < Date.now()) throw new GatewayError("Email link is invalid or has expired", 403);
    return this.mint(t.user);
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    const u = this.refreshTokens.get(refreshToken);
    if (!u) throw new GatewayError("Invalid Refresh Token", 400);
    this.refreshTokens.delete(refreshToken);
    return this.mint(u);
  }

  async signOut(accessToken: string): Promise<void> { this.signedOut.push(accessToken); }

  /** A session as the fake would hand out after sign-in, for tests of refresh. */
  async session(u: U): Promise<Tokens> { return this.mint(u); }
}
