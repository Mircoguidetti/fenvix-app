import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { Readable, type Writable } from "node:stream";
import type { Config } from "./config.ts";
import type { Services } from "./context.ts";
import { Db } from "./db.ts";
import { type EngineClient, EngineError } from "./engine/types.ts";
import type { DataClient } from "./engine/data.ts";
import { FakeDataClient } from "./engine/data-fake.ts";
import { MongoDataClient } from "./engine/data-mongo.ts";
import { type EngineUsers, FakeEngineUsers, MongoEngineUsers, NoEngineUsers } from "./engine/users.ts";
import { reconcileEngineUsers } from "./services/engine-users.ts";
import { ApiError, internal, notFound } from "./errors.ts";
import { JwtVerifier } from "./auth/jwt.ts";
import { type AuthGateway } from "./auth/gateway.ts";
import { type Deps } from "./http.ts";
import { RateLimiter } from "./ratelimit.ts";
import { OnceSecrets } from "./once.ts";
import { OperationRunner } from "./services/operations.ts";
import { buildInvoicePdf } from "./services/account.ts";
import { buildUsageCsv, syncAllUsage } from "./services/usage.ts";
import { verifyDownload } from "./downloads.ts";
import { dataRoutes } from "./routes/data.ts";
import { sessionRoutes } from "./routes/session.ts";
import { explorerRoutes } from "./routes/explorer.ts";
import { usersRoutes } from "./routes/users.ts";

export interface AppOptions {
  cfg: Config;
  engine: EngineClient;
  /** The Data Explorer's client; defaults to what cfg.data says (the official driver, the in-memory fake, or none). */
  data?: DataClient;
  /** Per-database engine users; defaults to what cfg.engineUsers says (the engine, the in-memory fake, or none). */
  users?: EngineUsers;
  gateway: AuthGateway;
  /** Defaults to a pool on cfg.databaseUrl. */
  db?: Db;
  verifier?: JwtVerifier;
  /** Where log lines go; stdout when omitted. Tests pass a stream to read them. */
  logStream?: Writable;
}

export interface App {
  fastify: FastifyInstance;
  deps: Deps;
  /** Every route that was registered, as "METHOD /path". */
  routes: string[];
  /** Starts the background sweeps (operations, usage sync). */
  startBackground(): void;
  close(): Promise<void>;
}

const REQ_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** The path as logged: no query string, and nothing after `/data/` (collection names and document ids stay out of logs). */
export const logPath = (url: string) => url.split("?")[0]!.replace(/^(\/v1\/databases\/[^/]+\/data)\/.*$/, "$1/[redacted]");

function defaultDataClient(cfg: Config): DataClient {
  // Only the master key goes to the Data Explorer, never the provisioner (cfg.engineUsers.provisioner).
  if (cfg.data.driver === "mongo") return new MongoDataClient(cfg.data, cfg.engineUsers ? { current: cfg.engineUsers.current, previous: cfg.engineUsers.previous } : null);
  // "off" also gets the fake so the interface is always there; the routes answer 503 before using it.
  return new FakeDataClient();
}

function defaultUsers(cfg: Config): EngineUsers {
  if (cfg.engineUsers) return new MongoEngineUsers(cfg.data, cfg.engineUsers);
  if (cfg.engineDriver === "fake") return new FakeEngineUsers();
  // ENGINE_DRIVER=real without the Data Explorer (or local development without authentication): no users to manage.
  return new NoEngineUsers();
}

export async function buildApp(opts: AppOptions): Promise<App> {
  const { cfg } = opts;
  const db = opts.db ?? new Db(cfg.databaseUrl, cfg.dbPoolMax, cfg.dbStatementTimeoutMs);

  const fastify = Fastify({
    trustProxy: cfg.trustProxy,
    bodyLimit: 256 * 1024,
    // Signed download links are longer than the default of 100 characters.
    routerOptions: { maxParamLength: 2048 },
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && REQ_ID.test(given) ? given : randomUUID();
    },
    requestIdHeader: false,
    logger: {
      level: cfg.logLevel,
      stream: opts.logStream,
      // Never log credentials, and log the path without its query string (it can hold a sign-in code).
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]"], censor: "[redacted]" },
      serializers: {
        req: (r) => ({ method: r.method, path: logPath(String(r.url)) }),
        res: (r) => ({ statusCode: r.statusCode }),
      },
    },
  });

  const routes: string[] = [];
  fastify.addHook("onRoute", (r) => { for (const m of [r.method].flat()) if (m !== "HEAD" && m !== "OPTIONS") routes.push(`${m} ${r.url}`); });

  const data = opts.data ?? defaultDataClient(cfg);
  const users = opts.users ?? defaultUsers(cfg);
  const s: Services = { cfg, db, engine: opts.engine, data, users, once: new OnceSecrets(), log: fastify.log };
  const runner = new OperationRunner(s);
  const deps: Deps = {
    s,
    gateway: opts.gateway,
    verifier: opts.verifier ?? new JwtVerifier(cfg.supabaseUrl, cfg.supabaseJwksUrl),
    runner,
    limiter: new RateLimiter(),
  };

  await fastify.register(cookie);
  if (cfg.dashboardOrigins.length > 0) {
    await fastify.register(cors, {
      origin: cfg.dashboardOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
      exposedHeaders: ["Retry-After", "X-Request-Id", "Location", "Operation-Id", "Idempotent-Replay"],
      maxAge: 600,
    });
  }

  fastify.addHook("onSend", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
    reply.header("X-Content-Type-Options", "nosniff");
  });

  fastify.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.code(err.status).send(err.body());
    }
    const code = (err as FastifyError).code ?? "";
    if (code.startsWith("FST_ERR_CTP") || (err as FastifyError).statusCode === 400 || err instanceof SyntaxError) {
      const msg = code === "FST_ERR_CTP_BODY_TOO_LARGE" ? "The request body is too large." : "The request body is not valid JSON.";
      return reply.code(400).send(new ApiError("validation_failed", msg).body());
    }
    req.log.error({ err: { message: err.message, name: err.name, code } }, "request failed");
    return reply.code(500).send(internal().body());
  });

  fastify.setNotFoundHandler((_req, reply) => reply.code(404).send(notFound("There is no such endpoint.").body()));

  fastify.get("/healthz", async () => ({ ok: true }));
  fastify.get("/readyz", async (_req, reply) => {
    try { await db.ping(); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  // Files this service builds itself. The signed link is the credential, so no session is needed.
  fastify.get("/v1/downloads/:token", async (req, reply) => {
    deps.limiter.hit(`anon:${req.ip}`, cfg.rateLimitAnonPerMinute);
    const claim = verifyDownload(cfg.downloadSigningKey, String((req.params as { token: string }).token));
    if (!claim) throw notFound("This download link has expired or is not valid.");
    reply.header("Cache-Control", "no-store");
    if (claim.kind === "engine-export") {
      if (!s.engine.openExportArchive) throw notFound("This download link has expired or is not valid.");
      const a = await s.engine.openExportArchive(String(claim.p.exportId)).catch((e) => {
        if (e instanceof EngineError && e.kind === "not_found") throw notFound("This export has expired or does not exist.");
        throw e;
      });
      reply.header("Content-Type", a.mimeType).header("Content-Disposition", `attachment; filename="${a.filename}"`);
      return reply.send(Readable.from(a.body));
    }
    if (claim.kind === "usage-csv") {
      const { filename, csv } = await buildUsageCsv(s, claim.ws, claim.p as unknown as Parameters<typeof buildUsageCsv>[2]);
      return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="${filename}"`).send(csv);
    }
    const pdf = await buildInvoicePdf(s, claim.ws, String(claim.p.id));
    if (!pdf) throw notFound("This download link has expired or is not valid.");
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `attachment; filename="${pdf.filename}"`).send(Buffer.from(pdf.body, "latin1"));
  });

  await fastify.register(async (v1) => {
    sessionRoutes(v1, deps);
    dataRoutes(v1, deps);
    await v1.register(async (sub) => explorerRoutes(sub, deps));
    await v1.register(async (sub) => usersRoutes(sub, deps));
  }, { prefix: "/v1" });

  let usageTimer: NodeJS.Timeout | undefined;
  let usersTimer: NodeJS.Timeout | undefined;
  return {
    fastify,
    deps,
    routes,
    startBackground() {
      runner.start(cfg.operationSweepSeconds);
      void runner.sweepOnce().catch((e) => fastify.log.error({ err: String(e) }, "first operation sweep failed"));
      if (cfg.usageSyncSeconds > 0) {
        let busy = false;
        usageTimer = setInterval(() => {
          if (busy) return;
          busy = true;
          syncAllUsage(s).catch((e) => fastify.log.error({ err: String(e) }, "usage sync failed")).finally(() => { busy = false; });
        }, cfg.usageSyncSeconds * 1000);
        usageTimer.unref();
      }
      const sweep = cfg.engineUsers?.sweepSeconds ?? 0;
      if (sweep > 0) {
        let busy = false;
        usersTimer = setInterval(() => {
          if (busy) return;
          busy = true;
          reconcileEngineUsers(s).catch((e) => fastify.log.error({ err: e instanceof Error ? e.message : String(e) }, "engine user sweep failed")).finally(() => { busy = false; });
        }, sweep * 1000);
        usersTimer.unref();
      }
    },
    async close() {
      if (usageTimer) clearInterval(usageTimer);
      if (usersTimer) clearInterval(usersTimer);
      await runner.stop();
      await fastify.close();
      if (!opts.data) await data.close();
      if (!opts.users) await users.close();
      if (!opts.db) await db.close();
    },
  };
}
