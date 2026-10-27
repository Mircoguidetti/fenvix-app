import type { Session, User } from "@supabase/supabase-js";
import { configError, redirectTarget } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { lastRedirectError } from "./redirect";
import type { AuthProvider, SessionClient, SessionUser } from "./client";

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

  async requestEmailLink(email: string) {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("Enter a valid email address.");
    const { error } = await getSupabase().auth.signInWithOtp({
      email: clean,
      options: { emailRedirectTo: redirectTarget(), shouldCreateUser: true },
    });
    if (error) throw new Error(error.message);
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

  /** Keeps the app in step with sign-in, sign-out and token refreshes in any tab. */
  subscribe(onChange: (user: SessionUser | null) => void) {
    if (configError) return () => {};
    const { data } = getSupabase().auth.onAuthStateChange((_event: string, session: Session | null) => onChange(toUser(session?.user)));
    return () => data.subscription.unsubscribe();
  },
};
