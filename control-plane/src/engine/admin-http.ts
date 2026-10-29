import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { EngineError } from "./types.ts";
import type { EngineSettings } from "../config.ts";

/**
 * The only way this service talks to the engine's admin interface, and the place where "the control plane may do
 * the operations it is meant to do and nothing else" is enforced.
 *
 * The engine has a single bearer token that opens every route (including listing every database, reading manifests
 * and checkpoints, and deleting exports), so the engine cannot narrow it. Narrowing happens here, before a byte is
 * sent: a request goes out only if its method and path match one of the routes below, and the database in the path
 * is a name this service makes (`db_` and 32 hex digits; see names.ts), never any other database in the engine.
 * Routes that exist in the engine but that no operation needs are left out on purpose: `GET /v1/databases` (it
 * would list every customer's databases), `/manifest`, `/checkpoints`, `DELETE /v1/exports/{id}`, `/v1/health`.
 * `GET /v1/network` does show every address the engine tracks: the adapter keeps only the blocks of the database asked
 * about and the trusted networks (real.ts), and passes nothing else on.
 */
const DB = "db_[0-9a-f]{32}";
const EXPORT_ID = `${DB}\\.[0-9a-f]{16}`;
const FILE = "[^/?#]{1,300}";
/** An IPv4 or IPv6 address as the adapter writes it (checked before by netlist.ts). */
const IP = "[0-9a-f.:]{2,39}";

export type RouteClass = "short" | "long";

interface Route { method: string; re: RegExp; cls: RouteClass; what: string }
const route = (method: string, pattern: string, cls: RouteClass, what: string): Route => ({ method, re: new RegExp(`^/v1/${pattern}$`), cls, what });

export const ALLOWED_ROUTES: readonly Route[] = [
  route("POST", "databases", "long", "create"),
  route("GET", `databases/${DB}`, "short", "get"),
  route("POST", `databases/${DB}/fork`, "long", "fork"),
  route("DELETE", `databases/${DB}`, "long", "erase"),
  route("PUT", `databases/${DB}/keep-awake`, "short", "keep awake on"),
  route("DELETE", `databases/${DB}/keep-awake`, "short", "keep awake off"),
  route("GET", `databases/${DB}/usage`, "short", "usage"),
  route("PUT", `databases/${DB}/retention`, "short", "retention"),
  route("GET", `databases/${DB}/restore-points`, "short", "restore points"),
  route("POST", `databases/${DB}/restore`, "long", "restore"),
  route("POST", `databases/${DB}/exports`, "long", "export snapshot"),
  route("GET", `exports/${EXPORT_ID}`, "short", "export record"),
  route("GET", `exports/${EXPORT_ID}/files/${DB}/${FILE}`, "long", "export file"),
  route("GET", `databases/${DB}/ip-allowlist`, "short", "read the IP allowlist"),
  route("PUT", `databases/${DB}/ip-allowlist`, "short", "set the IP allowlist"),
  route("DELETE", `databases/${DB}/ip-allowlist`, "short", "clear the IP allowlist"),
  route("GET", "network", "short", "network state (blocks, trusted networks)"),
  route("DELETE", `network/blocks/${IP}`, "short", "unblock an address"),
];

/** The class of an allowed request, or a refusal. Never reaches the network for anything else. */
export function authorize(method: string, target: string): RouteClass {
  const path = target.split("?")[0]!;
  const found = ALLOWED_ROUTES.find((r) => r.method === method && r.re.test(path));
  if (!found) throw new EngineError("invalid", `the control plane is not allowed to call ${method} ${target.replace(/[^\x20-\x7e]/g, "?").slice(0, 120)} on the engine`);
  return found.cls;
}

export interface AdminResponse { status: number; json: unknown }

const MAX_JSON_BYTES = 8 * 1024 * 1024;

export class AdminHttp {
  private readonly cfg: EngineSettings;
  constructor(cfg: EngineSettings) { this.cfg = cfg; }

  regions(): string[] { return Object.keys(this.cfg.endpoints); }

  hasRegion(region: string): boolean { return Object.hasOwn(this.cfg.endpoints, region); }

  private open(region: string, method: string, path: string, headers: Record<string, string>, body: Buffer | undefined, timeoutMs: number): Promise<IncomingMessage> {
    const base = this.cfg.endpoints[region];
    if (!base) return Promise.reject(new EngineError("invalid", `there is no engine for region ${region}`));
    const tls = base.protocol === "https:";
    const send = tls ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send({
        protocol: base.protocol, hostname: base.hostname, port: base.port || (tls ? 443 : 80), method, path,
        headers: { ...headers, authorization: `Bearer ${this.cfg.token}`, connection: "close", ...(body ? { "content-length": String(body.length) } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
        ...(tls ? { ca: this.cfg.caPem, cert: this.cfg.clientCertPem, key: this.cfg.clientKeyPem, servername: this.cfg.tlsServerName ?? (isIP(base.hostname) ? undefined : base.hostname), rejectUnauthorized: true } : {}),
      }, resolve);
      req.on("error", (e) => reject(unavailable(e)));
      req.end(body);
    });
  }

  /** A JSON call. Network failures and timeouts are `unavailable`; the caller maps the status. */
  async call(region: string, method: string, path: string, body?: unknown): Promise<AdminResponse> {
    const cls = authorize(method, path);
    const ms = cls === "long" ? this.cfg.longRequestTimeoutMs : this.cfg.requestTimeoutMs;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const res = await this.open(region, method, path, { accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) }, payload, ms);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of res) {
        size += (c as Buffer).length;
        if (size > MAX_JSON_BYTES) { res.destroy(); throw new EngineError("unavailable", "the engine's answer was too large"); }
        chunks.push(c as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let json: unknown = null;
      if (text) { try { json = JSON.parse(text); } catch { /* a proxy's HTML page: handled by the status */ } }
      return { status: res.statusCode ?? 0, json };
    } catch (e) {
      throw e instanceof EngineError ? e : unavailable(e);
    }
  }

  /** A streamed download from byte `from` on (`Range: bytes=N-`). The body is returned unread. */
  async download(region: string, path: string, from: number): Promise<{ status: number; body: IncomingMessage }> {
    const cls = authorize("GET", path);
    const res = await this.open(region, "GET", path, from > 0 ? { range: `bytes=${from}-` } : {}, undefined, cls === "long" ? this.cfg.longRequestTimeoutMs : this.cfg.requestTimeoutMs);
    return { status: res.statusCode ?? 0, body: res };
  }
}

function unavailable(e: unknown): EngineError {
  const code = (e as NodeJS.ErrnoException)?.code;
  const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
  // Only the kind of failure reaches the log: never the address, which is a deployment detail.
  return new EngineError("unavailable", `the engine could not be reached (${timedOut ? "timeout" : code ?? "network error"})`);
}
