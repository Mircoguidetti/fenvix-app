import type { ApiKey, BillingSummary, CreatedApiKey, Database, Settings, UsagePoint, UsageRange } from "./types";

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
  listDatabases(): Promise<Database[]>;
  getDatabase(id: string): Promise<Database | null>;
  getUsage(databaseId: string, range: UsageRange): Promise<UsagePoint[]>;
  getBilling(): Promise<BillingSummary>;
  listApiKeys(): Promise<ApiKey[]>;
  createApiKey(name: string): Promise<CreatedApiKey>;
  revokeApiKey(id: string): Promise<ApiKey>;
  getSettings(): Promise<Settings>;
  saveSettings(next: Settings): Promise<Settings>;
}
