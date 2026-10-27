import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { type Deps, SESSION_COOKIE, clearSessionCookies, hitAnon, sessionFromRequest, setSessionCookies } from "../http.ts";
import { ApiError, unauthenticated, validation } from "../errors.ts";
import { type Provider } from "../auth/gateway.ts";
import { asObject, parseEmail } from "../validate.ts";

const PROVIDERS: readonly string[] = ["github", "google"];
const OAUTH_COOKIE = "fnx_oauth";
const EXPIRED_LINK = "This sign-in link has expired. Request a new one.";

const b64 = (b: Buffer) => b.toString("base64url");

export function sessionRoutes(app: FastifyInstance, d: Deps): void {
  const { s } = d;
  const cookieBase = { httpOnly: true, secure: s.cfg.cookieSecure, sameSite: "lax" as const, domain: s.cfg.cookieDomain };

  /** A returnTo must be on one of the dashboard's own origins, or sign-in could send people anywhere. */
  const checkReturnTo = (value: unknown): string => {
    if (typeof value !== "string") throw validation("returnTo must be a dashboard address.", "returnTo");
    let u: URL;
    try { u = new URL(value); } catch { throw validation("returnTo must be a dashboard address.", "returnTo"); }
    if (!s.cfg.dashboardOrigins.includes(u.origin)) throw validation("returnTo must be a dashboard address.", "returnTo");
    return u.toString();
  };

  const user = (c: { userId: string; name: string; email: string; avatarUrl: string | null }) => ({ id: c.userId, name: c.name, email: c.email, avatarUrl: c.avatarUrl });

  app.get("/session", async (req, reply) => {
    hitAnon(d, req);
    const session = await sessionFromRequest(d, req, reply);
    if (!session) throw unauthenticated();
    reply.header("Cache-Control", "no-store");
    return user(session.claims);
  });

  app.post("/session/providers/:provider", async (req, reply) => {
    hitAnon(d, req);
    const { provider } = req.params as { provider: string };
    if (!PROVIDERS.includes(provider)) throw validation("Choose github or google.", "provider");
    const returnTo = checkReturnTo(asObject(req.body).returnTo);

    const verifier = b64(randomBytes(48));
    const challenge = b64(createHash("sha256").update(verifier).digest());
    reply.setCookie(OAUTH_COOKIE, b64(Buffer.from(JSON.stringify({ v: verifier, r: returnTo }))), {
      ...cookieBase, path: `${new URL(s.cfg.apiPublicUrl || "http://localhost").pathname.replace(/\/$/, "")}/session/providers`, maxAge: 600,
    });
    reply.header("Cache-Control", "no-store");
    return {
      redirectUrl: d.gateway.authorizeUrl({ provider: provider as Provider, redirectTo: `${s.cfg.apiPublicUrl}/session/providers/${provider}/callback`, codeChallenge: challenge }),
    };
  });

  app.get("/session/providers/:provider/callback", async (req, reply) => {
    hitAnon(d, req);
    const { provider } = req.params as { provider: string };
    const q = req.query as { code?: string; error?: string };
    reply.clearCookie(OAUTH_COOKIE, { path: `${new URL(s.cfg.apiPublicUrl || "http://localhost").pathname.replace(/\/$/, "")}/session/providers`, domain: s.cfg.cookieDomain });
    reply.header("Cache-Control", "no-store");

    let saved: { v: string; r: string } | null = null;
    try {
      const parsed = JSON.parse(Buffer.from(req.cookies[OAUTH_COOKIE] ?? "", "base64url").toString("utf8")) as { v?: unknown; r?: unknown };
      if (typeof parsed.v === "string" && typeof parsed.r === "string") saved = { v: parsed.v, r: checkReturnTo(parsed.r) };
    } catch { /* no usable cookie */ }

    const fallback = s.cfg.dashboardOrigins[0];
    const back = (target: string | undefined, failed: boolean) => {
      if (!target) throw validation("Sign-in could not be completed. Start again from the dashboard.");
      const u = new URL(target);
      if (failed) u.searchParams.set("error", "sign_in_failed");
      return reply.redirect(u.toString(), 302);
    };

    if (!PROVIDERS.includes(provider) || !saved) return back(saved?.r ?? fallback, true);
    if (q.error || typeof q.code !== "string" || q.code === "") return back(saved.r, true);
    try {
      const tokens = await d.gateway.exchangeCode({ code: q.code, codeVerifier: saved.v });
      const check = await d.verifier.verify(tokens.accessToken);
      if (!check.ok) throw new Error("the new session token did not verify");
      setSessionCookies(d, reply, tokens);
      return back(saved.r, false);
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.message : String(e) }, "sign-in callback failed");
      return back(saved.r, true);
    }
  });

  app.post("/session/email-link", async (req, reply) => {
    hitAnon(d, req);
    const email = parseEmail(asObject(req.body).email);
    // Counted per address, whether or not it has an account, so the answer never reveals which do.
    d.limiter.hit(`email:${createHash("sha256").update(email).digest("hex")}`, s.cfg.limits.emailLinksPerAddressPerHour, 3_600_000);
    const redirectTo = s.cfg.dashboardOrigins[0];
    if (!redirectTo) throw validation("Sign-in by email is not set up.");
    try {
      await d.gateway.sendEmailLink({ email, redirectTo: `${redirectTo}/` });
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.message : String(e), status: (e as { status?: number }).status }, "sending the email link failed");
    }
    reply.header("Cache-Control", "no-store");
    return reply.code(202).send({});
  });

  app.post("/session/email-link/complete", async (req, reply) => {
    hitAnon(d, req);
    const token = asObject(req.body).token;
    if (typeof token !== "string" || token.length < 1 || token.length > 2048) throw validation(EXPIRED_LINK, "token");
    try {
      const tokens = await d.gateway.verifyEmailToken(token);
      const check = await d.verifier.verify(tokens.accessToken);
      if (!check.ok) throw new Error("the new session token did not verify");
      setSessionCookies(d, reply, tokens);
      reply.header("Cache-Control", "no-store");
      return user(check.claims);
    } catch (e) {
      req.log.info({ err: e instanceof Error ? e.message : String(e) }, "email link was not accepted");
      throw new ApiError("validation_failed", EXPIRED_LINK, "token");
    }
  });

  app.delete("/session", async (req, reply) => {
    hitAnon(d, req);
    const access = req.cookies[SESSION_COOKIE];
    clearSessionCookies(d, reply);
    if (access) await d.gateway.signOut(access).catch((e) => req.log.info({ err: e instanceof Error ? e.message : String(e) }, "sign-out at Supabase failed"));
    return reply.code(204).send();
  });
}
