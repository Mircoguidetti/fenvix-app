import { BSON, type Document, EJSON } from "bson";
import { type CallOptions, type CollectionInfo, type DataClient, DataError, type DataErrorKind, type DataTarget, type FindOptions, targetDbName } from "./data.ts";

export type FakeDataOp = "listCollections" | "estimatedCount" | "find" | "findOne" | "insertOne" | "replaceOne" | "deleteOne";

/** How the real driver hands documents back (data-mongo.ts): every BSON type kept, nothing turned into a JS number. */
export const READ_OPTIONS = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const;

/**
 * In-memory MongoDB listener for tests and local runs, with the same interface as `MongoDataClient`. Documents are
 * kept as BSON bytes, so types come back exactly as the driver would return them. It understands the filter
 * operators the explorer lets through (rules.ts) and nothing else. Databases start asleep: the first call to one
 * waits `wakeMs`, like the engine opening a tenant from object storage.
 */
export class FakeDataClient implements DataClient {
  /** The address the fake "connects" from: loopback, which the engine trusts by default. */
  source: string | null = "127.0.0.1";
  async sourceAddress(_region: string): Promise<string | null> { return this.source; }
  /** db name -> collection -> documents (BSON). */
  readonly dbs = new Map<string, Map<string, Buffer[]>>();
  readonly calls: Record<FakeDataOp, number> = { listCollections: 0, estimatedCount: 0, find: 0, findOne: 0, insertOne: 0, replaceOne: 0, deleteOne: 0 };
  /** Every database name a call was made on, in order. Tests check it is only ever the caller's own. */
  readonly touched: string[] = [];
  /** The maxTimeMS of the last call. */
  lastMaxTimeMS = 0;
  wakeMs = 0;
  private readonly awake = new Set<string>();
  private readonly failures: { op: FakeDataOp; kind: DataErrorKind; times: number }[] = [];
  private readonly delays = new Map<FakeDataOp, number>();
  closed = false;

  failNext(op: FakeDataOp, kind: DataErrorKind = "unavailable", times = 1): void { this.failures.push({ op, kind, times }); }
  delay(op: FakeDataOp, ms: number): void { if (ms <= 0) this.delays.delete(op); else this.delays.set(op, ms); }
  sleepAll(): void { this.awake.clear(); }

  /** Seeds documents directly (tests): Extended JSON in, BSON stored. */
  seed(t: DataTarget, collection: string, docs: Document[]): void {
    const c = this.coll(targetDbName(t), collection, true)!;
    for (const d of docs) c.push(Buffer.from(BSON.serialize(EJSON.deserialize(d, { relaxed: false }))));
  }

  private coll(db: string, name: string, create: boolean): Buffer[] | undefined {
    let d = this.dbs.get(db);
    if (!d) { if (!create) return undefined; d = new Map(); this.dbs.set(db, d); }
    let c = d.get(name);
    if (!c) { if (!create) return undefined; c = []; d.set(name, c); }
    return c;
  }

  private async enter(op: FakeDataOp, t: DataTarget, o: CallOptions): Promise<string> {
    const db = targetDbName(t);
    this.calls[op]++;
    this.touched.push(db);
    this.lastMaxTimeMS = o.maxTimeMS;
    if (!this.awake.has(db) && this.wakeMs > 0) await new Promise((r) => setTimeout(r, this.wakeMs));
    this.awake.add(db);
    const d = this.delays.get(op);
    if (d) await new Promise((r) => setTimeout(r, d));
    const f = this.failures.find((x) => x.op === op && x.times > 0);
    if (f) { f.times--; throw new DataError(f.kind, f.kind === "duplicate" ? 11000 : undefined); }
    return db;
  }

  private read(b: Buffer): Document { return BSON.deserialize(b, READ_OPTIONS); }

  async listCollections(t: DataTarget, o: CallOptions & { limit: number }): Promise<CollectionInfo[]> {
    const db = await this.enter("listCollections", t, o);
    return [...(this.dbs.get(db)?.keys() ?? [])].slice(0, o.limit).map((name) => ({ name, type: "collection" }));
  }

  async estimatedCount(t: DataTarget, collection: string, o: CallOptions): Promise<number | null> {
    const db = await this.enter("estimatedCount", t, o);
    return this.coll(db, collection, false)?.length ?? 0;
  }

  async find(t: DataTarget, collection: string, o: FindOptions): Promise<{ docs: Document[]; stoppedEarly: boolean }> {
    const db = await this.enter("find", t, o);
    const all = (this.coll(db, collection, false) ?? []).map((b) => this.read(b)).filter((d) => matches(d, o.filter));
    all.sort((a, b) => compareBySort(a, b, o.sort));
    const docs: Document[] = [];
    let bytes = 0;
    let stoppedEarly = false;
    for (const d of all.slice(o.skip, o.skip + o.limit)) {
      bytes += BSON.calculateObjectSize(d);
      docs.push(o.projection ? project(d, o.projection) : d);
      if (bytes >= o.maxBytes) { stoppedEarly = true; break; }
    }
    return { docs, stoppedEarly };
  }

  async findOne(t: DataTarget, collection: string, filter: Document, o: CallOptions): Promise<Document | null> {
    const db = await this.enter("findOne", t, o);
    return (this.coll(db, collection, false) ?? []).map((b) => this.read(b)).find((d) => matches(d, filter)) ?? null;
  }

  async insertOne(t: DataTarget, collection: string, doc: Document, o: CallOptions): Promise<void> {
    const db = await this.enter("insertOne", t, o);
    const c = this.coll(db, collection, true)!;
    if (c.some((b) => equal(this.read(b)._id, doc._id))) throw new DataError("duplicate", 11000);
    c.push(Buffer.from(BSON.serialize(doc)));
  }

  async replaceOne(t: DataTarget, collection: string, filter: Document, doc: Document, o: CallOptions): Promise<{ matched: number }> {
    const db = await this.enter("replaceOne", t, o);
    const c = this.coll(db, collection, false) ?? [];
    const i = c.findIndex((b) => matches(this.read(b), filter));
    if (i < 0) return { matched: 0 };
    c[i] = Buffer.from(BSON.serialize(doc));
    return { matched: 1 };
  }

  async deleteOne(t: DataTarget, collection: string, filter: Document, o: CallOptions): Promise<{ deleted: number }> {
    const db = await this.enter("deleteOne", t, o);
    const c = this.coll(db, collection, false) ?? [];
    const i = c.findIndex((b) => matches(this.read(b), filter));
    if (i < 0) return { deleted: 0 };
    c.splice(i, 1);
    return { deleted: 1 };
  }

  async close(): Promise<void> { this.closed = true; }
}

// ---------------------------------------------------------------- a small matcher for the allowed operators

type V = unknown;

/** BSON type order (simplified) and a comparable key, so values of one kind compare like MongoDB does. */
function rank(v: V): [number, unknown] {
  if (v === undefined) return [0, 0];
  if (v === null) return [1, 0];
  const bt = (v as { _bsontype?: string })?._bsontype;
  switch (bt) {
    case "MinKey": return [-1, 0];
    case "MaxKey": return [100, 0];
    case "Int32": case "Double": return [2, Number((v as { value: number }).value)];
    case "Long": return [2, Number((v as { toNumber(): number }).toNumber())];
    case "Decimal128": return [2, Number.parseFloat(String(v))];
    case "ObjectId": case "ObjectID": return [7, (v as { toHexString(): string }).toHexString()];
    case "Binary": return [5, Buffer.from((v as { buffer: Uint8Array }).buffer).toString("hex")];
    case "Timestamp": return [10, String(v)];
    case "BSONRegExp": return [11, String((v as { pattern: string }).pattern)];
  }
  if (typeof v === "number") return [2, v];
  if (typeof v === "string") return [3, v];
  if (typeof v === "boolean") return [8, v ? 1 : 0];
  if (v instanceof Date) return [9, v.getTime()];
  if (Array.isArray(v)) return [4, JSON.stringify(EJSON.serialize({ v }))];
  return [3.5, JSON.stringify(EJSON.serialize(v as Document, { relaxed: true }))];
}

function cmp(a: V, b: V): number {
  const [ra, ka] = rank(a);
  const [rb, kb] = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ka === kb) return 0;
  return (ka as number | string) < (kb as number | string) ? -1 : 1;
}

const equal = (a: V, b: V) => cmp(a, b) === 0 && (rank(a)[0] !== 2 || rank(b)[0] === 2);

/** Values at a dotted path; arrays along the way fan out, like MongoDB. */
function valuesAt(doc: V, path: string[]): V[] {
  if (path.length === 0) return [doc];
  if (Array.isArray(doc)) {
    const idx = Number(path[0]);
    if (Number.isInteger(idx) && String(idx) === path[0]) return valuesAt(doc[idx], path.slice(1));
    return doc.flatMap((e) => valuesAt(e, path));
  }
  if (doc && typeof doc === "object" && !(doc as { _bsontype?: string })._bsontype) {
    const o = doc as Record<string, V>;
    return Object.hasOwn(o, path[0]!) ? valuesAt(o[path[0]!], path.slice(1)) : [undefined];
  }
  return [undefined];
}

const expand = (vals: V[]) => vals.flatMap((v) => (Array.isArray(v) ? [v, ...v] : [v]));

function opMatch(vals: V[], ops: Document): boolean {
  for (const [op, arg] of Object.entries(ops)) {
    const all = expand(vals);
    let ok: boolean;
    switch (op) {
      case "$eq": ok = all.some((v) => equal(v, arg)); break;
      case "$ne": ok = !all.some((v) => equal(v, arg)); break;
      case "$gt": ok = all.some((v) => v !== undefined && rank(v)[0] === rank(arg)[0] && cmp(v, arg) > 0); break;
      case "$gte": ok = all.some((v) => v !== undefined && rank(v)[0] === rank(arg)[0] && cmp(v, arg) >= 0); break;
      case "$lt": ok = all.some((v) => v !== undefined && rank(v)[0] === rank(arg)[0] && cmp(v, arg) < 0); break;
      case "$lte": ok = all.some((v) => v !== undefined && rank(v)[0] === rank(arg)[0] && cmp(v, arg) <= 0); break;
      case "$in": ok = all.some((v) => (arg as V[]).some((a) => equal(v, a))); break;
      case "$nin": ok = !all.some((v) => (arg as V[]).some((a) => equal(v, a))); break;
      case "$exists": ok = vals.some((v) => v !== undefined) === arg; break;
      case "$regex": {
        const re = new RegExp(arg as string, (ops.$options as string | undefined) ?? "");
        ok = all.some((v) => typeof v === "string" && re.test(v));
        break;
      }
      case "$options": ok = true; break;
      case "$not": ok = !opMatch(vals, arg as Document); break;
      default: throw new DataError("refused");
    }
    if (!ok) return false;
  }
  return true;
}

const isOps = (v: V): v is Document => !!v && typeof v === "object" && !Array.isArray(v) && !(v as { _bsontype?: string })._bsontype && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith("$"));

export function matches(doc: Document, filter: Document): boolean {
  for (const [k, cond] of Object.entries(filter)) {
    if (k === "$and") { if (!(cond as Document[]).every((c) => matches(doc, c))) return false; continue; }
    if (k === "$or") { if (!(cond as Document[]).some((c) => matches(doc, c))) return false; continue; }
    const vals = valuesAt(doc, k.split("."));
    if (!(isOps(cond) ? opMatch(vals, cond) : opMatch(vals, { $eq: cond }))) return false;
  }
  return true;
}

function compareBySort(a: Document, b: Document, sort: Document): number {
  for (const [k, dir] of Object.entries(sort)) {
    const c = cmp(valuesAt(a, k.split("."))[0], valuesAt(b, k.split("."))[0]);
    if (c !== 0) return c * (dir as number);
  }
  return 0;
}

function project(d: Document, p: Document): Document {
  const include = Object.values(p).some((v) => v === 1);
  if (include) {
    const out: Document = { _id: d._id };
    for (const k of Object.keys(p)) {
      const top = k.split(".")[0]!;
      if (top in d) out[top] = d[top];
    }
    return out;
  }
  const out: Document = { ...d };
  for (const k of Object.keys(p)) delete out[k.split(".")[0]!];
  return out;
}
