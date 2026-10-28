/**
 * The Data Explorer's view of a database: collections and documents. The browser only ever talks to the control
 * plane (`/v1/databases/:id/data/...`); the control plane is the one that talks to the engine.
 *
 * Documents travel as MongoDB Extended JSON v2, canonical form: every value keeps its BSON type
 * (`{"$numberInt": "5"}`, `{"$oid": "..."}`, `{"$date": {"$numberLong": "..."}}`), so what is edited here goes back
 * with the same types.
 */
export type Ejson = null | boolean | number | string | Ejson[] | { [key: string]: Ejson };

export interface CollectionInfo {
  name: string;
  type: "collection" | "view";
  /** False for names the explorer does not open (outside its naming rule). */
  browsable: boolean;
  /** From the collection's metadata; null when unknown. Never a full count. */
  estimatedCount: number | null;
}

export interface DocumentItem {
  /** Canonical Extended JSON of the _id, as text. Used in URLs. */
  id: string;
  /** Version of the document as read; null when it cannot be saved from this view (projected, too large). */
  version: string | null;
  partial: boolean;
  tooLarge?: boolean;
  sizeBytes?: number;
  document?: { [key: string]: Ejson };
}

export interface DocumentPage {
  items: DocumentItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** The page stopped early because its documents were large. */
  truncated: boolean;
}

export interface DocumentQuery {
  /** JSON text, as typed by the person. Empty for every document. */
  filter?: string;
  sort?: string;
  projection?: string;
  page?: number;
  pageSize?: number;
}

/** An error from the control plane, with its contract code. */
export class ExplorerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field: string | undefined;
  readonly retryAfter: number | undefined;
  constructor(code: string, message: string, status: number, field?: string, retryAfter?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.field = field;
    this.retryAfter = retryAfter;
  }
  /** The database is asleep and waking, or did not answer in time. */
  get waking(): boolean {
    return this.status === 503;
  }
}

export interface ExplorerClient {
  listCollections(databaseId: string): Promise<{ items: CollectionInfo[]; truncated: boolean }>;
  findDocuments(databaseId: string, collection: string, query: DocumentQuery): Promise<DocumentPage>;
  getDocument(databaseId: string, collection: string, id: string): Promise<DocumentItem>;
  insertDocument(databaseId: string, collection: string, document: { [key: string]: Ejson }): Promise<{ id: string; version: string }>;
  replaceDocument(databaseId: string, collection: string, id: string, document: { [key: string]: Ejson }, version: string): Promise<{ id: string; version: string }>;
  deleteDocument(databaseId: string, collection: string, id: string, version: string): Promise<void>;
}

/** The same rule the control plane applies (control-plane/src/explorer/rules.ts), to explain a refusal early. */
export function isAllowedCollectionName(name: string): boolean {
  return name.length >= 1 && name.length <= 120 && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) && !/^system\./i.test(name) && !name.includes("..") && !name.endsWith(".");
}
