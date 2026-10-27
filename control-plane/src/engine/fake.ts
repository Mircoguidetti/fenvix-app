import { randomUUID } from "node:crypto";
import { type EngineClient, type EngineDatabase, EngineError, type EngineExport, type EngineUsage } from "./types.ts";

export type FakeOp = "create" | "get" | "list" | "fork" | "restore" | "export" | "exportUrl" | "erase" | "keepAwake" | "usage";

interface Stored { db: EngineDatabase; docs: number; requests: Map<string, number> }

/**
 * In-memory engine for tests and local runs. Honours idempotency keys the way the real engine
 * must, counts the work it really did (`effects`), and can be told to fail or stall.
 */
export class FakeEngine implements EngineClient {
  readonly dbs = new Map<string, Stored>();
  /** Calls received, by operation, including repeats. */
  readonly calls: Record<FakeOp, number> = { create: 0, get: 0, list: 0, fork: 0, restore: 0, export: 0, exportUrl: 0, erase: 0, keepAwake: 0, usage: 0 };
  /** Work actually done, by operation: a repeated idempotency key adds nothing here. */
  readonly effects: Record<FakeOp, number> = { create: 0, get: 0, list: 0, fork: 0, restore: 0, export: 0, exportUrl: 0, erase: 0, keepAwake: 0, usage: 0 };
  readonly exports = new Map<string, EngineExport & { ids: string[] }>();
  private readonly seen = new Map<string, unknown>();
  private readonly failures: { op: FakeOp; kind: ConstructorParameters<typeof EngineError>[0]; times: number }[] = [];
  private delays = new Map<FakeOp, number>();
  /** Set to make restores before this point fail as out of range. */
  earliestRestorePoint: string | null = null;
  now: () => Date = () => new Date();

  /** Next `times` calls of `op` fail with this kind. */
  failNext(op: FakeOp, kind: ConstructorParameters<typeof EngineError>[0] = "unavailable", times = 1): void {
    this.failures.push({ op, kind, times });
  }

  /** Every call of `op` waits this long first. */
  delay(op: FakeOp, ms: number): void {
    if (ms <= 0) this.delays.delete(op);
    else this.delays.set(op, ms);
  }

  setUsage(id: string, requestsByHour: Record<string, number>): void {
    const s = this.dbs.get(id);
    if (s) for (const [h, n] of Object.entries(requestsByHour)) s.requests.set(h, n);
  }

  private async enter(op: FakeOp): Promise<void> {
    this.calls[op]++;
    const d = this.delays.get(op);
    if (d) await new Promise((r) => setTimeout(r, d));
    const f = this.failures.find((x) => x.op === op && x.times > 0);
    if (f) {
      f.times--;
      throw new EngineError(f.kind, `fake engine: ${op} failed (${f.kind})`);
    }
  }

  /** Runs `work` once per idempotency key; repeats get the first result back. */
  private once<T>(op: FakeOp, key: string, work: () => T): T {
    const k = `${op}:${key}`;
    if (this.seen.has(k)) return structuredClone(this.seen.get(k) as T);
    const r = work();
    this.seen.set(k, r);
    this.effects[op]++;
    return structuredClone(r);
  }

  private find(id: string): Stored {
    const s = this.dbs.get(id);
    if (!s) throw new EngineError("not_found", `fake engine: no database ${id}`);
    return s;
  }

  async createDatabase(req: { id: string; workspaceId: string; name: string; region: string; idempotencyKey: string }): Promise<EngineDatabase> {
    await this.enter("create");
    return this.once("create", req.idempotencyKey, () => {
      const existing = this.dbs.get(req.id);
      if (existing) return structuredClone(existing.db);
      const at = this.now().toISOString();
      const db: EngineDatabase = {
        id: req.id, workspaceId: req.workspaceId, name: req.name, region: req.region, state: "asleep", storageBytes: 0,
        lastActiveAt: at, keepAwake: false, forkedFrom: null, restoredTo: null, earliestRestorePoint: this.earliestRestorePoint,
      };
      this.dbs.set(req.id, { db, docs: 0, requests: new Map() });
      return structuredClone(db);
    });
  }

  async getDatabase(id: string): Promise<EngineDatabase | null> {
    await this.enter("get");
    const s = this.dbs.get(id);
    return s ? structuredClone(s.db) : null;
  }

  async listDatabases(workspaceId: string): Promise<EngineDatabase[]> {
    await this.enter("list");
    return [...this.dbs.values()].filter((s) => s.db.workspaceId === workspaceId).map((s) => structuredClone(s.db));
  }

  async forkDatabase(req: { sourceId: string; id: string; workspaceId: string; name: string; idempotencyKey: string }): Promise<EngineDatabase> {
    await this.enter("fork");
    return this.once("fork", req.idempotencyKey, () => {
      const existing = this.dbs.get(req.id);
      if (existing) return structuredClone(existing.db);
      const src = this.find(req.sourceId);
      const db: EngineDatabase = {
        ...structuredClone(src.db), id: req.id, workspaceId: req.workspaceId, name: req.name, state: "asleep", keepAwake: false,
        forkedFrom: src.db.id, restoredTo: null, lastActiveAt: this.now().toISOString(),
      };
      this.dbs.set(req.id, { db, docs: src.docs, requests: new Map() });
      return structuredClone(db);
    });
  }

  async restoreDatabase(req: { id: string; at: string; idempotencyKey: string }): Promise<EngineDatabase> {
    await this.enter("restore");
    return this.once("restore", req.idempotencyKey, () => {
      const s = this.find(req.id);
      if (s.db.earliestRestorePoint && req.at < s.db.earliestRestorePoint) throw new EngineError("invalid", "That is earlier than the oldest backup.");
      s.db.restoredTo = req.at;
      s.db.lastActiveAt = this.now().toISOString();
      return structuredClone(s.db);
    });
  }

  async exportDatabases(req: { ids: string[]; idempotencyKey: string }): Promise<EngineExport> {
    await this.enter("export");
    return this.once("export", req.idempotencyKey, () => {
      for (const id of req.ids) this.find(id);
      const exportId = `exp_${randomUUID()}`;
      const e = { exportId, filename: `fenvix-export-${req.ids.length}-databases.archive`, mimeType: "application/zip", sizeBytes: 1024 * req.ids.length };
      this.exports.set(exportId, { ...e, ids: [...req.ids] });
      return e;
    });
  }

  async exportDownloadUrl(exportId: string, ttlSeconds: number): Promise<{ url: string; expiresAt: string }> {
    await this.enter("exportUrl");
    this.effects.exportUrl++;
    if (!this.exports.has(exportId)) throw new EngineError("not_found", "fake engine: unknown export");
    return { url: `https://exports.fake.invalid/${exportId}?ttl=${ttlSeconds}`, expiresAt: new Date(this.now().getTime() + ttlSeconds * 1000).toISOString() };
  }

  async eraseDatabase(req: { id: string; idempotencyKey: string }): Promise<{ erased: boolean }> {
    await this.enter("erase");
    return this.once("erase", req.idempotencyKey, () => ({ erased: this.dbs.delete(req.id) }));
  }

  async setKeepAwake(req: { id: string; enabled: boolean }): Promise<EngineDatabase> {
    await this.enter("keepAwake");
    const s = this.find(req.id);
    if (s.db.keepAwake !== req.enabled) this.effects.keepAwake++;
    s.db.keepAwake = req.enabled;
    if (req.enabled) s.db.state = "awake";
    return structuredClone(s.db);
  }

  async usage(req: { id: string; from: string; to: string }): Promise<EngineUsage> {
    await this.enter("usage");
    const s = this.find(req.id);
    const buckets = [...s.requests.entries()]
      .filter(([h]) => h >= req.from && h < req.to)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, requests]) => ({ hour, requests, storageBytes: s.db.storageBytes }));
    return { state: s.db.state, storageBytes: s.db.storageBytes, lastActiveAt: s.db.lastActiveAt, buckets, wakeUps: [] };
  }
}
