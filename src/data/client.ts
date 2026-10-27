import type { ApiKey, BillingOverview, BulkResult, CreatedApiKey, Database, ExportResult, NewDatabase, DatabaseFilter, DatabaseQuery, GroupedDatabases, Invoice, Page, Settings, TagCount, UsagePoint, UsageQuery, UsageRange, UsageReport } from "./types";

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
  listRegions(): Promise<string[]>;
  /** The connection string is on the returned database. Names are unique, lowercase, 3 to 48 characters. */
  createDatabase(input: NewDatabase): Promise<Database>;
  /** Instant copy under a new name, with the same region and tags. The copy starts asleep. */
  forkDatabase(id: string, name: string): Promise<Database>;
  /** Rolls the data back to `at` (ISO time, between creation and now). */
  restoreDatabase(id: string, at: string): Promise<Database>;
  /** Prepares a download of the data of one or more databases. */
  exportDatabases(ids: string[]): Promise<ExportResult>;
  /** Permanently deletes databases and their data. */
  eraseDatabases(ids: string[]): Promise<BulkResult>;
  /** Keeps databases awake (true) or lets them sleep when idle (false). */
  setKeepAwake(ids: string[], enabled: boolean): Promise<BulkResult>;
  /** Replaces the tags of one database. */
  setTags(id: string, tags: string[]): Promise<Database>;
  /** Adds tags to several databases. A key already on a database gets the new value. */
  addTags(ids: string[], tags: string[]): Promise<BulkResult>;
  /** Removes tags from several databases. "key:value" removes that value, a bare "key" removes the key. */
  removeTags(ids: string[], tags: string[]): Promise<BulkResult>;
  getUsage(databaseId: string, range: UsageRange): Promise<UsagePoint[]>;
  /** Months that have a usage report, newest first, as "YYYY-MM". */
  listUsageMonths(): Promise<string[]>;
  /** Storage and requests for a month, per database or per tag, sorted and paged. */
  getUsageReport(query: UsageQuery): Promise<UsageReport>;
  /** The same report as a CSV file, all rows, ignoring paging. */
  exportUsageReport(query: UsageQuery): Promise<ExportResult>;
  /** What the customer pays FENVIX: plan, month-to-date cost and payment method. */
  getBilling(): Promise<BillingOverview>;
  listInvoices(page?: number, pageSize?: number): Promise<Page<Invoice>>;
  /** A PDF of one invoice. */
  downloadInvoice(id: string): Promise<ExportResult>;
  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(name: string): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<ApiKey>;
  getSettings(): Promise<Settings>;
  saveSettings(next: Settings): Promise<Settings>;
}
