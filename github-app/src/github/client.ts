import { createSign, type KeyObject } from "node:crypto";

/** A non-2xx answer from GitHub. The message is GitHub's own (never contains our credentials). */
export class GitHubError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, method: string, path: string, body: unknown) {
    const msg = typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : "";
    super(`GitHub ${method} ${path} answered ${status}${msg ? `: ${msg}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Statuses that are answers, not errors (e.g. 404 for "no such file"). */
  allow?: number[];
}

export interface Response<T> { status: number; data: T }

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The App's own token (RS256, 10 minutes at most; issued 60 s in the past against clock drift), as GitHub documents. */
export function appJwt(appId: number, key: KeyObject, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Minimal REST client: JSON in, JSON out, a timeout, GitHub's required headers. One per token kind. */
export class GitHubHttp {
  private readonly apiUrl: string;
  private readonly token: () => Promise<string>;
  private readonly scheme: "Bearer" | "token";
  private readonly timeoutMs: number;

  constructor(apiUrl: string, token: () => Promise<string>, scheme: "Bearer" | "token" = "Bearer", timeoutMs = 15_000) {
    this.apiUrl = apiUrl;
    this.token = token;
    this.scheme = scheme;
    this.timeoutMs = timeoutMs;
  }

  async request<T = unknown>(method: string, path: string, o: RequestOptions = {}): Promise<Response<T>> {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "fenvix-github-app",
      authorization: `${this.scheme} ${await this.token()}`,
    };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok && !(o.allow ?? []).includes(res.status)) throw new GitHubError(res.status, method, path, data);
    return { status: res.status, data: data as T };
  }
}

interface CachedToken { token: string; expiresAt: number }

/**
 * Authentication as the App and as each installation. Installation tokens live one hour; they are cached and renewed
 * five minutes before they expire. Nothing here is ever logged.
 */
export class GitHubApp {
  private readonly tokens = new Map<number, CachedToken>();
  readonly app: GitHubHttp;
  private readonly o: { apiUrl: string; appId: number; privateKey: KeyObject; timeoutMs?: number };

  constructor(o: { apiUrl: string; appId: number; privateKey: KeyObject; timeoutMs?: number }) {
    this.o = o;
    this.app = new GitHubHttp(o.apiUrl, async () => appJwt(o.appId, o.privateKey), "Bearer", o.timeoutMs);
  }

  async installationToken(installationId: number): Promise<string> {
    const hit = this.tokens.get(installationId);
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
    const r = await this.app.request<{ token: string; expires_at: string }>("POST", `/app/installations/${installationId}/access_tokens`);
    this.tokens.set(installationId, { token: r.data.token, expiresAt: Date.parse(r.data.expires_at) || Date.now() + 50 * 60_000 });
    return r.data.token;
  }

  /** Forget a token GitHub refused (e.g. the installation was suspended). */
  forget(installationId: number): void { this.tokens.delete(installationId); }

  installation(installationId: number): GitHubHttp {
    return new GitHubHttp(this.o.apiUrl, () => this.installationToken(installationId), "Bearer", this.o.timeoutMs);
  }

  /** A client acting as a person (OAuth user token), used only to check which installations that person can see. */
  user(token: string): GitHubHttp {
    return new GitHubHttp(this.o.apiUrl, async () => token, "Bearer", this.o.timeoutMs);
  }
}

/** `owner/name` → path segments for /repos/{owner}/{repo}. */
export function repoPath(fullName: string): string {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error(`not a repository name: ${fullName}`);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** A path inside a repository for the contents API: each segment encoded, the slashes kept. */
export const contentPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
