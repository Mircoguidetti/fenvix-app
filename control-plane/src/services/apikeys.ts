import { createHash, randomBytes } from "node:crypto";
import { type Caller, type Services } from "../context.ts";
import { iso } from "../db.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { conflict, forbidden, notFound, unauthenticated, validation } from "../errors.ts";
import { type Obj, isUuid } from "../validate.ts";

/**
 * API keys of the public API (docs/public-api.md, migration 0010). Not the dashboard's `fnx_` keys (services/account.ts).
 *
 * A key is `fvx_` and 43 base64url characters (32 random bytes). It is in exactly one answer, the one that creates it;
 * Postgres keeps its SHA-256 (hex) and a display prefix (`fvx_` and the next 8 characters). Nothing here logs a key,
 * puts one in an error or writes one to the audit log.
 */

export type KeyRole = "admin" | "read_only";
export const KEY_ROLES: readonly KeyRole[] = ["admin", "read_only"];
export const TOKEN_PREFIX = "fvx_";
/** The whole token: what is accepted in `Authorization: Bearer`. Anything else is refused before any lookup. */
export const TOKEN_RE = /^fvx_[A-Za-z0-9_-]{43}$/;
const NAME_MAX = 60;
/** The furthest a key can be made to expire. */
const MAX_LIFETIME_DAYS = 3 * 365;
const KEY_NOT_FOUND = "That API key does not exist.";

export interface KeyRow {
  id: string; name: string; role: KeyRole; prefix: string; created_at: Date; created_by_type: string; created_by: string;
  last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null; cursor_at?: string;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

export function keyStatus(r: Pick<KeyRow, "revoked_at" | "expires_at">, now = Date.now()): "active" | "revoked" | "expired" {
  if (r.revoked_at) return "revoked";
  if (r.expires_at && new Date(r.expires_at).getTime() <= now) return "expired";
  return "active";
}

export const viewKey = (r: KeyRow) => ({
  id: String(r.id), name: r.name, role: r.role, prefix: r.prefix, status: keyStatus(r),
  createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), expiresAt: iso(r.expires_at), revokedAt: iso(r.revoked_at),
});

// ---------------------------------------------------------------- cursors

/**
 * A page boundary: the created_at (as Postgres prints it, to the microsecond) and id of the last row of the page.
 * Opaque to clients; anything that does not decode is a 400. It only ever narrows a query of the caller's own workspace.
 */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: unknown, field = "cursor"): { at: string; id: string } | null {
  if (value === undefined || value === "") return null;
  const bad = () => validation("This cursor is not valid. Use the nextCursor of the previous page.", field);
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw bad();
  const [at, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (rest.length || !id || !isUuid(id) || !at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)) throw bad();
  return { at, id: id.toLowerCase() };
}

/** `limit` query parameter: 1 to 100, 20 when absent. */
export function parseLimit(value: unknown, fallback = 20, max = 100): number {
  if (value === undefined || value === "") return fallback;
  const n = typeof value === "string" && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) throw validation(`limit must be a whole number from 1 to ${max}.`, "limit");
  return n;
}

/** The SQL expression that prints created_at the way cursors carry it. */
export const CURSOR_AT = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// ---------------------------------------------------------------- managing keys

export function parseNewKey(body: unknown, now = new Date()): { name: string; role: KeyRole; expiresAt: Date | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw validation("The request body must be a JSON object.");
  const b = body as Obj;
  const extra = Object.keys(b).find((k) => !["name", "role", "expiresAt"].includes(k));
  if (extra !== undefined) throw validation("Unknown field. Send only name, role and expiresAt.", extra.length <= 40 && /^[A-Za-z0-9_]+$/.test(extra) ? extra : undefined);
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw validation(`Use 1 to ${NAME_MAX} characters for the name, on one line.`, "name");
  if (!KEY_ROLES.includes(b.role as KeyRole)) throw validation("Choose a role: admin or read_only.", "role");
  let expiresAt: Date | null = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    const t = typeof b.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(b.expiresAt) ? new Date(b.expiresAt) : new Date(NaN);
    if (Number.isNaN(t.getTime())) throw validation("expiresAt must be a date and time, for example 2027-01-31T00:00:00Z.", "expiresAt");
    if (t.getTime() <= now.getTime() + 60_000) throw validation("expiresAt must be at least a minute from now.", "expiresAt");
    if (t.getTime() > now.getTime() + MAX_LIFETIME_DAYS * 86_400_000) throw validation(`expiresAt can be at most ${MAX_LIFETIME_DAYS} days from now.`, "expiresAt");
    expiresAt = t;
  }
  return { name, role: b.role as KeyRole, expiresAt };
}

/** Keys that are neither revoked nor expired, per organization. */
export const MAX_ACTIVE_KEYS = 100;

/**
 * Rules for a key made by another key (a person's session has none of these):
 *  - it cannot be an admin key: only a person signed in to the dashboard makes admin keys;
 *  - it cannot expire later than the key that makes it, and it must expire if that key does.
 * (A key made by a key is also revoked when that key is revoked: migration 0010.)
 */
function checkCreator(k: { role: KeyRole; expiresAt: Date | null }, creator: { expires_at: Date | null } | undefined): void {
  if (k.role === "admin") throw forbidden("Only an owner or admin signed in to the dashboard can create admin keys. An API key can create read_only keys.");
  if (!creator) throw unauthenticated("That API key is not valid, has expired or has been revoked.");
  if (creator.expires_at === null) return;
  const limit = new Date(creator.expires_at);
  if (k.expiresAt === null) throw validation(`This API key expires, so the keys it creates must expire too: set expiresAt to ${iso(limit)} or earlier.`, "expiresAt");
  if (k.expiresAt.getTime() > limit.getTime()) throw validation(`expiresAt cannot be later than the expiry of the key creating it (${iso(limit)}).`, "expiresAt");
}

export async function createKey(s: Services, caller: Caller, body: unknown) {
  const k = parseNewKey(body);
  const token = newToken();
  const key = await s.db.tx(caller.workspaceId, async (c) => {
    // The creator is checked again here, and its row is locked (FOR SHARE) until this key is committed: a demotion,
    // removal or revoke of the creator either finishes first (then this check fails) or waits for this key and then
    // revokes it (migration 0010's triggers). The insert trigger of 0010 makes the same check under the same lock.
    if (caller.actor.type === "user") {
      const m = await c.query(
        "select 1 from public.workspace_members where workspace_id = $1 and user_id = $2 and role in ('owner', 'admin') for share",
        [caller.workspaceId, caller.actor.id]);
      if (!m.rowCount) throw forbidden("Only an owner or admin of this organization can create API keys.");
    } else {
      const creator = (await c.query(
        `select expires_at from public.public_api_keys
          where workspace_id = $1 and id = $2 and revoked_at is null and (expires_at is null or expires_at > now()) for share`,
        [caller.workspaceId, caller.actor.id])).rows[0];
      checkCreator(k, creator);
    }
    // One create at a time per organization, so two at once cannot both take the last place.
    await c.query("select pg_advisory_xact_lock(hashtext('public_api_keys:' || $1))", [caller.workspaceId]);
    const active = (await c.query(
      "select count(*)::int as n from public.public_api_keys where workspace_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())",
      [caller.workspaceId])).rows[0].n as number;
    if (active >= MAX_ACTIVE_KEYS) throw conflict(`An organization can have up to ${MAX_ACTIVE_KEYS} active API keys. Revoke one first.`);
    const row = (await c.query(
      `insert into public.public_api_keys (workspace_id, name, role, key_hash, prefix, created_by_type, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [caller.workspaceId, k.name, k.role, hashToken(token), token.slice(0, TOKEN_PREFIX.length + 8), caller.actor.type, caller.actor.id, k.expiresAt],
    )).rows[0] as KeyRow;
    await writeAudit(c, auditWho(caller), {
      action: "api_key.public.create", targetType: "public_api_key", targetId: String(row.id),
      metadata: { name: k.name, role: k.role, expiresAt: iso(k.expiresAt) },
    });
    return viewKey(row);
  });
  knownKeys(s).add(hashToken(token));
  return { key, token };
}

export async function listKeys(s: Services, caller: Caller, q: { limit: number; cursor: { at: string; id: string } | null }) {
  return s.db.tx(caller.workspaceId, async (c) => {
    const params: unknown[] = [caller.workspaceId];
    let where = "workspace_id = $1";
    if (q.cursor) where += ` and (created_at, id) < ($${params.push(q.cursor.at)}::timestamptz, $${params.push(q.cursor.id)}::uuid)`;
    const rows = (await c.query(
      `select *, ${CURSOR_AT("created_at")} as cursor_at from public.public_api_keys where ${where}
       order by created_at desc, id desc limit $${params.push(q.limit + 1)}`, params)).rows as KeyRow[];
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(viewKey), nextCursor: rows.length > q.limit && last ? encodeCursor(last.cursor_at!, String(last.id)) : null };
  });
}

export async function revokeKey(s: Services, caller: Caller, id: unknown) {
  if (!isUuid(id)) throw notFound(KEY_NOT_FOUND);
  return s.db.tx(caller.workspaceId, async (c) => {
    const row = (await c.query(
      "update public.public_api_keys set revoked_at = coalesce(revoked_at, now()) where workspace_id = $1 and id = $2 returning *",
      [caller.workspaceId, id.toLowerCase()])).rows[0] as KeyRow | undefined;
    if (!row) throw notFound(KEY_NOT_FOUND);
    await writeAudit(c, auditWho(caller), { action: "api_key.public.revoke", targetType: "public_api_key", targetId: String(row.id) });
    return viewKey(row);
  });
}

/**
 * The key was made but its answer could not be completed (the Idempotency-Key record failed): nobody has the token, so
 * the key is revoked at once rather than left active. Recorded with reason "not_delivered".
 */
export async function revokeUndelivered(s: Services, caller: Caller, id: string): Promise<void> {
  const attempt = () => s.db.tx(caller.workspaceId, async (c) => {
    // Only a key still active is revoked and recorded; one already revoked (by a trigger, by a person) is left as it is.
    const row = (await c.query("update public.public_api_keys set revoked_at = now() where workspace_id = $1 and id = $2 and revoked_at is null returning id", [caller.workspaceId, id])).rows[0];
    if (row) await writeAudit(c, auditWho(caller), { action: "api_key.public.revoke", targetType: "public_api_key", targetId: id, metadata: { reason: "not_delivered" } });
  });
  // The failure that got us here may be a passing one (a dropped connection, a failover): one more try.
  try { await attempt(); } catch { await new Promise((r) => setTimeout(r, 100)); await attempt(); }
}

// ---------------------------------------------------------------- audit rows for refusals, at most one a minute

type Summary = (suppressed: number) => Promise<void>;
interface ThrottleEntry {
  /** End of the window opened by the last row written; 0 when no row has been written yet. */
  until: number;
  /** Refusals held back and not yet in any row. */
  suppressed: number;
  /** A row (or a summary) for this subject is being written. */
  pending: boolean;
  /** Held back refusals that the pending write carries; given back if it fails. */
  carried: number;
  /** Writes a summary row for a subject that went quiet with refusals held back. */
  summary: Summary | null;
}

/**
 * Lets one audit row through per subject (a key) and window, and counts the ones it holds back. The count is never
 * lost: it goes into the next row written for the subject (metadata.suppressed), or, when the subject goes quiet, into a
 * summary row written by flushDue() once the window has ended. The window starts only when a write has succeeded; a
 * failed write gives its count back and the next refusal tries again. In memory, per instance: with N instances, at
 * most N rows a minute per subject.
 */
export class AuditThrottle {
  private readonly seen = new Map<string, ThrottleEntry>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(windowMs = 60_000, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /**
   * Whether to write a row for `subject` now, and how many were held back since the last one. After a `write: true`,
   * call done() with the outcome of the write. `summary` writes the summary row if the subject goes quiet.
   */
  begin(subject: string, summary: Summary): { write: true; suppressed: number } | { write: false } {
    const t = this.now();
    const e = this.seen.get(subject) ?? { until: 0, suppressed: 0, pending: false, carried: 0, summary: null };
    this.seen.set(subject, e);
    e.summary = summary;
    if (e.pending || e.until > t) {
      e.suppressed++;
      return { write: false };
    }
    e.pending = true;
    e.carried = e.suppressed;
    e.suppressed = 0;
    return { write: true, suppressed: e.carried };
  }

  /** The write started by begin() (or by flushDue()) succeeded or failed. Only a success opens a window. */
  done(subject: string, ok: boolean): void {
    const e = this.seen.get(subject);
    if (!e) return;
    e.pending = false;
    if (ok) e.until = this.now() + this.windowMs;
    else e.suppressed += e.carried;
    e.carried = 0;
  }

  /**
   * Writes a summary row for every subject whose window has ended with refusals still held back, and forgets subjects
   * that have nothing left to say. Returns how many summaries were written. Called on a timer and, with `force`, on
   * shutdown (routes/public/index.ts).
   */
  async flushDue(force = false): Promise<number> {
    const t = this.now();
    let written = 0;
    for (const [subject, e] of [...this.seen]) {
      // `force` (on shutdown): write what is held back even inside its window, so nothing is lost.
      if (e.pending || (e.until > t && !(force && e.suppressed > 0))) continue;
      if (e.suppressed === 0 || !e.summary) { this.seen.delete(subject); continue; }
      e.pending = true;
      e.carried = e.suppressed;
      e.suppressed = 0;
      let ok = false;
      try { await e.summary(e.carried); ok = true; written++; } catch { /* given back below, tried again next time */ }
      this.done(subject, ok);
    }
    return written;
  }

  /** For tests: what is held back for a subject. */
  heldBack(subject: string): number {
    return this.seen.get(subject)?.suppressed ?? 0;
  }
}

const throttles = new WeakMap<Services, AuditThrottle>();
/** The throttle of one running service (one per app, so tests with several apps do not share one). */
export function auditThrottle(s: Services): AuditThrottle {
  let t = throttles.get(s);
  if (!t) { t = new AuditThrottle(); throttles.set(s, t); }
  return t;
}

/** Writes a throttled audit row: begin, write, done. A failed write is logged and its count kept for the next one. */
async function throttledAudit(s: Services, subject: string, write: (suppressed: number, summary: boolean) => Promise<void>, what: string): Promise<void> {
  const th = auditThrottle(s);
  const t = th.begin(subject, (n) => write(n, true));
  if (!t.write) return;
  let ok = false;
  try { await write(t.suppressed, false); ok = true; } catch (e) {
    s.log.error({ err: e instanceof Error ? e.message : String(e) }, `could not record ${what} in the audit log`);
  }
  th.done(subject, ok);
}

// ---------------------------------------------------------------- keys known to be valid

/**
 * Hashes of keys this instance has seen valid (or created) recently. When an address has used up its budget of failed
 * sign-ins, only these may still be looked up (auth/apikeys.ts), so a flood of made-up keys from one address costs no
 * database lookups while a working key from the same address keeps working. Only hashes are kept, never keys; an entry
 * only lets a lookup happen, the lookup still decides (a revoked key is refused at once).
 */
export class KnownKeys {
  private readonly hashes = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 15 * 60_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  add(hash: string): void {
    if (this.hashes.size > 100_000) {
      const t = this.now();
      for (const [h, until] of this.hashes) if (until <= t) this.hashes.delete(h);
    }
    this.hashes.set(hash, this.now() + this.ttlMs);
  }

  has(hash: string): boolean {
    const until = this.hashes.get(hash);
    return until !== undefined && until > this.now();
  }

  delete(hash: string): void {
    this.hashes.delete(hash);
  }
}

const known = new WeakMap<Services, KnownKeys>();
export function knownKeys(s: Services): KnownKeys {
  let k = known.get(s);
  if (!k) { k = new KnownKeys(); known.set(s, k); }
  return k;
}

// ---------------------------------------------------------------- resolving a key

export type Resolved =
  | { ok: true; keyId: string; workspaceId: string; role: KeyRole }
  | { ok: false; reason: "malformed" | "unknown" }
  | { ok: false; reason: "revoked" | "expired"; keyId: string; workspaceId: string };

/**
 * The organization and role of a token. Revoked and expired keys are told apart from unknown ones only so the refusal
 * can be recorded in their organization's audit log; the caller gets the same 401 for all of them. Records use at most
 * once a minute.
 */
export async function resolveKey(s: Services, token: string, now = Date.now()): Promise<Resolved> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "malformed" };
  const r = await s.db.system(async (c) => (await c.query("select * from public.fenvix_cp_resolve_public_api_key($1)", [hashToken(token)])).rows[0] as
    { key_id: string; workspace_id: string; role: KeyRole; expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null } | undefined);
  if (!r) return { ok: false, reason: "unknown" };
  const status = keyStatus(r, now);
  if (status !== "active") return { ok: false, reason: status, keyId: String(r.key_id), workspaceId: String(r.workspace_id) };
  if (!r.last_used_at || now - new Date(r.last_used_at).getTime() > 60_000) {
    await s.db.tx(r.workspace_id, (c) => c.query("update public.public_api_keys set last_used_at = now() where id = $1 and workspace_id = $2", [r.key_id, r.workspace_id])).catch(() => {});
  }
  return { ok: true, keyId: String(r.key_id), workspaceId: String(r.workspace_id), role: r.role };
}

/**
 * A refused sign-in with a key that exists, in its organization's audit log: at most one row a minute per key, with the
 * number held back since the previous one. Never the key, never its hash.
 */
export async function auditFailedAuth(s: Services, r: { keyId: string; workspaceId: string; reason: string }, req: { id: string; ip: string; method: string; path: string }) {
  await throttledAudit(s, `auth_failed:${r.keyId}`, (suppressed, summary) => s.db.tx(r.workspaceId, (c) => writeAudit(c,
    { workspaceId: r.workspaceId, actor: { type: "api_key", id: r.keyId }, requestId: summary ? null : req.id, ip: summary ? null : req.ip },
    {
      action: "api_key.public.auth_failed", targetType: "public_api_key", targetId: r.keyId, outcome: "denied",
      metadata: summary ? { summary: true, reason: r.reason, suppressed } : { reason: r.reason, method: req.method, path: req.path, suppressed },
    })), "a refused API key");
}

/** A change refused to a read-only key: at most one row a minute per key, like auditFailedAuth. */
export async function auditDenied(s: Services, caller: Caller, keyId: string, req: { method: string; route: string }) {
  await throttledAudit(s, `denied:${keyId}`, (suppressed, summary) => s.db.tx(caller.workspaceId, (c) => writeAudit(c,
    summary ? { ...auditWho(caller), requestId: null, ip: null } : auditWho(caller),
    {
      action: "api_key.public.denied", targetType: "public_api_key", targetId: keyId, outcome: "denied",
      metadata: summary ? { summary: true, suppressed } : { method: req.method, route: req.route, suppressed },
    })), "a refused change");
}
