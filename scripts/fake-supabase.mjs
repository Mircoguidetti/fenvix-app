// A small stand-in for Supabase, for testing the dashboard's Supabase code with no real project.
//
//   - Auth: /auth/v1/authorize, /token (PKCE), /otp, /user, /logout. It plays the part of
//     Google, GitHub and the email provider, and checks the PKCE challenge like GoTrue does.
//   - Data: /rest/v1/rpc/<function> runs the REAL SQL functions from supabase/migrations on a
//     scratch Postgres, as the signed-in user, so row level security applies.
//
// It is NOT Supabase: it does not test Google, GitHub, email delivery, PostgREST, the JWT
// signature check or the real anon key. Needs TEST_DATABASE_URL (see supabase/tests/run-local.sh).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";

const PORT = Number(process.env.FAKE_SUPABASE_PORT ?? 54399);
const DB = process.env.TEST_DATABASE_URL;
if (!DB) throw new Error("Set TEST_DATABASE_URL to the scratch database.");

const OWNER = { email: "mircoguidetti1994@gmail.com", name: "Mirco Guidetti", avatar: "https://avatars.githubusercontent.com/u/1?v=4" };

const sql = (text) => spawnSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-tA", "-c", text], { encoding: "utf8" });

function ensureUser(email, name) {
  const found = sql(`select id from auth.users where lower(email) = lower('${email.replace(/'/g, "''")}')`).stdout.trim();
  if (found) return found;
  return sql(`insert into auth.users (email, raw_user_meta_data) values ('${email.replace(/'/g, "''")}', '${JSON.stringify({ full_name: name }).replace(/'/g, "''")}') returning id`).stdout.trim().split("\n")[0];
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const challenges = new Map(); // code -> { challenge, email, name, avatar }
const emailLinks = [];
const sessions = new Map(); // refresh token -> user

function sessionFor(user) {
  const now = Math.floor(Date.now() / 1000);
  const refresh = randomBytes(12).toString("hex");
  sessions.set(refresh, user);
  return {
    access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, role: "authenticated", aud: "authenticated", email: user.email, exp: now + 3600 })}.unsigned`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: refresh,
    user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: { provider: "google" }, user_metadata: { full_name: user.name, avatar_url: user.avatar }, created_at: new Date().toISOString() },
  };
}

const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "boolean" || typeof v === "number" ? String(v) : Array.isArray(v) ? `'{${v.map((x) => `"${String(x).replace(/(["\\])/g, "\\$1")}"`).join(",")}}'` : `'${String(v).replace(/'/g, "''")}'`);

function rpc(fn, body, token) {
  if (!/^fenvix_[a-z_]+$/.test(fn)) return { status: 404, json: { message: "Not found" } };
  let sub = null;
  try { sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub; } catch { /* anonymous */ }
  const args = Object.entries(body ?? {}).map(([k, v]) => `${k} => ${lit(v)}`).join(", ");
  const claims = JSON.stringify({ sub, role: sub ? "authenticated" : "anon" }).replace(/'/g, "''");
  const run = spawnSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-tA", "-c",
    `begin; set local role ${sub ? "authenticated" : "anon"}; set local request.jwt.claims = '${claims}'; select coalesce(to_json(public.${fn}(${args}))::text, 'null'); commit;`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(run.stderr);
    return { status: m?.[1] === "42501" ? 403 : 400, json: { code: m?.[1] ?? "XX000", message: m?.[2]?.trim() ?? run.stderr.trim(), details: null, hint: null } };
  }
  const lines = run.stdout.split("\n").filter((l) => l && !/^(BEGIN|SET|COMMIT)$/.test(l));
  return { status: 200, text: lines[lines.length - 1] ?? "null" };
}

const corsFor = (req) => ({ "access-control-allow-origin": "*", "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-expose-headers": "content-range" });

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (status, body, headers = {}) => { res.writeHead(status, { ...corsFor(req), "content-type": "application/json", ...headers }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  if (req.method === "OPTIONS") return send(204, "");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : {};
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");

    if (url.pathname === "/auth/v1/authorize") {
      // The provider screen is skipped: the user is "signed in" and sent straight back with a code.
      const code = randomBytes(10).toString("hex");
      challenges.set(code, { challenge: url.searchParams.get("code_challenge"), ...OWNER });
      const back = new URL(url.searchParams.get("redirect_to"));
      back.searchParams.set("code", code);
      res.writeHead(302, { ...corsFor(req), location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/auth/v1/otp") {
      const email = String(body.email ?? "").toLowerCase();
      const code = randomBytes(10).toString("hex");
      challenges.set(code, { challenge: body.code_challenge, email, name: email.split("@")[0], avatar: null });
      const back = new URL(body.email_redirect_to ?? url.searchParams.get("redirect_to") ?? "http://localhost/");
      back.searchParams.set("code", code);
      emailLinks.push({ email, link: back.toString() });
      return send(200, {});
    }
    if (url.pathname === "/__last_email_link") return send(200, emailLinks[emailLinks.length - 1] ?? {});
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const entry = challenges.get(body.auth_code);
      if (!entry) return send(400, { code: 400, error_code: "validation_failed", msg: "invalid flow state, no valid flow state found" });
      const expected = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
      if (entry.challenge !== expected) return send(400, { code: 400, error_code: "bad_code_verifier", msg: "code challenge does not match previously saved code verifier" });
      challenges.delete(body.auth_code); // a code works once
      const user = { id: ensureUser(entry.email, entry.name), email: entry.email, name: entry.name, avatar: entry.avatar };
      return send(200, sessionFor(user));
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const user = sessions.get(body.refresh_token);
      return user ? send(200, sessionFor(user)) : send(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    }
    if (url.pathname === "/auth/v1/user") {
      try {
        const p = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString());
        return send(200, { id: p.sub, email: p.email, aud: "authenticated", role: "authenticated" });
      } catch { return send(401, { msg: "invalid JWT" }); }
    }
    if (url.pathname === "/auth/v1/logout") return send(204, "");
    const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (m && req.method === "POST") {
      const out = rpc(m[1], body, bearer);
      return out.json ? send(out.status, out.json) : send(out.status, out.text);
    }
    return send(404, { message: "Not found" });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fake supabase on http://127.0.0.1:${PORT}`));
