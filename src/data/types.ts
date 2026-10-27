export type DbState = "awake" | "asleep";

export interface Database {
  id: string;
  name: string;
  state: DbState;
  /** Storage used, in MB. */
  storageMb: number;
  requests24h: number;
  lastActiveAt: string;
  createdAt: string;
  region: string;
  host: string;
  /** Connection string with a password placeholder. The real value is never shown here. */
  connectionString: string;
  /** Tags as "key:value" strings, for example "customer:acme-labs". */
  tags: string[];
  /** When true the database never goes to sleep. */
  keepAwake: boolean;
  /** Set when this database was created as a fork. */
  forkedFrom: string | null;
  /** Point in time the data was last restored to, if ever. */
  restoredTo: string | null;
}

export interface NewDatabase {
  name: string;
  region: string;
  tags: string[];
}

/** A file the browser can download. */
export interface ExportResult {
  filename: string;
  mimeType: string;
  downloadUrl: string;
}

/** One page of a list. Pages are numbered from 1. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type DatabaseSort = "name" | "state" | "keepAwake" | "storageMb" | "requests24h" | "lastActiveAt";

/** Which databases to list. All parts combine with AND. */
export interface DatabaseFilter {
  /** Case-insensitive match on the name. */
  search?: string;
  state?: DbState;
  keepAwake?: boolean;
  /** "key:value" matches that tag exactly; a bare "key" matches any database that has the key; "!key" matches databases without the key. */
  tags?: string[];
}

export interface DatabaseQuery extends DatabaseFilter {
  sort?: DatabaseSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface TagCount {
  key: string;
  value: string;
  /** Databases carrying this tag. */
  count: number;
}

export interface DatabaseGroup {
  /** Value of the group key, or null for databases without that key. */
  value: string | null;
  count: number;
  awake: number;
  keepAwake: number;
  storageMb: number;
}

export interface GroupedDatabases {
  groupBy: string;
  groups: DatabaseGroup[];
  /** Databases that match the filter, across all groups. */
  total: number;
}

export interface BulkResult {
  /** Databases that were changed. */
  affected: number;
}

export type UsageRange = "24h" | "7d" | "30d";

export interface UsagePoint {
  /** ISO timestamp of the start of the bucket. */
  at: string;
  requests: number;
  storageMb: number;
}

export interface BillingLine {
  databaseId: string;
  name: string;
  requests: number;
  awakeHours: number;
  storageGbHours: number;
  /** Fake amount, for layout only. */
  amount: number;
}

export interface BillingSummary {
  periodLabel: string;
  currency: string;
  lines: BillingLine[];
  total: number;
}

export interface ApiKey {
  id: string;
  name: string;
  /** Last characters only. The full secret is shown once at creation. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  key: ApiKey;
  /** Shown once. */
  secret: string;
}

export interface Settings {
  workspaceName: string;
  idleMinutes: number;
  emailNotices: boolean;
}
