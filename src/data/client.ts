import type { ApiKey, BillingSummary, BulkResult, CreatedApiKey, Database, DatabaseFilter, DatabaseQuery, GroupedDatabases, Page, Settings, TagCount, UsagePoint, UsageRange } from "./types";

/**
 * Everything the dashboard needs from a backend. The screens only talk to this interface.
 * To go live, write an HTTP implementation of `DataClient` and export it from `./index.ts`
 * instead of the mock one.
 */
export interface DataClient {
  /** True while the data is fake. Drives the "Sample data" label. */
  readonly isSample: boolean;
  /** "now" used for relative times. A real client returns the current time. */
  now(): Date;
  /** Filtered, sorted, paged list. Default sort is last active first, 50 per page. */
  listDatabases(query?: DatabaseQuery): Promise<Page<Database>>;
  /** Ids of every database matching the filter, for "select all matching". */
  listDatabaseIds(filter?: DatabaseFilter): Promise<string[]>;
  /** Matching databases counted per value of one tag key. */
  groupDatabases(groupBy: string, filter?: DatabaseFilter): Promise<GroupedDatabases>;
  /** Every tag in use with its database count. */
  listTags(): Promise<TagCount[]>;
  getDatabase(id: string): Promise<Database | null>;
  /** Replaces the tags of one database. */
  setTags(id: string, tags: string[]): Promise<Database>;
  /** Adds tags to several databases. A key already on a database gets the new value. */
  addTags(ids: string[], tags: string[]): Promise<BulkResult>;
  /** Removes tags from several databases. "key:value" removes that value, a bare "key" removes the key. */
  removeTags(ids: string[], tags: string[]): Promise<BulkResult>;
  getUsage(databaseId: string, range: UsageRange): Promise<UsagePoint[]>;
  getBilling(): Promise<BillingSummary>;
  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(name: string): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<ApiKey>;
  getSettings(): Promise<Settings>;
  saveSettings(next: Settings): Promise<Settings>;
}
