import { apiUrl } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { orgHeaders } from "../lib/org";
import { type DocumentItem, type DocumentPage, type DocumentQuery, type Ejson, type ExplorerClient, ExplorerError } from "./explorer";
import { type HttpConfig, type Method, httpRequest } from "./http.ts";

/**
 * The Data Explorer over HTTP, to the control plane at VITE_API_URL. The person's Supabase session token is sent as
 * `Authorization: Bearer` (the control plane verifies it with the project's keys); no cookie is sent or set here.
 * Nothing is cached: the control plane answers with Cache-Control: no-store and requests use `cache: "no-store"`.
 * The request itself (timeout, errors) is in http.ts, shared with every other control-plane client.
 */
async function token(): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new ExplorerError("unauthenticated", "Your session has ended. Sign in again.", 401);
  return t;
}

/** The browser's connection to the control plane: VITE_API_URL, the session token, the chosen organization. */
export const httpConfig: HttpConfig = { baseUrl: apiUrl, token, headers: orgHeaders };

/** One request to the control plane, for the organization chosen in the browser. Also used for database users and organizations. */
export async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return (await httpRequest<T>(httpConfig, method, path, { body })).data;
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
