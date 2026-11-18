/**
 * A fake phoenixNAP (OAuth token endpoint, BMC API servers, Billing API product availability) on a local port, built
 * from phoenixNAP's own OpenAPI descriptions (tests/fixtures/pnap, PROVENANCE.md): every request body our client sends
 * is validated against the operation's request schema (unknown top-level fields refused too), and every response the
 * fake answers is validated against the operation's response schema, so a field we read that phoenixNAP does not
 * document fails the test. It keeps real state: servers go creating → powered-on (with addresses) on `tick()`, and
 * deleting → gone; a location can be out of capacity (406), and the token can expire.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

type Json = Record<string, unknown>;
const FIX = new URL("../fixtures/pnap/", import.meta.url);
export const BMC_SPEC = parse(readFileSync(new URL("bmc-api.yaml", FIX), "utf8"));
export const BILLING_SPEC = parse(readFileSync(new URL("billing-api.yaml", FIX), "utf8"));

function validator(spec: Json) {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  addFormats(ajv);
  ajv.addFormat("byte", /^[A-Za-z0-9+/]*={0,2}$/);
  return (name: string, value: unknown): string[] => {
    const schema = { components: spec.components, $ref: `#/components/schemas/${name}` };
    if (ajv.validate(schema, value)) {
      const props = ((spec.components as Json).schemas as Record<string, { properties?: Json }>)[name]?.properties;
      if (props && value && typeof value === "object" && !Array.isArray(value)) {
        const extra = Object.keys(value).filter((k) => !(k in props));
        return extra.length ? [`${name}: unknown fields ${extra.join(", ")}`] : [];
      }
      return [];
    }
    return [`${name}: ${ajv.errorsText()}`];
  };
}
const bmc = validator(BMC_SPEC);
const billing = validator(BILLING_SPEC);

export interface FakeServer {
  id: string; status: string; hostname: string; description?: string; os: string; type: string; location: string; pricingModel: string;
  privateIpAddresses: string[]; publicIpAddresses: string[]; provisionedOn?: string; userData?: string; createdAt: number; ticks: number;
}

export interface PnapExchange { method: string; path: string; status: number; body: unknown; problems: string[] }

export class FakePnap {
  readonly clientId = "fx-test-client";
  readonly clientSecret = randomBytes(16).toString("hex");
  servers = new Map<string, FakeServer>();
  /** Servers still available per type and location (default 10, as the API's maximum report). */
  capacity = new Map<string, number>();
  exchanges: PnapExchange[] = [];
  tokensIssued = 0;
  /** Seconds a token lives. */
  tokenTtl = 3600;
  /** Ticks a server stays "creating". */
  provisionTicks = 2;
  private tokens = new Map<string, number>();
  private http: HttpServer | null = null;
  private seq = 0;
  url = "";

  async start(): Promise<void> {
    this.http = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((r) => this.http!.listen(0, "127.0.0.1", r));
    const a = this.http.address() as { port: number };
    this.url = `http://127.0.0.1:${a.port}`;
  }

  async stop(): Promise<void> { await new Promise<void>((r) => this.http?.close(() => r())); }

  get problems(): string[] { return this.exchanges.flatMap((e) => e.problems.map((p) => `${e.method} ${e.path}: ${p}`)); }

  /** Time passes at phoenixNAP: creating servers come up, deleting ones disappear. */
  tick(): void {
    for (const s of [...this.servers.values()]) {
      s.ticks++;
      if (s.status === "creating" && s.ticks >= this.provisionTicks) {
        s.status = "powered-on";
        s.provisionedOn = new Date().toISOString();
        s.publicIpAddresses = [`198.51.100.${++this.seq % 250}`];
      } else if (s.status === "deleting") {
        this.servers.delete(s.id);
      }
    }
  }

  expireTokens(): void { this.tokens.clear(); }

  private serverJson(s: FakeServer): Json {
    return {
      id: s.id, status: s.status, hostname: s.hostname, ...(s.description ? { description: s.description } : {}), os: s.os, type: s.type,
      location: s.location, cpu: "Dual Xeon Gold 6536", cpuCount: 2, coresPerCpu: 16, cpuFrequency: 3, ram: "256 GB", storage: "2x 2TB NVMe",
      privateIpAddresses: s.privateIpAddresses, publicIpAddresses: s.publicIpAddresses, pricingModel: s.pricingModel, networkType: "PUBLIC_AND_PRIVATE",
      ...(s.provisionedOn ? { provisionedOn: s.provisionedOn } : {}),
      networkConfiguration: { privateNetworkConfiguration: { configurationType: "USE_OR_CREATE_DEFAULT" } },
      storageConfiguration: { rootPartition: { raid: "NO_RAID", size: -1 } },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url ?? "/", this.url);
    const ex: PnapExchange = { method: req.method ?? "", path: u.pathname, status: 0, body: undefined, problems: [] };
    this.exchanges.push(ex);
    const send = (status: number, body: unknown, schema?: [(n: string, v: unknown) => string[], string, "array"?]) => {
      if (schema) {
        const [check, name, arr] = schema;
        ex.problems.push(...(arr ? (body as unknown[]).flatMap((x) => check(name, x)) : check(name, body)).map((p) => `response ${status}: ${p}`));
      }
      ex.status = status;
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const error = (status: number, message: string) => send(status, { message }, [bmc, "Error"]);

    if (u.pathname === "/auth/realms/BMC/protocol/openid-connect/token") {
      const want = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
      if (req.method !== "POST" || req.headers.authorization !== want || !/^grant_type=client_credentials$/.test(raw)) {
        return send(401, { error: "unauthorized_client" });
      }
      const t = randomBytes(24).toString("base64url");
      this.tokens.set(t, Date.now() + this.tokenTtl * 1000);
      this.tokensIssued++;
      return send(200, { access_token: t, expires_in: this.tokenTtl, token_type: "Bearer", scope: "bmc bmc.read" });
    }
    const tok = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!tok || !this.tokens.has(tok) || this.tokens.get(tok)! < Date.now()) return error(401, "The request failed due to invalid credentials.");
    let body: Json | undefined;
    if (raw) { try { body = JSON.parse(raw) as Json; } catch { return error(400, "not JSON"); } }
    ex.body = body;

    let m: RegExpExecArray | null;
    if (u.pathname === "/bmc/v1/servers" && req.method === "POST") {
      const p = bmc("ServerCreate", body);
      ex.problems.push(...p.map((x) => `request: ${x}`));
      if (p.length) return error(400, p.join("; "));
      const b = body as Json;
      const key = `${b.type}@${b.location}`;
      const left = this.capacity.get(key) ?? 10;
      if (left <= 0) return error(406, "There are currently no servers available for the selected instance type.");
      this.capacity.set(key, left - 1);
      if ([...this.servers.values()].some((s) => s.hostname === b.hostname && s.status !== "deleting")) return error(409, "hostname in use");
      const id = randomBytes(12).toString("hex");
      const s: FakeServer = {
        id, status: "creating", hostname: String(b.hostname), description: b.description as string | undefined, os: String(b.os), type: String(b.type),
        // The schema requires a private address from the order on (Server.privateIpAddresses, minItems 1).
        location: String(b.location), pricingModel: String(b.pricingModel ?? "HOURLY"), privateIpAddresses: [`10.0.0.${10 + (++this.seq % 200)}`], publicIpAddresses: [],
        userData: ((b.osConfiguration as Json | undefined)?.cloudInit as Json | undefined)?.userData as string | undefined, createdAt: Date.now(), ticks: 0,
      };
      this.servers.set(id, s);
      // userData is never returned (phoenixNAP: "will NOT be returned in the response").
      return send(200, this.serverJson(s), [bmc, "Server"]);
    }
    if (u.pathname === "/bmc/v1/servers" && req.method === "GET") {
      const loc = u.searchParams.getAll("location");
      const list = [...this.servers.values()].filter((s) => !loc.length || loc.includes(s.location)).map((s) => this.serverJson(s));
      return send(200, list, [bmc, "Server", "array"]);
    }
    if ((m = /^\/bmc\/v1\/servers\/([0-9a-f]+)$/.exec(u.pathname)) && req.method === "GET") {
      const s = this.servers.get(m[1]!);
      return s ? send(200, this.serverJson(s), [bmc, "Server"]) : error(404, "Server not found");
    }
    if ((m = /^\/bmc\/v1\/servers\/([0-9a-f]+)\/actions\/deprovision$/.exec(u.pathname)) && req.method === "POST") {
      const p = bmc("RelinquishIpBlock", body ?? {});
      ex.problems.push(...p.map((x) => `request: ${x}`));
      const s = this.servers.get(m[1]!);
      if (!s) return error(404, "Server not found");
      if (s.status === "deleting") return error(409, "The resource is in an incompatible state.");
      s.status = "deleting";
      return send(202, "Server deprovisioned");
    }
    if (u.pathname === "/billing/v1/product-availability" && req.method === "GET") {
      const codes = u.searchParams.getAll("productCode");
      const locs = u.searchParams.getAll("location");
      const out = codes.map((code) => ({
        productCode: code, productCategory: "SERVER",
        locationAvailabilityDetails: locs.map((location) => {
          const n = this.capacity.get(`${code}@${location}`) ?? 10;
          return { location, minQuantityRequested: Number(u.searchParams.get("minQuantity") ?? 1), minQuantityAvailable: n >= Number(u.searchParams.get("minQuantity") ?? 1), availableQuantity: Math.min(n, 10), solutions: ["SERVER_RANCHER"] };
        }),
      }));
      return send(200, out, [billing, "ProductAvailability", "array"]);
    }
    return error(404, `no such route in the fake: ${req.method} ${u.pathname}`);
  }
}
