/**
 * What the control plane needs from the engine. Every call that changes something takes an
 * `idempotencyKey`: calling again with the same key must return the first result and must not
 * do the work twice. The control plane uses the id of its operation record as the key, so a
 * retry after a crash or a timeout is always safe.
 *
 * Databases are addressed by `id`, the same UUID as the row in Postgres. The engine never sees
 * tags, billing or users.
 */
export type EngineState = "awake" | "asleep";

export interface EngineDatabase {
  id: string;
  workspaceId: string;
  name: string;
  region: string;
  state: EngineState;
  /** Bytes in the object store for the live data. */
  storageBytes: number;
  lastActiveAt: string;
  /** Whether it is pinned awake. */
  keepAwake: boolean;
  /** Set when it was created by a fork. */
  forkedFrom: string | null;
  /** Point in time of the last restore. */
  restoredTo: string | null;
  /** Earliest point a restore can go back to (null: back to creation). */
  earliestRestorePoint: string | null;
}

export interface EngineBucket {
  /** Start of the hour, ISO, UTC. */
  hour: string;
  requests: number;
  storageBytes: number;
}

export interface EngineUsage {
  state: EngineState;
  storageBytes: number;
  lastActiveAt: string;
  buckets: EngineBucket[];
  wakeUps: { at: string; firstRequestMs: number }[];
}

export interface EngineExport {
  /** Stable for one idempotency key: asking again names the same file. */
  exportId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** The IP allowlist of a database as the engine holds it (docs/network-allowlist.md). */
export interface EngineAllowlist {
  /** The networks in the engine's form (`10.0.0.0/8`, `203.0.113.7/32`); empty: every address is allowed. */
  entries: string[];
  /** False when the engine runs without authentication: then nothing checks the list. */
  enforced: boolean;
}

/** An address the engine refuses on one database after too many failed sign-ins. Never a user name or a password. */
export interface EngineBlock {
  /** The address, or its /64 for IPv6 (the engine counts IPv6 per /64), as the engine shows it. */
  ip: string;
  until: string;
  remainingSecs: number;
}

export type EngineErrorKind =
  /** The id is unknown to the engine. */
  | "not_found"
  /** The target already exists, or is busy. Not retryable as is. */
  | "conflict"
  /** The request is not acceptable (for example a restore point outside the window). */
  | "invalid"
  /** The engine could not be reached or failed. Retry later with the same idempotency key. */
  | "unavailable";

export class EngineError extends Error {
  readonly kind: EngineErrorKind;
  constructor(kind: EngineErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface EngineClient {
  /** Creates an empty database, asleep. Creating the same id again returns the existing one. */
  createDatabase(req: { id: string; workspaceId: string; name: string; region: string; idempotencyKey: string }): Promise<EngineDatabase>;
  getDatabase(id: string): Promise<EngineDatabase | null>;
  listDatabases(workspaceId: string): Promise<EngineDatabase[]>;
  /** Copy-on-write copy: instant, asleep, same region. */
  forkDatabase(req: { sourceId: string; id: string; workspaceId: string; name: string; idempotencyKey: string }): Promise<EngineDatabase>;
  /** Rolls the database back in place to `at`. */
  restoreDatabase(req: { id: string; at: string; idempotencyKey: string }): Promise<EngineDatabase>;
  /** Prepares one archive holding all the databases. */
  exportDatabases(req: { ids: string[]; idempotencyKey: string }): Promise<EngineExport>;
  /** A link to the archive that works for `ttlSeconds`. Can be called again for a fresh link. */
  exportDownloadUrl(exportId: string, ttlSeconds: number): Promise<{ url: string; expiresAt: string }>;
  /** Deletes the live data and every backup. Erasing what is already gone is not an error. */
  eraseDatabase(req: { id: string; idempotencyKey: string }): Promise<{ erased: boolean }>;
  /** Pin (true, and wake it) or unpin (false). Repeating it changes nothing. */
  setKeepAwake(req: { id: string; enabled: boolean }): Promise<EngineDatabase>;
  /** Hourly usage in [from, to), plus wake-ups, for the usage sync. */
  usage(req: { id: string; from: string; to: string }): Promise<EngineUsage>;
  /** The database's IP allowlist in the engine. */
  getIpAllowlist(id: string): Promise<EngineAllowlist>;
  /** Replaces the list (empty: removes it, every address allowed). The engine checks the entries again. Repeatable. */
  setIpAllowlist(req: { id: string; entries: string[] }): Promise<EngineAllowlist>;
  /** Addresses blocked on this database right now (not the blocks of every database: those are other customers' too). */
  networkBlocks(id: string): Promise<EngineBlock[]>;
  /**
   * Lifts the block of the address (an IP, or the network part of an IPv6 /64) on THIS database only: its blocks on
   * other databases and an address-wide block (every database) stay.
   */
  unblockAddress(req: { id: string; ip: string }): Promise<{ unblocked: boolean }>;
  /** The networks the engine of a region trusts (`--trusted-networks`): they skip lists, blocks and counting. */
  trustedNetworks(region: string): Promise<string[]>;
  /**
   * Only for engines whose export is not a download link of their own: the archive of an export, produced as a
   * stream by this service and served at a signed `/downloads/` link. Absent on the fake.
   */
  openExportArchive?(exportId: string): Promise<{ filename: string; mimeType: string; body: AsyncIterable<Uint8Array> }>;
}
