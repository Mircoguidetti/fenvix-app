import { backend, configError } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { friendlyError } from "../data/queries";

let redirectError: string | null = null;

/** Set when the browser came back from a provider but the exchange failed. */
export const lastRedirectError = () => redirectError;

/**
 * Finishes a sign-in redirect before the router renders.
 *
 * Supabase sends the browser back to the site root with `?code=…` in the query string, while
 * this app keeps its routes after the `#`. The two never collide: `location.search` is read
 * here, the code is exchanged for a session, the query is then wiped with `replaceState` and
 * the URL is left at `#/`, so HashRouter mounts on a clean address with a session already in
 * place. Nothing downstream ever sees the code.
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
  url.hash = url.hash && url.hash !== "#" ? url.hash : "#/";
  window.history.replaceState(null, "", url.toString());
}
