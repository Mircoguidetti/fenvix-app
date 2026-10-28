import { createHash } from "node:crypto";
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

  // ---- the customer's own users of a database (docs/database-users.md). Defined on `db_<hex>`, one role on it only.

  /** False when this deployment cannot make engine users (no provisioner): the users routes answer 503. */
  readonly customerUsers: boolean;
  /** The customer users of a database, never `cp_<hex>`. */
  listCustomer(id: string, region: string): Promise<CustomerUser[]>;
  /** Creates a user. `conflict` when the name is taken. `role` comes from CUSTOMER_ROLES only, never from a request. */
  createCustomer(id: string, region: string, u: { username: string; role: CustomerRole; password: string; createdAt: string }): Promise<void>;
  /** Creates the user, or (a retry of the same operation) sets its password and role again. */
  ensureCustomer(id: string, region: string, u: { username: string; role: CustomerRole; password: string; createdAt: string }): Promise<void>;
  /** New password for an existing customer user. `not_found` when there is no such user. */
  setCustomerPassword(id: string, region: string, username: string, password: string): Promise<void>;
  /** `{ dropped: false }` when there was no such user. */
  dropCustomer(id: string, region: string, username: string): Promise<{ dropped: boolean }>;
  /**
   * Erase, step 1: every customer user of the database loses its roles at once (open connections included), and its
   * roles are kept in the user's own customData on the engine, so a refused erase can give them back. Repeatable.
   */
  lockCustomers(id: string, region: string): Promise<number>;
  /** A refused erase: the roles kept by `lockCustomers` are given back. Repeatable. */
  unlockCustomers(id: string, region: string): Promise<number>;
  /**
   * Drops EVERY user defined on the database (its `cp_<hex>` and the customer's), before the database is erased: the
   * engine's erase leaves users in place. Returns how many were dropped.
   */
  dropAll(id: string, region: string): Promise<number>;
  close(): Promise<void>;
}

export interface EngineUserInfo { id: string; keyVersion: string | null }

/**
 * The only roles a customer user can have, and the engine role each one is. A request names one of the keys; the
 * engine role and its database (always the user's own `db_<hex>`) are set here and nowhere else.
 */
export const CUSTOMER_ROLES = { readWrite: "readWrite", read: "read" } as const;
export type CustomerRole = keyof typeof CUSTOMER_ROLES;
export const isCustomerRole = (v: unknown): v is CustomerRole => typeof v === "string" && Object.hasOwn(CUSTOMER_ROLES, v);

export interface CustomerUser {
  username: string;
  /** "other" when the engine holds a role that is not exactly one of CUSTOMER_ROLES on the database (made by hand). */
  role: CustomerRole | "other";
  createdAt: string | null;
}

/** The role of a user as listed by `usersInfo`, mapped back to the fixed list. */
export function roleOf(roles: unknown, db: string): CustomerRole | "other" {
  if (!Array.isArray(roles) || roles.length !== 1) return "other";
  const r = roles[0] as { role?: unknown; db?: unknown };
  if (r.db !== db) return "other";
  for (const [k, v] of Object.entries(CUSTOMER_ROLES)) if (r.role === v) return k as CustomerRole;
  return "other";
}

const customData = (createdAt: string) => ({ fenvix: { kind: "customer", createdAt } });

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

  readonly customerUsers = true;

  private customerCommand(id: string, username: string, role: CustomerRole, password: string, createdAt: string, verb: "createUser" | "updateUser") {
    const db = engineName(id);
    return {
      [verb]: username, pwd: password, roles: [{ role: CUSTOMER_ROLES[role], db }],
      ...(verb === "createUser" ? { customData: customData(createdAt) } : {}),
      mechanisms: ["SCRAM-SHA-256"],
    };
  }

  async listCustomer(id: string, region: string): Promise<CustomerUser[]> {
    const db = engineName(id);
    const own = engineUserName(id);
    const r = await this.command(region, db, { usersInfo: 1, showCustomData: true }, "list the database's users");
    const users = Array.isArray(r.users) ? r.users : [];
    const out: CustomerUser[] = [];
    for (const u of users as { user?: unknown; db?: unknown; roles?: unknown; customData?: { fenvix?: { createdAt?: unknown } } }[]) {
      if (typeof u.user !== "string" || u.db !== db || u.user === own) continue;
      const at = u.customData?.fenvix?.createdAt;
      out.push({ username: u.user, role: roleOf(u.roles, db), createdAt: typeof at === "string" ? at : null });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
  }

  async createCustomer(id: string, region: string, u: { username: string; role: CustomerRole; password: string; createdAt: string }): Promise<void> {
    try {
      await this.command(region, engineName(id), this.customerCommand(id, u.username, u.role, u.password, u.createdAt, "createUser"), "create a user");
    } catch (e) {
      if ((e as { engineCode?: number }).engineCode === USER_EXISTS) throw new EngineError("conflict", "a user with that name exists");
      throw e;
    }
  }

  async ensureCustomer(id: string, region: string, u: { username: string; role: CustomerRole; password: string; createdAt: string }): Promise<void> {
    try {
      await this.createCustomer(id, region, u);
    } catch (e) {
      if (!(e instanceof EngineError) || e.kind !== "conflict") throw e;
      await this.command(region, engineName(id), this.customerCommand(id, u.username, u.role, u.password, u.createdAt, "updateUser"), "update a user");
    }
  }

  async setCustomerPassword(id: string, region: string, username: string, password: string): Promise<void> {
    try {
      await this.command(region, engineName(id), { updateUser: username, pwd: password, mechanisms: ["SCRAM-SHA-256"] }, "set a user's password");
    } catch (e) {
      if ((e as { engineCode?: number }).engineCode === USER_NOT_FOUND) throw new EngineError("not_found", "no such user");
      throw e;
    }
  }

  async dropCustomer(id: string, region: string, username: string): Promise<{ dropped: boolean }> {
    try {
      await this.command(region, engineName(id), { dropUser: username }, "drop a user");
      return { dropped: true };
    } catch (e) {
      if ((e as { engineCode?: number }).engineCode === USER_NOT_FOUND) return { dropped: false };
      throw e;
    }
  }

  private async rawUsers(id: string, region: string) {
    const db = engineName(id);
    const r = await this.command(region, db, { usersInfo: 1, showCustomData: true }, "list the database's users");
    return (Array.isArray(r.users) ? r.users : []).filter((u: { user?: unknown; db?: unknown }) => typeof u.user === "string" && u.db === db && u.user !== engineUserName(id)) as
      { user: string; roles?: unknown; customData?: { fenvix?: Record<string, unknown> } }[];
  }

  async lockCustomers(id: string, region: string): Promise<number> {
    let n = 0;
    for (const u of await this.rawUsers(id, region)) {
      const roles = Array.isArray(u.roles) ? u.roles.map((x: { role?: unknown; db?: unknown }) => ({ role: x.role, db: x.db })) : [];
      const fenvix = u.customData?.fenvix ?? {};
      if (roles.length === 0) continue; // already locked (a retry)
      await this.command(region, engineName(id), { updateUser: u.user, roles: [], customData: { ...u.customData, fenvix: { ...fenvix, lockedRoles: roles } } }, "lock a user");
      n++;
    }
    return n;
  }

  async unlockCustomers(id: string, region: string): Promise<number> {
    let n = 0;
    for (const u of await this.rawUsers(id, region)) {
      const fenvix = { ...(u.customData?.fenvix ?? {}) };
      const locked = fenvix.lockedRoles;
      if (!Array.isArray(locked)) continue;
      delete fenvix.lockedRoles;
      await this.command(region, engineName(id), { updateUser: u.user, roles: locked, customData: { ...u.customData, fenvix } }, "unlock a user");
      n++;
    }
    return n;
  }

  async dropAll(id: string, region: string): Promise<number> {
    const db = engineName(id);
    const r = await this.command(region, db, { usersInfo: 1 }, "list the database's users");
    const names = (Array.isArray(r.users) ? r.users : [])
      .filter((u: { user?: unknown; db?: unknown }) => typeof u.user === "string" && u.db === db)
      .map((u: { user: string }) => u.user);
    // Its own user is always dropped, even when usersInfo did not show it.
    if (!names.includes(engineUserName(id))) names.push(engineUserName(id));
    let n = 0;
    for (const name of names) {
      try {
        await this.command(region, db, { dropUser: name }, "drop a user");
        n++;
      } catch (e) {
        if ((e as { engineCode?: number }).engineCode !== USER_NOT_FOUND) throw e;
      }
    }
    return n;
  }

  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.close().catch(() => {})));
  }
}

export type FakeUserOp = "ensure" | "drop" | "list" | "customer";

/** In memory, for tests and ENGINE_DRIVER=fake: records users and their key version, can be told to fail. */
export class FakeEngineUsers implements EngineUsers {
  /** id -> key version of its password. */
  readonly users = new Map<string, string>();
  readonly calls: Record<FakeUserOp, number> = { ensure: 0, drop: 0, list: 0, customer: 0 };
  /** Customer users: database id -> user name -> what the engine would keep (a hash of the password, never the password). */
  readonly customers = new Map<string, Map<string, { role: CustomerRole; createdAt: string; passwordHash: string; locked?: boolean }>>();
  readonly customerUsers = true;
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

  /** What a SCRAM verifier stands for here: something that checks a password without being it. */
  static hash(password: string): string { return createHash("sha256").update(`fake-scram\u0000${password}`).digest("hex"); }

  /** True when `password` is the user's current one (tests: the password a route showed really works). */
  checkPassword(id: string, username: string, password: string): boolean {
    return this.customers.get(id)?.get(username)?.passwordHash === FakeEngineUsers.hash(password);
  }

  private db(id: string) {
    engineName(id);
    let m = this.customers.get(id);
    if (!m) { m = new Map(); this.customers.set(id, m); }
    return m;
  }

  async listCustomer(id: string, _region: string): Promise<CustomerUser[]> {
    this.enter("customer");
    return [...this.db(id)].map(([username, u]) => ({ username, role: u.locked ? "other" as const : u.role, createdAt: u.createdAt })).sort((a, b) => a.username.localeCompare(b.username));
  }

  async lockCustomers(id: string, _region: string): Promise<number> {
    this.enter("customer");
    let n = 0;
    for (const u of this.db(id).values()) if (!u.locked) { u.locked = true; n++; }
    return n;
  }

  async unlockCustomers(id: string, _region: string): Promise<number> {
    this.enter("customer");
    let n = 0;
    for (const u of this.db(id).values()) if (u.locked) { u.locked = false; n++; }
    return n;
  }

  async createCustomer(id: string, _region: string, u: { username: string; role: CustomerRole; password: string; createdAt: string }): Promise<void> {
    this.enter("customer");
    if (!isCustomerRole(u.role)) throw new EngineError("invalid", "fake users: role not allowed");
    const m = this.db(id);
    if (m.has(u.username) || u.username === engineUserName(id)) throw new EngineError("conflict", "fake users: exists");
    m.set(u.username, { role: u.role, createdAt: u.createdAt, passwordHash: FakeEngineUsers.hash(u.password) });
  }

  async ensureCustomer(id: string, _region: string, u: { username: string; role: CustomerRole; password: string; createdAt: string }): Promise<void> {
    this.enter("customer");
    if (!isCustomerRole(u.role)) throw new EngineError("invalid", "fake users: role not allowed");
    const m = this.db(id);
    m.set(u.username, { role: u.role, createdAt: m.get(u.username)?.createdAt ?? u.createdAt, passwordHash: FakeEngineUsers.hash(u.password) });
  }

  async setCustomerPassword(id: string, _region: string, username: string, password: string): Promise<void> {
    this.enter("customer");
    const u = this.db(id).get(username);
    if (!u) throw new EngineError("not_found", "fake users: no such user");
    u.passwordHash = FakeEngineUsers.hash(password);
  }

  async dropCustomer(id: string, _region: string, username: string): Promise<{ dropped: boolean }> {
    this.enter("customer");
    return { dropped: this.db(id).delete(username) };
  }

  async dropAll(id: string, _region: string): Promise<number> {
    this.enter("drop");
    const n = (this.customers.get(id)?.size ?? 0) + (this.users.delete(id) ? 1 : 0);
    this.customers.delete(id);
    return n;
  }

  async close(): Promise<void> {}
}

/** No per-database users: ENGINE_DRIVER=real with the Data Explorer off, or local development without authentication. */
export class NoEngineUsers implements EngineUsers {
  async ensure(): Promise<void> {}
  async drop(): Promise<{ dropped: boolean }> { return { dropped: false }; }
  async list(): Promise<EngineUserInfo[]> { return []; }
  currentVersion(): null { return null; }
  /** Without a provisioner no user can be made: databases have no initial user and the users routes answer 503. */
  readonly customerUsers = false;
  private off(): never { throw new EngineError("unavailable", "no provisioner: users cannot be managed on this deployment"); }
  async listCustomer(): Promise<CustomerUser[]> { this.off(); }
  async createCustomer(): Promise<void> { this.off(); }
  async ensureCustomer(): Promise<void> { this.off(); }
  async setCustomerPassword(): Promise<void> { this.off(); }
  async dropCustomer(): Promise<{ dropped: boolean }> { this.off(); }
  async lockCustomers(): Promise<number> { return 0; }
  async unlockCustomers(): Promise<number> { return 0; }
  async dropAll(): Promise<number> { return 0; }
  async close(): Promise<void> {}
}
