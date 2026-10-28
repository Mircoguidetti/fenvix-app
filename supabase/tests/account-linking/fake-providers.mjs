// Stand-ins for the outside world that Supabase Auth (GoTrue) talks to during sign-in, so the
// real GoTrue can be driven end to end on a laptop with made-up people. FOR LOCAL TESTS ONLY.
//
//   * GitHub      (GoTrue's own GitHub provider, pointed here with GOTRUE_EXTERNAL_GITHUB_URL):
//                 /gh/login/oauth/authorize, /gh/login/oauth/access_token,
//                 /gh/api/v3/user and /gh/api/v3/user/emails (the same calls GoTrue makes to GitHub).
//   * "Google"    GoTrue's Google provider cannot be pointed anywhere but accounts.google.com, so
//                 an OpenID Connect stand-in is used through GoTrue's Keycloak provider, which reads
//                 the same claims Google sends (sub, email, email_verified, name). Linking in
//                 GoTrue does not depend on the provider's name: every OAuth provider is in the
//                 same linking domain, so this exercises the same code path as Google.
//                 /kc/protocol/openid-connect/{auth,token,userinfo}
//   * SMTP        a sink on port 2525 that keeps every message, readable at GET /mail.
//
// Who signs in next is set with POST /next {"provider":"github"|"keycloak", "profile":{…}}.
// A profile for GitHub: {id, login, name, emails:[{email, verified, primary}]}.
// A profile for the OIDC stand-in: {sub, email, email_verified, name}.
import { createServer } from "node:http";
import { createServer as createTcp } from "node:net";
import { randomBytes } from "node:crypto";

const HTTP_PORT = Number(process.env.FAKE_HTTP_PORT ?? 9999);
const SMTP_PORT = Number(process.env.FAKE_SMTP_PORT ?? 2525);

const next = { github: null, keycloak: null };
const codes = new Map(); // code -> {provider, profile}
const tokens = new Map(); // access token -> {provider, profile}
const mail = [];

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const bearer = (req) => (req.headers.authorization ?? "").replace(/^(Bearer|token)\s+/i, "");

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === "/next" && req.method === "POST") {
    const { provider, profile } = JSON.parse(await readBody(req));
    next[provider] = profile;
    return json(res, 200, { ok: true });
  }
  if (p === "/mail") return json(res, 200, mail);
  if (p === "/mail" && req.method === "DELETE") { mail.length = 0; return json(res, 200, {}); }
  if (p === "/mail/clear") { mail.length = 0; return json(res, 200, {}); }

  // The provider's consent page: answers at once for whoever was set with /next.
  if (p === "/gh/login/oauth/authorize" || p === "/kc/protocol/openid-connect/auth") {
    const provider = p.startsWith("/gh") ? "github" : "keycloak";
    if (!next[provider]) return json(res, 400, { error: "no profile set" });
    const code = randomBytes(12).toString("hex");
    codes.set(code, { provider, profile: next[provider] });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (p === "/gh/login/oauth/access_token" || p === "/kc/protocol/openid-connect/token") {
    const form = new URLSearchParams(await readBody(req));
    const hit = codes.get(form.get("code"));
    if (!hit) return json(res, 400, { error: "bad_verification_code" });
    codes.delete(form.get("code"));
    const t = randomBytes(12).toString("hex");
    tokens.set(t, hit);
    return json(res, 200, { access_token: t, token_type: "bearer", expires_in: 3600, scope: "user:email" });
  }
  const who = tokens.get(bearer(req));
  if (p === "/gh/api/v3/user") {
    if (!who) return json(res, 401, {});
    const u = who.profile;
    const primary = u.emails.find((e) => e.primary);
    // GitHub's public profile email is null when the person keeps it private.
    return json(res, 200, { id: u.id, login: u.login, name: u.name, email: u.publicEmail ?? null, avatar_url: "" });
  }
  if (p === "/gh/api/v3/user/emails") {
    if (!who) return json(res, 401, {});
    return json(res, 200, who.profile.emails.map((e) => ({ email: e.email, verified: e.verified, primary: e.primary, visibility: null })));
  }
  if (p === "/kc/protocol/openid-connect/userinfo") {
    if (!who) return json(res, 401, {});
    return json(res, 200, who.profile);
  }
  json(res, 404, { error: "not found", path: p });
}).listen(HTTP_PORT, "127.0.0.1");

// A minimal SMTP server: enough of the protocol for GoTrue's mailer, no TLS, no auth.
createTcp((sock) => {
  let inData = false;
  let buf = "";
  let cur = { from: "", to: [], data: "" };
  sock.write("220 fake-smtp ready\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          mail.push({ ...cur, at: Date.now() });
          cur = { from: "", to: [], data: "" };
          sock.write("250 OK\r\n");
        } else cur.data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") sock.write("250-fake-smtp\r\n250 8BITMIME\r\n");
      else if (cmd === "HELO") sock.write("250 fake-smtp\r\n");
      else if (cmd === "MAIL") { cur.from = line; sock.write("250 OK\r\n"); }
      else if (cmd === "RCPT") { cur.to.push(line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "")); sock.write("250 OK\r\n"); }
      else if (cmd === "DATA") { inData = true; sock.write("354 go ahead\r\n"); }
      else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
      else if (cmd === "RSET" || cmd === "NOOP") sock.write("250 OK\r\n");
      else sock.write("502 not implemented\r\n");
    }
  });
  sock.on("error", () => {});
}).listen(SMTP_PORT, "127.0.0.1");

console.log(`fake providers on http://127.0.0.1:${HTTP_PORT}, smtp on ${SMTP_PORT}`);
