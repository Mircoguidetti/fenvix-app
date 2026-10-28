import { createHash, randomUUID } from "node:crypto";
import { type Caller, type Services } from "../context.ts";
import { type Client, iso, isUniqueViolation } from "../db.ts";
import { type EngineDatabase, EngineError } from "../engine/types.ts";
import { ApiError, type ErrorCode, forbidden, conflict, internal, notFound, validation } from "../errors.ts";
import { auditWho, writeAudit } from "../audit.ts";
import { planFor } from "../limits.ts";
import { type Tag } from "../validate.ts";
import { type Database, readDatabase } from "./databases.ts";

export type OperationKind = "create" | "fork" | "restore" | "export" | "erase";
export type OperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface OperationRow {
  id: string;
  workspace_id: string;
  kind: OperationKind;
  status: OperationStatus;
  database_id: string | null;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: { code: ErrorCode; message: string; field?: string } | null;
  dedupe_key: string | null;
  attempts: number;
  retry_at: Date;
  locked_until: Date | null;
  actor_type: "user" | "api_key" | "system";
  actor_id: string | null;
  request_id: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** What the dashboard polls. */
export interface OperationView {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  databaseId: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  result: unknown;
  error: { code: ErrorCode; message: string; field?: string } | null;
}

const OP_LEASE_SECONDS = 120;
const OP_MAX_ATTEMPTS = 8;
const backoffSeconds = (attempts: number) => Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));

const hashIds = (ids: string[]) => createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 32);

// ---------------------------------------------------------------- reading

const OP_SELECT = "select * from public.operations";

export async function loadOperation(s: Services, workspaceId: string, id: string): Promise<OperationRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return s.db.tx(workspaceId, async (c) => (await c.query(`${OP_SELECT} where workspace_id = $1 and id = $2`, [workspaceId, id])).rows[0] ?? null);
}

export async function listOperations(s: Services, workspaceId: string, page: number, pageSize: number, status?: OperationStatus) {
  return s.db.tx(workspaceId, async (c) => {
    const params: unknown[] = [workspaceId];
    let where = "workspace_id = $1";
    if (status) where += ` and status = $${params.push(status)}`;
    const total = (await c.query(`select count(*)::bigint as n from public.operations where ${where}`, params)).rows[0].n as number;
    const rows = (await c.query(
      `${OP_SELECT} where ${where} order by created_at desc, id desc limit $${params.push(pageSize)} offset $${params.push((page - 1) * pageSize)}`, params,
    )).rows as OperationRow[];
    return { rows, total };
  });
}

export async function viewOperation(s: Services, row: OperationRow): Promise<OperationView> {
  let result: unknown = row.status === "succeeded" ? row.result : null;
  if (row.status === "succeeded" && row.kind === "export" && row.result) {
    // The file stays; the link is made fresh on every read, so it is always valid for the full time.
    const r = row.result as { exportId: string; filename: string; mimeType: string };
    const link = await s.engine.exportDownloadUrl(r.exportId, s.cfg.limits.exportUrlTtlSeconds).catch((e) => {
      s.log.error({ err: e instanceof Error ? e.message : String(e), operationId: row.id }, "could not make an export link");
      throw internal("The export is ready but its download link could not be made. Try again.");
    });
    result = { filename: r.filename, mimeType: r.mimeType, downloadUrl: link.url };
  }
  return {
    id: row.id, kind: row.kind, status: row.status, databaseId: row.database_id,
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, finishedAt: iso(row.finished_at),
    result, error: row.error,
  };
}

/** The error a failed operation answers with. */
export const operationError = (row: OperationRow): ApiError =>
  row.error ? new ApiError(row.error.code, row.error.message, row.error.field) : internal();

// ---------------------------------------------------------------- submitting

interface NewOp {
  kind: OperationKind;
  databaseId: string | null;
  params: Record<string, unknown>;
  dedupeKey: string | null;
  status?: "queued" | "succeeded";
  result?: Record<string, unknown>;
}

async function activeByDedupe(c: Client, ws: string, key: string): Promise<OperationRow | null> {
  const res = await c.query(`${OP_SELECT} where workspace_id = $1 and dedupe_key = $2 and status in ('queued', 'running')`, [ws, key]);
  return res.rows[0] ?? null;
}

async function insertOperation(c: Client, caller: Caller, n: NewOp): Promise<OperationRow> {
  const done = n.status === "succeeded";
  const res = await c.query(
    `insert into public.operations (workspace_id, kind, status, database_id, params, result, dedupe_key, actor_type, actor_id, request_id, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${done ? "now()" : "null"}) returning *`,
    [caller.workspaceId, n.kind, n.status ?? "queued", n.databaseId, JSON.stringify(n.params), n.result ? JSON.stringify(n.result) : null,
     n.dedupeKey, caller.actor.type, caller.actor.id, caller.requestId],
  );
  const row = res.rows[0] as OperationRow;
  await writeAudit(c, auditWho(caller), { action: `database.${n.kind}.requested`, targetType: "database", targetId: n.databaseId ?? undefined, metadata: { operationId: row.id, ...summaryOf(n) } });
  return row;
}

const summaryOf = (n: NewOp) => ({ kind: n.kind, ...(n.kind === "export" || n.kind === "erase" ? { databases: (n.params.ids as string[]).length } : {}) });

/** Runs a submit transaction; if a concurrent identical request won the race, answers with its operation. */
async function submit(s: Services, caller: Caller, dedupeKey: string | null, work: (c: Client) => Promise<OperationRow>): Promise<OperationRow> {
  try {
    return await s.db.tx(caller.workspaceId, async (c) => {
      if (dedupeKey) {
        const existing = await activeByDedupe(c, caller.workspaceId, dedupeKey);
        if (existing) return existing;
      }
      return work(c);
    });
  } catch (e) {
    if (isUniqueViolation(e, "operations_active_dedupe") && dedupeKey) {
      const existing = await s.db.tx(caller.workspaceId, (c) => activeByDedupe(c, caller.workspaceId, dedupeKey));
      if (existing) return existing;
    }
    if (isUniqueViolation(e, "databases_workspace_name") || isUniqueViolation(e, "databases_host_unique")) throw conflict("A database with that name already exists.", "name");
    throw e;
  }
}

async function assertRoomForDatabases(s: Services, c: Client, caller: Caller, adding: number): Promise<void> {
  const settings = await c.query("select plan from public.workspace_settings where workspace_id = $1", [caller.workspaceId]);
  const plan = planFor(s.cfg.catalogue, settings.rows[0]?.plan as string | undefined);
  if (plan.limits.maxDatabases === null) return;
  const n = (await c.query("select count(*)::bigint as n from public.databases where workspace_id = $1", [caller.workspaceId])).rows[0].n as number;
  if (n + adding > plan.limits.maxDatabases) throw forbidden(`Your ${plan.name} plan allows ${plan.limits.maxDatabases} databases.`);
}

async function assertNameFree(c: Client, ws: string, name: string): Promise<void> {
  const taken = await c.query("select 1 from public.databases where workspace_id = $1 and name = $2", [ws, name]);
  if (taken.rowCount) throw conflict(`A database named ${name} already exists.`, "name");
}

export function submitCreate(s: Services, caller: Caller, req: { name: string; region: string; tags: Tag[] }): Promise<OperationRow> {
  return submit(s, caller, `create:${req.name}`, async (c) => {
    await assertNameFree(c, caller.workspaceId, req.name);
    await assertRoomForDatabases(s, c, caller, 1);
    const id = randomUUID();
    await c.query(
      "insert into public.databases (id, workspace_id, name, region, engine_state) values ($1, $2, $3, $4, 'provisioning')",
      [id, caller.workspaceId, req.name, req.region],
    );
    for (const t of req.tags) {
      await c.query("insert into public.database_tags (database_id, workspace_id, key, value) values ($1, $2, $3, $4)", [id, caller.workspaceId, t.key, t.value]);
    }
    return insertOperation(c, caller, { kind: "create", databaseId: id, params: { name: req.name, region: req.region }, dedupeKey: `create:${req.name}` });
  });
}

export function submitFork(s: Services, caller: Caller, sourceId: string, name: string): Promise<OperationRow> {
  return submit(s, caller, `fork:${sourceId}:${name}`, async (c) => {
    const src = (await c.query(
      "select id, region, storage_bytes, engine_state from public.databases where workspace_id = $1 and id = $2 and engine_state <> 'provisioning' for share",
      [caller.workspaceId, sourceId],
    )).rows[0];
    if (!src) throw notFound("That database does not exist.");
    if (src.engine_state !== "ready") throw conflict("This database is busy. Try again when the current operation has finished.");
    await assertNameFree(c, caller.workspaceId, name);
    await assertRoomForDatabases(s, c, caller, 1);
    const id = randomUUID();
    await c.query(
      "insert into public.databases (id, workspace_id, name, region, storage_bytes, forked_from, engine_state) values ($1, $2, $3, $4, $5, $6, 'provisioning')",
      [id, caller.workspaceId, name, src.region, src.storage_bytes, sourceId],
    );
    await c.query(
      "insert into public.database_tags (database_id, workspace_id, key, value) select $1, $2, key, value from public.database_tags where database_id = $3",
      [id, caller.workspaceId, sourceId],
    );
    return insertOperation(c, caller, { kind: "fork", databaseId: id, params: { sourceId, name }, dedupeKey: `fork:${sourceId}:${name}` });
  });
}

export function submitRestore(s: Services, caller: Caller, id: string, at: Date): Promise<OperationRow> {
  const key = `restore:${id}`;
  return submit(s, caller, null, async (c) => {
    const db = (await c.query(
      "select id, created_at, engine_state from public.databases where workspace_id = $1 and id = $2 and engine_state <> 'provisioning' for update",
      [caller.workspaceId, id],
    )).rows[0];
    if (!db) throw notFound("That database does not exist.");

    const running = await activeByDedupe(c, caller.workspaceId, key);
    if (running) {
      if (running.params.at === at.toISOString()) return running;
      throw conflict("A restore is already running for this database.");
    }
    if (db.engine_state !== "ready") throw conflict("This database is busy. Try again when the current operation has finished.");

    const now = Date.now();
    if (at.getTime() > now) throw validation("Choose a time in the past.", "at");
    if (at.getTime() < new Date(db.created_at).getTime()) throw validation("That is before this database was created.", "at");
    const settings = await c.query("select plan from public.workspace_settings where workspace_id = $1", [caller.workspaceId]);
    const plan = planFor(s.cfg.catalogue, settings.rows[0]?.plan as string | undefined);
    if (plan.limits.retentionDays !== null && at.getTime() < now - plan.limits.retentionDays * 86_400_000) {
      throw validation(`Your ${plan.name} plan keeps history for ${plan.limits.retentionDays} days. Choose a later time.`, "at");
    }

    await c.query("update public.databases set engine_state = 'restoring' where id = $1", [id]);
    return insertOperation(c, caller, { kind: "restore", databaseId: id, params: { at: at.toISOString() }, dedupeKey: key });
  });
}

export function submitExport(s: Services, caller: Caller, ids: string[]): Promise<OperationRow> {
  return submit(s, caller, null, async (c) => {
    const found = (await c.query(
      "select id, engine_state from public.databases where workspace_id = $1 and id = any($2::uuid[]) and engine_state <> 'provisioning'",
      [caller.workspaceId, ids],
    )).rows as { id: string; engine_state: string }[];
    if (found.length !== ids.length) throw notFound("One of those databases does not exist.");
    if (found.some((r) => r.engine_state === "erasing")) throw conflict("A database in this selection is being erased.");
    return insertOperation(c, caller, { kind: "export", databaseId: null, params: { ids }, dedupeKey: null });
  });
}

export function submitErase(s: Services, caller: Caller, ids: string[]): Promise<OperationRow> {
  const key = `erase:${hashIds(ids)}`;
  return submit(s, caller, key, async (c) => {
    const found = (await c.query(
      "select id, engine_state from public.databases where workspace_id = $1 and id = any($2::uuid[]) and engine_state <> 'provisioning' for update",
      [caller.workspaceId, ids],
    )).rows as { id: string; engine_state: string }[];
    if (found.some((r) => r.engine_state === "restoring")) throw conflict("A database in this selection is being restored. Try again when that has finished.");
    const claim = found.filter((r) => r.engine_state === "ready").map((r) => r.id);
    if (claim.length) await c.query("update public.databases set engine_state = 'erasing' where id = any($1::uuid[])", [claim]);
    if (claim.length === 0) {
      return insertOperation(c, caller, { kind: "erase", databaseId: null, params: { ids: [] }, dedupeKey: null, status: "succeeded", result: { affected: 0 } });
    }
    return insertOperation(c, caller, { kind: "erase", databaseId: null, params: { ids: claim }, dedupeKey: key });
  });
}

// ---------------------------------------------------------------- running

class Failure extends Error {
  readonly api: ApiError;
  constructor(api: ApiError) { super(api.message); this.api = api; }
}

function fromEngine(e: EngineError, what: string): Failure {
  switch (e.kind) {
    case "invalid": return new Failure(validation(e.message));
    case "conflict": return new Failure(conflict(e.message));
    case "not_found": return new Failure(notFound(`${what} no longer exists in the engine.`));
    default: return new Failure(internal("The database engine did not respond. Try again in a moment."));
  }
}

/** Runs operations, one attempt at a time, safe to call again for the same operation. */
export class OperationRunner {
  private readonly s: Services;
  private readonly inflight = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(s: Services) { this.s = s; }

  /**
   * Runs the operation now (a no-op when another runner already holds it) and waits up to
   * `waitMs` for it to finish. Returns its latest state, which may still be queued or running.
   */
  async runAndWait(row: OperationRow, waitMs: number): Promise<OperationRow> {
    const deadline = Date.now() + waitMs;
    if (row.status !== "succeeded" && row.status !== "failed") {
      const p = this.run(row.workspace_id, row.id).catch((e) => {
        this.s.log.error({ err: e instanceof Error ? e.message : String(e), operationId: row.id }, "operation run crashed");
      });
      this.track(p);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, waitMs); })]);
      clearTimeout(timer);
    }
    for (;;) {
      const latest = (await loadOperation(this.s, row.workspace_id, row.id)) ?? row;
      const waitingForRetry = latest.status === "queued" && new Date(latest.retry_at).getTime() > Date.now();
      if (latest.status === "succeeded" || latest.status === "failed" || waitingForRetry || Date.now() >= deadline) return latest;
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Picks up what is due: queued operations that are waiting out a retry, and ones whose runner died. */
  async sweepOnce(limit = 20): Promise<number> {
    const due = await this.s.db.system(async (c) => (await c.query("select * from public.fenvix_cp_due_operations($1)", [limit])).rows as { id: string; workspace_id: string }[]);
    await Promise.all(due.map((d) => {
      const p = this.run(d.workspace_id, d.id).catch((e) => this.s.log.error({ err: e instanceof Error ? e.message : String(e), operationId: d.id }, "operation run crashed"));
      this.track(p);
      return p;
    }));
    return due.length;
  }

  start(everySeconds: number): void {
    if (everySeconds <= 0 || this.timer) return;
    let busy = false;
    this.timer = setInterval(() => {
      if (busy) return;
      busy = true;
      this.sweepOnce().catch((e) => this.s.log.error({ err: e instanceof Error ? e.message : String(e) }, "operation sweep failed")).finally(() => { busy = false; });
    }, everySeconds * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.inflight]);
  }

  /** One attempt. Never throws for an operation's own failure: that is recorded on the operation. */
  async run(workspaceId: string, id: string): Promise<void> {
    const s = this.s;
    const op = await s.db.tx(workspaceId, async (c) => (await c.query(
      `update public.operations
          set status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => $3), updated_at = now()
        where workspace_id = $1 and id = $2 and retry_at <= now()
          and (status = 'queued' or (status = 'running' and locked_until < now()))
        returning *`,
      [workspaceId, id, OP_LEASE_SECONDS],
    )).rows[0] as OperationRow | undefined);
    if (!op) return; // finished, or another runner holds it

    const log = s.log.child({ operationId: op.id, kind: op.kind, attempt: op.attempts, requestId: op.request_id });
    try {
      const result = await this.execute(op);
      await s.db.tx(workspaceId, async (c) => {
        await c.query("update public.operations set status = 'succeeded', result = $3, error = null, locked_until = null, updated_at = now(), finished_at = now() where workspace_id = $1 and id = $2", [workspaceId, id, JSON.stringify(result)]);
        await writeAudit(c, { workspaceId, actor: { type: op.actor_type, id: op.actor_id }, requestId: op.request_id }, { action: `database.${op.kind}.completed`, targetType: "database", targetId: op.database_id ?? undefined, metadata: { operationId: op.id } });
      });
      log.info("operation succeeded");
    } catch (e) {
      const transient = !(e instanceof Failure) && (!(e instanceof EngineError) || e.kind === "unavailable");
      if (transient && op.attempts < OP_MAX_ATTEMPTS) {
        log.warn({ err: e instanceof Error ? e.message : String(e) }, "operation will be retried");
        await s.db.tx(workspaceId, (c) => c.query(
          "update public.operations set status = 'queued', retry_at = now() + make_interval(secs => $3), locked_until = null, updated_at = now() where workspace_id = $1 and id = $2",
          [workspaceId, id, backoffSeconds(op.attempts)],
        ));
        return;
      }
      const failure = e instanceof Failure ? e : e instanceof EngineError ? fromEngine(e, "The database") : new Failure(internal("The operation could not be completed. Try again."));
      log.error({ err: e instanceof Error ? e.message : String(e), code: failure.api.code }, "operation failed");
      await s.db.tx(workspaceId, async (c) => {
        await this.compensate(c, op);
        const err = { code: failure.api.code, message: failure.api.message, ...(failure.api.field ? { field: failure.api.field } : {}) };
        await c.query("update public.operations set status = 'failed', error = $3, locked_until = null, updated_at = now(), finished_at = now() where workspace_id = $1 and id = $2", [workspaceId, id, JSON.stringify(err)]);
        await writeAudit(c, { workspaceId, actor: { type: op.actor_type, id: op.actor_id }, requestId: op.request_id }, { action: `database.${op.kind}.failed`, outcome: "failed", targetType: "database", targetId: op.database_id ?? undefined, metadata: { operationId: op.id, code: failure.api.code } });
      });
    }
  }

  /** Puts Postgres back the way it was when an operation fails for good. */
  private async compensate(c: Client, op: OperationRow): Promise<void> {
    const ws = op.workspace_id;
    if ((op.kind === "create" || op.kind === "fork") && op.database_id) {
      await c.query("delete from public.databases where workspace_id = $1 and id = $2 and engine_state = 'provisioning'", [ws, op.database_id]);
    } else if (op.kind === "restore" && op.database_id) {
      await c.query("update public.databases set engine_state = 'ready' where workspace_id = $1 and id = $2 and engine_state = 'restoring'", [ws, op.database_id]);
    } else if (op.kind === "erase") {
      await c.query("update public.databases set engine_state = 'ready' where workspace_id = $1 and id = any($2::uuid[]) and engine_state = 'erasing'", [ws, op.params.ids as string[]]);
    }
  }

  private async execute(op: OperationRow): Promise<Record<string, unknown>> {
    const s = this.s;
    const ws = op.workspace_id;
    const wrap = async <T>(fn: () => Promise<T>, what: string): Promise<T> => {
      try { return await fn(); } catch (e) { if (e instanceof EngineError && e.kind !== "unavailable") throw fromEngine(e, what); throw e; }
    };
    const finishProvisioning = async (eng: EngineDatabase): Promise<Database> => s.db.tx(ws, async (c) => {
      await c.query(
        `update public.databases set engine_state = 'ready', state = $3::public.database_state, storage_bytes = $4
         where workspace_id = $1 and id = $2 and engine_state = 'provisioning'`,
        [ws, op.database_id, eng.state, eng.storageBytes],
      );
      const db = await readDatabase(s, c, ws, op.database_id!);
      if (!db) throw new Failure(internal("The database disappeared while it was being created."));
      return db;
    });

    switch (op.kind) {
      case "create": {
        const p = op.params as { name: string; region: string };
        const eng = await wrap(() => s.engine.createDatabase({ id: op.database_id!, workspaceId: ws, name: p.name, region: p.region, idempotencyKey: op.id }), "The database");
        return { ...(await finishProvisioning(eng)) };
      }
      case "fork": {
        const p = op.params as { sourceId: string; name: string };
        const eng = await wrap(() => s.engine.forkDatabase({ sourceId: p.sourceId, id: op.database_id!, workspaceId: ws, name: p.name, idempotencyKey: op.id }), "The source database");
        return { ...(await finishProvisioning(eng)) };
      }
      case "restore": {
        const at = (op.params as { at: string }).at;
        await wrap(() => s.engine.restoreDatabase({ id: op.database_id!, at, idempotencyKey: op.id }), "The database");
        return { ...(await s.db.tx(ws, async (c) => {
          await c.query("update public.databases set restored_to = $3, last_active_at = now(), engine_state = 'ready' where workspace_id = $1 and id = $2 and engine_state = 'restoring'", [ws, op.database_id, at]);
          const db = await readDatabase(s, c, ws, op.database_id!);
          if (!db) throw new Failure(internal("The database disappeared while it was being restored."));
          return db;
        })) };
      }
      case "export": {
        const ids = (op.params as { ids: string[] }).ids;
        const e = await wrap(() => s.engine.exportDatabases({ ids, idempotencyKey: op.id }), "A database");
        return { exportId: e.exportId, filename: e.filename, mimeType: e.mimeType, sizeBytes: e.sizeBytes };
      }
      case "erase": {
        const ids = (op.params as { ids: string[] }).ids;
        for (const id of ids) {
          await wrap(() => s.engine.eraseDatabase({ id, idempotencyKey: `${op.id}:${id}` }), "The database");
          await s.db.tx(ws, async (c) => {
            await c.query("delete from public.databases where workspace_id = $1 and id = $2 and engine_state = 'erasing'", [ws, id]);
            // keep the lease alive while a long list is worked through
            await c.query("update public.operations set locked_until = now() + make_interval(secs => $2), updated_at = now() where id = $1", [op.id, OP_LEASE_SECONDS]);
          });
        }
        return { affected: ids.length };
      }
    }
  }
}
