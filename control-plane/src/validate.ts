import { type Limits } from "./limits.ts";
import { validation } from "./errors.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const TAG_PART = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
export const NAME_RULE = "Use 3 to 48 lowercase letters, numbers or dashes, starting and ending with a letter or number.";

export type Obj = Record<string, unknown>;

export function asObject(body: unknown, what = "The request body"): Obj {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw validation(`${what} must be a JSON object.`);
  return body as Obj;
}

/** Database and fork names: trimmed, lowercased, then checked against the contract rule. */
export function parseName(value: unknown, limits: Limits, field = "name"): string {
  if (typeof value !== "string") throw validation("Enter a name.", field);
  const name = value.trim().toLowerCase();
  if (name.length < limits.nameMinLength || name.length > limits.nameMaxLength || !NAME_RE.test(name)) {
    throw validation(NAME_RULE, field);
  }
  return name;
}

export interface Tag { key: string; value: string }

export function splitTag(raw: string): Tag {
  const t = raw.trim().toLowerCase();
  const i = t.indexOf(":");
  const key = i < 0 ? "" : t.slice(0, i);
  const value = i < 0 ? "" : t.slice(i + 1);
  if (i < 1 || !TAG_PART.test(key) || !TAG_PART.test(value)) {
    throw validation("Write a tag as key:value, for example customer:acme-labs.", "tags");
  }
  return { key, value };
}

/** A full tag list: valid tags, one value per key, at most the limit. */
export function parseTags(value: unknown, limits: Limits, field = "tags"): Tag[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((t) => typeof t !== "string")) throw validation("Tags must be a list of key:value strings.", field);
  const tags = (value as string[]).map(splitTag);
  if (new Set(tags.map((t) => t.key)).size !== tags.length) throw validation("A database can have one value per tag key.", field);
  if (tags.length > limits.maxTagsPerDatabase) throw validation(`A database can have up to ${limits.maxTagsPerDatabase} tags.`, field);
  return tags;
}

/** Terms to remove: "key:value" or a bare "key". */
export function parseRemoveTerms(value: unknown): { key: string; value: string | null }[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((t) => typeof t !== "string")) {
    throw validation("Choose at least one tag to remove.", "tags");
  }
  return (value as string[]).map((raw) => {
    const t = raw.trim().toLowerCase();
    if (t.includes(":")) {
      const { key, value: v } = splitTag(t);
      return { key, value: v };
    }
    if (!TAG_PART.test(t)) throw validation("Write a tag as key or key:value.", "tags");
    return { key: t, value: null };
  });
}

export function parseTagKey(value: unknown, field: string): string {
  if (typeof value !== "string" || !TAG_PART.test(value.trim().toLowerCase())) throw validation("Enter a tag key, for example customer.", field);
  return value.trim().toLowerCase();
}

/** A list of database ids from a request body: at least one, at most `max`, all UUIDs, duplicates dropped. */
export function parseIds(value: unknown, max: number, field = "ids"): string[] {
  if (!Array.isArray(value) || value.length === 0) throw validation("Choose at least one database.", field);
  if (value.length > max) throw validation(`Choose up to ${max} databases at a time.`, field);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (!isUuid(v)) throw validation("One of the database ids is not valid.", field);
    const id = v.toLowerCase();
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export function parseBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw validation("This must be true or false.", field);
  return value;
}

export function parseEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw validation(`Choose one of: ${allowed.join(", ")}.`, field);
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw validation(`Choose one of: ${allowed.join(", ")}.`, field);
  }
  return value as T;
}

export function parseIntParam(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw validation(`Use a whole number from ${min} to ${max}.`, field);
  return n;
}

export function parsePaging(q: Obj, limits: Limits, defaultPageSize = limits.defaultPageSize, maxPageSize = limits.maxPageSize): { page: number; pageSize: number } {
  return {
    page: parseIntParam(q.page, "page", 1, 1, 1_000_000),
    pageSize: parseIntParam(q.pageSize, "pageSize", defaultPageSize, 1, maxPageSize),
  };
}

export function parseMonth(value: unknown, field = "month"): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw validation("Use a month written as YYYY-MM.", field);
  return value;
}

/** A moment in time: ISO 8601 with a zone, so it means the same thing everywhere. */
export function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw validation("Choose a date and time, written like 2026-10-20T10:00:00Z.", field);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw validation("Choose a date and time, written like 2026-10-20T10:00:00Z.", field);
  return d;
}

export interface DatabaseFilter {
  search?: string;
  state?: "awake" | "asleep";
  keepAwake?: boolean;
  /** "key:value", "key" or "!key" */
  tags: string[];
}

/** The filter as it arrives in a query string: tag may be repeated. */
export function parseFilter(q: Obj): DatabaseFilter {
  const f: DatabaseFilter = { tags: [] };
  if (q.search !== undefined && q.search !== "") {
    if (typeof q.search !== "string" || q.search.length > 100) throw validation("Search for up to 100 characters.", "search");
    f.search = q.search;
  }
  if (q.state !== undefined && q.state !== "") f.state = parseEnum(q.state, ["awake", "asleep"] as const, "state");
  if (q.keepAwake !== undefined && q.keepAwake !== "") {
    if (q.keepAwake !== "true" && q.keepAwake !== "false" && typeof q.keepAwake !== "boolean") throw validation("keepAwake must be true or false.", "keepAwake");
    f.keepAwake = q.keepAwake === true || q.keepAwake === "true";
  }
  const raw = q.tag ?? q.tags;
  const terms = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  for (const t of terms) {
    if (typeof t !== "string") throw validation("Tags must be written key:value, key or !key.", "tag");
    const s = t.trim().toLowerCase();
    if (s.startsWith("!")) {
      if (!TAG_PART.test(s.slice(1))) throw validation("Tags must be written key:value, key or !key.", "tag");
    } else if (s.includes(":")) splitTag(s);
    else if (!TAG_PART.test(s)) throw validation("Tags must be written key:value, key or !key.", "tag");
    f.tags.push(s);
  }
  if (f.tags.length > 50) throw validation("Use up to 50 tag filters.", "tag");
  return f;
}

export function parseEmail(value: unknown): string {
  if (typeof value !== "string") throw validation("Enter a valid email address.", "email");
  const e = value.trim();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw validation("Enter a valid email address.", "email");
  return e.toLowerCase();
}
