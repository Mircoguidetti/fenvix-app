import pg from "pg";
import { pgTls } from "./db-tls.ts";

// bigint columns here are GitHub ids and counts, all far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric columns (minutes) as numbers.
pg.types.setTypeParser(1700, (v) => Number(v));

export type Client = pg.PoolClient;

/**
 * The only way the App touches Postgres, as the restricted role fenvix_github_app. Every transaction names the
 * organization it acts for (`app.workspace_id`, or none for an installation not linked yet); row level security on the
 * CI tables hides every other organization, whatever the SQL says.
 */
export class Db {
  readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10, ca?: string) {
    this.pool = new pg.Pool({ ...pgTls(connectionString, ca), max, idleTimeoutMillis: 30_000, application_name: "fenvix-github-app", statement_timeout: 30_000 });
    this.pool.on("error", () => {});
  }

  async tx<T>(workspaceId: string | null, fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', $1, true)", [workspaceId ?? ""]);
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

  async q<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async close(): Promise<void> { await this.pool.end(); }
}
