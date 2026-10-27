import { backend, configError } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { friendlyError } from "../data/queries";

let redirectError: string | null = null;

/** Set when the browser came back from a provider but the exchange failed. */
export const lastRedirectError = () => redirectError;

/**
 * Finishes a sign-in redirect before the router renders.
 *
 * Supabase sends the browser back to the site root with `?code=…` in the query string. This
 * runs before React renders: the code is read from `location.search`, exchanged for a session,
 * and the address is then replaced with `/overview` (no query, no history entry), so the router
 * mounts on a clean URL with the session already stored. Nothing downstream ever sees the code.
 */
export async function completeAuthRedirect(): Promise<void> {
  if (backend !== "supabase" || typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const failure = params.get("error_description") ?? params.get("error");
  if (!code && !failure) return;

  if (failure) redirectError = decodeURIComponent(failure);
  else if (configError) redirectError = configError;
  else {
    try {
      const { error } = await getSupabase().auth.exchangeCodeForSession(code!);
      if (error) redirectError = friendlyError({ message: error.message, status: error.status });
    } catch (e) {
      redirectError = friendlyError({ message: e instanceof Error ? e.message : "" }) || "That sign-in link did not work.";
    }
  }

  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/overview";
  window.history.replaceState(null, "", url.toString());
}
