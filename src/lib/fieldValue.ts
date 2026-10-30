import type { Ejson } from "../data/explorer.ts";
import { describe } from "./ejson.ts";

/** The types of the "Add field" form, in the order the list shows them. */
export const FIELD_TYPES = ["String", "Number", "Boolean", "Date", "ObjectId", "Array", "Object", "Null"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A short example of each type for the list and the placeholder of the value box. */
export const FIELD_HINTS: Record<FieldType, string> = {
  String: '"abc"',
  Number: "42.5",
  Boolean: "true",
  Date: "ISO",
  ObjectId: "24 hex",
  Array: "[ ]",
  Object: "{ }",
  Null: "null",
};

export type Converted = { ok: true; value: Ejson } | { ok: false; error: string };

const bad = (error: string): Converted => ({ ok: false, error });

/** A field name MongoDB accepts in the documents this dashboard writes: no empty name, no "$" start, no ".", no NUL. */
export function fieldNameProblem(name: string): string | null {
  if (!name) return "Give the field a name.";
  if (name.startsWith("$")) return 'A field name cannot start with "$".';
  if (name.includes(".")) return 'A field name cannot contain ".".';
  if (name.includes("\0")) return "A field name cannot contain a null character.";
  if (name.length > 120) return "A field name can have at most 120 characters.";
  return null;
}

/**
 * The text typed in the form, as a canonical Extended JSON value of the chosen type (the form the control plane
 * stores): integers are {"$numberInt"} or {"$numberLong"}, other numbers {"$numberDouble"}, dates {"$date": {"$numberLong"}}.
 */
export function toEjson(type: FieldType, text: string): Converted {
  switch (type) {
    case "String":
      return { ok: true, value: text };
    case "Null":
      return { ok: true, value: null };
    case "Boolean": {
      const t = text.trim().toLowerCase();
      return t === "true" || t === "false" ? { ok: true, value: t === "true" } : bad("Choose true or false.");
    }
    case "Number": {
      const t = text.trim();
      if (!t) return bad("Type a number.");
      if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return bad("This is not a number. Use digits, for example 42 or 42.5.");
      const n = Number(t);
      if (!Number.isFinite(n)) return bad("This number is too large.");
      if (/^[-+]?\d+$/.test(t)) {
        if (!Number.isSafeInteger(n)) return bad("Whole numbers go up to 9,007,199,254,740,991. Use a string for larger ones.");
        return n >= -2147483648 && n <= 2147483647 ? { ok: true, value: { $numberInt: String(n) } } : { ok: true, value: { $numberLong: String(n) } };
      }
      return { ok: true, value: { $numberDouble: String(n) } };
    }
    case "Date": {
      const t = text.trim();
      if (!t) return bad("Type a date, for example 2026-10-30T17:48:12Z.");
      const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : /(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`);
      return Number.isNaN(ms) ? bad("This is not a date. Use ISO format, for example 2026-10-30T17:48:12Z.") : { ok: true, value: { $date: { $numberLong: String(ms) } } };
    }
    case "ObjectId": {
      const t = text.trim();
      return /^[0-9a-fA-F]{24}$/.test(t) ? { ok: true, value: { $oid: t.toLowerCase() } } : bad("An ObjectId is 24 characters, 0 to 9 and a to f.");
    }
    case "Array":
    case "Object": {
      let v: unknown;
      try {
        v = JSON.parse(text);
      } catch (e) {
        return bad(`This is not valid JSON: ${e instanceof Error ? e.message.replace(/^JSON\.parse: /, "") : "check the brackets and quotes"}.`);
      }
      if (type === "Array") return Array.isArray(v) ? { ok: true, value: v as Ejson } : bad("An array starts with [ and ends with ].");
      return typeof v === "object" && v !== null && !Array.isArray(v) ? { ok: true, value: v as Ejson } : bad("An object starts with { and ends with }.");
    }
  }
}

/** The form type of a stored value, or null for types the form does not edit (binary, regex, decimal, UUID…). */
export function fieldTypeOf(v: Ejson): FieldType | null {
  const d = describe(v);
  if (d.kind === "array") return "Array";
  if (d.kind === "object") return "Object";
  switch (d.type) {
    case "string":
      return "String";
    case "number":
    case "int32":
    case "int64":
    case "double":
      return "Number";
    case "bool":
      return "Boolean";
    case "date":
      return "Date";
    case "objectId":
      return "ObjectId";
    case "null":
      return "Null";
    default:
      return null;
  }
}

/** The pill next to a field: the type as MongoDB names it. */
export function typeLabel(v: Ejson): string {
  const d = describe(v);
  if (d.kind !== "scalar") return d.kind;
  return ({ bool: "boolean", int32: "int", int64: "long", double: "double", decimal128: "decimal", objectId: "objectId" } as Record<string, string>)[d.type] ?? d.type;
}

/** The text a value has in the form when it is edited. */
export function textOf(v: Ejson): string {
  const d = describe(v);
  if (d.kind !== "scalar") return JSON.stringify(v, null, 2);
  if (d.type === "string") return v as string;
  if (d.type === "date") return /"([^"]+)"/.exec(d.text)?.[1] ?? "";
  if (d.type === "objectId") return /"([^"]+)"/.exec(d.text)?.[1] ?? "";
  return d.text;
}
