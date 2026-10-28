import { apiUrl } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { type DocumentItem, type DocumentPage, type DocumentQuery, type Ejson, type ExplorerClient, ExplorerError } from "./explorer";

/**
 * The Data Explorer over HTTP, to the control plane at VITE_API_URL. The person's Supabase session token is sent as
 * `Authorization: Bearer` (the control plane verifies it with the project's keys); no cookie is sent or set here.
 * Nothing is cached: the control plane answers with Cache-Control: no-store and requests use `cache: "no-store"`.
 */
const TIMEOUT_MS = 30_000;

async function token(): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new ExplorerError("unauthenticated", "Sign in again to see this database's data.", 401);
  return t;
}

async function call<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  if (!apiUrl) throw new ExplorerError("not_configured", "The data explorer is not set up for this dashboard yet (VITE_API_URL).", 0);
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof ExplorerError) throw e;
    throw new ExplorerError("network", "Could not reach FENVIX. Check your connection and try again.", 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: handled below */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; field?: string } } | null)?.error;
    const retry = Number(res.headers.get("retry-after"));
    throw new ExplorerError(err?.code ?? "internal", err?.message ?? "Something went wrong. Try again.", res.status, err?.field, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return json as T;
}

const base = (db: string) => `/databases/${encodeURIComponent(db)}/data/collections`;
const docs = (db: string, c: string) => `${base(db)}/${encodeURIComponent(c)}/documents`;
const doc = (db: string, c: string, id: string) => `${docs(db, c)}/${encodeURIComponent(id)}`;

export const httpExplorer: ExplorerClient = {
  listCollections: (db) => call("GET", base(db)),
  findDocuments(db, c, q: DocumentQuery) {
    const p = new URLSearchParams();
    if (q.filter?.trim()) p.set("filter", q.filter.trim());
    if (q.sort?.trim()) p.set("sort", q.sort.trim());
    if (q.projection?.trim()) p.set("projection", q.projection.trim());
    if (q.page) p.set("page", String(q.page));
    if (q.pageSize) p.set("pageSize", String(q.pageSize));
    const qs = p.toString();
    return call<DocumentPage>("GET", `${docs(db, c)}${qs ? `?${qs}` : ""}`);
  },
  getDocument: (db, c, id) => call<DocumentItem>("GET", doc(db, c, id)),
  insertDocument: (db, c, document: { [key: string]: Ejson }) => call("POST", docs(db, c), { document }),
  replaceDocument: (db, c, id, document, version) => call("PUT", doc(db, c, id), { document, version }),
  async deleteDocument(db, c, id, version) {
    await call("DELETE", `${doc(db, c, id)}?version=${encodeURIComponent(version)}`);
  },
};
