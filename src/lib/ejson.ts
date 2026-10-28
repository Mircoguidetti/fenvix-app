import type { Ejson } from "../data/explorer";

/**
 * How a canonical Extended JSON value is shown in the Data tab. Everything returned here is plain text that React
 * renders as text: nothing a document holds is ever turned into HTML.
 */
export type Shown =
  | { kind: "scalar"; text: string; type: string }
  | { kind: "object"; entries: [string, Ejson][] }
  | { kind: "array"; items: Ejson[] };

const isObj = (v: Ejson): v is { [k: string]: Ejson } => typeof v === "object" && v !== null && !Array.isArray(v);
const one = (v: { [k: string]: Ejson }, k: string) => Object.keys(v).length === 1 && k in v;

function dateText(d: Ejson): string {
  const ms = isObj(d) && typeof d.$numberLong === "string" ? Number(d.$numberLong) : typeof d === "string" ? Date.parse(d) : typeof d === "number" ? d : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(isObj(d) ? d.$numberLong : d);
}

/** One value: a typed scalar (wrappers included), an object or an array. */
export function describe(v: Ejson): Shown {
  if (v === null) return { kind: "scalar", text: "null", type: "null" };
  if (typeof v === "boolean") return { kind: "scalar", text: String(v), type: "bool" };
  if (typeof v === "number") return { kind: "scalar", text: String(v), type: "number" };
  if (typeof v === "string") return { kind: "scalar", text: JSON.stringify(v), type: "string" };
  if (Array.isArray(v)) return { kind: "array", items: v };
  if (one(v, "$oid")) return { kind: "scalar", text: `ObjectId("${String(v.$oid)}")`, type: "objectId" };
  if (one(v, "$date")) return { kind: "scalar", text: `ISODate("${dateText(v.$date)}")`, type: "date" };
  if (one(v, "$numberInt")) return { kind: "scalar", text: String(v.$numberInt), type: "int32" };
  if (one(v, "$numberLong")) return { kind: "scalar", text: String(v.$numberLong), type: "int64" };
  if (one(v, "$numberDouble")) return { kind: "scalar", text: String(v.$numberDouble), type: "double" };
  if (one(v, "$numberDecimal")) return { kind: "scalar", text: String(v.$numberDecimal), type: "decimal128" };
  if (one(v, "$uuid")) return { kind: "scalar", text: `UUID("${String(v.$uuid)}")`, type: "uuid" };
  if (one(v, "$binary") && isObj(v.$binary)) {
    const b = v.$binary;
    if (b.subType === "04" && typeof b.base64 === "string") return { kind: "scalar", text: `UUID("${uuidFromBase64(b.base64)}")`, type: "uuid" };
    return { kind: "scalar", text: `Binary("${String(b.base64)}", ${String(b.subType)})`, type: "binary" };
  }
  if (one(v, "$timestamp") && isObj(v.$timestamp)) return { kind: "scalar", text: `Timestamp(${String(v.$timestamp.t)}, ${String(v.$timestamp.i)})`, type: "timestamp" };
  if (one(v, "$regularExpression") && isObj(v.$regularExpression)) {
    return { kind: "scalar", text: `/${String(v.$regularExpression.pattern)}/${String(v.$regularExpression.options)}`, type: "regex" };
  }
  if (one(v, "$minKey")) return { kind: "scalar", text: "MinKey", type: "minKey" };
  if (one(v, "$maxKey")) return { kind: "scalar", text: "MaxKey", type: "maxKey" };
  return { kind: "object", entries: Object.entries(v) };
}

function uuidFromBase64(b64: string): string {
  try {
    const hex = Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    if (hex.length !== 32) return b64;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return b64;
  }
}

/** A one-line text of a value, cut to `max` characters, for collapsed rows and the _id heading. */
export function summary(v: Ejson, max = 80): string {
  const d = describe(v);
  const text = d.kind === "scalar" ? d.text : d.kind === "array" ? `[ ${d.items.length} item${d.items.length === 1 ? "" : "s"} ]` : `{ ${d.entries.length} field${d.entries.length === 1 ? "" : "s"} }`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The text of an `_id` as the API gives it (canonical Extended JSON). */
export function idSummary(id: string, max = 80): string {
  try {
    return summary(JSON.parse(id) as Ejson, max);
  } catch {
    return id.slice(0, max);
  }
}

/** Pretty JSON for the editor. */
export const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** Checks a JSON text typed in a box; the message says where it broke. Null when valid. */
export function jsonError(text: string, what: string, mustBeObject = true): string | null {
  if (!text.trim()) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return `${what} is not valid JSON: ${e instanceof Error ? e.message.replace(/^JSON\.parse: /, "") : "check the brackets and quotes"}.`;
  }
  if (mustBeObject && (typeof v !== "object" || v === null || Array.isArray(v))) return `${what} must be a JSON object, for example {"status": "active"}.`;
  return null;
}
