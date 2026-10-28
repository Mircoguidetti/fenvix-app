import { BSON } from "bson";
import { type Document, MongoClient, type MongoClientOptions, MongoServerError } from "mongodb";
import type { DataSettings } from "../config.ts";
import { type CallOptions, type CollectionInfo, type DataClient, DataError, type DataTarget, type FindOptions, targetDbName } from "./data.ts";
import { READ_OPTIONS } from "./data-fake.ts";

/** Extra time the client waits after the engine's own maxTimeMS before giving up on a command. */
const CLIENT_GRACE_MS = 2000;

/**
 * The Data Explorer's connection to the engine's MongoDB listener, through the official driver.
 *
 * One client per region, created on first use and closed again after `clientIdleCloseMs` without a request, so an idle
 * control plane holds no connection (not even the driver's monitoring) to the engine. Inside a client the pool has at
 * most `poolMax` connections, each closed after `poolIdleMs` unused. A connection is to the engine, not to a database:
 * the engine wakes and keeps awake a database only for commands that name it, so an open idle connection keeps
 * nothing awake (docs/data-explorer-security.md, "Sleeping databases").
 *
 * Every command goes through `db()`, which names the database only from the `DataTarget` (targetDbName).
 */
export class MongoDataClient implements DataClient {
  private readonly cfg: DataSettings;
  private readonly clients = new Map<string, { client: MongoClient; lastUsed: number; inFlight: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(cfg: DataSettings) {
    this.cfg = cfg;
    this.timer = setInterval(() => void this.closeIdle(), Math.min(10_000, cfg.clientIdleCloseMs));
    this.timer.unref();
  }

  /** Driver options. Credentials go in `auth`, never in a URL that could end up in a message. */
  options(): MongoClientOptions {
    const c = this.cfg;
    return {
      directConnection: true,
      appName: "fenvix-data-explorer",
      maxPoolSize: c.poolMax,
      minPoolSize: 0,
      maxIdleTimeMS: c.poolIdleMs,
      maxConnecting: 2,
      connectTimeoutMS: c.connectTimeoutMs,
      serverSelectionTimeoutMS: c.connectTimeoutMs,
      socketTimeoutMS: c.commandTimeoutMs + CLIENT_GRACE_MS,
      waitQueueTimeoutMS: c.connectTimeoutMs,
      retryWrites: false,
      retryReads: false,
      monitorCommands: false,
      tls: c.tls,
      ...(c.tls && c.tlsCaFile ? { tlsCAFile: c.tlsCaFile } : {}),
      ...(c.tls && c.tlsServerName ? { servername: c.tlsServerName } : {}),
      ...(c.username ? { auth: { username: c.username, password: c.password }, authMechanism: c.authMechanism, authSource: c.authSource } : {}),
      // READ_OPTIONS (types kept as BSON) are set on find/findOne only: on the client they would also turn the
      // engine's own answers (error codes, matched/deleted counts) into Int32 objects.
    };
  }

  private entry(region: string) {
    const addr = this.cfg.endpoints[region];
    if (!addr) throw new DataError("unavailable", "no-endpoint");
    let e = this.clients.get(region);
    if (!e) {
      e = { client: new MongoClient(`mongodb://${addr}/`, this.options()), lastUsed: Date.now(), inFlight: 0 };
      // A pool error must not crash the process, and its message (which can carry the address) is not logged.
      e.client.on("error", () => {});
      this.clients.set(region, e);
    }
    return e;
  }

  /** The one place a database is chosen: always the target's own `db_<id>`. */
  private async run<T>(t: DataTarget, work: (db: ReturnType<MongoClient["db"]>) => Promise<T>, timeoutMs: number): Promise<T> {
    const e = this.entry(t.region);
    e.inFlight++;
    e.lastUsed = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const db = e.client.db(targetDbName(t));
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DataError("timeout", "client")), timeoutMs + CLIENT_GRACE_MS); });
      return await Promise.race([work(db), deadline]);
    } catch (err) {
      throw mapError(err);
    } finally {
      clearTimeout(timer);
      e.inFlight--;
      e.lastUsed = Date.now();
    }
  }

  async listCollections(t: DataTarget, o: CallOptions & { limit: number }): Promise<CollectionInfo[]> {
    return this.run(t, async (db) => {
      const cur = db.listCollections({}, { nameOnly: true, authorizedCollections: true, batchSize: Math.min(o.limit, 1000), maxTimeMS: o.maxTimeMS } as never);
      const out: CollectionInfo[] = [];
      try {
        for await (const c of cur) {
          out.push({ name: String((c as { name: unknown }).name), type: String((c as { type?: unknown }).type ?? "collection") });
          if (out.length >= o.limit) break;
        }
      } finally {
        await cur.close().catch(() => {});
      }
      return out;
    }, o.maxTimeMS);
  }

  async estimatedCount(t: DataTarget, collection: string, o: CallOptions): Promise<number | null> {
    return this.run(t, async (db) => {
      const n = Number(await db.collection(collection).estimatedDocumentCount({ maxTimeMS: o.maxTimeMS }));
      return Number.isFinite(n) ? n : null;
    }, o.maxTimeMS);
  }

  async find(t: DataTarget, collection: string, o: FindOptions): Promise<{ docs: Document[]; stoppedEarly: boolean }> {
    return this.run(t, async (db) => {
      const cur = db.collection(collection).find(o.filter, {
        sort: o.sort, projection: o.projection, skip: o.skip, limit: o.limit,
        // Small batches: the bytes held at once stay near batchSize documents, and reading stops at maxBytes.
        batchSize: Math.min(o.limit, 25), maxTimeMS: o.maxTimeMS, ...READ_OPTIONS,
      });
      const docs: Document[] = [];
      let bytes = 0;
      let stoppedEarly = false;
      try {
        for await (const d of cur) {
          docs.push(d);
          bytes += approxSize(d);
          if (bytes >= o.maxBytes) { stoppedEarly = true; break; }
        }
      } finally {
        await cur.close().catch(() => {});
      }
      return { docs, stoppedEarly };
    }, o.maxTimeMS);
  }

  async findOne(t: DataTarget, collection: string, filter: Document, o: CallOptions): Promise<Document | null> {
    return this.run(t, (db) => db.collection(collection).findOne(filter, { maxTimeMS: o.maxTimeMS, ...READ_OPTIONS }), o.maxTimeMS);
  }

  async insertOne(t: DataTarget, collection: string, doc: Document, o: CallOptions): Promise<void> {
    await this.run(t, (db) => db.collection(collection).insertOne(doc, { maxTimeMS: o.maxTimeMS, forceServerObjectId: false } as never), o.maxTimeMS);
  }

  async replaceOne(t: DataTarget, collection: string, filter: Document, doc: Document, o: CallOptions): Promise<{ matched: number }> {
    const r = await this.run(t, (db) => db.collection(collection).replaceOne(filter, doc, { maxTimeMS: o.maxTimeMS, upsert: false } as never), o.maxTimeMS);
    return { matched: Number(r.matchedCount) };
  }

  async deleteOne(t: DataTarget, collection: string, filter: Document, o: CallOptions): Promise<{ deleted: number }> {
    const r = await this.run(t, (db) => db.collection(collection).deleteOne(filter, { maxTimeMS: o.maxTimeMS } as never), o.maxTimeMS);
    return { deleted: Number(r.deletedCount) };
  }

  /** Closes clients nobody used for `clientIdleCloseMs`. */
  async closeIdle(now = Date.now()): Promise<void> {
    for (const [region, e] of this.clients) {
      if (e.inFlight === 0 && now - e.lastUsed >= this.cfg.clientIdleCloseMs) {
        this.clients.delete(region);
        await e.client.close().catch(() => {});
      }
    }
  }

  /** Regions with an open client (tests). */
  openRegions(): string[] { return [...this.clients.keys()]; }

  async close(): Promise<void> {
    clearInterval(this.timer);
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((e) => e.client.close().catch(() => {})));
  }
}

function approxSize(d: Document): number {
  try {
    return BSON.calculateObjectSize(d);
  } catch {
    return 1024;
  }
}

/** Server error codes that are the engine's trouble, not the request's: InternalError, HostUnreachable, HostNotFound,
 * NetworkTimeout, ShutdownInProgress, PrimarySteppedDown, ExceededTimeLimit, SocketException, NotWritablePrimary,
 * InterruptedAtShutdown, NotPrimaryNoSecondaryOk, NotPrimaryOrSecondary. */
const ENGINE_SIDE = new Set([1, 6, 7, 89, 91, 189, 262, 9001, 10107, 11600, 13435, 13436]);

/** Turns any driver error into a DataError that carries only a kind and a numeric code: never the message. */
export function mapError(err: unknown): DataError {
  if (err instanceof DataError) return err;
  const e = err as { name?: string; code?: unknown; codeName?: string };
  // A code can arrive as a number or as a BSON Int32 (when values are not promoted): compare numbers.
  const code = typeof e?.code === "object" && e.code !== null ? Number((e.code as { valueOf(): unknown }).valueOf()) : typeof e?.code === "number" ? e.code : undefined;
  if (err instanceof MongoServerError || e?.name === "MongoServerError" || e?.name === "MongoBulkWriteError" || e?.name === "MongoWriteConcernError") {
    if (code === 11000 || code === 11001) return new DataError("duplicate", code);
    if (code === 50 || e.codeName === "MaxTimeMSExpired") return new DataError("timeout", 50);
    // Authentication failed (18), unauthorized (13): our own credentials, not the customer's mistake.
    if (code === 18 || code === 13) return new DataError("unavailable", code);
    // The engine's own failures (internal error, shutting down, not primary, network, time limit): retry later.
    if (code !== undefined && ENGINE_SIDE.has(code)) return new DataError("unavailable", code);
    return new DataError("refused", code);
  }
  const name = String(e?.name ?? "");
  if (/Timeout/i.test(name)) return new DataError("timeout", name);
  if (/Network|ServerSelection|PoolClosed|Topology|NotConnected|Socket|Connection|MongoTLS|ECONN|MongoAPIError|MongoServerClosed/i.test(name)) return new DataError("unavailable", name);
  if (/BSON|Invalid/i.test(name)) return new DataError("refused", name);
  return new DataError("unavailable", name || "unknown");
}
