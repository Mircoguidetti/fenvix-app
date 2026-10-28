import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";
import type { LightMyRequestResponse as Res } from "fastify";
import pg from "pg";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from "jose";
import { buildApp, type App } from "../../src/app.ts";
import { loadConfig, type Config } from "../../src/config.ts";
import { JwtVerifier } from "../../src/auth/jwt.ts";
import { FakeEngine } from "../../src/engine/fake.ts";
import type { EngineClient } from "../../src/engine/types.ts";
import { FakeGateway } from "./fake-gateway.ts";
import { Db } from "../../src/db.ts";

export const SUPABASE_URL = "https://project.supabase.invalid";
export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:54329/cp_test?host=/tmp/pgscratch";
export const DASHBOARD = "https://app.fenvix.test";

if (/supabase\.(co|com)|pooler/.test(ADMIN_URL)) throw new Error("TEST_DATABASE_URL looks like a hosted Supabase project; the tests need a scratch database.");

/** Signs and publishes session tokens the way a Supabase project does: asymmetric keys, served as a JWKS. */
export class Signer {
  readonly kid = "test-key-1";
  private priv!: CryptoKey;
  private jwk!: JWK;
  private server!: Server;
  jwksUrl = "";
  /** How many times the JWKS endpoint was fetched. */
  jwksFetches = 0;

  async start(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    this.priv = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: this.kid, alg: "ES256", use: "sig" };
    this.server = createServer((req, res) => {
      if (req.url === "/jwks.json") {
        this.jwksFetches++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [this.jwk] }));
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.jwksUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/jwks.json`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  async token(user: { id: string; email: string; name?: string; avatar?: string }, o: { expiresIn?: string | number; issuer?: string; audience?: string } = {}): Promise<string> {
    return new SignJWT({ email: user.email, user_metadata: { full_name: user.name, avatar_url: user.avatar } })
      .setProtectedHeader({ alg: "ES256", kid: this.kid })
      .setIssuer(o.issuer ?? `${SUPABASE_URL}/auth/v1`)
      .setAudience(o.audience ?? "authenticated")
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(o.expiresIn ?? "1h")
      .sign(this.priv);
  }
}

export interface Fixture { userId: string; email: string; name: string; workspaceId: string; token: string }

export class Lines extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer, _enc: string, cb: () => void): void { this.lines.push(...chunk.toString().split("\n").filter(Boolean)); cb(); }
  text(): string { return this.lines.join("\n"); }
}

export interface Client {
  get(url: string, h?: Record<string, string>): Promise<Res>;
  post(url: string, body?: unknown, h?: Record<string, string>): Promise<Res>;
  put(url: string, body?: unknown, h?: Record<string, string>): Promise<Res>;
  del(url: string, h?: Record<string, string>): Promise<Res>;
}

export interface Harness {
  app: App;
  cfg: Config;
  engine: FakeEngine;
  gateway: FakeGateway;
  signer: Signer;
  admin: pg.Pool;
  logs: Lines;
  cpUrl: string;
  cpPassword: string;
  /** A new user with a workspace of their own (the sign-up trigger makes it). */
  user(name?: string): Promise<Fixture>;
  /** Adds an existing user to another workspace with a role. */
  addMember(ws: string, name: string, role: "owner" | "admin" | "member"): Promise<Fixture>;
  apiKey(ws: string, name?: string): Promise<string>;
  /** inject() with a session cookie or API key. */
  as(who: Fixture | string): Client;
  close(): Promise<void>;
}

const dropActiveOperations = (admin: pg.Pool) =>
  admin.query("update public.operations set status = 'failed', finished_at = now(), error = '{\"code\":\"internal\",\"message\":\"test cleanup\"}' where status in ('queued', 'running')");

export async function startHarness(over: Record<string, string | undefined> = {}, opts: { engine?: FakeEngine; gateway?: FakeGateway; /** Use this engine client instead of the fake (the fake in `Harness.engine` is then unused). */ engineFactory?: (cfg: Config) => EngineClient } = {}): Promise<Harness> {
  const adminUrl = process.env.TEST_DATABASE_URL ?? ADMIN_URL;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 4 });
  // The sweeper looks across workspaces, so leftovers of an earlier test must not be picked up by this one.
  await dropActiveOperations(admin);
  const cpPassword = randomBytes(18).toString("hex"); // random per run, only ever on the local scratch database
  await admin.query(`alter role fenvix_control_plane with password '${cpPassword}'`);
  const u = new URL(adminUrl);
  u.username = "fenvix_control_plane";
  u.password = cpPassword;
  const cpUrl = u.toString();

  const signer = new Signer();
  await signer.start();
  const cfg = loadConfig({
    CONTROL_PLANE_DATABASE_URL: cpUrl,
    SUPABASE_URL,
    SUPABASE_JWKS_URL: signer.jwksUrl,
    SUPABASE_ANON_KEY: "anon-key-for-tests",
    DOWNLOAD_SIGNING_KEY: randomBytes(32).toString("hex"),
    ENGINE_DRIVER: "fake",
    API_PUBLIC_URL: "https://api.fenvix.test/v1",
    DASHBOARD_ORIGINS: DASHBOARD,
    COOKIE_SECURE: "true",
    LOG_LEVEL: "info",
    OPERATION_WAIT_MS: "5000",
    OPERATION_SWEEP_SECONDS: "0",
    ...over,
  });
  const engine = opts.engine ?? new FakeEngine();
  const gateway = opts.gateway ?? new FakeGateway(signer);
  const logs = new Lines();
  const appDb = new Db(cpUrl, 6);
  const app = await buildApp({
    cfg, engine: opts.engineFactory ? opts.engineFactory(cfg) : engine, gateway, logStream: logs,
    db: appDb,
    verifier: new JwtVerifier(cfg.supabaseUrl, cfg.supabaseJwksUrl),
  });
  await app.fastify.ready();

  const make = async (userId: string, email: string, name: string, workspaceId: string): Promise<Fixture> => ({
    userId, email, name, workspaceId, token: await signer.token({ id: userId, email, name }),
  });

  const h: Harness = {
    app, cfg, engine, gateway, signer, admin, logs, cpUrl, cpPassword,
    async user(name = "Test User") {
      const id = randomUUID();
      const email = `${id.slice(0, 8)}@example.invalid`;
      await admin.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, email, JSON.stringify({ full_name: name })]);
      const ws = (await admin.query("select workspace_id from public.workspace_members where user_id = $1", [id])).rows[0].workspace_id as string;
      gateway.register({ id, email, name });
      return make(id, email, name, ws);
    },
    async addMember(ws, name, role) {
      const id = randomUUID();
      const email = `${id.slice(0, 8)}@example.invalid`;
      await admin.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, email, JSON.stringify({ full_name: name })]);
      // the trigger gave them a workspace of their own; move them into the other one
      await admin.query("delete from public.workspace_members where user_id = $1", [id]);
      await admin.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [ws, id, role]);
      return make(id, email, name, ws);
    },
    async apiKey(ws, name = "test key") {
      const secret = `fnx_${randomBytes(32).toString("hex")}`;
      await admin.query("insert into public.api_keys (workspace_id, name, key_hash, last4) values ($1, $2, $3, $4)", [ws, name, createHash("sha256").update(secret).digest("hex"), secret.slice(-4)]);
      return secret;
    },
    as(who) {
      const headers = (extra: Record<string, string> = {}) => ({
        ...(typeof who === "string" ? { authorization: `Bearer ${who}` } : { cookie: `fnx_session=${who.token}` }),
        ...extra,
      });
      const f = app.fastify;
      return {
        get: (url, h) => f.inject({ method: "GET", url: `/v1${url}`, headers: headers(h) }),
        post: (url, body, h) => f.inject({ method: "POST", url: `/v1${url}`, headers: headers(h), payload: body === undefined ? undefined : (body as object) }),
        put: (url, body, h) => f.inject({ method: "PUT", url: `/v1${url}`, headers: headers(h), payload: body as object }),
        del: (url, h) => f.inject({ method: "DELETE", url: `/v1${url}`, headers: headers(h) }),
      };
    },
    async close() {
      await app.close();
      await dropActiveOperations(admin);
      await appDb.close();
      await signer.stop();
      await admin.end();
    },
  };
  return h;
}

export const json = <T = any>(res: { body: string }): T => JSON.parse(res.body) as T;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
