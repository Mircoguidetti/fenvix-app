/**
 * GitHub's own schemas, as published by GitHub through Octokit:
 *  - REST API: @octokit/openapi, generated/api.github.com.deref.json (GitHub's OpenAPI description, dereferenced);
 *  - webhooks: @octokit/webhooks-schemas (JSON Schema of every webhook payload) and @octokit/webhooks-examples
 *    (payloads recorded from GitHub).
 * Every request the App sends and every response the fake GitHub answers is checked against the REST description;
 * every webhook fixture against the webhook schema.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

const require = createRequire(import.meta.url);
const addFormats = addFormatsModule as unknown as (a: Ajv) => Ajv;

type Json = Record<string, unknown>;
interface Operation { method: string; template: string; re: RegExp; literal: number; op: Json }

let spec: Json | null = null;
let ops: Operation[] = [];
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
const compiled = new Map<unknown, ValidateFunction>();

function load(): void {
  if (spec) return;
  spec = JSON.parse(readFileSync(require.resolve("@octokit/openapi/generated/api.github.com.deref.json"), "utf8")) as Json;
  ops = [];
  for (const [template, item] of Object.entries(spec.paths as Record<string, Json>)) {
    const parts = template.split(/(\{[^}]+\})/).filter(Boolean);
    const params = parts.filter((p) => p.startsWith("{"));
    const last = params[params.length - 1];
    const re = new RegExp("^" + parts.map((p) => (p.startsWith("{") ? (p === last && template.endsWith(p) ? "(.+)" : "([^/]+)") : p.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))).join("") + "$");
    const literal = parts.filter((p) => !p.startsWith("{")).join("").length;
    for (const m of ["get", "post", "put", "patch", "delete"]) if (item[m]) ops.push({ method: m.toUpperCase(), template, re, literal, op: item[m] as Json });
  }
  ops.sort((a, b) => b.literal - a.literal);
}

function validator(schema: unknown): ValidateFunction {
  let v = compiled.get(schema);
  if (!v) { v = ajv.compile(schema as object); compiled.set(schema, v); }
  return v;
}

export function findOperation(method: string, path: string): { template: string; operationId: string; op: Json } | null {
  load();
  const o = ops.find((x) => x.method === method && x.re.test(path));
  return o ? { template: o.template, operationId: String(o.op.operationId), op: o.op } : null;
}

export interface Problem { where: string; errors: string }

const fmt = (v: ValidateFunction) => (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}${e.params && "allowedValues" in e.params ? ` ${JSON.stringify(e.params.allowedValues)}` : ""}`).join("; ");

/** Checks one request/response pair against GitHub's REST description. Returns the problems (none = valid). */
export function checkExchange(x: { method: string; path: string; query: Record<string, string>; body: unknown; status: number; response: unknown }): { operationId: string | null; problems: Problem[] } {
  const found = findOperation(x.method, x.path);
  if (!found) return { operationId: null, problems: [{ where: `${x.method} ${x.path}`, errors: "no such operation in GitHub's REST API" }] };
  const problems: Problem[] = [];
  const op = found.op as { parameters?: { in: string; name: string; schema: unknown; required?: boolean }[]; requestBody?: { content?: Record<string, { schema: unknown }>; required?: boolean }; responses: Record<string, { content?: Record<string, { schema: unknown }> }> };
  for (const [k, v] of Object.entries(x.query)) {
    const p = (op.parameters ?? []).find((pp) => pp.in === "query" && pp.name === k);
    if (!p) { problems.push({ where: `query ${k}`, errors: "not a parameter of this operation" }); continue; }
    const s = p.schema as { type?: string };
    const val = s.type === "integer" || s.type === "number" ? Number(v) : s.type === "boolean" ? v === "true" : v;
    const fn = validator(p.schema);
    if (!fn(val)) problems.push({ where: `query ${k}`, errors: fmt(fn) });
  }
  const reqSchema = op.requestBody?.content?.["application/json"]?.schema;
  if (x.body !== undefined && x.body !== null) {
    if (!reqSchema) problems.push({ where: "request body", errors: "this operation takes no JSON body" });
    else { const fn = validator(reqSchema); if (!fn(x.body)) problems.push({ where: "request body", errors: fmt(fn) }); }
  } else if (op.requestBody?.required) {
    problems.push({ where: "request body", errors: "required" });
  }
  const res = op.responses[String(x.status)];
  if (!res) problems.push({ where: `response ${x.status}`, errors: "not a documented status" });
  else {
    const rs = res.content?.["application/json"]?.schema;
    if (rs && x.response !== null && x.response !== undefined) { const fn = validator(rs); if (!fn(x.response)) problems.push({ where: `response ${x.status}`, errors: fmt(fn) }); }
  }
  return { operationId: found.operationId, problems };
}

/** GitHub's example response of an operation (from the OpenAPI description), as a starting point for a fake answer. */
export function exampleResponse(method: string, template: string, status: number): Json {
  load();
  const o = ops.find((x) => x.method === method && x.template === template);
  if (!o) throw new Error(`no operation ${method} ${template}`);
  const content = (o.op.responses as Record<string, { content?: Record<string, { examples?: Record<string, { value: unknown }>; example?: unknown }> }>)[String(status)]?.content?.["application/json"];
  const ex = content?.examples ? Object.values(content.examples)[0]?.value : content?.example;
  if (ex === undefined) throw new Error(`no example for ${method} ${template} ${status}`);
  return structuredClone(ex) as Json;
}

// ---------------------------------------------------------------- webhooks

let hooks: Json | null = null;
const HOOKS_ID = "https://fenvix.test/webhooks-schema.json";

function hookSchema(): void {
  if (hooks) return;
  hooks = JSON.parse(readFileSync(require.resolve("@octokit/webhooks-schemas/schema.json"), "utf8")) as Json;
  ajv.addSchema({ ...hooks, $id: HOOKS_ID });
}

/** Checks a webhook payload against GitHub's schema of `event` with `action` (push has none). */
export function checkWebhook(event: string, payload: Json): string[] {
  hookSchema();
  const key = event === "push" ? "push$event" : `${event}$${String(payload.action)}`;
  const fn = ajv.getSchema(`${HOOKS_ID}#/definitions/${key}`);
  if (!fn) return [`no schema for ${key}`];
  return fn(payload) ? [] : (fn.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

/** A payload GitHub recorded for `event`/`action` (@octokit/webhooks-examples), deep-copied. */
export function recordedWebhook(event: string, action: string | null, pick = 0): Json {
  const all = require("@octokit/webhooks-examples") as { name: string; examples: Json[] }[];
  const list = all.find((e) => e.name === event)?.examples.filter((x) => action === null || x.action === action) ?? [];
  const ex = list[pick];
  if (!ex) throw new Error(`no recorded ${event}.${action}`);
  return structuredClone(ex);
}
