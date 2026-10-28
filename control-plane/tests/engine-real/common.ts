import type { LightMyRequestResponse as Res } from "fastify";
import { RealEngine } from "../../src/engine/real.ts";
import { MongoDataClient } from "../../src/engine/data-mongo.ts";
import type { EngineClient } from "../../src/engine/types.ts";
import { type EngineUsers, MongoEngineUsers } from "../../src/engine/users.ts";
import type { Config } from "../../src/config.ts";
import { type Fixture, type Harness, json, sleep, startHarness } from "../helpers/harness.ts";
import { type EngineEnv, startEngines } from "../helpers/engine-proc.ts";

/**
 * The engine-real suite: the whole control plane (HTTP API, restricted Postgres role, operations, Data Explorer) with
 * ENGINE_DRIVER=real against REAL engine processes that the suite starts and stops itself. Off unless
 *
 *   ENGINE_E2E_BIN=<mongo-server with --admin-listen: branch control-ops, or the fused branch>
 *   ENGINE_E2E_AUTH_BIN=<mongo-server with --auth/--tls-mode: branch compat-gaps> (not needed with the fused branch)
 *
 * are set (and TEST_DATABASE_URL, as for the integration suite). `npm run test:engine-real`.
 */
export const ADMIN_BIN = process.env.ENGINE_E2E_BIN;
export const AUTH_BIN = process.env.ENGINE_E2E_AUTH_BIN;
export const SKIP: false | string = ADMIN_BIN ? false : "set ENGINE_E2E_BIN (and ENGINE_E2E_AUTH_BIN unless the binary is the fused engine) to run against the real engine";

export const cookie = { origin: "https://app.fenvix.test" };

export interface World {
  e: EngineEnv;
  h: Harness;
  data: MongoDataClient;
  users: EngineUsers;
  engine: EngineClient;
  u: Fixture;
  /** Runs what is due now (queued operations past their retry time are made due first). */
  sweep(): Promise<void>;
  /**
   * The final state of a submitted operation (an answer, or an operation id): runs the sweeper until it is no longer
   * queued or running. An answer that is not a 202 is returned as it is.
   */
  settle(res: Res | string, rounds?: number): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export function cpEnv(e: EngineEnv, over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ENGINE_DRIVER: "real",
    ENGINE_ADMIN_ENDPOINTS: e.adminUrl,
    ENGINE_ADMIN_TOKEN_FILE: e.tokenFile,
    ENGINE_RETENTION_WINDOW_SECS: "3600",
    ENGINE_RETENTION_INTERVAL_SECS: "1",
    ENGINE_REQUEST_TIMEOUT_MS: "3000",
    ENGINE_LONG_REQUEST_TIMEOUT_MS: "6000",
    CONNECTION_PORT: "27018",
    BASE_DOMAIN: "db.example.test",
    HOST_TEMPLATE: "<name>-<workspace>.<region>.<BASE_DOMAIN>",
    CONNECTION_DB_NAME: "engine",
    DATA_ENGINE_ENDPOINTS: e.dataAddr,
    DATA_ENGINE_TLS: "true",
    DATA_ENGINE_TLS_CA_FILE: e.caFile,
    DATA_ENGINE_CONNECT_TIMEOUT_MS: "3000",
    DATA_COMMAND_TIMEOUT_MS: "5000",
    DATA_ENGINE_CLIENT_IDLE_CLOSE_MS: "2000",
    ENGINE_USER_KEY: e.userKey,
    ENGINE_PROVISIONER_USERNAME: e.provisioner.username,
    ENGINE_PROVISIONER_PASSWORD: e.provisioner.password,
    ENGINE_USER_SWEEP_SECONDS: "0",
    RATE_LIMIT_PER_MINUTE: "100000", DATA_RATE_LIMIT_PER_MINUTE: "100000", DATA_WRITE_RATE_LIMIT_PER_MINUTE: "100000",
    OPERATION_WAIT_MS: "10000",
    ...over,
  };
}

export interface WorldOptions {
  /** Wraps the real per-database users (to inject a failure in our own code path). */
  wrapUsers?: (u: EngineUsers) => EngineUsers;
  wrapEngine?: (e: EngineClient) => EngineClient;
  engines?: EngineEnv;
}

export async function startWorld(over: Record<string, string | undefined> = {}, o: WorldOptions = {}): Promise<World> {
  const e = o.engines ?? (await startEngines(ADMIN_BIN!, AUTH_BIN));
  let data!: MongoDataClient;
  let users!: EngineUsers;
  let engine!: EngineClient;
  const h = await startHarness(cpEnv(e, over), {
    engineFactory: (cfg: Config) => {
      const real = new RealEngine({ settings: cfg.engine!, downloadSigningKey: cfg.downloadSigningKey, apiPublicUrl: cfg.apiPublicUrl });
      engine = o.wrapEngine ? o.wrapEngine(real) : real;
      return engine;
    },
    // The Data Explorer gets the master key only, exactly as app.ts gives it: never the provisioner.
    dataFactory: (cfg: Config) => (data = new MongoDataClient(cfg.data, { current: cfg.engineUsers!.current, previous: cfg.engineUsers!.previous })),
    usersFactory: (cfg: Config) => {
      const real = new MongoEngineUsers(cfg.data, cfg.engineUsers!);
      users = o.wrapUsers ? o.wrapUsers(real) : real;
      return users;
    },
  });
  const u = await h.user("Engine Real");
  const sweep = async () => {
    await h.admin.query("update public.operations set retry_at = now() where status = 'queued'");
    await h.app.deps.runner.sweepOnce();
  };
  return {
    e, h, data, users, engine, u, sweep,
    async settle(res, rounds = 30) {
      if (typeof res !== "string" && res.statusCode !== 202) return { status: res.statusCode, body: json(res) };
      const opId = typeof res === "string" ? res : String(res.headers["operation-id"]);
      for (let i = 0; i < rounds; i++) {
        const op = json(await h.as(u).get(`/operations/${opId}`));
        if (op.status === "succeeded" || op.status === "failed") return { status: op.status === "succeeded" ? 200 : 500, body: op };
        await sweep();
        await sleep(200);
      }
      return { status: 202, body: json(await h.as(u).get(`/operations/${opId}`)) };
    },
    async close() {
      await data?.close();
      await users?.close();
      await h.close();
      if (!o.engines) await e.stop();
    },
  };
}

/** Every user this service made on the engine (`cp_<hex>` on `db_<hex>`), read as root. */
export async function engineUsers(e: EngineEnv): Promise<{ user: string; db: string; roles: { role: string; db: string }[] }[]> {
  const r = e.rootClient();
  try {
    const res = await r.db("admin").command({ usersInfo: { forAllDBs: true } });
    return (res.users as { user: string; db: string; roles: { role: string; db: string }[] }[]).filter((x) => x.user.startsWith("cp_"));
  } finally { await r.close(); }
}

/** Does the admin engine have this database? (GET as the test, with the token; the control plane may not list.) */
export async function engineHas(e: EngineEnv, dbName: string): Promise<boolean> {
  const r = await fetch(`${e.adminUrl}/v1/databases/${dbName}?storage=false`, { headers: { authorization: `Bearer ${e.token}` } });
  await r.arrayBuffer();
  if (r.status === 200) return true;
  if (r.status === 404) return false;
  throw new Error(`engine answered ${r.status}`);
}

/** The control plane's log and the engines' logs must never contain any of these. */
export function secretsOf(w: World): string[] {
  const k = w.h.cfg.engineUsers!;
  return [w.e.token, w.e.provisioner.password, w.e.root.password, k.current.secret.toString("utf8"), w.e.userKey];
}
