import pg from "pg";

export type Row = Record<string, unknown>;

/** What a query in an API transaction can call. */
export interface Tx {
  q<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

/**
 * Types of this pool only (the App's pool keeps its own): bigint and numeric as numbers (GitHub ids, counts and minutes,
 * all far below 2^53), date as its text (YYYY-MM-DD, never shifted by a time zone). timestamptz stays a Date; the row
 * mappers turn it into ISO 8601.
 */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === 20 || oid === 1700) return (v: string) => Number(v);
    if (oid === 1082) return (v: string) => v;
    return pg.types.getTypeParser(oid, format as "text");
  },
};

/**
 * The dashboard API's only way to Postgres: the restricted role fenvix_api, through the Supabase pooler in transaction
 * mode (port 6543). So: one transaction per request; who it acts for is set with set_config(..., true), which lasts
 * until the transaction ends (no session state survives into another client's transaction); no named prepared
 * statement (node-postgres sends unnamed ones unless a query is given a name). Row level security
 * (supabase/migrations/0014_dashboard_api.sql) reads app.user_id and app.workspace_id: a second barrier behind the
 * API's own membership and role checks.
 */
export class ApiDb {
  readonly pool: pg.Pool;

  constructor(connectionString: string, max = 5) {
    this.pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, application_name: "fenvix-api", statement_timeout: 15_000, types } as pg.PoolConfig);
    this.pool.on("error", () => {});
  }

  /** One transaction for `userId` in `workspaceId` (or none: the person's own organizations only). */
  async tx<T>(userId: string, workspaceId: string | null, fn: (t: Tx) => Promise<T>, apiKeyId: string | null = null): Promise<T> {
    const c = await this.pool.connect();
    const t: Tx = {
      q: async <R = Row>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as R[],
      one: async <R = Row>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0] as R | undefined,
    };
    let broken = false;
    try {
      await c.query("begin");
      await c.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true), set_config('app.api_key_id', $3, true)",
        [userId, workspaceId ?? "", apiKeyId ?? ""]);
      const out = await fn(t);
      await c.query("commit");
      return out;
    } catch (e) {
      // A connection that cannot even roll back is broken: it is closed, not given to the next request.
      broken = await c.query("rollback").then(() => false, () => true);
      throw e;
    } finally {
      c.release(broken);
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}
