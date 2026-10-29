import { ExplorerError } from "./explorer.ts";

/**
 * One request to the control plane, with no dependency on Vite or Supabase so it can be unit tested in Node. The
 * browser wiring (base URL, the person's session token, the organization header) lives in explorer-http.ts.
 *
 * Every failure becomes an ExplorerError with the control plane's code and a message a person can read: the server's
 * own message when it sent one, otherwise a plain sentence for the status (a proxy's HTML error page is never shown).
 */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface HttpConfig {
  /** Includes /v1, no trailing slash. Empty when the dashboard has no VITE_API_URL. */
  baseUrl: string;
  /** The bearer token of the signed-in person. Throws an ExplorerError when there is none. */
  token(): Promise<string>;
  /** Extra headers sent with every request (the chosen organization). */
  headers(): Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** VITE_API_URL as written, to the base every path is added to: no trailing slash, and /v1 when only a host is given. */
export function normalizeApiUrl(value: string): string {
  const v = value.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/]+$/i.test(v) ? `${v}/v1` : v;
}

/** What to say when the server gave no message of its own. */
export function messageForStatus(status: number): string {
  if (status === 400) return "FENVIX could not accept that. Check the values and try again.";
  if (status === 401) return "Your session has ended. Sign in again.";
  if (status === 403) return "You do not have permission to do this in this organization.";
  if (status === 404) return "That was not found. It may have been erased.";
  if (status === 409) return "That conflicts with a change made in the meantime. Reload and try again.";
  if (status === 422) return "FENVIX could not accept that. Check the values and try again.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status === 503) return "FENVIX is busy right now. Try again in a moment.";
  return "Something went wrong on FENVIX's side. Try again in a moment.";
}

const CODES: Record<number, string> = { 400: "validation_failed", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "validation_failed", 429: "rate_limited", 503: "unavailable" };

export async function httpRequest<T>(cfg: HttpConfig, method: Method, path: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
  if (!cfg.baseUrl) throw new ExplorerError("not_configured", "This dashboard is not connected to FENVIX yet (VITE_API_URL is not set).", 0);
  const doFetch = cfg.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await cfg.token()}`,
        ...cfg.headers(),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof ExplorerError) throw e;
    throw new ExplorerError("network", "Could not reach FENVIX. Check your connection and try again.", 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: handled below */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: unknown; message?: unknown; field?: unknown } } | null)?.error;
    const message = typeof err?.message === "string" && err.message.trim() ? err.message : messageForStatus(res.status);
    const code = typeof err?.code === "string" ? err.code : (CODES[res.status] ?? "internal");
    const retry = Number(res.headers.get("retry-after"));
    throw new ExplorerError(code, message, res.status, typeof err?.field === "string" ? err.field : undefined, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return { status: res.status, data: json as T };
}
