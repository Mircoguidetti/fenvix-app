import pg from "pg";

// bigint columns (counts, bytes, request totals) stay far below 2^53 here, so plain numbers are safe.
pg.types.setTypeParser(20, (v) => Number(v));

export type Client = pg.PoolClient;

/** ISO 8601 in UTC, without ".000" so the common case reads like the contract's examples. */
export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString().replace(".000Z", "Z");

/**
 * The only way the service touches Postgres. Every transaction starts by naming the workspace
 * it acts for (`app.workspace_id`); the row level security policies of the restricted role
 * then hide every other workspace, whatever the SQL says.
 */
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, application_name: "fenvix-control-plane" });
    // An idle client dropping must not crash the process.
    this.pool.on("error", () => {});
  }

  /** Runs `fn` in one transaction scoped to a workspace. */
  async tx<T>(workspaceId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  /** For the five functions that look across workspaces. No workspace is set. */
  async system<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const isUniqueViolation = (e: unknown, constraint?: string): boolean =>
  (e as { code?: string })?.code === "23505" && (constraint === undefined || (e as { constraint?: string }).constraint === constraint);
