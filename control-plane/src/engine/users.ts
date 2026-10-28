import { MongoClient, type MongoClientOptions } from "mongodb";
import type { DataSettings, EngineUserSettings } from "../config.ts";
import { type EngineCredential, type EngineUserKey, engineCredential, engineUserName, idFromEngineUserName } from "./credentials.ts";
import { engineName } from "./names.ts";
import { EngineError } from "./types.ts";

/**
 * The per-database engine users: made with the database, dropped with it, checked against Postgres by a sweep.
 *
 * Users live on the engine's MongoDB listener (`createUser` / `dropUser` / `updateUser` / `usersInfo`), the only
 * place the engine supports them; its admin interface (8443) has no user routes. These commands are sent as the
 * provisioner, an engine user that only this module ever authenticates as. The Data Explorer (data-mongo.ts) never
 * sees the provisioner: it gets the master key only and authenticates as the database's own user.
 *
 * Every method is safe to repeat: `ensure` makes or repairs, `drop` of a missing user is not an error.
 */
export interface EngineUsers {
  /** The user of the database exists, with the current key's password and exactly `readWrite` on the database. */
  ensure(id: string, region: string): Promise<void>;
  /** Drops the database's user. `{ dropped: false }` when there was none. */
  drop(id: string, region: string): Promise<{ dropped: boolean }>;
  /**
   * The users this service made on the engine of a region (`cp_<hex>` on `db_<hex>`): the database id and the key
   * version its password was made with (kept in the user's customData; a version is not a secret).
   */
  list(region: string): Promise<EngineUserInfo[]>;
  /** The key version `ensure` makes passwords with (null: no users). */
  currentVersion(): string | null;
  close(): Promise<void>;
}

export interface EngineUserInfo { id: string; keyVersion: string | null }

/** The engine's own role for a database user: read and write documents, indexes and collections of that one database. */
export const USER_ROLE = "readWrite";

/** Engine error codes, never the engine's text. */
const USER_EXISTS = 51003;
const USER_NOT_FOUND = 11;

function code(e: unknown): number | undefined {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "number" ? c : undefined;
}

/** Any failure as an EngineError that says only what kind it was. Messages from the engine are never passed on. */
function toEngineError(e: unknown, what: string): EngineError {
  if (e instanceof EngineError) return e;
  const c = code(e);
  // 13 Unauthorized, 18 AuthenticationFailed: the provisioner's credential or role is wrong. Not retryable by waiting,
  // but reported as unavailable so an operation is retried after the deployment is fixed, never failed as the customer's.
  if (c === 13 || c === 18) return new EngineError("unavailable", `the engine refused the provisioner (${what}, code ${c})`);
  if (c !== undefined && c !== 1 && c < 1000 && ![6, 7, 89, 91, 189, 262, 9001].includes(c)) return new EngineError("invalid", `the engine refused ${what} (code ${c})`);
  return new EngineError("unavailable", `the engine could not ${what} (${c ?? (e as Error)?.name ?? "error"})`);
}

export class MongoEngineUsers implements EngineUsers {
  private readonly data: DataSettings;
  private readonly cfg: EngineUserSettings;
  private readonly clients = new Map<string, MongoClient>();

  constructor(data: DataSettings, cfg: EngineUserSettings) {
    this.data = data;
    this.cfg = cfg;
  }

  private options(): MongoClientOptions {
    const d = this.data;
    const p = this.cfg.provisioner;
    return {
      directConnection: true,
      appName: "fenvix-provisioner",
      maxPoolSize: 2,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      connectTimeoutMS: d.connectTimeoutMs,
      serverSelectionTimeoutMS: d.connectTimeoutMs,
      socketTimeoutMS: d.commandTimeoutMs + 2000,
      retryWrites: false,
      retryReads: false,
      monitorCommands: false,
      tls: d.tls,
      ...(d.tls && d.tlsCaFile ? { tlsCAFile: d.tlsCaFile } : {}),
      ...(d.tls && d.tlsServerName ? { servername: d.tlsServerName } : {}),
      auth: { username: p.username, password: p.password },
      authMechanism: "SCRAM-SHA-256",
      authSource: p.authSource,
    };
  }

  private client(region: string): MongoClient {
    const addr = this.data.endpoints[region];
    if (!addr) throw new EngineError("invalid", `there is no engine for region ${region}`);
    let c = this.clients.get(region);
    if (!c) {
      c = new MongoClient(`mongodb://${addr}/`, this.options());
      c.on("error", () => {}); // its message can carry the address
      this.clients.set(region, c);
    }
    return c;
  }

  private async command(region: string, db: string, cmd: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    try {
      return await this.client(region).db(db).command(cmd, { maxTimeMS: this.data.commandTimeoutMs } as never);
    } catch (e) {
      throw Object.assign(toEngineError(e, what), { engineCode: code(e) });
    }
  }

  async ensure(id: string, region: string): Promise<void> {
    const c: EngineCredential = engineCredential(this.cfg.current, id);
    const roles = [{ role: USER_ROLE, db: c.authSource }];
    const customData = { fenvix: { keyVersion: c.version } };
    try {
      await this.command(region, c.authSource, { createUser: c.username, pwd: c.password, roles, customData, mechanisms: ["SCRAM-SHA-256"] }, "create the database's user");
    } catch (e) {
      if ((e as { engineCode?: number }).engineCode !== USER_EXISTS) throw e;
      // Already there (a retry, or a rotation): set the password and the role again, so a changed user is repaired.
      await this.command(region, c.authSource, { updateUser: c.username, pwd: c.password, roles, customData, mechanisms: ["SCRAM-SHA-256"] }, "update the database's user");
    }
  }

  async drop(id: string, region: string): Promise<{ dropped: boolean }> {
    try {
      await this.command(region, engineName(id), { dropUser: engineUserName(id) }, "drop the database's user");
      return { dropped: true };
    } catch (e) {
      if ((e as { engineCode?: number }).engineCode === USER_NOT_FOUND) return { dropped: false };
      throw e;
    }
  }

  async list(region: string): Promise<EngineUserInfo[]> {
    const r = await this.command(region, "admin", { usersInfo: { forAllDBs: true } }, "list users");
    const users = Array.isArray(r.users) ? r.users : [];
    const out: EngineUserInfo[] = [];
    for (const u of users as { user?: unknown; db?: unknown; customData?: { fenvix?: { keyVersion?: unknown } } }[]) {
      const name = typeof u.user === "string" ? u.user : "";
      const db = typeof u.db === "string" ? u.db : "";
      const id = idFromEngineUserName(name);
      // Only users this service made, on the database they belong to.
      if (id && db === engineName(id)) out.push({ id, keyVersion: typeof u.customData?.fenvix?.keyVersion === "string" ? u.customData.fenvix.keyVersion : null });
    }
    return out;
  }

  currentVersion(): string { return this.cfg.current.version; }

  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.close().catch(() => {})));
  }
}

export type FakeUserOp = "ensure" | "drop" | "list";

/** In memory, for tests and ENGINE_DRIVER=fake: records users and their key version, can be told to fail. */
export class FakeEngineUsers implements EngineUsers {
  /** id -> key version of its password. */
  readonly users = new Map<string, string>();
  readonly calls: Record<FakeUserOp, number> = { ensure: 0, drop: 0, list: 0 };
  private readonly failures: { op: FakeUserOp; kind: ConstructorParameters<typeof EngineError>[0]; times: number }[] = [];
  private readonly key: EngineUserKey;

  constructor(key: EngineUserKey = { version: "v1", secret: Buffer.from("fake-engine-user-key-for-tests-only-000") }) { this.key = key; }

  failNext(op: FakeUserOp, kind: ConstructorParameters<typeof EngineError>[0] = "unavailable", times = 1): void {
    this.failures.push({ op, kind, times });
  }

  private enter(op: FakeUserOp): void {
    this.calls[op]++;
    const f = this.failures.find((x) => x.op === op && x.times > 0);
    if (f) { f.times--; throw new EngineError(f.kind, `fake users: ${op} failed (${f.kind})`); }
  }

  async ensure(id: string, _region: string): Promise<void> {
    this.enter("ensure");
    engineName(id); // same validation as the real one
    this.users.set(id, this.key.version);
  }

  async drop(id: string, _region: string): Promise<{ dropped: boolean }> {
    this.enter("drop");
    return { dropped: this.users.delete(id) };
  }

  async list(_region: string): Promise<EngineUserInfo[]> {
    this.enter("list");
    return [...this.users].map(([id, keyVersion]) => ({ id, keyVersion }));
  }

  currentVersion(): string { return this.key.version; }

  async close(): Promise<void> {}
}

/** No per-database users: ENGINE_DRIVER=real with the Data Explorer off, or local development without authentication. */
export class NoEngineUsers implements EngineUsers {
  async ensure(): Promise<void> {}
  async drop(): Promise<{ dropped: boolean }> { return { dropped: false }; }
  async list(): Promise<EngineUserInfo[]> { return []; }
  currentVersion(): null { return null; }
  async close(): Promise<void> {}
}
