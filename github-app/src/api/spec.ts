/*
 * The contract (openapi/fenvix-api.yaml, compiled into openapi.gen.ts) as a route table: every operation with its
 * method, path, role (x-fenvix-role) and the JSON Schemas the server validates its request against. The API's routes
 * are made from this table, so an operation of the YAML without a handler fails at start-up (and in the tests).
 */
import { OPENAPI_JSON } from "./openapi.gen.ts";

type Json = Record<string, unknown>;
export type Schema = Json;

export interface Operation {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** OpenAPI path, e.g. /organization/members/{userId}. */
  path: string;
  /** Fastify path under /v1, e.g. /v1/organization/members/:userId. */
  route: string;
  tags: string[];
  /** x-fenvix-role: admin (an owner or admin of the organization). */
  admin: boolean;
  /** x-fenvix-key: what an API key may call (read, or replay: a key with the replay scope); null: no key. */
  key: "read" | "replay" | null;
  /** Takes X-Fenvix-Workspace (an operation on one organization). */
  workspace: boolean;
  /** Request schemas, references inlined (null: none). */
  params: Schema | null;
  querystring: Schema | null;
  headers: Schema | null;
  body: Schema | null;
  /** The JSON schema of each response status that has one (references inlined). */
  responses: Record<string, Schema | null>;
}

export const OPENAPI: Json = JSON.parse(OPENAPI_JSON) as Json;

const components = (OPENAPI.components ?? {}) as Record<string, Record<string, Json>>;

/** Follows a local reference (#/components/...). */
function lookup(ref: string): Json {
  if (!ref.startsWith("#/")) throw new Error(`only local references are supported: ${ref}`);
  let cur: unknown = OPENAPI;
  for (const part of ref.slice(2).split("/")) cur = (cur as Json)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (!cur || typeof cur !== "object") throw new Error(`unresolved reference ${ref}`);
  return cur as Json;
}

/**
 * A schema with every $ref replaced by what it names (the contract has no recursive schema; a cycle throws). Keys that
 * JSON Schema validators do not know (description, x-*) are dropped.
 */
export function inline(schema: unknown, seen: string[] = []): Schema {
  const walk = (s: unknown, path: string[]): unknown => {
    if (Array.isArray(s)) return s.map((x) => walk(x, path));
    if (!s || typeof s !== "object") return s;
    const o = s as Json;
    if (typeof o.$ref === "string") {
      if (path.includes(o.$ref)) throw new Error(`recursive schema ${o.$ref}`);
      return walk(lookup(o.$ref), [...path, o.$ref]);
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "description" || k === "example" || k === "examples" || k.startsWith("x-")) continue;
      // properties is a map of schemas: keep its keys (a property may be called "description").
      out[k] = k === "properties" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, walk(pv, path)])) : walk(v, path);
    }
    return out;
  };
  return walk(schema, seen) as Schema;
}

interface Param { name: string; in: "path" | "query" | "header"; required?: boolean; schema?: Json }

function paramsOf(list: unknown): Param[] {
  return ((list ?? []) as Json[]).map((p) => (typeof p.$ref === "string" ? lookup(p.$ref) : p) as unknown as Param);
}

function objectSchema(params: Param[], lower = false): Schema | null {
  if (!params.length) return null;
  const name = (p: Param) => (lower ? p.name.toLowerCase() : p.name);
  const required = params.filter((p) => p.required).map(name);
  return { type: "object", properties: Object.fromEntries(params.map((p) => [name(p), inline(p.schema ?? {})])), ...(required.length ? { required } : {}) };
}

let cache: Operation[] | null = null;

/** Every operation of the contract. */
export function operations(): Operation[] {
  if (cache) return cache;
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(OPENAPI.paths as Record<string, Json>)) {
    const shared = paramsOf(item.parameters);
    for (const method of ["get", "post", "put", "delete"] as const) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      const params = [...shared, ...paramsOf(op.parameters)];
      const body = (((op.requestBody as Json | undefined)?.content as Json | undefined)?.["application/json"] as Json | undefined)?.schema;
      const responses: Record<string, Schema | null> = {};
      for (const [status, r] of Object.entries((op.responses ?? {}) as Record<string, Json>)) {
        const res = typeof r.$ref === "string" ? lookup(r.$ref) : r;
        const content = res.content as Record<string, Json> | undefined;
        const schema = content?.["application/json"]?.schema ?? content?.["text/csv"]?.schema;
        responses[status] = schema ? inline(schema) : null;
      }
      out.push({
        operationId: String(op.operationId),
        method: method.toUpperCase() as Operation["method"],
        path,
        route: `/v1${path.replace(/\{([^}]+)\}/g, ":$1")}`,
        tags: (op.tags ?? []) as string[],
        admin: op["x-fenvix-role"] === "admin",
        key: op["x-fenvix-key"] === "read" || op["x-fenvix-key"] === "replay" ? op["x-fenvix-key"] : null,
        workspace: params.some((p) => p.in === "header" && p.name === "X-Fenvix-Workspace"),
        params: objectSchema(params.filter((p) => p.in === "path")),
        querystring: objectSchema(params.filter((p) => p.in === "query")),
        headers: objectSchema(params.filter((p) => p.in === "header"), true),
        body: body ? inline(body) : null,
        responses,
      });
    }
  }
  cache = out;
  return out;
}

export const dashboardOperations = () => operations().filter((o) => o.tags.includes("dashboard"));

/** A component schema by name, references inlined (the tests validate responses with it). */
export const componentSchema = (name: string): Schema => inline(components.schemas?.[name] ?? (() => { throw new Error(`no schema ${name}`); })());
