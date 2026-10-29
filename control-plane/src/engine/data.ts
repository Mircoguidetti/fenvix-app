import type { Document } from "bson";
import { engineName } from "./names.ts";

/**
 * What the Data Explorer needs from the engine's MongoDB listener: a handful of document operations on ONE database.
 *
 * The control plane's other engine calls go to the admin interface (`EngineClient`, admin-http.ts). These go to the
 * MongoDB protocol, through the official driver (`MongoDataClient`, data-mongo.ts) or the in-memory fake
 * (`FakeDataClient`, data-fake.ts). The browser never reaches either: only the control plane opens a connection.
 *
 * Tenant scope. A `DataTarget` can only be made by `dataTarget()`, from the database row the control plane has just
 * read from Postgres for the caller's workspace (services/explorer.ts). The engine database name is derived from that
 * row's id by `targetDbName()`, the one function every implementation uses to pick the database. Nothing a client
 * sends ever becomes a database name.
 */
const TARGET = Symbol("DataTarget");

export interface DataTarget {
  readonly id: string;
  readonly region: string;
  readonly [TARGET]: true;
}

/** Only for a row read from Postgres for the caller's workspace (services/explorer.ts). */
export function dataTarget(row: { id: string; region: string }): DataTarget {
  return Object.freeze({ id: row.id, region: row.region, [TARGET]: true as const });
}

/** The engine's name of the target database: `db_` and the 32 hex digits of the id. The only way a name is chosen. */
export function targetDbName(t: DataTarget): string {
  if (!t || t[TARGET] !== true) throw new Error("not a DataTarget");
  return engineName(t.id);
}

export type DataErrorKind =
  /** The engine could not be reached, or did not answer in time (it may be waking the database). Retry. */
  | "unavailable"
  /** The command ran out of its time (maxTimeMS or the client's deadline). */
  | "timeout"
  /** Insert of an `_id` that exists. */
  | "duplicate"
  /** The engine refused the command (bad value, unsupported feature, document too large, ...). */
  | "refused";

/** Never carries the engine's own message, address or credentials: only a kind and a numeric code. */
export class DataError extends Error {
  readonly kind: DataErrorKind;
  readonly code: number | string | undefined;
  constructor(kind: DataErrorKind, code?: number | string) {
    super(`data ${kind}${code === undefined ? "" : ` (${code})`}`);
    this.kind = kind;
    this.code = code;
  }
}

export interface CallOptions {
  /** maxTimeMS sent to the engine. */
  maxTimeMS: number;
}

export interface FindOptions extends CallOptions {
  filter: Document;
  sort: Document;
  projection: Document | undefined;
  skip: number;
  /** At most this many documents come back (the caller asks one more than the page to know if there is a next one). */
  limit: number;
  /** Stop reading once this many bytes (BSON) of documents were read; `stoppedEarly` says it happened. */
  maxBytes: number;
}

export interface CollectionInfo { name: string; type: string }

export interface DataClient {
  /** Collection and view names, at most `limit`. */
  listCollections(t: DataTarget, o: CallOptions & { limit: number }): Promise<CollectionInfo[]>;
  /** From the collection's metadata (`count` without a filter), never a scan. Null when the engine cannot say. */
  estimatedCount(t: DataTarget, collection: string, o: CallOptions): Promise<number | null>;
  find(t: DataTarget, collection: string, o: FindOptions): Promise<{ docs: Document[]; stoppedEarly: boolean }>;
  findOne(t: DataTarget, collection: string, filter: Document, o: CallOptions): Promise<Document | null>;
  insertOne(t: DataTarget, collection: string, doc: Document, o: CallOptions): Promise<void>;
  /** Replaces the one document matching `filter` (its `_id` and the values last read). */
  replaceOne(t: DataTarget, collection: string, filter: Document, doc: Document, o: CallOptions): Promise<{ matched: number }>;
  deleteOne(t: DataTarget, collection: string, filter: Document, o: CallOptions): Promise<{ deleted: number }>;
  /**
   * The address this process reaches the engine's MongoDB listener of a region from, as the engine sees it (the local
   * end of a TCP connection; there is no address translation between a container and its host). Null when it cannot be
   * reached. Used to tell whether the engine trusts the control plane (docs/network-allowlist.md).
   */
  sourceAddress(region: string): Promise<string | null>;
  close(): Promise<void>;
}
