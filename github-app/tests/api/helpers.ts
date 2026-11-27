/*
 * The dashboard API against the local Supabase (scripts/local-supabase/up.sh): the real Postgres image with the
 * migrations, and the real Supabase Auth server issuing ES256 tokens. Every test makes its own people and
 * organizations (unique e-mails and GitHub ids), so it never resets a database other tests use.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import pg from "pg";
import { loadApiConfig } from "../../src/api/config.ts";
import type { OnboardWork } from "../../src/api/context.ts";
import { type Api, buildApi } from "../../src/api/server.ts";
import { dashboardOperations, type Operation } from "../../src/api/spec.ts";

const addFormats = addFormatsModule as unknown as (a: Ajv) => Ajv;

/** LOCAL_SUPABASE_URL, LOCAL_DB_URL, LOCAL_API_DATABASE_URL: from the environment or the file up.sh writes. */
export function localSupabase(): { supabaseUrl: string; dbUrl: string; apiDbUrl: string } | null {
  const env: Record<string, string | undefined> = { ...process.env };
  const file = `${process.env.LOCAL_SUPABASE_STATE ?? `${process.env.TMPDIR ?? "/tmp"}/fenvix-local-supabase`}/env.sh`;
  if (!env.LOCAL_SUPABASE_URL && existsSync(file)) {
    for (const m of readFileSync(file, "utf8").matchAll(/^export (\w+)=(.*)$/gm)) env[m[1]!] = m[2]!.trim();
  }
  if (!env.LOCAL_SUPABASE_URL || !env.LOCAL_DB_URL || !env.LOCAL_API_DATABASE_URL) return null;
  for (const u of [env.LOCAL_DB_URL, env.LOCAL_API_DATABASE_URL]) {
    if (/supabase\.(co|com)|pooler/.test(u)) throw new Error("the API tests need the LOCAL Supabase (scripts/local-supabase/up.sh), not a hosted project");
  }
  return { supabaseUrl: env.LOCAL_SUPABASE_URL, dbUrl: env.LOCAL_DB_URL, apiDbUrl: env.LOCAL_API_DATABASE_URL };
}

export const LOCAL = localSupabase();
/** Why the integration tests are skipped, or false. */
export const SKIP = LOCAL ? false : "no local Supabase: run bash scripts/local-supabase/up.sh (Docker) first";

export const DASHBOARD = "http://localhost:5173";
export const STATE_KEY = "state-signing-key-for-api-tests-0123456789";
/** The API's clock in the tests (the seeded data is placed around it). */
export const NOW = new Date("2026-11-18T12:00:00Z");
export const DAY = 86_400_000;
export const at = (daysAgo: number, hours = 0) => new Date(NOW.getTime() - daysAgo * DAY + hours * 3600_000);

/** Unique per test run: e-mails, GitHub ids. */
export const RUN = randomBytes(4).toString("hex");
let idBase = 1_000_000_000 + Math.floor(Math.random() * 900_000_000);
export const githubId = () => ++idBase;
export const sha = () => randomBytes(20).toString("hex");
export const key32 = () => randomBytes(16).toString("hex");

export interface Person { email: string; userId: string; token: string; workspaceId: string }

/** A person signed up with Supabase Auth (a real ES256 token); the sign-up trigger gives them an organization. */
export async function signUp(admin: pg.Client, label: string, name = label): Promise<Person> {
  const email = `api-${RUN}-${label}@api.fenvix.test`;
  const res = await fetch(`${LOCAL!.supabaseUrl}/auth/v1/signup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: `pw-${randomUUID()}`, data: { full_name: name } }),
  });
  const body = (await res.json()) as { access_token?: string; user?: { id: string } };
  if (!res.ok || !body.access_token || !body.user) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(body)}`);
  const ws = (await admin.query<{ workspace_id: string }>("select workspace_id from public.workspace_members where user_id = $1", [body.user.id])).rows[0];
  if (!ws) throw new Error("the sign-up trigger made no organization");
  return { email, userId: body.user.id, token: body.access_token, workspaceId: ws.workspace_id };
}

/** Adds an existing person to an organization with a role (as the database owner: the seed, not the API). */
export async function addTo(admin: pg.Client, p: Person, workspaceId: string, role: "owner" | "admin" | "member"): Promise<void> {
  await admin.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, p.userId, role]);
}

export class RecordingQueue {
  readonly sent: OnboardWork[] = [];
  fail = false;
  async enqueue(w: OnboardWork): Promise<void> {
    if (this.fail) throw new Error("queue down");
    this.sent.push(w);
  }
}

export async function startApi(queue = new RecordingQueue(), env: Record<string, string> = {}): Promise<{ api: Api; queue: RecordingQueue }> {
  const cfg = loadApiConfig({
    NODE_ENV: "test", API_DATABASE_URL: LOCAL!.apiDbUrl, SUPABASE_URL: LOCAL!.supabaseUrl, STATE_SIGNING_KEY: STATE_KEY,
    DASHBOARD_URL: DASHBOARD, GITHUB_APP_SLUG: "fenvix-test", DB_POOL_MAX: "4", LOG_LEVEL: "silent", ...env,
  });
  return { api: buildApi({ cfg, queue, logger: false, now: () => NOW }), queue };
}

// ---------------------------------------------------------------- calling operations, checking every answer

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();
const OPS = new Map(dashboardOperations().map((o) => [o.operationId, o]));

/** Every 2xx answer of the tests, by operation: the coverage check reads it. */
export const covered = new Set<string>();

/** The body's problems against the operation's response schema for that status (empty: it matches). */
export function responseProblems(op: Operation, status: number, body: unknown): string[] {
  const schema = op.responses[String(status)];
  if (schema === undefined) return [`status ${status} is not in the contract for ${op.operationId}`];
  if (schema === null) return [];
  const k = `${op.operationId}:${status}`;
  let v = validators.get(k);
  if (!v) { v = ajv.compile(schema); validators.set(k, v); }
  return v(body) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`);
}

export interface Call { status: number; body: any; headers: Record<string, string | string[] | number | undefined>; text: string }

/**
 * Calls one operation of the contract. A 2xx answer is checked against the operation's response schema (ajv) and the
 * test fails on any mismatch; any other answer must be the contract's error shape.
 */
export async function call(api: Api, operationId: string, o: {
  token?: string | null; ws?: string | null; params?: Record<string, string | number>; query?: Record<string, string | number>;
  body?: unknown; headers?: Record<string, string>;
} = {}): Promise<Call> {
  const op = OPS.get(operationId);
  if (!op) throw new Error(`no dashboard operation ${operationId}`);
  const url = op.route.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(String(o.params?.[k] ?? `missing-${k}`)));
  const qs = o.query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(o.query).map(([k, v]) => [k, String(v)])))}` : "";
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.ws) headers["x-fenvix-workspace"] = o.ws;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await api.fastify.inject({ method: op.method, url: url + qs, headers, ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}) });
  const text = res.body;
  const isJson = String(res.headers["content-type"] ?? "").startsWith("application/json");
  const body = isJson && text ? JSON.parse(text) : text;
  if (res.statusCode >= 200 && res.statusCode < 300) {
    const problems = responseProblems(op, res.statusCode, body);
    if (problems.length) throw new Error(`${operationId} ${res.statusCode}: the answer does not match the contract:\n  ${problems.join("\n  ")}\n${text.slice(0, 2000)}`);
    covered.add(operationId);
  } else if (res.statusCode !== 304) {
    // Every error is the contract's Error: { error: { code, message, field? } }.
    const problems = responseProblems({ ...op, responses: { [res.statusCode]: op.responses.default ?? null } }, res.statusCode, body);
    if (problems.length) throw new Error(`${operationId} ${res.statusCode}: not the contract's error shape: ${text}`);
  }
  return { status: res.statusCode, body, headers: res.headers, text };
}

export const admin = async (): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: LOCAL!.dbUrl });
  await c.connect();
  return c;
};
