import type { ApiConfig } from "./config.ts";
import type { Tx } from "./db.ts";
import { ApiError, NO_ORGANIZATION } from "./errors.ts";

export type Role = "owner" | "admin" | "member";

/** Owners and admins may call the operations marked `x-fenvix-role: admin`; members read. */
export const mayAdminister = (role: Role) => role === "owner" || role === "admin";

/** An operation's access rule: who may call it, given their role in the organization the request names. */
export function allowed(op: { admin: boolean }, role: Role): boolean {
  return !op.admin || mayAdminister(role);
}

/**
 * The work the API hands to the App's worker (github-app/src/work.ts): "onboard" (a setup pull request) and
 * "installation_linked" (an installation was just linked: its repositories get their projects).
 */
export type OnboardWork =
  | { kind: "onboard"; repositoryId: number }
  | { kind: "installation_linked"; installationId: number }
  | { kind: "refresh_default_branch"; repositoryId: number };
export interface OnboardQueue { enqueue(work: OnboardWork): Promise<void> }

export interface Org { id: string; name: string; nameConfirmed: boolean; region: "us" | "eu"; emailNotices: boolean }

/** What a handler gets: the person (from the verified token), the organization and their role there, the request. */
export interface Ctx {
  userId: string;
  /** The organization of X-Fenvix-Workspace, once the person was found a member of it (null: an operation without one). */
  org: Org | null;
  role: Role | null;
  t: Tx;
  cfg: ApiConfig;
  queue: OnboardQueue;
  now: Date;
  // Validated against the contract before the handler runs.
  params: Record<string, any>;
  query: Record<string, any>;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  /** Runs once the request's transaction has committed (never if it rolled back); a failure there is logged only. */
  afterCommit(fn: () => Promise<void>): void;
}

/** A response other than 200 with a JSON body. */
export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status; this.body = body; this.headers = headers;
  }
}

export type Handler = (ctx: Ctx) => Promise<unknown>;

/** The organization of the request (only called by operations that take X-Fenvix-Workspace). */
export function orgOf(ctx: Ctx): Org & { role: Role } {
  if (!ctx.org || !ctx.role) throw new ApiError(404, "not_found", NO_ORGANIZATION);
  return { ...ctx.org, role: ctx.role };
}
