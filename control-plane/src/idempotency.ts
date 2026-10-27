import { createHash } from "node:crypto";
import { type Caller, type Services } from "./context.ts";
import { conflict } from "./errors.ts";

export type Begun =
  | { state: "new" }
  | { state: "replay"; status: number | null; body: unknown; operationId: string | null };

export const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export const requestHash = (method: string, path: string, body: unknown) =>
  createHash("sha256").update(`${method} ${path}\n${JSON.stringify(body ?? null)}`).digest("hex");

/** Claims the key for this request, or says what the first request answered. Keys last 24 hours. */
export async function begin(s: Services, caller: Caller, key: string, method: string, path: string, hash: string): Promise<Begun> {
  return s.db.tx(caller.workspaceId, async (c) => {
    // Old keys, and keys whose first request died before answering, are free again.
    await c.query(
      `delete from public.idempotency_keys where workspace_id = $1 and key = $2
        and (created_at < now() - make_interval(hours => $3) or (status = 'in_progress' and created_at < now() - interval '2 minutes'))`,
      [caller.workspaceId, key, s.cfg.limits.idempotencyTtlHours]);
    const ins = await c.query(
      `insert into public.idempotency_keys (workspace_id, key, method, path, request_hash) values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [caller.workspaceId, key, method, path, hash]);
    if (ins.rowCount) return { state: "new" } as const;
    const row = (await c.query("select * from public.idempotency_keys where workspace_id = $1 and key = $2", [caller.workspaceId, key])).rows[0];
    if (row.request_hash !== hash || row.method !== method || row.path !== path) {
      throw conflict("This Idempotency-Key was already used for a different request. Use a new key.");
    }
    if (row.status !== "done") throw conflict("A request with this Idempotency-Key is still running. Wait a moment, then retry.");
    return { state: "replay", status: row.response_status, body: row.response_body, operationId: row.operation_id } as const;
  });
}

/** Remembers the answer. For requests that started an operation, only the operation id is kept. */
export async function finish(s: Services, caller: Caller, key: string, r: { status?: number; body?: unknown; operationId?: string }): Promise<void> {
  await s.db.tx(caller.workspaceId, (c) => c.query(
    "update public.idempotency_keys set status = 'done', response_status = $3, response_body = $4, operation_id = $5 where workspace_id = $1 and key = $2",
    [caller.workspaceId, key, r.status ?? null, r.body === undefined ? null : JSON.stringify(r.body), r.operationId ?? null]));
}

/** The request failed in a way worth retrying: free the key. */
export async function abandon(s: Services, caller: Caller, key: string): Promise<void> {
  await s.db.tx(caller.workspaceId, (c) => c.query("delete from public.idempotency_keys where workspace_id = $1 and key = $2 and status = 'in_progress'", [caller.workspaceId, key])).catch(() => {});
}
