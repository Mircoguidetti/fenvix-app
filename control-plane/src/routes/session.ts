import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Deps, SESSION_COOKIE, clearSessionCookies, hitAnon, sessionFromRequest, setSessionCookies } from "../http.ts";
import { ApiError, conflict, forbidden, internal, notFound, unauthenticated, validation } from "../errors.ts";
import { GatewayError, type Provider } from "../auth/gateway.ts";
import { asObject, parseEmail } from "../validate.ts";

const PROVIDERS: readonly string[] = ["github", "google"];
const OAUTH_COOKIE = "fnx_oauth";
const EXPIRED_LINK = "This sign-in link has expired. Request a new one.";
const LAST_METHOD = "Link another way to sign in before removing this one.";

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

  const oauthCookiePath = () => `${new URL(s.cfg.apiPublicUrl || "http://localhost").pathname.replace(/\/$/, "")}/session/providers`;

  /** Starts a provider round trip: a PKCE verifier in a short-lived cookie, the challenge to the provider. */
  const startOAuth = (reply: FastifyReply, returnTo: string, mode: "sign_in" | "link") => {
    const verifier = b64(randomBytes(48));
    const challenge = b64(createHash("sha256").update(verifier).digest());
    reply.setCookie(OAUTH_COOKIE, b64(Buffer.from(JSON.stringify({ v: verifier, r: returnTo, m: mode }))), { ...cookieBase, path: oauthCookiePath(), maxAge: 600 });
    reply.header("Cache-Control", "no-store");
    return challenge;
  };

  /** The signed-in caller, for the endpoints that change their own sign-in methods. */
  const signedIn = async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await sessionFromRequest(d, req, reply);
    if (!session) throw unauthenticated();
    if (session.viaCookie && req.method !== "GET") {
      // Cookies are sent by the browser on its own, so a change must come from the dashboard.
      const origin = req.headers.origin;
      if (origin !== undefined && !s.cfg.dashboardOrigins.includes(origin)) throw forbidden("This request did not come from the dashboard.");
    }
    reply.header("Cache-Control", "no-store");
    return session;
  };

  app.post("/session/providers/:provider", async (req, reply) => {
    hitAnon(d, req);
    const { provider } = req.params as { provider: string };
    if (!PROVIDERS.includes(provider)) throw validation("Choose github or google.", "provider");
    const returnTo = checkReturnTo(asObject(req.body).returnTo);
    const challenge = startOAuth(reply, returnTo, "sign_in");
    return {
      redirectUrl: d.gateway.authorizeUrl({ provider: provider as Provider, redirectTo: `${s.cfg.apiPublicUrl}/session/providers/${provider}/callback`, codeChallenge: challenge }),
    };
  });

  // ------------------------------------------------------------ ways to sign in (Settings)
  //
  // Linking is always explicit and always proves the other account: the person signs in to the
  // provider while signed in here. Which account an address belongs to is never said: every
  // refusal is the same message (supabase/migrations/0006_account_linking.sql has the rules).

  app.get("/session/identities", async (req, reply) => {
    hitAnon(d, req);
    const session = await signedIn(req, reply);
    const items = await d.gateway.identities(session.accessToken);
    return { items: items.map((i) => ({ id: i.id, provider: i.provider, email: i.email })) };
  });

  app.post("/session/identities/:provider", async (req, reply) => {
    hitAnon(d, req);
    const { provider } = req.params as { provider: string };
    if (!PROVIDERS.includes(provider)) throw validation("Choose github or google.", "provider");
    const session = await signedIn(req, reply);
    const returnTo = checkReturnTo(asObject(req.body).returnTo);
    const challenge = startOAuth(reply, returnTo, "link");
    try {
      return {
        redirectUrl: await d.gateway.linkUrl({
          accessToken: session.accessToken, provider: provider as Provider, codeChallenge: challenge,
          redirectTo: `${s.cfg.apiPublicUrl}/session/providers/${provider}/callback`,
        }),
      };
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.message : String(e), code: (e as GatewayError).code }, "starting a link failed");
      if (e instanceof GatewayError && e.code === "manual_linking_disabled") throw forbidden("Linking another way to sign in is not turned on for this service.");
      throw internal();
    }
  });

  app.delete("/session/identities/:id", async (req, reply) => {
    hitAnon(d, req);
    const { id } = req.params as { id: string };
    const session = await signedIn(req, reply);
    const items = await d.gateway.identities(session.accessToken);
    if (!items.some((i) => i.id === id)) throw notFound("That way to sign in is not linked to your account.");
    if (items.length < 2) throw conflict(LAST_METHOD);
    try {
      await d.gateway.unlinkIdentity({ accessToken: session.accessToken, identityId: id });
    } catch (e) {
      req.log.warn({ err: e instanceof Error ? e.message : String(e), code: (e as GatewayError).code }, "unlinking failed");
      if (e instanceof GatewayError && e.code === "single_identity_not_deletable") throw conflict(LAST_METHOD);
      if (e instanceof GatewayError && e.code === "email_conflict_identity_not_deletable") throw conflict("This way to sign in cannot be removed. Contact support.");
      throw internal();
    }
    return reply.code(204).send();
  });

  app.get("/session/providers/:provider/callback", async (req, reply) => {
    hitAnon(d, req);
    const { provider } = req.params as { provider: string };
    const q = req.query as { code?: string; error?: string };
    reply.clearCookie(OAUTH_COOKIE, { path: oauthCookiePath(), domain: s.cfg.cookieDomain });
    reply.header("Cache-Control", "no-store");

    let saved: { v: string; r: string; link: boolean } | null = null;
    try {
      const parsed = JSON.parse(Buffer.from(req.cookies[OAUTH_COOKIE] ?? "", "base64url").toString("utf8")) as { v?: unknown; r?: unknown; m?: unknown };
      if (typeof parsed.v === "string" && typeof parsed.r === "string") saved = { v: parsed.v, r: checkReturnTo(parsed.r), link: parsed.m === "link" };
    } catch { /* no usable cookie */ }

    const fallback = s.cfg.dashboardOrigins[0];
    // One outcome per kind of failure, whatever the reason: an unverified address, an address that
    // belongs to another account and a cancelled consent all read the same, so nothing is revealed.
    const back = (target: string | undefined, failed: boolean) => {
      if (!target) throw validation("Sign-in could not be completed. Start again from the dashboard.");
      const u = new URL(target);
      if (failed) u.searchParams.set("error", saved?.link ? "link_failed" : "sign_in_failed");
      else if (saved?.link) u.searchParams.set("linked", provider);
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
