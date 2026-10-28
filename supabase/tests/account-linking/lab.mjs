// Drives the real Supabase Auth server (GoTrue) through sign-in, the emailed link, and
// identity linking, against the stand-ins in fake-providers.mjs. FOR LOCAL TESTS ONLY.
import { execFileSync } from "node:child_process";

export const AUTH = process.env.LAB_AUTH_URL ?? "http://127.0.0.1:9998";
export const FAKE = process.env.LAB_FAKE_URL ?? "http://127.0.0.1:9999";
export const DB = process.env.LAB_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/authlab";
const SITE = "http://localhost:3000/";

if (/supabase\.(co|com|in)|pooler/.test(DB + AUTH)) throw new Error("This lab only runs against a local scratch database and a local GoTrue.");

/** Runs SQL on the scratch database and returns the rows as objects. */
export function sql(query) {
  const out = execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-tAq", "-c", `select coalesce(json_agg(t), '[]') from (${query}) t`], { encoding: "utf8" });
  return JSON.parse(out.trim() || "[]");
}
export function exec(statement) {
  return execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-tAq", "-c", statement], { encoding: "utf8" });
}

const fragment = (location) => {
  const u = new URL(location);
  const params = new URLSearchParams(u.hash.replace(/^#/, ""));
  for (const [k, v] of u.searchParams) params.set(k, v);
  return Object.fromEntries(params);
};

export async function follow(url, headers = {}) {
  // Follows redirects by hand until the browser would land back on the dashboard.
  let next = url;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(next, { redirect: "manual", headers: next.startsWith(AUTH) ? headers : {} });
    const loc = res.headers.get("location");
    if (!loc) return { status: res.status, body: await res.text() };
    if (loc.startsWith(SITE)) return fragment(loc);
    next = new URL(loc, next).toString();
  }
  throw new Error("too many redirects");
}

const decodeJwt = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

/** What came back to the dashboard: a session (who) or an error (what the person would read). */
function outcome(r) {
  if (r.access_token) {
    const c = decodeJwt(r.access_token);
    return { ok: true, userId: c.sub, email: c.email, accessToken: r.access_token };
  }
  return { ok: false, error: r.error, code: r.error_code, description: r.error_description, raw: r };
}

/** Signs in with a provider as the given made-up person. provider: "github" | "keycloak" (the Google stand-in). */
export async function oauth(provider, profile) {
  await fetch(`${FAKE}/next`, { method: "POST", body: JSON.stringify({ provider, profile }) });
  return outcome(await follow(`${AUTH}/authorize?provider=${provider}&redirect_to=${encodeURIComponent(SITE)}`));
}

/** Links another provider to a signed-in user, as "Link GitHub" in Settings does. */
export async function linkIdentity(accessToken, provider, profile) {
  await fetch(`${FAKE}/next`, { method: "POST", body: JSON.stringify({ provider, profile }) });
  const res = await fetch(`${AUTH}/user/identities/authorize?provider=${provider}&redirect_to=${encodeURIComponent(SITE)}&skip_http_redirect=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) return { ok: false, status: res.status, error: body.error_code ?? body.code, description: body.msg ?? body.message };
  return outcome(await follow(body.url));
}

export async function identities(accessToken) {
  const res = await fetch(`${AUTH}/user`, { headers: { authorization: `Bearer ${accessToken}` } });
  return (await res.json()).identities ?? [];
}

export async function unlink(accessToken, identityId) {
  const res = await fetch(`${AUTH}/user/identities/${identityId}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, error: body.error_code, description: body.msg };
}

const decodeQp = (s) => s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** Asks for an emailed sign-in link and returns the link that arrived (or null). */
export async function requestEmailLink(email) {
  await fetch(`${FAKE}/mail/clear`);
  const res = await fetch(`${AUTH}/otp?redirect_to=${encodeURIComponent(SITE)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, create_user: true }),
  });
  const status = res.status;
  const body = await res.text();
  const mail = await (await fetch(`${FAKE}/mail`)).json();
  const msg = mail.find((m) => m.to.includes(email));
  const link = msg ? decodeQp(msg.data).match(/https?:\/\/127\.0\.0\.1:9998\/verify\?[^"'\s<>]+/)?.[0]?.replace(/&amp;/g, "&") : null;
  return { status, body, link };
}

/** Opens the emailed link like a browser would. */
export async function openLink(link) {
  return outcome(await follow(link));
}

/** The latest message sent to an address, decoded. */
export async function lastMailTo(email) {
  const mail = await (await fetch(`${FAKE}/mail`)).json();
  const msg = mail.filter((m) => m.to.includes(email)).at(-1);
  return msg ? decodeQp(msg.data) : null;
}
export const clearMail = () => fetch(`${FAKE}/mail/clear`);

/** People, accounts and workspaces as the database sees them. */
export function snapshot(emailLike) {
  return sql(`
    select u.id, u.email, u.email_confirmed_at is not null as confirmed,
      (select json_agg(json_build_object('provider', i.provider, 'email', i.email, 'verified', (i.identity_data->>'email_verified')) order by i.created_at)
         from auth.identities i where i.user_id = u.id) as identities,
      (select json_agg(m.workspace_id) from public.workspace_members m where m.user_id = u.id) as workspaces
    from auth.users u where u.email ilike '${emailLike.replace(/'/g, "''")}' or exists (
      select 1 from auth.identities i where i.user_id = u.id and i.email ilike '${emailLike.replace(/'/g, "''")}')
    order by u.created_at`);
}

export const gh = (id, login, emails, extra = {}) => ({ id, login, name: login, emails, ...extra });
export const google = (sub, email, verified = true, name = "Test Person") => ({ sub, email, email_verified: verified, name });
