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
