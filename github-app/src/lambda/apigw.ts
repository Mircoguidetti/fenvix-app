import type { FastifyInstance } from "fastify";

/** The parts of an API Gateway HTTP API event (payload format 2.0) the adapter reads. */
export interface HttpApiEvent {
  version?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string }; requestId?: string };
}

export interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
  cookies?: string[];
}

const TEXT = /^(application\/(json|problem\+json|xml|x-www-form-urlencoded)|text\/)/i;
/** Hop-by-hop or recomputed headers: Fastify's inject sets its own. */
const DROP = new Set(["content-length", "transfer-encoding", "connection"]);

/**
 * Runs one API Gateway request through the Fastify app (no socket: `inject`). The body keeps its exact bytes (the
 * webhook signature is computed over them): base64 bodies are decoded, text bodies are taken as UTF-8, which is how
 * API Gateway passed them.
 */
export async function invoke(fastify: FastifyInstance, event: HttpApiEvent): Promise<HttpApiResult> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined && !DROP.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  if (event.cookies?.length) headers.cookie = event.cookies.join("; ");
  const payload = event.body === undefined || event.body === null ? undefined : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
  const res = await fastify.inject({
    method: event.requestContext.http.method as "GET",
    url: event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : ""),
    headers,
    ...(payload ? { payload } : {}),
    remoteAddress: event.requestContext.http.sourceIp ?? "127.0.0.1",
  });
  const out: Record<string, string> = {};
  let cookies: string[] | undefined;
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || DROP.has(k)) continue;
    if (k === "set-cookie") { cookies = (Array.isArray(v) ? v : [String(v)]).map(String); continue; }
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  const text = TEXT.test(out["content-type"] ?? "text/plain");
  return {
    statusCode: res.statusCode,
    headers: out,
    body: text ? res.rawPayload.toString("utf8") : res.rawPayload.toString("base64"),
    isBase64Encoded: !text,
    ...(cookies ? { cookies } : {}),
  };
}
