import { BSON, BSONRegExp, type Document, EJSON, Int32, Long, Double, ObjectId } from "bson";
import { ApiError, validation } from "../errors.ts";

/**
 * What a browser may send to the Data Explorer, and how it becomes something the engine is given.
 *
 * Everything here is an allowlist: a key, an operator or a value shape that is not named below is refused with a
 * 400, never passed on. Values are written in MongoDB Extended JSON v2 (canonical or relaxed); a wrapper such as
 * `{"$oid": ...}` is turned into its BSON type here, one wrapper at a time, after its shape was checked, so the
 * EJSON parser never sees a whole client object (it would read legacy forms like `{"$regex","$options"}` or
 * `{"$ref","$id"}` as values).
 */

export const LIMITS = {
  collectionNameMax: 120,
  filterMaxBytes: 8 * 1024,
  filterMaxDepth: 8,
  filterMaxKeys: 100,
  logicalMaxBranches: 20,
  inMaxValues: 100,
  regexMaxLength: 256,
  fieldPathMax: 256,
  sortMaxKeys: 8,
  projectionMaxKeys: 50,
  /** sort and projection are small: one level of field: value pairs. */
  smallJsonMaxBytes: 2 * 1024,
  documentMaxDepth: 32,
  documentMaxKeys: 20_000,
  fieldNameMax: 512,
  idMaxBytes: 1024,
} as const;

export type Plain = null | boolean | number | string | Plain[] | { [k: string]: Plain };

// ---------------------------------------------------------------- collection names

const COLLECTION_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export const COLLECTION_RULE = `Collection names are 1 to ${LIMITS.collectionNameMax} letters, digits, "_", "-" or ".", do not start with a dot or "system." and have no "..".`;

/** True for a name the explorer may open. Everything else (system collections, `$`, NUL, spaces, unicode) is refused. */
export function isAllowedCollection(name: unknown): name is string {
  return typeof name === "string"
    && name.length >= 1 && name.length <= LIMITS.collectionNameMax
    && COLLECTION_RE.test(name)
    && !/^system\./i.test(name)
    && !name.includes("..")
    && !name.endsWith(".");
}

export function parseCollection(name: unknown): string {
  if (!isAllowedCollection(name)) throw validation(COLLECTION_RULE, "collection");
  return name;
}

// ---------------------------------------------------------------- Extended JSON wrappers

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysOf = (o: Record<string, unknown>) => Object.keys(o);
const only = (o: Record<string, unknown>, ...k: string[]) => { const ks = keysOf(o); return ks.length === k.length && k.every((x) => ks.includes(x)); };

const INT_RE = /^-?\d{1,10}$/;
const LONG_RE = /^-?\d{1,19}$/;
const DOUBLE_RE = /^(-?(\d+(\.\d+)?([eE][-+]?\d+)?)|Infinity|-Infinity|NaN)$/;
const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^-?Infinity$|^NaN$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The wrappers accepted as values. `$code`, `$symbol`, `$dbPointer`, `$ref` and legacy forms are not. */
type WrapperName = "$oid" | "$date" | "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal" | "$binary" | "$uuid" | "$timestamp" | "$minKey" | "$maxKey" | "$regularExpression";

/** The wrapper this object is, after checking its exact shape, or null when it is not one. Throws for a broken one. */
function wrapperOf(o: Record<string, unknown>, where: string): WrapperName | null {
  const ks = keysOf(o);
  if (ks.length !== 1) return null;
  const k = ks[0]!;
  const v = o[k];
  const bad = (): never => { throw validation(`${where}: ${k} is not written correctly.`); };
  switch (k) {
    case "$oid": if (typeof v !== "string" || !/^[0-9a-fA-F]{24}$/.test(v)) bad(); return k;
    case "$date":
      if (typeof v === "string") { if (!ISO_RE.test(v) || Number.isNaN(Date.parse(v))) bad(); return k; }
      if (typeof v === "number") { if (!Number.isSafeInteger(v)) bad(); return k; }
      if (isObj(v) && only(v, "$numberLong") && typeof v.$numberLong === "string" && LONG_RE.test(v.$numberLong)) return k;
      return bad();
    case "$numberInt": if (typeof v !== "string" || !INT_RE.test(v) || Math.abs(Number(v)) > 2 ** 31 || Number(v) === 2 ** 31) bad(); return k;
    case "$numberLong": if (typeof v !== "string" || !LONG_RE.test(v)) bad(); return k;
    case "$numberDouble": if (typeof v !== "string" || !DOUBLE_RE.test(v)) bad(); return k;
    case "$numberDecimal": if (typeof v !== "string" || v.length > 64 || !DECIMAL_RE.test(v)) bad(); return k;
    case "$binary":
      if (!isObj(v) || !only(v, "base64", "subType") || typeof v.base64 !== "string" || !B64_RE.test(v.base64) || typeof v.subType !== "string" || !/^[0-9a-fA-F]{1,2}$/.test(v.subType)) bad();
      return k;
    case "$uuid": if (typeof v !== "string" || !UUID_RE.test(v)) bad(); return k;
    case "$timestamp":
      if (!isObj(v) || !only(v, "t", "i") || !Number.isInteger(v.t) || !Number.isInteger(v.i) || (v.t as number) < 0 || (v.i as number) < 0 || (v.t as number) > 0xffffffff || (v.i as number) > 0xffffffff) bad();
      return k;
    case "$minKey": case "$maxKey": if (v !== 1) bad(); return k;
    case "$regularExpression":
      if (!isObj(v) || !only(v, "pattern", "options") || typeof v.pattern !== "string" || typeof v.options !== "string" || v.pattern.length > LIMITS.regexMaxLength || !/^[imsux]*$/.test(v.options)) bad();
      return k;
    default: return null;
  }
}

function fromWrapper(o: Record<string, unknown>, where: string): unknown {
  try {
    return EJSON.deserialize(o as Document, { relaxed: false });
  } catch {
    throw validation(`${where}: ${keysOf(o)[0]} is not written correctly.`);
  }
}

/** A bare JSON number, typed as canonical EJSON parsing does: int32 when it fits, int64 for other integers, else double. */
function fromNumber(n: number): Int32 | Long | Double {
  if (Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31) return new Int32(n);
  if (Number.isSafeInteger(n)) return Long.fromNumber(n);
  return new Double(n);
}

// ---------------------------------------------------------------- values (documents, _id, literals in filters)

interface Budget { keys: number; maxKeys: number; maxDepth: number }

/** A field name inside a stored document. */
function checkFieldName(k: string, where: string): void {
  if (k.length === 0 || k.length > LIMITS.fieldNameMax) throw validation(`${where}: field names are 1 to ${LIMITS.fieldNameMax} characters.`);
  if (k.startsWith("$")) throw validation(`${where}: field names cannot start with "$".`);
  if (k.includes(".")) throw validation(`${where}: field names cannot contain ".".`);
  if (k.includes("\0")) throw validation(`${where}: field names cannot contain a NUL character.`);
  if (k === "__proto__") throw validation(`${where}: "__proto__" cannot be used as a field name.`);
}

function value(v: unknown, depth: number, b: Budget, where: string, allowRegex: boolean): unknown {
  if (depth > b.maxDepth) throw validation(`${where} is nested too deeply (at most ${b.maxDepth} levels).`);
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return fromNumber(v);
  if (Array.isArray(v)) {
    b.keys += v.length;
    if (b.keys > b.maxKeys) throw validation(`${where} has too many values (at most ${b.maxKeys}).`);
    return v.map((x) => value(x, depth + 1, b, where, allowRegex));
  }
  if (isObj(v)) {
    const w = wrapperOf(v, where);
    if (w) {
      if (w === "$regularExpression" && !allowRegex) throw validation(`${where}: use $regex to match a pattern.`);
      return fromWrapper(v, where);
    }
    const out: Record<string, unknown> = {};
    for (const k of keysOf(v)) {
      b.keys++;
      if (b.keys > b.maxKeys) throw validation(`${where} has too many fields (at most ${b.maxKeys}).`);
      checkFieldName(k, where);
      out[k] = value(v[k], depth + 1, b, where, allowRegex);
    }
    return out;
  }
  throw validation(`${where} is not valid JSON.`);
}

/** Parses JSON text that a client sent in a query parameter, with a size cap. */
function parseJsonParam(raw: unknown, field: string, maxBytes: number): unknown {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") throw validation(`${field} must be JSON text.`, field);
  if (Buffer.byteLength(raw) > maxBytes) throw validation(`${field} is too long (at most ${maxBytes} bytes).`, field);
  try {
    return JSON.parse(raw);
  } catch {
    throw validation(`${field} is not valid JSON.`, field);
  }
}

// ---------------------------------------------------------------- documents

/**
 * A document a browser wants to insert or save, as Extended JSON. Field names: no `$` prefix, no `.`, no NUL,
 * no `__proto__`. `_id` must not be an array or a regular expression; it is added (an ObjectId) when missing.
 * Returns the BSON document with `_id` first, and its BSON size.
 */
export function parseDocument(raw: unknown, maxBytes: number, where = "document"): { doc: Document; bytes: number } {
  return inField(where, () => documentOf(raw, maxBytes, where));
}

function documentOf(raw: unknown, maxBytes: number, where: string): { doc: Document; bytes: number } {
  if (!isObj(raw)) throw validation("The document must be a JSON object.", where);
  const b: Budget = { keys: 0, maxKeys: LIMITS.documentMaxKeys, maxDepth: LIMITS.documentMaxDepth };
  const body = value(raw, 0, b, "The document", true) as Document;
  if ("_id" in body) checkId(body._id, "The document's _id");
  const doc: Document = { _id: "_id" in body ? body._id : new ObjectId() };
  for (const [k, v] of Object.entries(body)) if (k !== "_id") doc[k] = v;
  let bytes: number;
  try {
    bytes = BSON.calculateObjectSize(doc);
  } catch {
    throw validation("The document cannot be stored.", where);
  }
  if (bytes > maxBytes) throw validation(`The document is too large (${bytes} bytes; at most ${maxBytes}).`, where);
  return { doc, bytes };
}

function checkId(id: unknown, where: string): void {
  if (id === undefined) throw validation(`${where} is missing.`);
  if (Array.isArray(id)) throw validation(`${where} cannot be an array.`);
  if (id instanceof BSONRegExp) throw validation(`${where} cannot be a regular expression.`);
}

/** The `_id` of a document as it appears in a URL: its canonical Extended JSON text. */
export function parseDocumentId(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw) > LIMITS.idMaxBytes) throw validation("The document id is not valid.", "id");
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw validation("The document id is not valid.", "id");
  }
  const b: Budget = { keys: 0, maxKeys: 100, maxDepth: 4 };
  const id = value(j, 0, b, "The document id", false);
  checkId(id, "The document id");
  return id;
}

/** Canonical Extended JSON of a value: what the API sends and accepts back. Lossless for every BSON type. */
export const toCanonical = (v: unknown): unknown => EJSON.serialize(v as Document, { relaxed: false });
/** The string form of an `_id` used in URLs. */
export const idText = (id: unknown): string => JSON.stringify(EJSON.serialize({ v: id } as Document, { relaxed: false }).v);

// ---------------------------------------------------------------- filters

const COMPARE = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]);
const IN = new Set(["$in", "$nin"]);
const LOGICAL = new Set(["$and", "$or"]);
const REGEX_OPTIONS = /^(?!.*(.).*\1)[ims]*$/;

/** A path such as `a.b.0.c`: no `$` prefix, no empty part, no NUL. */
export function checkFieldPath(k: string, where: string): void {
  if (k.length === 0 || k.length > LIMITS.fieldPathMax) throw validation(`${where}: field names are 1 to ${LIMITS.fieldPathMax} characters.`);
  if (k.startsWith("$")) throw validation(`${where}: the operator ${k.slice(0, 40)} is not allowed.`);
  if (k.includes("\0")) throw validation(`${where}: field names cannot contain a NUL character.`);
  if (k.split(".").some((p) => p === "" || p.startsWith("$"))) throw validation(`${where}: "${k.slice(0, 60)}" is not a valid field path.`);
  if (k === "__proto__" || k.split(".").includes("__proto__")) throw validation(`${where}: "__proto__" cannot be used as a field name.`);
}

interface FilterBudget extends Budget { where: string }

function filterDoc(v: unknown, depth: number, b: FilterBudget): Document {
  if (!isObj(v)) throw validation(`${b.where} must be a JSON object, for example {"status": "active"}.`, "filter");
  if (depth > b.maxDepth) throw validation(`${b.where} is nested too deeply (at most ${b.maxDepth} levels).`, "filter");
  const out: Document = {};
  for (const k of keysOf(v)) {
    if (++b.keys > b.maxKeys) throw validation(`${b.where} has too many conditions (at most ${b.maxKeys}).`, "filter");
    const x = v[k];
    if (LOGICAL.has(k)) {
      if (!Array.isArray(x) || x.length === 0 || x.length > LIMITS.logicalMaxBranches) throw validation(`${b.where}: ${k} takes a list of 1 to ${LIMITS.logicalMaxBranches} conditions.`, "filter");
      out[k] = x.map((c) => filterDoc(c, depth + 1, b));
      continue;
    }
    if (k.startsWith("$")) throw validation(`${b.where}: the operator ${k.slice(0, 40)} is not allowed here.`, "filter");
    checkFieldPath(k, b.where);
    out[k] = condition(x, depth + 1, b);
  }
  return out;
}

const literal = (x: unknown, depth: number, b: FilterBudget) => value(x, depth, b, b.where, false);

/** The value of a field in a filter: a literal (equality) or an object of allowed operators. */
function condition(x: unknown, depth: number, b: FilterBudget): unknown {
  if (depth > b.maxDepth) throw validation(`${b.where} is nested too deeply (at most ${b.maxDepth} levels).`, "filter");
  if (!isObj(x) || wrapperOf(x, b.where)) return literal(x, depth, b);
  const ks = keysOf(x);
  const ops = ks.filter((k) => k.startsWith("$"));
  if (ops.length === 0) return literal(x, depth, b);
  if (ops.length !== ks.length) throw validation(`${b.where}: do not mix operators and field names in one object.`, "filter");
  return operators(x, depth, b);
}

function operators(x: Record<string, unknown>, depth: number, b: FilterBudget): Document {
  const out: Document = {};
  for (const op of keysOf(x)) {
    if (++b.keys > b.maxKeys) throw validation(`${b.where} has too many conditions (at most ${b.maxKeys}).`, "filter");
    const v = x[op];
    if (COMPARE.has(op)) {
      out[op] = literal(v, depth + 1, b);
    } else if (IN.has(op)) {
      if (!Array.isArray(v) || v.length > LIMITS.inMaxValues) throw validation(`${b.where}: ${op} takes a list of at most ${LIMITS.inMaxValues} values.`, "filter");
      out[op] = v.map((e) => literal(e, depth + 1, b));
    } else if (op === "$exists") {
      if (typeof v !== "boolean") throw validation(`${b.where}: $exists takes true or false.`, "filter");
      out[op] = v;
    } else if (op === "$regex") {
      if (typeof v !== "string" || v.length === 0 || v.length > LIMITS.regexMaxLength) throw validation(`${b.where}: $regex takes a pattern of 1 to ${LIMITS.regexMaxLength} characters.`, "filter");
      if (v.includes("\0")) throw validation(`${b.where}: $regex cannot contain a NUL character.`, "filter");
      out[op] = v;
    } else if (op === "$options") {
      if (!("$regex" in x)) throw validation(`${b.where}: $options goes with $regex.`, "filter");
      if (typeof v !== "string" || !REGEX_OPTIONS.test(v)) throw validation(`${b.where}: $options may only use i, m and s.`, "filter");
      out[op] = v;
    } else if (op === "$not") {
      if (!isObj(v) || keysOf(v).length === 0 || !keysOf(v).every((k) => k.startsWith("$")) || wrapperOf(v, b.where)) {
        throw validation(`${b.where}: $not takes an operator object, for example {"$not": {"$gt": 5}}.`, "filter");
      }
      out[op] = operators(v, depth + 1, b);
    } else {
      throw validation(`${b.where}: the operator ${op.slice(0, 40)} is not allowed.`, "filter");
    }
  }
  return out;
}

/** Every refusal of a parameter names that parameter, so the dashboard can show it next to the right box. */
function inField<T>(field: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ApiError && e.field === undefined) throw validation(e.message, field);
    throw e;
  }
}

/** The `filter` query parameter. Empty means every document. */
export function parseFilter(raw: unknown): Document {
  return inField("filter", () => {
    const j = parseJsonParam(raw, "filter", LIMITS.filterMaxBytes);
    if (j === undefined) return {};
    return filterDoc(j, 1, { keys: 0, maxKeys: LIMITS.filterMaxKeys, maxDepth: LIMITS.filterMaxDepth, where: "The filter" });
  });
}

/** The `sort` query parameter: field paths to 1 or -1. `_id` is added last so pages are stable. */
export function parseSort(raw: unknown): Document {
  return inField("sort", () => sortOf(raw));
}

function sortOf(raw: unknown): Document {
  const j = parseJsonParam(raw, "sort", LIMITS.smallJsonMaxBytes);
  const out: Document = {};
  if (j !== undefined) {
    if (!isObj(j)) throw validation('The sort must be a JSON object, for example {"createdAt": -1}.', "sort");
    const ks = keysOf(j);
    if (ks.length > LIMITS.sortMaxKeys) throw validation(`Sort by at most ${LIMITS.sortMaxKeys} fields.`, "sort");
    for (const k of ks) {
      checkFieldPath(k, "The sort");
      if (j[k] !== 1 && j[k] !== -1) throw validation("Sort each field by 1 (ascending) or -1 (descending).", "sort");
      out[k] = j[k];
    }
  }
  if (!("_id" in out)) out._id = 1;
  return out;
}

/** The `projection` query parameter: field paths to 1 (show) or 0 (hide), not both, and `_id` is always shown. */
export function parseProjection(raw: unknown): Document | undefined {
  return inField("projection", () => projectionOf(raw));
}

function projectionOf(raw: unknown): Document | undefined {
  const j = parseJsonParam(raw, "projection", LIMITS.smallJsonMaxBytes);
  if (j === undefined) return undefined;
  if (!isObj(j)) throw validation('The projection must be a JSON object, for example {"name": 1}.', "projection");
  const ks = keysOf(j);
  if (ks.length === 0) return undefined;
  if (ks.length > LIMITS.projectionMaxKeys) throw validation(`Name at most ${LIMITS.projectionMaxKeys} fields in the projection.`, "projection");
  const out: Document = {};
  let mode: 0 | 1 | null = null;
  for (const k of ks) {
    checkFieldPath(k, "The projection");
    const v = j[k] === true ? 1 : j[k] === false ? 0 : j[k];
    if (v !== 0 && v !== 1) throw validation("In the projection use 1 to show a field or 0 to hide it.", "projection");
    if (k === "_id") {
      if (v === 0) throw validation("The _id is always shown.", "projection");
      continue;
    }
    if (mode !== null && mode !== v) throw validation("A projection either shows fields (1) or hides them (0), not both.", "projection");
    mode = v;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
