import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { validateEntries } from "../../src/engine/netlist.ts";

/**
 * A simulated engine admin interface (`control-ops` of Mircoguidetti/test5, branch control-ops), written from its code
 * (`mongo-server/src/ctl/api.rs`, `http.rs`, `meta.rs`, `fork.rs`, `erase.rs`, `pin.rs`, `pitr.rs`, `export.rs`,
 * `usage.rs`) and `results-ops.md`. It models only what those files say. Where they say nothing, it does nothing
 * (no idempotency keys, no workspace, no region, no hourly usage), and `docs/engine-adapter.md` lists those as questions.
 *
 * Test hooks (not part of the engine): `failNext`, `loseAnswer` and `breakDownload` inject faults.
 */
interface Db {
  name: string; createdMs: number; createdVia: string; forkedFrom: { database: string; at_ms: number; mode: string } | null;
  keepAwake: boolean; awake: boolean; retention: { window_secs: number; interval_secs: number } | null;
  /** Restore points and the documents at each. */
  points: { atMs: number; docs: string[]; collections: Record<string, string> }[];
  docs: string[];
  collections: Record<string, string>;
  usage: Map<string, { commands: number; wakes: { at_ms: number; first_request_latency_ms: number }[] }>;
  /** `ip_allowlist` of the metadata record (network-limits, ctl/allowlist.rs): absent after create and fork. */
  allowlist: string[] | null;
}
interface Export { id: string; database: string; createdMs: number; expiresMs: number; files: { collection: string; kind: "bson" | "metadata"; path: string; body: Buffer }[]; complete: Record<string, { bytes: number; sha256: string }> }

export class SimEngine {
  readonly token: string;
  readonly dbs = new Map<string, Db>();
  readonly exports = new Map<string, Export>();
  /** Every request received: `METHOD path` (without the query). */
  readonly seen: string[] = [];
  /** Requests received with a missing or wrong token. */
  unauthorized = 0;
  now = () => Date.now();
  exportTtlMs = 86_400_000;
  /** Bytes the engine sends of a file before a scripted break. */
  private breaks: { path: string; after: number; times: number }[] = [];
  private faults: { match: RegExp; status: number; code: string; times: number }[] = [];
  private lose: { match: RegExp; times: number }[] = [];
  private server!: Server;
  port = 0;
  /** In-memory blocks of the engine's network guard (network-limits, netguard.rs `state()`); tests add them. */
  readonly blocked: { ip: string; database: string | null; until: string; remaining_secs: number; strike: number }[] = [];
  trusted = ["127.0.0.0/8", "::1/128"];

  private readonly tls: { key: string; cert: string } | undefined;

  constructor(token = "sim-admin-token-0123456789", tls?: { key: string; cert: string }) { this.token = token; this.tls = tls; }

  get url(): string { return `${this.tls ? "https" : "http"}://127.0.0.1:${this.port}`; }

  async start(): Promise<void> {
    const handler = (req: IncomingMessage, res: ServerResponse) => { void this.handle(req, res); };
    this.server = this.tls ? createTlsServer(this.tls, handler) : createServer(handler);
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  /** The next `times` requests whose "METHOD path" matches answer with this status and error code (before doing anything). */
  failNext(match: RegExp, status: number, code = "internal", times = 1): void { this.faults.push({ match, status, code, times }); }
  /** The next `times` matching requests are carried out, and then the connection is cut without an answer. */
  loseAnswer(match: RegExp, times = 1): void { this.lose.push({ match, times }); }
  /** A download of this path is cut after `after` bytes, `times` times. */
  breakDownload(path: string, after: number, times = 1): void { this.breaks.push({ path, after, times }); }

  /** Documents are opaque strings here; a database's size is the sum of their lengths. */
  write(db: string, docs: string[], collection = "c"): void {
    const d = this.dbs.get(db)!;
    d.docs.push(...docs);
    d.collections[collection] = (d.collections[collection] ?? "") + docs.join("\n") + "\n";
    this.day(d).commands += docs.length;
  }

  private day(d: Db) {
    const k = new Date(this.now()).toISOString().slice(0, 10);
    let u = d.usage.get(k);
    if (!u) d.usage.set(k, (u = { commands: 0, wakes: [] }));
    return u;
  }

  private newDb(name: string, via: string): Db {
    return { name, createdMs: this.now(), createdVia: via, forkedFrom: null, keepAwake: false, awake: false, retention: null, points: [], docs: [], collections: {}, usage: new Map(), allowlist: null };
  }

  // ---------------------------------------------------------------- http

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // like http.rs: authenticate before anything else is read
    const given = /^Bearer (.*)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    if (given !== this.token) {
      this.unauthorized++;
      return this.error(res, 401, "unauthorized", "missing or invalid bearer token", { "WWW-Authenticate": "Bearer" });
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    const line = `${req.method} ${path}`;
    this.seen.push(line);
    const fault = this.faults.find((f) => f.times > 0 && f.match.test(line));
    if (fault) { fault.times--; return this.error(res, fault.status, fault.code, "injected fault"); }
    let body: Record<string, unknown> = {};
    if (raw.length) { try { body = JSON.parse(raw.toString()); } catch { return this.error(res, 400, "bad_request", "body is not valid JSON"); } }
    const lose = this.lose.find((l) => l.times > 0 && l.match.test(line));
    const out = this.route(req.method ?? "GET", path, url.searchParams, body, req.headers);
    if (lose) { lose.times--; res.socket?.destroy(); return; }
    if (out.stream) return this.sendStream(res, out.stream, path);
    res.writeHead(out.status, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify(out.json));
  }

  private error(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json", Connection: "close", ...headers });
    res.end(JSON.stringify({ error: { code, message } }));
  }

  private sendStream(res: ServerResponse, s: { status: number; body: Buffer; headers: Record<string, string> }, path: string): void {
    res.writeHead(s.status, { ...s.headers, "Transfer-Encoding": "chunked", Connection: "close" });
    const brk = this.breaks.find((b) => b.times > 0 && b.path === path);
    if (brk && s.body.length > brk.after) {
      brk.times--;
      res.write(s.body.subarray(0, brk.after));
      // no terminating chunk: the client sees a truncated, resumable transfer (http.rs)
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    res.end(s.body);
  }

  // ---------------------------------------------------------------- routes (api.rs)

  private route(method: string, path: string, q: URLSearchParams, b: Record<string, unknown>, headers: IncomingMessage["headers"]): { status: number; json?: unknown; stream?: { status: number; body: Buffer; headers: Record<string, string> } } {
    const segs = path.replace(/^\/+|\/+$/g, "").split("/");
    const J = (status: number, json: unknown) => ({ status, json });
    const E = (status: number, code: string, message: string) => J(status, { error: { code, message } });
    if (segs[0] !== "v1") return E(404, "no_route", "not found");
    const [, a, db, c, d] = segs;
    const checkName = (n: string) => {
      if (!n || n.length >= 64 || /[/\\. "$*<>:|?\0]/.test(n)) return E(400, "bad_request", `invalid database name ${JSON.stringify(n)}`);
      if (["admin", "local", "config"].includes(n)) return E(400, "bad_request", `${n} is a reserved database name`);
      return null;
    };
    if (method === "GET" && a === "health") return J(200, { ok: true });
    if (method === "GET" && a === "network" && !db) {
      return J(200, { config: { trusted_networks: this.trusted, auth_fail_max: 10, auth_fail_max_per_db: 5 }, blocked: this.blocked, failing: [{ ip: "192.0.2.200", database: null, failures_in_window: 3 }], connections: [{ ip: "192.0.2.201", open: 2 }], tracked_addresses: 3, totals: {} });
    }
    if (method === "DELETE" && a === "network" && db === "blocks" && c) {
      if (!/^[0-9a-fA-F.:]+$/.test(c)) return E(400, "bad_request", "not an IPv4 or IPv6 address");
      const before = this.blocked.length;
      for (let i = this.blocked.length - 1; i >= 0; i--) if (this.blocked[i]!.ip === c || this.blocked[i]!.ip.startsWith(`${c}/`)) this.blocked.splice(i, 1);
      return J(200, { ip: c, unblocked: this.blocked.length < before });
    }
    if (method === "POST" && a === "databases" && !db) {
      if (typeof b.name !== "string") return E(400, "bad_request", "body needs a string field name");
      const bad = checkName(b.name); if (bad) return bad;
      if (this.dbs.has(b.name)) return E(409, "exists", `database ${b.name} already exists`);
      this.dbs.set(b.name, this.newDb(b.name, "admin"));
      return J(201, this.describe(b.name, true));
    }
    if (method === "GET" && a === "databases" && !db) return J(200, { databases: [...this.dbs.keys()].map((n) => this.describe(n, q.get("storage") === "true")) });
    if (a === "databases" && db) {
      const bad = checkName(db); if (bad && !(method === "DELETE" && !c)) return bad;
      const e = this.dbs.get(db);
      if (method === "GET" && !c) return e ? J(200, this.describe(db, q.get("storage") !== "false")) : E(404, "not_found", `database ${db} does not exist`);
      if (!e && !(method === "DELETE" && !c) ) return E(404, "not_found", `database ${db} does not exist`);
      if (method === "GET" && c === "usage") return this.usage(db, e!, q);
      if (method === "POST" && c === "fork") return this.fork(db, e!, b);
      if (method === "DELETE" && !c) return this.erase(db);
      if (method === "PUT" && c === "keep-awake") { e!.keepAwake = true; e!.awake = true; return J(200, { ...this.describe(db, false), keep_awake_lease: { holder: "sim" } }); }
      if (method === "DELETE" && c === "keep-awake") { e!.keepAwake = false; return J(200, this.describe(db, false)); }
      if (method === "POST" && c === "exports") return this.makeExport(db, e!);
      if (method === "GET" && c === "restore-points") return this.restorePoints(db, e!);
      if (method === "PUT" && c === "retention") {
        if (typeof b.window_secs !== "number") return E(400, "bad_request", "body needs an integer window_secs (0 switches retention off)");
        const interval = typeof b.interval_secs === "number" ? b.interval_secs : 600;
        if (interval < 1) return E(400, "bad_request", "interval_secs must be at least 1");
        e!.retention = { window_secs: b.window_secs, interval_secs: interval };
        if (b.window_secs > 0 && e!.points.length === 0) e!.points.push({ atMs: this.now(), docs: [...e!.docs], collections: { ...e!.collections } });
        return J(200, { database: db, retention: e!.retention });
      }
      if (method === "POST" && c === "restore") return this.restore(db, e!, b);
      if (c === "ip-allowlist") {
        const reply = (extra: Record<string, unknown> = {}) => J(200, { database: db, entries: e!.allowlist ?? [], allow_all: !e!.allowlist?.length, max_entries: 100, enforced: true, ...extra });
        if (method === "GET") return reply();
        if (method === "DELETE") { e!.allowlist = null; return reply({ cleared: true }); }
        if (method === "PUT") {
          if (Object.keys(b).some((k) => k !== "entries")) return E(400, "invalid_allowlist", "unknown field");
          try { e!.allowlist = validateEntries(b.entries); } catch (x) { return E(400, "invalid_allowlist", (x as Error).message); }
          return reply({ connections_deauthenticated: 0 });
        }
      }
      void d;
    }
    if (a === "exports" && db) {
      const x = this.exports.get(db);
      if (!x) return E(404, "not_found", `no export ${db}`);
      if (x.expiresMs < this.now()) return E(410, "expired", `export ${db} has expired`);
      if (method === "GET" && !c) return J(200, this.exportView(x));
      if (method === "GET" && c === "files") return this.download(x, segs.slice(4).join("/"), headers.range);
      if (method === "DELETE" && !c) { this.exports.delete(db); return J(200, { id: db, deleted: true }); }
    }
    return E(404, "no_route", `no route for ${method} ${path}`);
  }

  private describe(name: string, storage: boolean) {
    const d = this.dbs.get(name)!;
    const bytes = d.docs.reduce((n, x) => n + x.length, 0);
    return {
      name, state: d.awake ? "awake" : "asleep", mode: d.awake ? "full" : "closed", holder: d.awake ? "sim" : null,
      keep_awake: d.keepAwake, keep_awake_lease: null,
      storage_bytes: storage ? bytes : null, storage_objects: storage ? d.docs.length : null,
      created_at: new Date(d.createdMs).toISOString(), created_at_ms: d.createdMs, created_via: d.createdVia,
      last_active_at: new Date(this.now()).toISOString(), last_active_at_ms: this.now(),
      forked_from: d.forkedFrom, retention: d.retention ?? { window_secs: 0, interval_secs: 600, source: "default" }, operation: null,
    };
  }

  private forkCount(name: string): number { return [...this.dbs.values()].filter((x) => x.forkedFrom?.database === name && x.forkedFrom.mode === "clone").length; }

  private fork(src: string, s: Db, b: Record<string, unknown>) {
    const J = (status: number, json: unknown) => ({ status, json });
    const E = (status: number, code: string, message: string) => J(status, { error: { code, message } });
    if (typeof b.target !== "string") return E(400, "bad_request", "body needs a string field target");
    const mode = typeof b.mode === "string" ? b.mode : "clone";
    if (b.target === src) return E(400, "bad_request", "source and target are the same database");
    if (mode !== "clone" && mode !== "copy") return E(400, "bad_request", 'mode must be "clone" or "copy"');
    if (this.dbs.has(b.target)) return E(409, "exists", `database ${b.target} already exists`);
    if (mode === "copy" && s.forkedFrom?.mode === "clone") return E(409, "source_is_shallow_fork", `database ${src} is itself a shallow fork`);
    const t = this.newDb(b.target, "fork");
    t.docs = [...s.docs]; t.collections = { ...s.collections };
    t.forkedFrom = { database: src, at_ms: this.now(), mode };
    this.dbs.set(b.target, t);
    s.awake = s.keepAwake; // a fork closes the source (it wakes again on demand)
    return J(201, { ...this.describe(b.target, true), fork: { source: src, mode } });
  }

  private erase(name: string) {
    const J = (status: number, json: unknown) => ({ status, json });
    const d = this.dbs.get(name);
    if (!d) return J(404, { error: { code: "not_found", message: `database ${name} does not exist` } });
    if (this.forkCount(name) > 0) return J(409, { error: { code: "has_forks", message: "databases are shallow forks that still read the objects" } });
    const final_usage = { commands: [...d.usage.values()].reduce((n, u) => n + u.commands, 0) };
    this.dbs.delete(name);
    for (const [id, x] of this.exports) if (x.database === name) this.exports.delete(id);
    return J(200, { database: name, erased: true, objects_deleted: d.docs.length + 3, proof: { remaining_objects: 0 }, final_usage, erased_at: new Date(this.now()).toISOString() });
  }

  private restorePoints(name: string, d: Db) {
    return { status: 200, json: {
      database: name, retention: d.retention ?? { window_secs: 0, interval_secs: 600 },
      points: d.points.map((p, i) => ({ id: String(i), at: new Date(p.atMs).toISOString(), at_ms: p.atMs })),
      earliest_restorable: d.points[0] ? new Date(d.points[0].atMs).toISOString() : null,
      earliest_restorable_ms: d.points[0]?.atMs ?? null, latest_restorable_ms: this.now(),
    } };
  }

  /** Test helper: a restore point of the current documents, as the engine takes them at its interval. */
  takePoint(name: string, atMs = this.now()): void { const d = this.dbs.get(name)!; d.points.push({ atMs, docs: [...d.docs], collections: { ...d.collections } }); d.points.sort((x, y) => x.atMs - y.atMs); }

  private restore(name: string, d: Db, b: Record<string, unknown>) {
    const J = (status: number, json: unknown) => ({ status, json });
    const E = (status: number, code: string, message: string) => J(status, { error: { code, message } });
    const to = typeof b.to === "string" ? Date.parse(b.to) : typeof b.to === "number" ? b.to : NaN;
    if (!Number.isFinite(to)) return E(400, "bad_request", "body needs `to`: an RFC 3339 time or epoch milliseconds");
    if (to > this.now() + 1000) return E(400, "bad_request", "the time to restore to is in the future");
    if ((d.retention?.window_secs ?? 0) === 0 && d.points.length === 0) return E(409, "retention_off", `database ${name} has no retention window; enable one with PUT /v1/databases/${name}/retention`);
    const earliest = d.points[0]?.atMs;
    if (earliest === undefined) return E(409, "no_restore_points", `database ${name} has no restore points`);
    if (to < earliest) return E(400, "bad_request", `${new Date(to).toISOString()} is before the earliest restorable time ${new Date(earliest).toISOString()}`);
    const point = [...d.points].filter((p) => p.atMs <= to).pop()!;
    d.points.push({ atMs: this.now(), docs: [...d.docs], collections: { ...d.collections } }); // the safety point taken before applying
    d.docs = [...point.docs]; d.collections = { ...point.collections };
    return J(200, { database: name, restored_to: new Date(to).toISOString(), restored_to_ms: to, applied: true, from_point: { id: "0", at: new Date(point.atMs).toISOString() }, precision: "1 s (object-store timestamp of the WAL objects)" });
  }

  private makeExport(name: string, d: Db) {
    const id = `${name}.${randomBytes(8).toString("hex")}`;
    const files: Export["files"] = [];
    for (const [coll, body] of Object.entries(d.collections)) {
      files.push({ collection: coll, kind: "bson", path: `${name}/${coll}.bson`, body: Buffer.from(body) });
      files.push({ collection: coll, kind: "metadata", path: `${name}/${coll}.metadata.json`, body: Buffer.from(JSON.stringify({ collectionName: coll, indexes: [] })) });
    }
    const x: Export = { id, database: name, createdMs: this.now(), expiresMs: this.now() + this.exportTtlMs, files, complete: {} };
    this.exports.set(id, x);
    return { status: 201, json: { ...this.exportView(x), snapshot: { elapsed_ms: 1 } } };
  }

  private exportView(x: Export) {
    return {
      id: x.id, database: x.database, created_at: new Date(x.createdMs).toISOString(), expires_at: new Date(x.expiresMs).toISOString(),
      files: x.files.map((f) => f.kind === "bson"
        ? { collection: f.collection, kind: "bson", path: f.path, complete: x.complete[f.collection] ?? null }
        : { collection: f.collection, kind: "metadata", path: f.path, bytes: f.body.length, sha256: createHash("sha256").update(f.body).digest("hex") }),
      restore_with: `mongorestore --dir <download dir> --nsInclude '${x.database}.*'`,
    };
  }

  private download(x: Export, file: string, range: string | undefined) {
    const f = x.files.find((y) => y.path === file);
    if (!f) return { status: 404, json: { error: { code: "not_found", message: `no file ${file} in export ${x.id}` } } };
    let start = 0;
    if (range !== undefined) {
      const m = /^bytes=(\d+)-$/.exec(range);
      if (!m) return { status: 416, json: { error: { code: "bad_range", message: "only `bytes=N-` is supported" } } };
      start = Number(m[1]);
    }
    if (f.kind === "bson") x.complete[f.collection] = { bytes: f.body.length, sha256: createHash("sha256").update(f.body).digest("hex") };
    const headers: Record<string, string> = { "Content-Type": f.kind === "bson" ? "application/octet-stream" : "application/json", "Accept-Ranges": "bytes" };
    if (start > 0) headers["Content-Range"] = `bytes ${start}-*/*`;
    return { status: start > 0 ? 206 : 200, stream: { status: start > 0 ? 206 : 200, body: f.body.subarray(start), headers } };
  }

  private usage(name: string, d: Db, q: URLSearchParams) {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const to = q.get("to") ?? today;
    const from = q.get("from") ?? new Date(Date.parse(to) - 6 * 86_400_000).toISOString().slice(0, 10);
    if (!day.test(to)) return { status: 400, json: { error: { code: "bad_request", message: "to must be YYYY-MM-DD" } } };
    if (!day.test(from)) return { status: 400, json: { error: { code: "bad_request", message: "from must be YYYY-MM-DD" } } };
    if (from > to) return { status: 400, json: { error: { code: "bad_request", message: "from is after to" } } };
    const days = [...d.usage.entries()].filter(([k]) => k >= from && k <= to).sort(([a], [b]) => a.localeCompare(b)).map(([k, u]) => ({
      day: k, requests: { commands: u.commands, by_command: {} }, object_store: {}, wakes: { count: u.wakes.length, events_listed: u.wakes.length, events: u.wakes.map((w) => ({ at: new Date(w.at_ms).toISOString(), ...w, command: "find" })) },
      storage_bytes_sampled: null, processes: 1,
    }));
    return { status: 200, json: { database: name, from, to, days, totals: { commands: days.reduce((n, x) => n + x.requests.commands, 0) }, storage_bytes_now: q.get("storage") === "false" ? null : d.docs.reduce((n, x) => n + x.length, 0) } };
  }
}
