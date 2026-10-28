import { createHash, randomUUID } from "node:crypto";
import { type AuthGateway, GatewayError, type Identity, type Provider, type Tokens } from "../../src/auth/gateway.ts";
import type { Signer } from "./harness.ts";

interface U { id: string; email: string; name: string }

/** Stands in for Supabase Auth: PKCE codes, one-time email tokens, refresh tokens. */
export class FakeGateway implements AuthGateway {
  private readonly signer: Signer;
  private readonly users = new Map<string, U>();
  private readonly codes = new Map<string, { challenge: string; user: U }>();
  private readonly emailTokens = new Map<string, { user: U; expires: number }>();
  private readonly refreshTokens = new Map<string, U>();
  /** Ways to sign in, per user id. Everyone starts with the email link to their own address. */
  readonly identityList = new Map<string, Identity[]>();
  private readonly linkCodes = new Map<string, { challenge: string; user: U; identity: Identity }>();
  manualLinkingDisabled = false;
  readonly sentEmails: { email: string; redirectTo: string }[] = [];
  readonly signedOut: string[] = [];
  accessLifetime: string | number = "1h";
  failSending = false;

  constructor(signer: Signer) { this.signer = signer; }

  register(u: U): void {
    this.users.set(u.email, u);
    if (!this.identityList.has(u.id)) this.identityList.set(u.id, [{ id: randomUUID(), provider: "email", email: u.email }]);
  }

  private userOf(accessToken: string): U {
    const sub = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString()).sub as string;
    const u = [...this.users.values()].find((x) => x.id === sub);
    if (!u) throw new GatewayError("User not found", 404);
    return u;
  }

  async identities(accessToken: string): Promise<Identity[]> {
    return [...(this.identityList.get(this.userOf(accessToken).id) ?? [])];
  }

  async linkUrl(a: { accessToken: string; provider: Provider; redirectTo: string; codeChallenge: string }): Promise<string> {
    if (this.manualLinkingDisabled) throw new GatewayError("Manual linking is disabled", 404, "manual_linking_disabled");
    const u = this.userOf(a.accessToken);
    const q = new URLSearchParams({ provider: a.provider, redirect_to: a.redirectTo, code_challenge: a.codeChallenge, user: u.id });
    return `https://project.supabase.invalid/auth/v1/user/identities/authorize?${q}`;
  }

  /** What Supabase Auth would do after the person approves at the provider: returns the callback `code`. */
  approveLink(linkUrl: string, providerEmail: string | null): string {
    const q = new URL(linkUrl).searchParams;
    const user = [...this.users.values()].find((x) => x.id === q.get("user"))!;
    const code = randomUUID();
    this.linkCodes.set(code, { challenge: q.get("code_challenge")!, user, identity: { id: randomUUID(), provider: q.get("provider")!, email: providerEmail } });
    return code;
  }

  async unlinkIdentity(a: { accessToken: string; identityId: string }): Promise<void> {
    const u = this.userOf(a.accessToken);
    const list = this.identityList.get(u.id) ?? [];
    if (!list.some((i) => i.id === a.identityId)) throw new GatewayError("Identity doesn't exist", 422, "identity_not_found");
    if (list.length < 2) throw new GatewayError("User must have at least 1 identity after unlinking", 422, "single_identity_not_deletable");
    this.identityList.set(u.id, list.filter((i) => i.id !== a.identityId));
  }

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
    const l = this.linkCodes.get(a.code);
    if (l) {
      this.linkCodes.delete(a.code);
      if (createHash("sha256").update(a.codeVerifier).digest("base64url") !== l.challenge) throw new GatewayError("invalid flow state", 400);
      this.identityList.set(l.user.id, [...(this.identityList.get(l.user.id) ?? []), l.identity]);
      return this.mint(l.user);
    }
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
