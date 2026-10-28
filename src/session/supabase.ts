import type { Session, User } from "@supabase/supabase-js";
import { configError, redirectTarget } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { LAST_METHOD, lastRedirectError, markLinkPending } from "./redirect";
import type { AuthProvider, LinkedIdentity, SessionClient, SessionUser } from "./client";

function nameOf(user: User): string {
  const meta = user.user_metadata ?? {};
  const name = (meta.full_name ?? meta.name ?? meta.user_name ?? "").toString().trim();
  if (name) return name;
  const local = (user.email ?? "").split("@")[0];
  return local ? local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Account";
}

function toUser(user: User | null | undefined): SessionUser | null {
  if (!user) return null;
  const meta = user.user_metadata ?? {};
  const avatar = (meta.avatar_url ?? meta.picture ?? "").toString();
  return { id: user.id, name: nameOf(user), email: user.email ?? "", avatarUrl: avatar || null };
}

/** Sign-in on Supabase Auth: GitHub, Google and a one-time email link. */
export const supabaseSession: SessionClient = {
  get configError() {
    return lastRedirectError() ?? configError;
  },

  async getSession() {
    if (configError) return null; // the sign-in screen shows the problem instead
    const { data, error } = await getSupabase().auth.getSession();
    if (error) throw new Error(error.message);
    return toUser(data.session?.user);
  },

  /** Hands the browser to the provider. The promise never resolves: the page navigates away. */
  async signInWithProvider(provider: AuthProvider) {
    const { data, error } = await getSupabase().auth.signInWithOAuth({
      provider,
      options: { redirectTo: redirectTarget(), skipBrowserRedirect: true },
    });
    if (error) throw new Error(error.message);
    if (!data.url) throw new Error("The provider did not return a sign-in address.");
    window.location.assign(data.url);
    return new Promise<SessionUser>(() => {});
  },

  /**
   * The page says "check your inbox" whatever Supabase answers, as the control plane does: a
   * different answer for some addresses (a per-address wait, a refused address) would tell anyone
   * which addresses have accounts. Only a connection that never reached Supabase is reported.
   */
  async requestEmailLink(email: string) {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("Enter a valid email address.");
    const { error } = await getSupabase().auth.signInWithOtp({
      email: clean,
      options: { emailRedirectTo: redirectTarget(), shouldCreateUser: true },
    });
    if (error && !error.status) throw new Error("Could not reach the sign-in service. Check your connection and try again.");
  },

  /**
   * The emailed link normally comes back as `?code=…` and is handled before the app renders.
   * This covers the case where a code reaches the router instead.
   */
  async completeEmailLink(token: string) {
    const { data, error } = await getSupabase().auth.exchangeCodeForSession(token);
    if (error) throw new Error(error.message);
    const user = toUser(data.session?.user);
    if (!user) throw new Error("This sign-in link has expired. Request a new one.");
    return user;
  },

  async signOut() {
    const { error } = await getSupabase().auth.signOut();
    if (error) throw new Error(error.message);
  },

  async listIdentities(): Promise<LinkedIdentity[]> {
    const { data, error } = await getSupabase().auth.getUserIdentities();
    if (error) throw new Error(error.message);
    return (data?.identities ?? []).map((i) => ({
      id: i.identity_id,
      provider: i.provider,
      email: typeof i.identity_data?.email === "string" ? i.identity_data.email : null,
    }));
  },

  /** Hands the browser to the provider; it comes back to Settings. The promise never resolves. */
  async linkProvider(provider: AuthProvider) {
    markLinkPending(provider);
    const { data, error } = await getSupabase().auth.linkIdentity({
      provider,
      options: { redirectTo: redirectTarget(), skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      markLinkPending(null);
      throw new Error(error?.code === "manual_linking_disabled" ? "Linking another way to sign in is not turned on for this service." : "Could not start linking. Try again.");
    }
    window.location.assign(data.url);
    return new Promise<void>(() => {});
  },

  async unlinkIdentity(id: string) {
    const auth = getSupabase().auth;
    const { data, error } = await auth.getUserIdentities();
    if (error) throw new Error(error.message);
    const all = data?.identities ?? [];
    const target = all.find((i) => i.identity_id === id);
    if (!target) throw new Error("That way to sign in is not linked to your account.");
    if (all.length < 2) throw new Error(LAST_METHOD);
    const { error: e } = await auth.unlinkIdentity(target);
    if (e) throw new Error(e.code === "single_identity_not_deletable" ? LAST_METHOD : "Could not remove it. Try again.");
    await auth.refreshSession();
  },

  /** Keeps the app in step with sign-in, sign-out and token refreshes in any tab. */
  subscribe(onChange: (user: SessionUser | null) => void) {
    if (configError) return () => {};
    const { data } = getSupabase().auth.onAuthStateChange((_event: string, session: Session | null) => onChange(toUser(session?.user)));
    return () => data.subscription.unsubscribe();
  },
};
