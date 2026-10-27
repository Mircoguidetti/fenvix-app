import type { Caller } from "./context.ts";
import type { Client } from "./db.ts";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  outcome?: "ok" | "failed" | "denied";
  metadata?: Record<string, unknown>;
}

/** Keys that must never be written to the audit log, whatever a caller passes. */
const SECRET_KEYS = /secret|token|password|authorization|cookie|key_hash|connection/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[removed]" : scrub(v, depth + 1)]));
  }
  return value;
}

/** Adds one audit row inside the caller's transaction, so it is there if and only if the change is. */
export async function writeAudit(
  c: Client,
  who: { workspaceId: string; actor: { type: "user" | "api_key" | "system"; id: string | null }; requestId: string | null; ip?: string | null },
  e: AuditEntry,
): Promise<void> {
  await c.query(
    `insert into public.audit_log (workspace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, ip, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [who.workspaceId, who.actor.type, who.actor.id, e.action, e.targetType ?? null, e.targetId ?? null, e.outcome ?? "ok",
     who.requestId, who.ip ?? null, JSON.stringify(scrub(e.metadata ?? {}))],
  );
}

export const auditWho = (caller: Caller) => ({ workspaceId: caller.workspaceId, actor: caller.actor, requestId: caller.requestId, ip: caller.ip });
