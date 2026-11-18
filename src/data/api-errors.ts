/**
 * What every client of the fenvix API shares, with no dependency on Vite, Supabase or the browser so that it can be
 * unit tested in Node: the error a screen shows, the sentence for a status the server gave no message for, and the
 * base address read from VITE_API_URL.
 */

/** An error from the API (or the mock), with the API's code (openapi/fenvix-api.yaml, Error) and a sentence to show. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field: string | undefined;
  constructor(code: string, message: string, status: number, field?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export const SESSION_ENDED = "Your session has ended. Sign in again.";
export const UNREACHABLE = "Could not reach fenvix. Check your connection and try again.";
export const READ_ONLY = "Your role in this organization is read only. Ask an owner or admin to do this.";

/** What to say when the server gave no message of its own. */
export function messageForStatus(status: number): string {
  if (status === 400 || status === 422) return "fenvix could not accept that. Check the values and try again.";
  if (status === 401) return SESSION_ENDED;
  if (status === 403) return "You do not have permission to do this in this organization.";
  if (status === 404) return "That was not found. It may have been removed, or it belongs to another organization.";
  if (status === 409) return "That conflicts with a change made in the meantime. Reload and try again.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status === 503) return "fenvix is busy right now. Try again in a moment.";
  return "Something went wrong on fenvix's side. Try again in a moment.";
}

const CODES: Record<number, string> = { 400: "validation_failed", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "validation_failed", 429: "rate_limited", 503: "unavailable" };

/**
 * The ApiError for a response that was not OK. The body is the API's `{ error: { code, message, field? } }` when it
 * sent one; anything else (a proxy's HTML page, an empty body) gets the sentence for its status. A 401 always says
 * the session has ended: signing in again is the only thing a person can do about it.
 */
export function errorFromResponse(status: number, body: unknown): ApiError {
  const err = (body && typeof body === "object" ? (body as { error?: { code?: unknown; message?: unknown; field?: unknown } }).error : undefined) ?? undefined;
  const code = typeof err?.code === "string" ? err.code : (CODES[status] ?? "internal");
  const field = typeof err?.field === "string" ? err.field : undefined;
  if (status === 401) return new ApiError("unauthenticated", SESSION_ENDED, 401, field);
  const message = typeof err?.message === "string" && err.message.trim() ? err.message.trim() : messageForStatus(status);
  return new ApiError(code, message, status, field);
}

/** VITE_API_URL as written, to the base every path is added to: no trailing slash, and /v1 when only a host is given. */
export function normalizeApiUrl(value: string): string {
  const v = value.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/]+$/i.test(v) ? `${v}/v1` : v;
}

/** The message of anything thrown, for a screen. */
export const messageOf = (e: unknown, fallback = "Something went wrong. Try again.") => (e instanceof Error && e.message ? e.message : fallback);
