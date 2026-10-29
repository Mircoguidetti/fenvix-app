import { BSON } from "bson";
import { connect as tcpConnect } from "node:net";
import { type Document, MongoClient, type MongoClientOptions, MongoServerError } from "mongodb";
import type { DataSettings } from "../config.ts";
import { type EngineCredential, type EngineUserKey, engineCredential } from "./credentials.ts";
import { type CallOptions, type CollectionInfo, type DataClient, DataError, type DataTarget, type FindOptions, targetDbName } from "./data.ts";
import { READ_OPTIONS } from "./data-fake.ts";
import { type AuthAttempt, type AuthFailureGuard, AuthGuardRefusal, processAuthGuard } from "./auth-guard.ts";

/** Extra time the client waits after the engine's own maxTimeMS before giving up on a command. */
const CLIENT_GRACE_MS = 2000;

/** The master key versions the Data Explorer derives per-database passwords with. Never the provisioner. */
export interface DataUserKeys { current: EngineUserKey; previous: EngineUserKey | null }

interface Entry {
  client: MongoClient; lastUsed: number; inFlight: number; region: string; db: string; version: string;
  /** Has this client signed in successfully? Until it has, its first command is a sign-in attempt the engine may count. */
  proven: boolean;
  /** The attempt in progress on a client that has not signed in yet: the others wait for it instead of trying too. */
  proving: Promise<void> | null;
}

/**
 * The Data Explorer's connection to the engine's MongoDB listener, through the official driver.
 *
 * With per-database users (`perDatabaseUsers`, the production setting) there is one driver client per database, and it
 * authenticates as that database's own engine user (`cp_<hex>` on `db_<hex>`, password derived from the master key;
 * credentials.ts). The engine itself then refuses anything outside that database, whatever this code asks for. Without
 * them (local development, or the old shared credential) there is one client per region.
 *
 * A client is created on first use and closed after `clientIdleCloseMs` without a request, so an idle control plane holds
 * no connection (not even the driver's monitoring) to the engine; at most `maxClients` are open, the least recently used
 * idle one is closed first. Inside a client the pool has at most `poolMax` connections, each closed after `poolIdleMs`
 * unused. The engine wakes and keeps awake a database only for commands that name it, so an open idle connection keeps
 * nothing awake (docs/data-explorer-security.md, "Sleeping databases").
 *
 * Every command goes through `run()`, which names the database only from the `DataTarget` (targetDbName), and takes the
 * credential from the same target.
 */
export class MongoDataClient implements DataClient {
  private readonly cfg: DataSettings;
  private readonly keys: DataUserKeys | null;
  private readonly clients = new Map<string, Entry>();
  /** Database id -> the key version that worked last (during a rotation some users still have the previous one). */
  private readonly versionOf = new Map<string, { version: string; at: number }>();
  /**
   * The key version that worked last on any database. During a rotation most users have the same version, so a database
   * not seen yet is tried with it first: one failed sign-in for the whole rotation instead of one per database.
   */
  private lastGood: { version: string; at: number } | null = null;
  private readonly timer: NodeJS.Timeout;
  /** Failed sign-ins of this process, so the engine never blocks the control plane's address (auth-guard.ts). */
  private readonly guard: AuthFailureGuard;

  constructor(cfg: DataSettings, keys: DataUserKeys | null = null, guard: AuthFailureGuard = processAuthGuard) {
    if (cfg.perDatabaseUsers && !keys) throw new Error("per-database users need the master key");
    this.cfg = cfg;
    this.guard = guard;
    this.keys = cfg.perDatabaseUsers ? keys : null;
    this.timer = setInterval(() => void this.closeIdle(), Math.min(10_000, cfg.clientIdleCloseMs));
    this.timer.unref();
  }

  /** Driver options. Credentials go in `auth`, never in a URL that could end up in a message. */
  options(cred?: EngineCredential): MongoClientOptions {
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
      ...(cred
        ? { auth: { username: cred.username, password: cred.password }, authMechanism: "SCRAM-SHA-256" as const, authSource: cred.authSource }
        : c.username ? { auth: { username: c.username, password: c.password }, authMechanism: c.authMechanism, authSource: c.authSource } : {}),
      // READ_OPTIONS (types kept as BSON) are set on find/findOne only: on the client they would also turn the
      // engine's own answers (error codes, matched/deleted counts) into Int32 objects.
    };
  }

  /** The credentials to try for a database, the one that worked last first. Empty without per-database users. */
  private credentials(t: DataTarget): EngineCredential[] {
    if (!this.keys) return [];
    const all = [this.keys.current, ...(this.keys.previous ? [this.keys.previous] : [])].map((k) => engineCredential(k, t.id));
    const mine = this.versionOf.get(t.id);
    // The newer of "what worked on this database" and "what worked on any database" goes first.
    const first = mine && (!this.lastGood || mine.at >= this.lastGood.at) ? mine.version : this.lastGood?.version;
    return first ? [...all.filter((c) => c.version === first), ...all.filter((c) => c.version !== first)] : all;
  }

  private async entry(t: DataTarget, cred: EngineCredential | undefined): Promise<Entry> {
    const addr = this.cfg.endpoints[t.region];
    if (!addr) throw new DataError("unavailable", "no-endpoint");
    const key = cred ? `${t.region}|${cred.authSource}|${cred.version}` : t.region;
    let e = this.clients.get(key);
    if (!e) {
      if (this.clients.size >= this.cfg.maxClients) await this.closeLeastRecentlyUsed();
      e = { client: new MongoClient(`mongodb://${addr}/`, this.options(cred)), lastUsed: Date.now(), inFlight: 0, region: t.region, db: cred?.authSource ?? "", version: cred?.version ?? "", proven: false, proving: null };
      // A pool error must not crash the process, and its message (which can carry the address) is not logged.
      e.client.on("error", () => {});
      this.clients.set(key, e);
    }
    return e;
  }

  private async closeLeastRecentlyUsed(): Promise<void> {
    let oldest: [string, Entry] | undefined;
    for (const kv of this.clients) if (kv[1].inFlight === 0 && (!oldest || kv[1].lastUsed < oldest[1].lastUsed)) oldest = kv;
    // Every client is busy: refuse rather than open connections without bound.
    if (!oldest) throw new DataError("unavailable", "clients");
    this.clients.delete(oldest[0]);
    await oldest[1].client.close().catch(() => {});
  }

  /** The one place a database is chosen: always the target's own `db_<id>`, as the target's own engine user. */
  private async run<T>(t: DataTarget, work: (db: ReturnType<MongoClient["db"]>) => Promise<T>, timeoutMs: number): Promise<T> {
    const creds = this.credentials(t);
    const attempts: (EngineCredential | undefined)[] = creds.length ? creds : [undefined];
    for (let i = 0; ; i++) {
      try {
        const r = await this.signedIn(t, attempts[i], work, timeoutMs);
        if (attempts[i]) {
          const now = Date.now();
          this.versionOf.set(t.id, { version: attempts[i]!.version, at: now });
          if (this.lastGood?.version !== attempts[i]!.version) this.lastGood = { version: attempts[i]!.version, at: now };
        }
        return r;
      } catch (err) {
        // Authentication failed with this key version: during a rotation the user may still have the other one.
        const mapped = mapError(err);
        if (mapped.code === 18 && i + 1 < attempts.length) continue;
        throw mapped;
      }
    }
  }

  /**
   * One command on the client of a credential. A client that has not signed in yet signs in with this command: that is
   * an attempt the engine counts if it fails, so it goes through the guard, one at a time per client. A failed sign-in
   * on a client that had signed in before (a password or an allowlist changed under it) is counted too.
   */
  private async signedIn<T>(t: DataTarget, cred: EngineCredential | undefined, work: (db: ReturnType<MongoClient["db"]>) => Promise<T>, timeoutMs: number): Promise<T> {
    const e = await this.entry(t, cred);
    const authSource = cred?.authSource ?? this.cfg.authSource;
    while (!e.proven && e.proving) await e.proving;
    let attempt: AuthAttempt | null = null;
    let release: () => void = () => {};
    if (!e.proven) {
      try { attempt = this.guard.begin(t.region, authSource, "data"); } catch (x) {
        if (x instanceof AuthGuardRefusal) throw new DataError("unavailable", "auth-guard");
        throw x;
      }
      e.proving = new Promise<void>((r) => { release = r; });
    }
    try {
      const r = await this.once(e, t, work, timeoutMs);
      e.proven = true;
      attempt?.done(true);
      return r;
    } catch (err) {
      const failedSignIn = mapError(err).code === 18;
      if (attempt) attempt.done(!failedSignIn);
      else if (failedSignIn) this.guard.failed(t.region, authSource);
      if (failedSignIn) e.proven = false;
      throw err;
    } finally {
      if (attempt) { e.proving = null; release(); }
    }
  }

  private async once<T>(e: Entry, t: DataTarget, work: (db: ReturnType<MongoClient["db"]>) => Promise<T>, timeoutMs: number): Promise<T> {
    e.inFlight++;
    e.lastUsed = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const db = e.client.db(targetDbName(t));
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DataError("timeout", "client")), timeoutMs + CLIENT_GRACE_MS); });
      return await Promise.race([work(db), deadline]);
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
    for (const [key, e] of this.clients) {
      if (e.inFlight === 0 && now - e.lastUsed >= this.cfg.clientIdleCloseMs) {
        this.clients.delete(key);
        await e.client.close().catch(() => {});
      }
    }
  }

  async sourceAddress(region: string): Promise<string | null> {
    const addr = this.cfg.endpoints[region];
    if (!addr) return null;
    const i = addr.lastIndexOf(":");
    const host = addr.slice(0, i).replace(/^\[|\]$/g, "");
    const port = Number(addr.slice(i + 1));
    return new Promise((resolve) => {
      // A bare TCP connection, closed at once: nothing is sent, so the engine counts nothing and wakes nothing.
      const sock = tcpConnect({ host, port, timeout: this.cfg.connectTimeoutMs });
      const done = (v: string | null) => { sock.destroy(); resolve(v); };
      sock.once("connect", () => done(sock.localAddress ?? null));
      sock.once("timeout", () => done(null));
      sock.once("error", () => done(null));
    });
  }

  /** Regions with an open client (tests). */
  openRegions(): string[] { return [...new Set([...this.clients.values()].map((e) => e.region))]; }

  /** Open clients: region, database and key version, never a credential (tests). */
  openClients(): { region: string; db: string; version: string }[] { return [...this.clients.values()].map((e) => ({ region: e.region, db: e.db, version: e.version })); }

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
