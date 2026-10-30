// In-memory Data Explorer for VITE_DATA_BACKEND=mock (the Playwright checks). Every name and value is made up.
import { assertMockCanManage } from "./orgs-mock";
import { type CollectionInfo, type DocumentItem, type DocumentPage, type DocumentQuery, type Ejson, type ExplorerClient, ExplorerError, isAllowedCollectionName } from "./explorer";

type Doc = { [key: string]: Ejson };

const oid = (n: number) => ({ $oid: `65f1a2b3c4d5e6f7${n.toString(16).padStart(8, "0")}` });
const date = (iso: string) => ({ $date: { $numberLong: String(Date.parse(iso)) } });
const int = (n: number) => ({ $numberInt: String(n) });

function seedOrders(): Doc[] {
  const states = ["paid", "shipped", "delivered", "refunded"];
  return Array.from({ length: 57 }, (_, i) => ({
    _id: oid(i + 1),
    number: int(10_400 + i),
    status: states[i % states.length]!,
    customer: { name: ["Ada Park", "Omar Diaz", "Lena Wolf", "Kai Moreno"][i % 4]!, email: `buyer${i + 1}@northwind.cloud` },
    total: { $numberDecimal: `${(19.9 + i * 3.25).toFixed(2)}` },
    items: [{ sku: `SKU-${100 + i}`, qty: int(1 + (i % 3)) }],
    placedAt: date(new Date(Date.UTC(2026, 8, 1 + (i % 28), 9 + (i % 8))).toISOString()),
  }));
}

/** The notes collection holds markup on purpose: the checks prove it is shown as text and never runs. */
function seedNotes(): Doc[] {
  return [
    { _id: oid(901), title: "<script>window.__xss = 'script'</script>", body: "<img src=x onerror=\"window.__xss='img'\">", author: "support" },
    { _id: oid(902), title: "Escalation", body: "Call back before Friday", tags: ["vip", "phone"], due: date("2026-10-30T10:00:00Z") },
  ];
}

const STORE = new Map<string, Map<string, Doc[]>>([
  ["db_0001", new Map([["orders", seedOrders()], ["customers", [{ _id: oid(501), name: "Northwind", plan: "team", seats: int(12) }]], ["notes", seedNotes()]])],
  ["db_0003", new Map([["orders", seedOrders().slice(0, 8)]])],
]);
const ASLEEP = new Set(["db_0003", "db_0004", "db_0005", "db_0007", "db_0008", "db_0010", "db_0011", "db_0012"]);
const woken = new Set<string>();

/** A short, stable hash as the version (the real one is SHA-256 on the server). */
function versionOf(d: Doc): string {
  const s = JSON.stringify(d);
  let out = "";
  for (let seed = 0; out.length < 32; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 32);
}

const FORBIDDEN = /"\$(where|function|accumulator|expr|lookup|out|merge|jsonSchema|text)"/;
const later = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

async function enter(db: string): Promise<Map<string, Doc[]>> {
  if (ASLEEP.has(db) && !woken.has(db)) {
    await new Promise((r) => setTimeout(r, 1800)); // the first request wakes it
    woken.add(db);
  }
  let d = STORE.get(db);
  if (!d) {
    d = new Map();
    STORE.set(db, d);
  }
  return d;
}

function badRequest(message: string, field?: string): never {
  throw new ExplorerError("validation_failed", message, 400, field);
}

function parseObject(text: string | undefined, field: string): Doc {
  if (!text?.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return badRequest(`${field} is not valid JSON.`, field);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) badRequest(`The ${field} must be a JSON object.`, field);
  const m = JSON.stringify(v).match(FORBIDDEN);
  if (m) badRequest(`The ${field}: the operator $${m[1]} is not allowed.`, field);
  return v as Doc;
}

const flat = (v: Ejson): string => JSON.stringify(v);
/** A stored value as something comparable: numbers (plain or wrapped), dates and text. */
function comparable(v: Ejson | undefined): number | string | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (!Array.isArray(v) && typeof v === "object") {
    for (const k of ["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"]) if (k in v) return Number(v[k]);
    if ("$date" in v) return Number(typeof v.$date === "object" && v.$date && !Array.isArray(v.$date) ? (v.$date as { $numberLong?: string }).$numberLong : Date.parse(String(v.$date)));
    if ("$oid" in v) return String(v.$oid);
  }
  return flat(v);
}
const same = (a: Ejson | undefined, b: Ejson | undefined) => comparable(a) === comparable(b);

/** The operators the control plane allows: $eq $ne $gt $gte $lt $lte $in $nin $and $or $not $exists $regex. Top-level fields only. */
function matches(d: Doc, f: Doc): boolean {
  return Object.entries(f).every(([k, cond]) => {
    if (k === "$and") return (cond as Doc[]).every((x) => matches(d, x));
    if (k === "$or") return (cond as Doc[]).some((x) => matches(d, x));
    const val = d[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond) && Object.keys(cond).every((o) => o.startsWith("$")) && !("$oid" in cond) && !("$date" in cond) && !Object.keys(cond).some((o) => o.startsWith("$number"))) {
      return Object.entries(cond).every(([op, arg]) => {
        const x = comparable(val);
        const y = comparable(arg as Ejson);
        switch (op) {
          case "$eq": return same(val, arg as Ejson);
          case "$ne": return !same(val, arg as Ejson);
          case "$gt": return x !== null && y !== null && x > y;
          case "$gte": return x !== null && y !== null && x >= y;
          case "$lt": return x !== null && y !== null && x < y;
          case "$lte": return x !== null && y !== null && x <= y;
          case "$in": return (arg as Ejson[]).some((a) => same(val, a));
          case "$nin": return !(arg as Ejson[]).some((a) => same(val, a));
          case "$exists": return (val !== undefined) === !!arg;
          case "$regex": return typeof val === "string" && new RegExp(String(arg), String((cond as Doc).$options ?? "")).test(val);
          case "$options": return true;
          case "$not": return !matches({ [k]: val as Ejson }, { [k]: arg as Ejson });
          default: return false;
        }
      });
    }
    return same(val, cond as Ejson);
  });
}

const item = (d: Doc, partial = false): DocumentItem => ({ id: JSON.stringify(d._id), version: partial ? null : versionOf(d), partial, document: d });

export const mockExplorer: ExplorerClient = {
  async listCollections(db) {
    const d = await enter(db);
    const items: CollectionInfo[] = [...d.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, docs]) => ({ name, type: "collection", browsable: isAllowedCollectionName(name), estimatedCount: docs.length }));
    return later({ items, truncated: false });
  },

  async findDocuments(db, c, q: DocumentQuery): Promise<DocumentPage> {
    const filter = parseObject(q.filter, "filter");
    const sort = parseObject(q.sort, "sort");
    const projection = parseObject(q.projection, "projection");
    const pageSize = Math.min(100, q.pageSize ?? 25);
    const page = q.page ?? 1;
    const all = ((await enter(db)).get(c) ?? []).filter((d) => matches(d, filter));
    const [sk, dir] = Object.entries(sort)[0] ?? ["_id", 1];
    all.sort((a, b) => (flat(a[sk] ?? null) < flat(b[sk] ?? null) ? -1 : flat(a[sk] ?? null) > flat(b[sk] ?? null) ? 1 : 0) * (dir === -1 ? -1 : 1));
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    const keys = Object.keys(projection);
    const shown = keys.length ? slice.map((d) => item(Object.fromEntries(Object.entries(d).filter(([k]) => k === "_id" || keys.includes(k))), true)) : slice.map((d) => item(d));
    return later({ items: shown, page, pageSize, hasMore: all.length > page * pageSize, truncated: false });
  },

  async getDocument(db, c, id) {
    const d = ((await enter(db)).get(c) ?? []).find((x) => JSON.stringify(x._id) === id);
    if (!d) throw new ExplorerError("not_found", "That document does not exist.", 404);
    return later(item(d));
  },

  async insertDocument(db, c, document) {
    assertMockCanManage();
    const coll = (await enter(db)).get(c) ?? [];
    (await enter(db)).set(c, coll);
    const doc: Doc = { _id: document._id ?? oid(Math.floor(Math.random() * 1e8)), ...document };
    if (coll.some((x) => flat(x._id) === flat(doc._id))) throw new ExplorerError("conflict", "A document with this _id already exists in this collection.", 409, "document");
    if (JSON.stringify(doc).match(/"\$(set|where|unset)"/)) badRequest('The document: field names cannot start with "$".', "document");
    coll.push(doc);
    return later({ id: JSON.stringify(doc._id), version: versionOf(doc) });
  },

  async replaceDocument(db, c, id, document, version) {
    assertMockCanManage();
    const coll = (await enter(db)).get(c) ?? [];
    const i = coll.findIndex((x) => JSON.stringify(x._id) === id);
    if (i < 0) throw new ExplorerError("not_found", "That document does not exist.", 404);
    if (versionOf(coll[i]!) !== version) throw new ExplorerError("conflict", "Someone changed this document after you opened it. Reload it and make your change again.", 409, "version");
    const next: Doc = { ...document, _id: coll[i]!._id };
    coll[i] = next;
    return later({ id, version: versionOf(next) });
  },

  async deleteDocument(db, c, id, version) {
    assertMockCanManage();
    const coll = (await enter(db)).get(c) ?? [];
    const i = coll.findIndex((x) => JSON.stringify(x._id) === id);
    if (i < 0) throw new ExplorerError("not_found", "That document does not exist.", 404);
    if (versionOf(coll[i]!) !== version) throw new ExplorerError("conflict", "Someone changed this document after you opened it. Reload it and try again.", 409, "version");
    coll.splice(i, 1);
    await later(null);
  },
};

/** For the checks: change a document behind the page's back, as another person would. */
export function mockTouch(db: string, c: string, id: string, field: string, value: Ejson): void {
  const d = STORE.get(db)?.get(c)?.find((x) => JSON.stringify(x._id) === id);
  if (d) d[field] = value;
}

// The checks reach the mock through the page, to play "another person" (VITE_DATA_BACKEND=mock only).
(globalThis as { __fenvixExplorerMock?: unknown }).__fenvixExplorerMock = { touch: mockTouch };
