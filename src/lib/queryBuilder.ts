import type { Ejson } from "../data/explorer.ts";

/**
 * The visual query builder writes the same filter the Data tab accepts as JSON, with only the operators the engine
 * allows ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or, $not, $exists, $regex).
 */
export const OPERATORS = [
  { value: "$eq", label: "is equal to", takes: "value" },
  { value: "$ne", label: "is not equal to", takes: "value" },
  { value: "$gt", label: "is greater than", takes: "value" },
  { value: "$gte", label: "is at least", takes: "value" },
  { value: "$lt", label: "is less than", takes: "value" },
  { value: "$lte", label: "is at most", takes: "value" },
  { value: "$in", label: "is one of", takes: "list" },
  { value: "$nin", label: "is none of", takes: "list" },
  { value: "$exists", label: "exists", takes: "none" },
  { value: "$notexists", label: "does not exist", takes: "none" },
  { value: "$regex", label: "matches the pattern", takes: "text" },
] as const;
export type OperatorValue = (typeof OPERATORS)[number]["value"];

export interface Condition {
  field: string;
  op: OperatorValue;
  value: string;
}
export type Match = "all" | "any";

/** A typed value: JSON when it parses (42, true, "paid", null), the text itself otherwise. */
export function parseValue(text: string): Ejson {
  const t = text.trim();
  if (t === "") return "";
  try {
    return JSON.parse(t) as Ejson;
  } catch {
    return t;
  }
}

function parseList(text: string): Ejson[] {
  const t = text.trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v as Ejson[];
    } catch {
      /* falls back to the comma list below */
    }
  }
  return t.split(",").map((p) => parseValue(p)).filter((v) => v !== "");
}

/** The problem with one row, or null. */
export function conditionProblem(c: Condition): string | null {
  if (!c.field.trim()) return "Name the field.";
  if (c.field.trim().startsWith("$")) return 'A field name cannot start with "$".';
  const op = OPERATORS.find((o) => o.value === c.op)!;
  if (op.takes !== "none" && !c.value.trim()) return "Give a value.";
  if (op.takes === "list" && parseList(c.value).length === 0) return "Give at least one value.";
  if (op.takes === "text") {
    try {
      new RegExp(c.value);
    } catch {
      return "This pattern is not a valid regular expression.";
    }
  }
  return null;
}

function one(c: Condition): { [k: string]: Ejson } {
  const field = c.field.trim();
  const op = OPERATORS.find((o) => o.value === c.op)!;
  if (c.op === "$exists") return { [field]: { $exists: true } };
  if (c.op === "$notexists") return { [field]: { $exists: false } };
  if (op.takes === "list") return { [field]: { [c.op]: parseList(c.value) } };
  if (op.takes === "text") return { [field]: { $regex: c.value } };
  return { [field]: { [c.op]: parseValue(c.value) } };
}

/** The filter object for the rows: {} for none, the row itself for one, $and or $or for several. */
export function buildFilter(conditions: Condition[], match: Match): { [k: string]: Ejson } {
  const rows = conditions.filter((c) => c.field.trim()).map(one);
  if (rows.length === 0) return {};
  if (rows.length === 1) return rows[0];
  return match === "all" ? { $and: rows } : { $or: rows };
}

export const filterText = (conditions: Condition[], match: Match) => {
  const f = buildFilter(conditions, match);
  return Object.keys(f).length ? JSON.stringify(f) : "";
};

const text = (v: Ejson) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));

function rowFrom(field: string, spec: Ejson): Condition | null {
  if (field.startsWith("$")) return null;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return { field, op: "$eq", value: text(spec) };
  const keys = Object.keys(spec);
  if (keys.length !== 1) return null;
  const k = keys[0];
  const v = (spec as { [k: string]: Ejson })[k];
  if (k === "$exists") return { field, op: v === false ? "$notexists" : "$exists", value: "" };
  if (k === "$in" || k === "$nin") return Array.isArray(v) ? { field, op: k, value: JSON.stringify(v) } : null;
  if (k === "$regex") return typeof v === "string" ? { field, op: "$regex", value: v } : null;
  if (["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"].includes(k)) return { field, op: k as OperatorValue, value: text(v) };
  return null;
}

/** The rows for a filter written as JSON, or null when the filter is more than the builder can show. */
export function parseFilter(filterJson: string): { conditions: Condition[]; match: Match } | null {
  if (!filterJson.trim()) return { conditions: [], match: "all" };
  let f: unknown;
  try {
    f = JSON.parse(filterJson);
  } catch {
    return null;
  }
  if (typeof f !== "object" || f === null || Array.isArray(f)) return null;
  const obj = f as { [k: string]: Ejson };
  const keys = Object.keys(obj);
  const rows = (list: Ejson): Condition[] | null => {
    if (!Array.isArray(list)) return null;
    const out: Condition[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null || Array.isArray(item) || Object.keys(item).length !== 1) return null;
      const [[field, spec]] = Object.entries(item);
      const r = rowFrom(field, spec);
      if (!r) return null;
      out.push(r);
    }
    return out;
  };
  if (keys.length === 1 && (keys[0] === "$and" || keys[0] === "$or")) {
    const r = rows(obj[keys[0]]);
    return r && { conditions: r, match: keys[0] === "$and" ? "all" : "any" };
  }
  const out: Condition[] = [];
  for (const k of keys) {
    const r = rowFrom(k, obj[k]);
    if (!r) return null;
    out.push(r);
  }
  return { conditions: out, match: "all" };
}
