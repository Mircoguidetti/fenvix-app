/** An error the API answers with: `{ error: { code, message, field? } }` and a message a person can read. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, field?: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status; this.code = code; this.field = field; this.headers = headers;
  }

  body(): { error: { code: string; message: string; field?: string } } {
    return { error: { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) } };
  }
}

export const unauthenticated = () => new ApiError(401, "unauthenticated", "Sign in again: your session is missing or has ended.");
export const notFound = (message: string) => new ApiError(404, "not_found", message);
export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
export const conflict = (message: string, field?: string) => new ApiError(409, "conflict", message, field);
export const validation = (message: string, field?: string) => new ApiError(400, "validation_failed", message, field);
export const unavailable = (message: string) => new ApiError(503, "unavailable", message);

/** One message for every organization the person cannot see, member or not: ids cannot be probed. */
export const NO_ORGANIZATION = "That organization does not exist, or you are not a member of it.";
export const ADMINS_ONLY = "Only an owner or admin of this organization can do this.";
