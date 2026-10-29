import { AdminHttp, type AdminResponse } from "./admin-http.ts";
import { engineName, idFromEngineName, isEngineName } from "./names.ts";
import { zipStream, type ZipEntry } from "./zip.ts";
import { signDownload } from "../downloads.ts";
import type { EngineSettings } from "../config.ts";
import { type EngineAllowlist, type EngineBlock, type EngineClient, type EngineDatabase, EngineError, type EngineErrorKind, type EngineExport, type EngineUsage } from "./types.ts";
import { canonicalAddress } from "./netlist.ts";

/**
 * The real `EngineClient`: it speaks the admin interface of the engine's `control-ops` (`/v1/...` JSON over HTTP, bearer
 * token). `docs/engine-adapter.md` maps every method to the engine's route and lists what the engine does not give.
 *
 * What the adapter cannot do for the interface, and how it behaves instead:
 *  - the engine has no idempotency keys. Create, fork, erase, keep-awake are naturally repeatable (409 `exists` is
 *    followed by a check that the database is the one asked for; erasing the gone is `{ erased: false }`). A restore is
 *    repeated as a restore (it applies the difference to the point again); export snapshots are remembered per key in
 *    this process only.
 *  - the engine addresses databases by name, the control plane by id: the name is derived from the id (names.ts).
 */
export interface RealEngineOptions {
  settings: EngineSettings;
  /** Signs the download link of an export, which this service streams itself. */
  downloadSigningKey: string;
  /** `API_PUBLIC_URL`, including /v1. */
  apiPublicUrl: string;
  now?: () => Date;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

interface Ctx { id: string; region: string; workspaceId?: string; name?: string }

/** Engine 409 codes that mean "try again shortly": another operation or another process is busy with the database. */
const TRANSIENT_CONFLICTS = new Set(["busy", "owned_elsewhere", "operation_in_progress", "transactions_open"]);
/** Engine 409 codes that mean there is no history to go back to. */
const NO_HISTORY = new Set(["retention_off", "no_restore_points"]);
const LOST_HISTORY = new Set(["retention_gap", "point_expired", "point_missing"]);

const MAX_RESUMES = 5;
const MAX_REMEMBERED = 1000;

export class RealEngine implements EngineClient {
  private readonly http: AdminHttp;
  private readonly cfg: EngineSettings;
  private readonly key: string;
  private readonly apiUrl: string;
  private readonly now: () => Date;
  private readonly regionOf = new Map<string, string>();
  private readonly exportsByKey = new Map<string, EngineExport>();

  constructor(o: RealEngineOptions) {
    this.cfg = o.settings;
    this.http = new AdminHttp(o.settings);
    this.key = o.downloadSigningKey;
    this.apiUrl = o.apiPublicUrl.replace(/\/+$/, "");
    this.now = o.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ plumbing

  private remember(id: string, region: string): void {
    if (this.regionOf.size >= 10_000) this.regionOf.delete(this.regionOf.keys().next().value!);
    this.regionOf.set(id, region);
  }

  /**
   * The region whose engine holds a database. With one region it is that one. With several, a database is looked up
   * where it was created, else by asking each engine; null when every engine said it does not exist.
   */
  private async region(id: string): Promise<string | null> {
    const all = this.http.regions();
    if (all.length === 1) return all[0]!;
    const known = this.regionOf.get(id);
    if (known) return known;
    let failure: EngineError | null = null;
    for (const r of all) {
      try {
        const res = await this.http.call(r, "GET", `/v1/databases/${engineName(id)}?storage=false`);
        if (res.status === 200) { this.remember(id, r); return r; }
        if (res.status !== 404) throw this.failure(res, "lookup");
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        if (e.kind !== "unavailable") throw e;
        failure ??= e;
      }
    }
    if (failure) throw failure; // some engine could not answer: not the same as "nowhere"
    return null;
  }

  private async located(id: string): Promise<string> {
    const r = await this.region(id);
    if (!r) throw new EngineError("not_found", `database ${id} does not exist in the engine`);
    return r;
  }

  /** The engine's refusal as an `EngineError` with a message a person can read. */
  private failure(res: AdminResponse, what: string): EngineError {
    const err = isObj(res.json) && isObj(res.json.error) ? res.json.error : {};
    const code = typeof err.code === "string" ? err.code : "";
    const engineMessage = typeof err.message === "string" ? err.message : "";
    const s = res.status;
    const e = (kind: EngineErrorKind, message: string) => Object.assign(new EngineError(kind, message), { engineStatus: s, engineCode: code, detail: engineMessage });
    if (s === 401 || s === 403) return e("unavailable", "The database engine refused the control plane's credentials.");
    if (s === 404 || s === 410) return e("not_found", "The database does not exist in the engine.");
    if (s === 409) {
      if (code === "exists") return e("conflict", "A database with that id already exists in the engine.");
      if (code === "has_forks") return e("conflict", "Other databases are forks of this one and still read its data. Erase them first.");
      if (code === "source_is_shallow_fork") return e("conflict", "This database is a fork whose source still holds its data, so it cannot be copied on its own yet.");
      if (NO_HISTORY.has(code)) return e("invalid", "There is no backup to restore from yet.");
      if (LOST_HISTORY.has(code)) return e("invalid", "The backups needed for that time are no longer available. Choose a later time.");
      if (TRANSIENT_CONFLICTS.has(code)) return e("unavailable", `The database engine is busy with this database (${code}).`);
      return e("conflict", "The database engine could not do this right now.");
    }
    if (s === 400 && what === "allowlist") {
      // The control plane checks every entry with the engine's own rules first (netlist.ts): a refusal here means the two
      // disagree. Said plainly; the engine's sentence is kept in `detail` for the log.
      return e("invalid", "The database engine refused the list.");
    }
    if (s === 400) {
      // Only a restore time out of range is the customer's to fix (restoreDatabase words it); everything else is a bug of
      // ours and is not shown as advice. The engine's own sentence is never passed on: it is kept in `detail` only.
      if (what === "restore") return e("invalid", /future/i.test(engineMessage) ? "Choose a time in the past." : "That time is before the earliest restorable point of this database. Choose a later time.");
      return e("invalid", "The database engine refused the request.");
    }
    if (s === 413 || s === 416) return e("invalid", "The database engine refused the request.");
    return e("unavailable", `The database engine failed (${s || "no status"}).`);
  }

  private ok(res: AdminResponse, what: string, accept: number[] = [200]): Obj {
    if (!accept.includes(res.status)) throw this.failure(res, what);
    if (!isObj(res.json)) throw new EngineError("unavailable", "The database engine sent an answer that was not understood.");
    return res.json;
  }

  private describe(j: Obj, c: Ctx): EngineDatabase {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const fork = isObj(j.forked_from) ? j.forked_from.database : j.forked_from;
    return {
      id: c.id,
      // The engine records neither: they are only known to the caller of create and fork.
      workspaceId: c.workspaceId ?? "",
      name: c.name ?? "",
      region: c.region,
      state: j.state === "awake" ? "awake" : "asleep",
      storageBytes: num(j.storage_bytes),
      lastActiveAt: typeof j.last_active_at === "string" ? j.last_active_at : typeof j.created_at === "string" ? j.created_at : new Date(0).toISOString(),
      keepAwake: j.keep_awake === true,
      forkedFrom: typeof fork === "string" ? idFromEngineName(fork) : null,
      restoredTo: null,
      earliestRestorePoint: null,
    };
  }

  /**
   * The database a 409 `exists` is about. The engine also answers `exists` while an earlier create or fork of that
   * name is still being finished or rolled back after a crash; then there is no database to read yet: try again later.
   */
  private async existing(region: string, key: string): Promise<AdminResponse> {
    const res = await this.http.call(region, "GET", `/v1/databases/${key}`);
    if (res.status === 404) throw new EngineError("unavailable", "The database engine is still finishing an earlier operation on this database.");
    return res;
  }

  /** New and forked databases get the configured restore-point window, so a restore has something to go back to. */
  private async applyRetention(region: string, key: string): Promise<void> {
    const w = this.cfg.retentionWindowSecs;
    if (w === null) return;
    const body: Obj = { window_secs: w };
    if (this.cfg.retentionIntervalSecs !== null) body.interval_secs = this.cfg.retentionIntervalSecs;
    this.ok(await this.http.call(region, "PUT", `/v1/databases/${key}/retention`, body), "retention");
  }

  // ------------------------------------------------------------------ EngineClient

  async createDatabase(req: { id: string; workspaceId: string; name: string; region: string; idempotencyKey: string }): Promise<EngineDatabase> {
    if (!this.http.hasRegion(req.region)) throw new EngineError("invalid", `There is no engine for region ${req.region}.`);
    const key = engineName(req.id);
    const ctx: Ctx = { id: req.id, region: req.region, workspaceId: req.workspaceId, name: req.name };
    let res = await this.http.call(req.region, "POST", "/v1/databases", { name: key });
    // A retry after a lost answer: the database is already there. It is ours, because its name is made from our id.
    if (res.status === 409 && errorCode(res) === "exists") res = await this.existing(req.region, key);
    const j = this.ok(res, "create", [200, 201]);
    this.remember(req.id, req.region);
    await this.applyRetention(req.region, key);
    return this.describe(j, ctx);
  }

  async getDatabase(id: string): Promise<EngineDatabase | null> {
    const region = await this.region(id);
    if (!region) return null;
    const res = await this.http.call(region, "GET", `/v1/databases/${engineName(id)}`);
    if (res.status === 404) return null;
    return this.describe(this.ok(res, "get"), { id, region });
  }

  async listDatabases(_workspaceId: string): Promise<EngineDatabase[]> {
    // The engine does not record which workspace a database belongs to, and its only listing returns every
    // customer's databases (a route this service is not allowed to call). Not called by the service today.
    throw new EngineError("invalid", "The engine cannot list the databases of one workspace.");
  }

  async forkDatabase(req: { sourceId: string; id: string; workspaceId: string; name: string; idempotencyKey: string }): Promise<EngineDatabase> {
    const region = await this.located(req.sourceId);
    const src = engineName(req.sourceId);
    const key = engineName(req.id);
    const ctx: Ctx = { id: req.id, region, workspaceId: req.workspaceId, name: req.name };
    let res = await this.http.call(region, "POST", `/v1/databases/${src}/fork`, { target: key, mode: this.cfg.forkMode });
    if (res.status === 404) throw new EngineError("not_found", "The source database no longer exists in the engine.");
    if (res.status === 409 && errorCode(res) === "exists") {
      // A retry after a lost answer, or a clash. Accept only a database that really is this fork of this source.
      const have = this.ok(await this.existing(region, key), "fork");
      const from = isObj(have.forked_from) ? have.forked_from.database : have.forked_from;
      if (from !== src) throw new EngineError("conflict", "A database with that id already exists in the engine and is not a fork of this one.");
      res = { status: 200, json: have };
    }
    const j = this.ok(res, "fork", [200, 201]);
    this.remember(req.id, region);
    await this.applyRetention(region, key);
    return this.describe(j, ctx);
  }

  async restoreDatabase(req: { id: string; at: string; idempotencyKey: string }): Promise<EngineDatabase> {
    const region = await this.located(req.id);
    const key = engineName(req.id);
    const res = await this.http.call(region, "POST", `/v1/databases/${key}/restore`, { to: req.at });
    // 500 `restore_retried`: the first run failed and the engine's own retry finished it. The data is at the point.
    const finished = res.status === 500 && errorCode(res) === "restore_retried";
    if (res.status === 400) {
      // Too early: say from when it can be restored, read from the engine's restore points (a time, not the engine's words).
      const err = this.failure(res, "restore");
      const earliest = /earliest/.test(err.message) ? await this.earliestPoint(region, key) : null;
      if (earliest) throw Object.assign(new EngineError("invalid", `That time is before the earliest restorable point of this database (${new Date(earliest).toISOString()}). Choose a later time.`), { engineStatus: 400, engineCode: errorCode(res) });
      throw err;
    }
    const done = finished ? { restored_to: req.at } : this.ok(res, "restore");
    const db = this.describe(this.ok(await this.http.call(region, "GET", `/v1/databases/${key}`), "get"), { id: req.id, region });
    db.restoredTo = typeof done.restored_to === "string" ? done.restored_to : req.at;
    db.earliestRestorePoint = await this.earliestPoint(region, key);
    return db;
  }

  private async earliestPoint(region: string, key: string): Promise<string | null> {
    try {
      const res = await this.http.call(region, "GET", `/v1/databases/${key}/restore-points`);
      return res.status === 200 && isObj(res.json) && typeof res.json.earliest_restorable === "string" ? res.json.earliest_restorable : null;
    } catch { return null; } // informational only: a restore that worked is not undone by this
  }

  /**
   * One snapshot per database (the engine exports one database at a time), named together in one id. The engine
   * has no idempotency key, so a retry in this process gets the first answer; after a restart it makes new snapshots
   * and the old ones expire by themselves.
   */
  async exportDatabases(req: { ids: string[]; idempotencyKey: string }): Promise<EngineExport> {
    const again = this.exportsByKey.get(req.idempotencyKey);
    if (again) return structuredClone(again);
    const ids: string[] = [];
    for (const id of req.ids) {
      const region = await this.located(id);
      const j = this.ok(await this.http.call(region, "POST", `/v1/databases/${engineName(id)}/exports`), "export", [200, 201]);
      if (typeof j.id !== "string") throw new EngineError("unavailable", "The database engine sent an answer that was not understood.");
      ids.push(j.id);
    }
    const out: EngineExport = {
      exportId: ids.join(","),
      filename: `fenvix-export-${ids.length}-${ids.length === 1 ? "database" : "databases"}.zip`,
      mimeType: "application/zip",
      // The size of a dump is only known once it has been read (the engine records it at the end of the first pass).
      sizeBytes: 0,
    };
    if (this.exportsByKey.size >= MAX_REMEMBERED) this.exportsByKey.delete(this.exportsByKey.keys().next().value!);
    this.exportsByKey.set(req.idempotencyKey, out);
    return structuredClone(out);
  }

  private parts(exportId: string): { exportId: string; key: string; id: string }[] {
    const parts = exportId.split(",").map((p) => {
      const key = p.split(".")[0] ?? "";
      const id = idFromEngineName(key);
      if (!isEngineName(key) || !id) throw new EngineError("not_found", "That export does not exist.");
      return { exportId: p, key, id };
    });
    if (parts.length === 0 || parts.length > 1000) throw new EngineError("not_found", "That export does not exist.");
    return parts;
  }

  async exportDownloadUrl(exportId: string, ttlSeconds: number): Promise<{ url: string; expiresAt: string }> {
    const parts = this.parts(exportId);
    // The engine keeps a snapshot for its own time; if the first one is gone, so is the export.
    const first = parts[0]!;
    this.ok(await this.http.call(await this.located(first.id), "GET", `/v1/exports/${first.exportId}`), "export");
    const exp = Math.floor(this.now().getTime() / 1000) + ttlSeconds;
    const token = signDownload(this.key, { ws: "", kind: "engine-export", p: { exportId }, exp });
    return { url: `${this.apiUrl}/downloads/${token}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** The zip of an export: for each database a folder named after its engine name, holding its mongodump files. */
  async openExportArchive(exportId: string): Promise<{ filename: string; mimeType: string; body: AsyncIterable<Uint8Array> }> {
    const parts = this.parts(exportId);
    // Look everything up before the first byte, so a missing or expired export is an error status and not a broken file.
    const plan: { region: string; files: string[] }[] = [];
    for (const p of parts) {
      const region = await this.located(p.id);
      const rec = this.ok(await this.http.call(region, "GET", `/v1/exports/${p.exportId}`), "export");
      const files = Array.isArray(rec.files) ? rec.files.flatMap((f) => (isObj(f) && typeof f.path === "string" ? [f.path] : [])) : [];
      plan.push({ region, files: files.map((f) => `/v1/exports/${p.exportId}/files/${f.split("/").map(encodeURIComponent).join("/")}`) });
    }
    const self = this;
    async function* entries(): AsyncGenerator<ZipEntry> {
      for (const [i, p] of plan.entries()) {
        for (const path of p.files) {
          const name = decodeURIComponent(path.slice(`/v1/exports/${parts[i]!.exportId}/files/`.length));
          yield { name, data: self.fileBytes(p.region, path) };
        }
      }
    }
    return { filename: `fenvix-export-${parts.length}-${parts.length === 1 ? "database" : "databases"}.zip`, mimeType: "application/zip", body: zipStream(entries()) };
  }

  /** One file of a dump. A broken transfer is continued from the byte it reached (`Range: bytes=N-`), as the engine supports. */
  private async *fileBytes(region: string, path: string): AsyncGenerator<Uint8Array> {
    let got = 0;
    for (let attempt = 0; ; attempt++) {
      let body: AsyncIterable<Uint8Array> | undefined;
      try {
        const res = await this.http.download(region, path, got);
        if (res.status !== (got > 0 ? 206 : 200)) {
          res.body.resume();
          if (res.status === 200 && got > 0) throw new EngineError("unavailable", "The database engine did not continue the download where it stopped.");
          throw this.failure({ status: res.status, json: null }, "export");
        }
        body = res.body;
        for await (const chunk of body) { got += chunk.length; yield chunk; }
        return;
      } catch (e) {
        const retryable = !(e instanceof EngineError) || e.kind === "unavailable";
        if (!retryable || attempt >= MAX_RESUMES) throw e instanceof EngineError ? e : new EngineError("unavailable", "The download from the engine broke off.");
      }
    }
  }

  async eraseDatabase(req: { id: string; idempotencyKey: string }): Promise<{ erased: boolean }> {
    const region = await this.region(req.id);
    if (!region) return { erased: false };
    const res = await this.http.call(region, "DELETE", `/v1/databases/${engineName(req.id)}`);
    this.regionOf.delete(req.id);
    if (res.status === 404) return { erased: false };
    // 500 `erase_incomplete`: objects were left behind; the engine finishes it when asked again, so this is retried.
    this.ok(res, "erase");
    return { erased: true };
  }

  async setKeepAwake(req: { id: string; enabled: boolean }): Promise<EngineDatabase> {
    const region = await this.located(req.id);
    const res = await this.http.call(region, req.enabled ? "PUT" : "DELETE", `/v1/databases/${engineName(req.id)}/keep-awake`);
    return this.describe(this.ok(res, "keep awake"), { id: req.id, region });
  }

  /**
   * The engine counts per UTC day, not per hour: each day becomes one bucket at 00:00 UTC of that day, holding the
   * Mongo commands of the whole day. Hourly charts built from it are therefore not real hourly data.
   */
  async usage(req: { id: string; from: string; to: string }): Promise<EngineUsage> {
    const region = await this.located(req.id);
    const key = engineName(req.id);
    const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
    const from = Date.parse(req.from);
    const to = Date.parse(req.to);
    const db = this.describe(this.ok(await this.http.call(region, "GET", `/v1/databases/${key}`), "usage"), { id: req.id, region });
    const u = this.ok(await this.http.call(region, "GET", `/v1/databases/${key}/usage?from=${day(req.from)}&to=${day(req.to)}&storage=false`), "usage");
    const buckets: EngineUsage["buckets"] = [];
    const wakeUps: EngineUsage["wakeUps"] = [];
    for (const d of Array.isArray(u.days) ? u.days : []) {
      if (!isObj(d) || typeof d.day !== "string") continue;
      const hour = new Date(`${d.day}T00:00:00.000Z`);
      const commands = isObj(d.requests) && typeof d.requests.commands === "number" ? d.requests.commands : 0;
      const sampled = isObj(d.storage_bytes_sampled) && typeof d.storage_bytes_sampled.bytes === "number" ? d.storage_bytes_sampled.bytes : db.storageBytes;
      if (hour.getTime() >= from && hour.getTime() < to) buckets.push({ hour: hour.toISOString(), requests: commands, storageBytes: sampled });
      const events = isObj(d.wakes) && Array.isArray(d.wakes.events) ? d.wakes.events : [];
      for (const w of events) {
        if (!isObj(w) || typeof w.at !== "string") continue;
        const at = Date.parse(w.at);
        if (at >= from && at < to) wakeUps.push({ at: new Date(at).toISOString(), firstRequestMs: typeof w.first_request_latency_ms === "number" ? w.first_request_latency_ms : 0 });
      }
    }
    buckets.sort((a, b) => a.hour.localeCompare(b.hour));
    wakeUps.sort((a, b) => a.at.localeCompare(b.at));
    return { state: db.state, storageBytes: db.storageBytes, lastActiveAt: db.lastActiveAt, buckets, wakeUps };
  }

  // ------------------------------------------------------------------ IP allowlist and network limits (docs/network-allowlist.md)

  private allowlist(j: Obj): EngineAllowlist {
    if (!Array.isArray(j.entries) || !j.entries.every((x) => typeof x === "string")) throw new EngineError("unavailable", "The database engine sent an answer that was not understood.");
    return { entries: j.entries as string[], enforced: j.enforced !== false };
  }

  async getIpAllowlist(id: string): Promise<EngineAllowlist> {
    const region = await this.located(id);
    return this.allowlist(this.ok(await this.http.call(region, "GET", `/v1/databases/${engineName(id)}/ip-allowlist`), "allowlist"));
  }

  /** PUT replaces the list; an empty list is a DELETE, so the database's record carries no list at all (as before one was set). */
  async setIpAllowlist(req: { id: string; entries: string[] }): Promise<EngineAllowlist> {
    const region = await this.located(req.id);
    const path = `/v1/databases/${engineName(req.id)}/ip-allowlist`;
    const res = req.entries.length
      ? await this.http.call(region, "PUT", path, { entries: req.entries })
      : await this.http.call(region, "DELETE", path);
    return this.allowlist(this.ok(res, "allowlist"));
  }

  private async network(region: string): Promise<Obj> {
    return this.ok(await this.http.call(region, "GET", "/v1/network"), "network");
  }

  /**
   * The engine's state lists every address it tracks, for every database. Only the blocks of this database are kept,
   * and of each only the address and its end: no other database, no counters, no connections.
   */
  async networkBlocks(id: string): Promise<EngineBlock[]> {
    const region = await this.located(id);
    const key = engineName(id);
    const j = await this.network(region);
    const out: EngineBlock[] = [];
    for (const b of Array.isArray(j.blocked) ? j.blocked : []) {
      if (!isObj(b) || b.database !== key || typeof b.ip !== "string" || typeof b.until !== "string") continue;
      out.push({ ip: b.ip, until: b.until, remainingSecs: typeof b.remaining_secs === "number" ? b.remaining_secs : 0 });
    }
    return out;
  }

  async unblockAddress(req: { id: string; ip: string }): Promise<{ unblocked: boolean }> {
    const region = await this.located(req.id);
    // An IPv6 block is shown as its /64; the engine takes any address inside it.
    const ip = canonicalAddress(req.ip.replace(/\/64$/, ""));
    if (!ip) throw new EngineError("invalid", "That is not an address.");
    // `?database=`: only the block of this address on THIS database goes; its blocks on other databases and an
    // address-wide block stay (engine-round2). Without the parameter the engine would lift them all.
    const key = engineName(req.id);
    const j = this.ok(await this.http.call(region, "DELETE", `/v1/network/blocks/${ip}?database=${key}`), "network");
    // An engine older than engine-round2 ignores the parameter and lifts every block of the address: its answer has no
    // `database`. Said, never taken for a per-database unblock.
    if (j.database !== key) throw new EngineError("unavailable", "The database engine does not support unblocking an address on one database: update the engine.");
    return { unblocked: j.unblocked === true };
  }

  async trustedNetworks(region: string): Promise<string[]> {
    const j = await this.network(region);
    const t = isObj(j.config) ? j.config.trusted_networks : undefined;
    if (!Array.isArray(t) || !t.every((x) => typeof x === "string")) throw new EngineError("unavailable", "The database engine sent an answer that was not understood.");
    return t as string[];
  }
}

function errorCode(res: AdminResponse): string {
  return isObj(res.json) && isObj(res.json.error) && typeof res.json.error.code === "string" ? res.json.error.code : "";
}
