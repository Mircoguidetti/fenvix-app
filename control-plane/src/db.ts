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

  constructor(connectionString: string, max = 10, statementTimeoutMs = 30_000) {
    this.pool = new pg.Pool({
      connectionString,
      max,
      application_name: "fenvix-control-plane",
      statement_timeout: statementTimeoutMs,
      // A request never waits forever for a connection: when the pool is full or Postgres does not answer, it fails
      // after 5 s with an error the caller sees, instead of hanging (the dashboard stayed on a blank screen).
      connectionTimeoutMillis: 5_000,
      // Client-side limit too: statement_timeout is enforced by Postgres, so it cannot end a query whose connection
      // died on the way (a pooler or NAT that dropped an idle socket); this one can.
      query_timeout: statementTimeoutMs + 5_000,
      // Idle connections close before a pooler or NAT drops them silently, and TCP keepalive finds the dead ones.
      idleTimeoutMillis: 10_000,
      keepAlive: true,
    });
    // An idle client dropping must not crash the process.
    this.pool.on("error", () => {});
  }

  /** Runs `fn` in one transaction scoped to a workspace. */
  async tx<T>(workspaceId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let broken = false;
    try {
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      const ok = await c.query("rollback").then(() => true, () => false);
      // A connection that cannot even roll back is broken: destroy it rather than give it to the next request.
      broken = !ok;
      throw e;
    } finally {
      c.release(broken);
    }
  }

  /** For the five functions that look across workspaces. No workspace is set. */
  async system<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let broken = false;
    try {
      return await fn(c);
    } catch (e) {
      // A query that timed out on the client side or lost its socket leaves the connection unusable.
      broken = isConnectionError(e);
      throw e;
    } finally {
      c.release(broken);
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Errors that mean the connection itself is gone (not a SQL error that Postgres answered). */
export const isConnectionError = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return !(e as { code?: string })?.code?.match(/^[0-9A-Z]{5}$/) && /timeout|terminated|ECONNRESET|EPIPE|ETIMEDOUT|Connection/i.test(m);
};

export const isUniqueViolation = (e: unknown, constraint?: string): boolean =>
  (e as { code?: string })?.code === "23505" && (constraint === undefined || (e as { constraint?: string }).constraint === constraint);
