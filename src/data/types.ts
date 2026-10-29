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
  /** Connection string. The password is written as <password>; the real secret is never sent here. */
  connectionString: string;
  /** Tags as "key:value" strings, for example "customer:acme-labs". */
  tags: string[];
  /** When true the database never goes to sleep. */
  keepAwake: boolean;
  /** Set when this database was created as a fork. */
  forkedFrom: string | null;
  /** Point in time the data was last restored to, if ever. */
  restoredTo: string | null;
  /**
   * Only on the answer to a create or a fork: the first database user. Its password is shown this one time and is
   * never sent again (null when it cannot be shown: reset it in the Users tab).
   */
  initialUser?: { username: string; role: string; password: string | null; connectionString: string | null } | null;
}

export interface NewDatabase {
  name: string;
  region: string;
  tags: string[];
  /** Name of the first database user; "app" when left out. */
  appUser?: string;
}

/**
 * Create, fork, restore, export and erase are long operations on the control plane. The request waits a while for the
 * result; when the work takes longer, the dashboard polls the operation until it has succeeded or failed.
 */
export type OperationKind = "create" | "fork" | "restore" | "export" | "erase";
/** "submitting" until the control plane has accepted the request, then the operation's own status. */
export type OperationStatus = "submitting" | "queued" | "running" | "succeeded" | "failed";

export interface OperationProgress {
  kind: OperationKind;
  status: OperationStatus;
  /** The control plane's operation id, once it is known. */
  operationId: string | null;
  /** Set when the status is "failed": the reason, written for people. */
  error: string | null;
}

export interface OperationOptions {
  /** Called on every change of status, so the screen can say what is happening. */
  onProgress?: (progress: OperationProgress) => void;
  /** Stops waiting (the operation itself goes on in the background). */
  signal?: AbortSignal;
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
  /** True when the database was serving for part of this bucket. */
  awake: boolean;
}

export type UsageSort = "name" | "databases" | "storageGb" | "requests";

export interface UsageQuery {
  /** Month as "YYYY-MM". */
  month: string;
  /** One row per database, or one row per tag value. */
  by: "database" | "tag";
  /** With by "tag": the tag key to total up. Leave out to list every key:value tag. */
  tagKey?: string;
  sort?: UsageSort;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface UsageRow {
  /** Database id, or the tag ("customer:acme-labs"). */
  id: string;
  name: string;
  /** Tags of the database (by "database" only). */
  tags: string[];
  /** Databases counted in this row. */
  databases: number;
  /** Average storage over the month, in GB. */
  storageGb: number;
  requests: number;
}

export interface UsageTotals {
  databases: number;
  storageGb: number;
  requests: number;
}

export interface UsageReport extends Page<UsageRow> {
  month: string;
  /** Over every database, not just this page. A database with several tags counts once. */
  totals: UsageTotals;
}

export interface BillingLine {
  label: string;
  /** Quantity with its unit, for example "1,204 GB-months". */
  quantity: string;
  rate: string;
  cost: number;
}

export interface BillingOverview {
  currency: string;
  plan: { name: string; description: string };
  monthToDate: { periodLabel: string; lines: BillingLine[]; total: number };
  paymentMethod: { brand: string; last4: string; expires: string };
}

export interface Invoice {
  id: string;
  number: string;
  /** Month the invoice covers, "YYYY-MM". */
  month: string;
  issuedAt: string;
  amount: number;
  currency: string;
  status: "paid" | "open";
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

/** Fleet-wide numbers for the overview page. */
export interface OverviewTotals {
  databases: number;
  awake: number;
  asleep: number;
  /** Share of the fleet asleep right now, 0 to 100. */
  asleepPercent: number;
  requests: number;
  storageGb: number;
  costMtd: number;
  currency: string;
}

/** Small series behind each number on the overview, oldest first. */
export interface OverviewSparks {
  databases: number[];
  awake: number[];
  requests: number[];
  storageGb: number[];
  cost: number[];
}

export interface AwakePoint {
  at: string;
  awake: number;
  total: number;
}

export interface RequestPoint {
  at: string;
  requests: number;
}

export interface CostPoint {
  at: string;
  /** Running cost this month up to this day. */
  cost: number;
  /** Same day of the month before, for reference. Null past the end of that month. */
  reference: number | null;
}

export interface WakeUp {
  id: string;
  name: string;
  at: string;
  /** How long the first request waited, in milliseconds. */
  latencyMs: number;
}

export interface TopDatabase {
  id: string;
  name: string;
  requests: number;
}

export interface Overview {
  range: UsageRange;
  totals: OverviewTotals;
  sparks: OverviewSparks;
  awakeSeries: AwakePoint[];
  requestSeries: RequestPoint[];
  costSeries: CostPoint[];
  topDatabases: TopDatabase[];
  recentWakeUps: WakeUp[];
}

/** One value of a tag key, with what it uses. */
export interface TagBreakdownRow {
  value: string;
  databases: number;
  storageGb: number;
  requests: number;
}

/** Daily usage of a month split by tag value, for a stacked chart. */
export interface UsageTrend {
  /** ISO day starts, oldest first. */
  days: string[];
  /** One entry per tag value, plus "Other" when there are more. */
  series: { label: string; values: number[] }[];
}

/** Totals for one month, for the small trend lines on the usage page. */
export interface UsageHistoryPoint {
  month: string;
  databases: number;
  storageGb: number;
  requests: number;
}

export interface Plan {
  id: string;
  name: string;
  price: string;
  /** "/ month", or empty for Free and Custom. */
  period: string;
  description: string;
  features: string[];
  current: boolean;
}
