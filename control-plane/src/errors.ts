export type ErrorCode =
  | "validation_failed"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal"
  /** A dependency (the engine's database listener) did not answer in time, or is waking up. Retry later. */
  | "unavailable";

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

/** An error with a contract code. `message` is written for people and shown in the dashboard as is. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly field: string | undefined;
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message: string, field?: string, headers: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.field = field;
    this.headers = headers;
  }

  get status(): number {
    return STATUS[this.code];
  }

  body(): { error: { code: ErrorCode; message: string; field?: string } } {
    return { error: { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) } };
  }
}

export const validation = (message: string, field?: string) => new ApiError("validation_failed", message, field);
export const notFound = (message = "Not found.") => new ApiError("not_found", message);
export const conflict = (message: string, field?: string) => new ApiError("conflict", message, field);
export const forbidden = (message = "You are not allowed to do this.") => new ApiError("forbidden", message);
export const unauthenticated = (message = "Sign in to continue.") => new ApiError("unauthenticated", message);
export const unavailable = (message: string, retryAfterSeconds = 2) => new ApiError("unavailable", message, undefined, { "Retry-After": String(retryAfterSeconds) });
export const internal = (message = "Something went wrong on our side. Try again in a moment.") => new ApiError("internal", message);
