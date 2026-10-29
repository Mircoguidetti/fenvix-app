import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient, type MongoClientOptions } from "mongodb";
import { type LocalS3, assertLocal, dropBucket, makeBucket } from "./s3-local.ts";

/**
 * Starts and stops REAL FENVIX engine processes (Mircoguidetti/test5, `mongo-server`) for the engine-real suite.
 *
 * Two shapes, chosen from what the binaries can do (`--help`):
 *  - one binary with both the admin interface (`--admin-listen`, branch control-ops) and authentication + TLS
 *    (`--auth`, `--tls-mode`, branch compat-gaps): ONE process serves both (the fused engine);
 *  - two binaries (ENGINE_E2E_BIN with the admin interface, ENGINE_E2E_AUTH_BIN with authentication): an "admin"
 *    process gets the admin interface and a separate "auth" process is the MongoDB listener the Data Explorer and the
 *    per-database users use. Data written through one is not seen by the other: the suite says which checks need the
 *    fused engine.
 *
 * Two profiles (ENGINE_E2E_PROFILE):
 *  - `memory` (default): `--store memory --no-leases`, admin on 127.0.0.1. A restart brings the engine back EMPTY.
 *  - `production`: as the deployment runs it, without AWS: `--store s3` against a LOCAL S3-compatible store (MinIO,
 *    ENGINE_E2E_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION; one fresh bucket per engine), `--region`, leases on
 *    (`--holder`, short ttl), the admin interface on a separate interface (127.0.0.2 by default, ENGINE_E2E_ADMIN_HOST)
 *    with the token, `--auth`, `--tls-mode requireTLS`, `--log-commands` (command names only: the suite checks which
 *    commands reached the data port). Data and users survive a restart. The S3 credentials are given to the engine
 *    in ITS environment only (AWS_ACCESS_KEY_ID/...); nothing of the caller's AWS_* environment is passed on.
 *
 * Everything lives in a fresh temporary directory: the admin token, a throw-away CA and server certificate, the
 * bootstrap root password. Nothing is a production value and nothing is written in the repository.
 */
export interface EngineCaps { admin: boolean; auth: boolean }

export function capabilities(bin: string): EngineCaps {
  const help = execFileSync(bin, ["--help"], { encoding: "utf8" });
  return { admin: help.includes("--admin-listen"), auth: help.includes("--auth") && help.includes("--tls-mode") };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** A throw-away CA and a certificate for localhost / 127.0.0.1. */
export function makeTls(dir: string): { caFile: string; serverPem: string } {
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=fenvix-test-ca"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost"]);
  writeFileSync(join(dir, "ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  run(["x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.crt", "-days", "2", "-extfile", "ext"]);
  execFileSync("sh", ["-c", "cat srv.crt srv.key > srv.pem"], { cwd: dir });
  return { caFile: join(dir, "ca.pem"), serverPem: join(dir, "srv.pem") };
}

export interface ProcOptions {
  bin: string;
  dataPort: number;
  adminPort?: number;
  tokenFile?: string;
  tls?: { serverPem: string };
  auth?: boolean;
  idleSecs?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  /** Address the admin interface binds to (default 127.0.0.1). */
  adminHost?: string;
  /** `--store s3` against a local S3-compatible store, with leases (the production profile). */
  s3?: LocalS3 & { bucket: string; holder: string };
  logCommands?: boolean;
}

/** One engine process. Its log is kept in memory (the suite checks it for secrets). */
export class EngineProcess {
  readonly o: ProcOptions;
  private child: ChildProcess | null = null;
  log = "";
  starts = 0;

  constructor(o: ProcOptions) { this.o = o; }

  args(): string[] {
    const o = this.o;
    const store = o.s3
      ? ["--store", "s3", "--bucket", o.s3.bucket, "--region", o.s3.region, "--endpoint", o.s3.endpoint, "--holder", o.s3.holder, "--lease-ttl-secs", "10"]
      : ["--store", "memory", "--no-leases"];
    return [
      "--listen", `127.0.0.1:${o.dataPort}`, ...store, "--idle-secs", String(o.idleSecs ?? 3),
      ...(o.logCommands ? ["--log-commands"] : []),
      ...(o.adminPort ? ["--admin-listen", `${o.adminHost ?? "127.0.0.1"}:${o.adminPort}`, "--admin-token-file", o.tokenFile!, "--pin-lease-ttl-secs", "6"] : []),
      ...(o.auth ? ["--auth"] : []),
      ...(o.tls ? ["--tls-mode", "requireTLS", "--tls-certificate-key-file", o.tls.serverPem] : []),
      ...(o.extraArgs ?? []),
    ];
  }

  async start(env: Record<string, string> = {}): Promise<void> {
    if (this.child) throw new Error("already running");
    this.starts++;
    const from = this.log.length;
    // A clean environment: PATH, then (production profile) the LOCAL store's test credentials, never the caller's AWS_*.
    const s3env: Record<string, string> = this.o.s3 ? { AWS_ACCESS_KEY_ID: this.o.s3.accessKey, AWS_SECRET_ACCESS_KEY: this.o.s3.secretKey } : {};
    const child = spawn(this.o.bin, this.args(), { env: { PATH: process.env.PATH ?? "", ...s3env, ...this.o.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (b: Buffer) => { this.log += b.toString(); });
    child.stderr!.on("data", (b: Buffer) => { this.log += b.toString(); });
    this.child = child;
    child.on("exit", () => { if (this.child === child) this.child = null; });
    const deadline = Date.now() + 15_000;
    const need = this.o.adminPort ? "admin interface listening" : "listening on";
    while (!this.log.slice(from).includes(need) || !this.log.slice(from).includes("listening on 127.0.0.1")) {
      if (!this.child) throw new Error(`engine exited at start:\n${this.log.slice(-2000)}`);
      if (Date.now() > deadline) throw new Error(`engine did not start:\n${this.log.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  get running(): boolean { return this.child !== null; }
  get pid(): number | undefined { return this.child?.pid; }

  /** SIGSTOP: the process stays, answers nothing (a slow or hung engine). */
  pause(): void { this.child?.kill("SIGSTOP"); }
  resume(): void { this.child?.kill("SIGCONT"); }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const c = this.child;
    if (!c) return;
    c.kill("SIGCONT");
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    c.kill(signal);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (this.child === c) { c.kill("SIGKILL"); await exited; }
    this.child = null;
  }

  /** kill -9 and start again (memory store: the engine comes back EMPTY). */
  async crashAndRestart(env: Record<string, string> = {}): Promise<void> {
    await this.stop("SIGKILL");
    await this.start(env);
  }
}

export interface EngineEnv {
  fused: boolean;
  /** `production` (local S3 store, leases, separate admin interface: data survives a restart) or `memory`. */
  profile: "memory" | "production";
  admin: EngineProcess;
  /** The MongoDB listener with authentication (the admin process itself when fused). */
  auth: EngineProcess;
  token: string;
  tokenFile: string;
  adminUrl: string;
  dataAddr: string;
  /** host:port of the admin engine's own MongoDB listener (no authentication unless fused). */
  adminDataAddr: string;
  caFile: string;
  root: { username: string; password: string };
  provisioner: { username: string; password: string };
  userKey: string;
  dir: string;
  /** A client of the auth listener as root (setup and checks only; the control plane never has this). */
  rootClient(): MongoClient;
  /** A client of the admin engine's MongoDB listener (root when fused, no credentials otherwise). */
  adminDataClient(): MongoClient;
  /** A client of the auth listener with the given credentials (or none). */
  clientAs(cred?: { username: string; password: string; authSource: string }, extra?: MongoClientOptions): MongoClient;
  /** Root, role and provisioner on the auth listener (again after a restart: the memory store forgets them). */
  bootstrap(): Promise<void>;
  /** The provisioner's role, exactly as the deployment guide makes it. */
  provisionerPrivileges: string[];
  stop(): Promise<void>;
}

export const PROVISIONER_ACTIONS = ["createUser", "dropUser", "viewUser", "changePassword", "changeCustomData", "grantRole", "revokeRole"];

export const PROFILE: "memory" | "production" = process.env.ENGINE_E2E_PROFILE === "production" ? "production" : "memory";

/** The local S3-compatible store of the production profile (required there). */
export function localS3(): LocalS3 {
  const v = (k: string) => { const x = process.env[k]; if (!x) throw new Error(`ENGINE_E2E_PROFILE=production needs ${k}`); return x; };
  const s3 = { endpoint: v("ENGINE_E2E_S3_ENDPOINT"), accessKey: v("ENGINE_E2E_S3_ACCESS_KEY"), secretKey: v("ENGINE_E2E_S3_SECRET_KEY"), region: process.env.ENGINE_E2E_S3_REGION ?? "eu-central-1" };
  assertLocal(s3);
  return s3;
}

export async function startEngines(adminBin: string, authBin: string | undefined): Promise<EngineEnv> {
  const capsA = capabilities(adminBin);
  if (!capsA.admin) throw new Error("ENGINE_E2E_BIN has no admin interface (--admin-listen): build branch control-ops (or the fused branch)");
  const fused = capsA.auth && (!authBin || authBin === adminBin);
  const authPath = fused ? adminBin : authBin;
  if (!authPath) throw new Error("ENGINE_E2E_BIN has no --auth/--tls-mode: set ENGINE_E2E_AUTH_BIN to a binary of branch compat-gaps (or use the fused branch)");
  if (!capabilities(authPath).auth) throw new Error("ENGINE_E2E_AUTH_BIN has no --auth/--tls-mode");

  const dir = mkdtempSync(join(tmpdir(), "fenvix-e2e-"));
  const token = randomBytes(24).toString("base64url");
  const tokenFile = join(dir, "admin-token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const tls = makeTls(dir);
  const [dataPort, adminPort, authPort] = [await freePort(), await freePort(), await freePort()];
  const prod = PROFILE === "production";
  if (prod && !fused) throw new Error("ENGINE_E2E_PROFILE=production needs the fused engine (one binary with --admin-listen and --auth)");
  const s3 = prod ? { ...localS3(), bucket: `fenvix-e2e-${randomBytes(6).toString("hex")}`, holder: `e2e-${randomBytes(4).toString("hex")}` } : undefined;
  if (s3) await makeBucket(s3, s3.bucket);
  const admin = new EngineProcess({
    bin: adminBin, dataPort, adminPort, tokenFile, ...(fused ? { auth: true, tls: { serverPem: tls.serverPem } } : {}),
    ...(prod ? { s3, adminHost: process.env.ENGINE_E2E_ADMIN_HOST ?? "127.0.0.2", logCommands: true } : {}),
  });
  const auth = fused ? admin : new EngineProcess({ bin: authPath, dataPort: authPort, auth: true, tls: { serverPem: tls.serverPem } });
  const root = { username: "bootstrap_root", password: randomBytes(18).toString("base64url") };
  const provisioner = { username: "fenvix_provisioner", password: randomBytes(18).toString("base64url") };
  const userKey = `v1:${randomBytes(32).toString("base64url")}`;
  const dataAddr = `127.0.0.1:${auth.o.dataPort}`;
  const tlsOpts = { tls: true, tlsCAFile: tls.caFile };
  const base: MongoClientOptions = { directConnection: true, serverSelectionTimeoutMS: 5000, ...tlsOpts };
  const clientAs = (cred?: { username: string; password: string; authSource: string }, extra: MongoClientOptions = {}) =>
    new MongoClient(`mongodb://${dataAddr}/`, { ...base, ...(cred ? { auth: { username: cred.username, password: cred.password }, authSource: cred.authSource, authMechanism: "SCRAM-SHA-256" } : {}), ...extra });

  const env: EngineEnv = {
    fused, profile: PROFILE, admin, auth, token, tokenFile, adminUrl: `http://${admin.o.adminHost ?? "127.0.0.1"}:${adminPort}`, dataAddr, adminDataAddr: `127.0.0.1:${dataPort}`,
    caFile: tls.caFile, root, provisioner, userKey, dir, provisionerPrivileges: PROVISIONER_ACTIONS,
    rootClient: () => clientAs({ ...root, authSource: "admin" }),
    adminDataClient: () => fused ? clientAs({ ...root, authSource: "admin" }) : new MongoClient(`mongodb://127.0.0.1:${dataPort}/`, { directConnection: true, serverSelectionTimeoutMS: 5000 }),
    clientAs,
    async bootstrap() {
      // The engine's localhost exception: until the first user exists, it can be created from the machine itself.
      // With a durable store (production profile) the users survive a restart: then there is nothing to make again.
      const r0 = clientAs({ ...root, authSource: "admin" });
      try {
        await r0.db("admin").command({ ping: 1 });
        const has = await r0.db("admin").command({ usersInfo: provisioner.username });
        if (Array.isArray(has.users) && has.users.length === 1) return;
      } catch { /* no root yet */ } finally { await r0.close(); }
      const anon = clientAs();
      try { await anon.db("admin").command({ createUser: root.username, pwd: root.password, roles: ["root"] }); } finally { await anon.close(); }
      const r = clientAs({ ...root, authSource: "admin" });
      try {
        await r.db("admin").command({ createRole: "fenvix_provisioner", privileges: [{ resource: { db: "", collection: "" }, actions: PROVISIONER_ACTIONS }], roles: [] });
        await r.db("admin").command({ createUser: provisioner.username, pwd: provisioner.password, roles: [{ role: "fenvix_provisioner", db: "admin" }], mechanisms: ["SCRAM-SHA-256"] });
      } finally { await r.close(); }
    },
    async stop() {
      await admin.stop();
      if (!fused) await auth.stop();
      if (s3) await dropBucket(s3, s3.bucket).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
  await admin.start();
  if (!fused) await auth.start();
  await env.bootstrap();
  return env;
}
