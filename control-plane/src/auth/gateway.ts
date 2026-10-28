/** What the control plane needs from Supabase Auth (GoTrue). Tests use a fake. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lives. */
  expiresIn: number;
}

export type Provider = "github" | "google";

/** A way to sign in to one account: a provider account, or the email link ("email"). */
export interface Identity {
  id: string;
  provider: string;
  /** The address the provider gave, if any. */
  email: string | null;
}

export class GatewayError extends Error {
  readonly status: number;
  /** Supabase Auth's error_code, e.g. single_identity_not_deletable. */
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AuthGateway {
  /** The provider page to send the browser to. PKCE: only the challenge leaves the server. */
  authorizeUrl(a: { provider: Provider; redirectTo: string; codeChallenge: string }): string;
  exchangeCode(a: { code: string; codeVerifier: string }): Promise<Tokens>;
  /** Sends the one-time link. The link is built by the Supabase email template (see README). */
  sendEmailLink(a: { email: string; redirectTo: string }): Promise<void>;
  /** Signs in with the `token_hash` from the emailed link. */
  verifyEmailToken(tokenHash: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  signOut(accessToken: string): Promise<void>;
  /** The signed-in user's ways to sign in. */
  identities(accessToken: string): Promise<Identity[]>;
  /** The provider page that links another provider to the signed-in user. PKCE, like sign-in. */
  linkUrl(a: { accessToken: string; provider: Provider; redirectTo: string; codeChallenge: string }): Promise<string>;
  /** Removes one way to sign in. Supabase Auth refuses to remove the last one. */
  unlinkIdentity(a: { accessToken: string; identityId: string }): Promise<void>;
}

/** Supabase Auth over its REST API, using only the project's public (anon) key. */
export class SupabaseGateway implements AuthGateway {
  private readonly base: string;
  private readonly anonKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(supabaseUrl: string, anonKey: string, fetchFn: typeof fetch = fetch) {
    this.base = `${supabaseUrl}/auth/v1`;
    this.anonKey = anonKey;
    this.fetchFn = fetchFn;
  }

  authorizeUrl(a: { provider: Provider; redirectTo: string; codeChallenge: string }): string {
    const q = new URLSearchParams({ provider: a.provider, redirect_to: a.redirectTo, code_challenge: a.codeChallenge, code_challenge_method: "s256" });
    return `${this.base}/authorize?${q}`;
  }

  private async call(path: string, body: unknown, extraHeaders: Record<string, string> = {}, method = "POST"): Promise<unknown> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json", apikey: this.anonKey, ...extraHeaders },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const m = json as { msg?: string; message?: string; error_description?: string; error_code?: string } | null;
      throw new GatewayError(m?.msg ?? m?.message ?? m?.error_description ?? `Supabase Auth answered ${res.status}`, res.status, m?.error_code);
    }
    return json;
  }

  private tokens(json: unknown): Tokens {
    const t = json as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
    if (!t?.access_token || !t.refresh_token) throw new GatewayError("Supabase Auth returned no session", 502);
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in ?? 3600 };
  }

  async exchangeCode(a: { code: string; codeVerifier: string }): Promise<Tokens> {
    return this.tokens(await this.call("/token?grant_type=pkce", { auth_code: a.code, code_verifier: a.codeVerifier }));
  }

  async sendEmailLink(a: { email: string; redirectTo: string }): Promise<void> {
    await this.call(`/otp?redirect_to=${encodeURIComponent(a.redirectTo)}`, { email: a.email, create_user: true });
  }

  async verifyEmailToken(tokenHash: string): Promise<Tokens> {
    return this.tokens(await this.call("/verify", { type: "email", token_hash: tokenHash }));
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    return this.tokens(await this.call("/token?grant_type=refresh_token", { refresh_token: refreshToken }));
  }

  async signOut(accessToken: string): Promise<void> {
    await this.call("/logout?scope=local", {}, { authorization: `Bearer ${accessToken}` });
  }

  async identities(accessToken: string): Promise<Identity[]> {
    const u = (await this.call("/user", null, { authorization: `Bearer ${accessToken}` }, "GET")) as {
      identities?: { identity_id?: string; id?: string; provider?: string; identity_data?: { email?: unknown } }[];
    } | null;
    return (u?.identities ?? []).map((i) => ({
      id: String(i.identity_id ?? i.id ?? ""),
      provider: String(i.provider ?? ""),
      email: typeof i.identity_data?.email === "string" ? i.identity_data.email : null,
    }));
  }

  async linkUrl(a: { accessToken: string; provider: Provider; redirectTo: string; codeChallenge: string }): Promise<string> {
    const q = new URLSearchParams({
      provider: a.provider, redirect_to: a.redirectTo, code_challenge: a.codeChallenge, code_challenge_method: "s256", skip_http_redirect: "true",
    });
    const r = (await this.call(`/user/identities/authorize?${q}`, null, { authorization: `Bearer ${a.accessToken}` }, "GET")) as { url?: string } | null;
    if (!r?.url) throw new GatewayError("Supabase Auth returned no address to link", 502);
    return r.url;
  }

  async unlinkIdentity(a: { accessToken: string; identityId: string }): Promise<void> {
    await this.call(`/user/identities/${encodeURIComponent(a.identityId)}`, null, { authorization: `Bearer ${a.accessToken}` }, "DELETE");
  }
}
