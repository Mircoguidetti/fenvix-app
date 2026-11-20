import { backend, configError } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { friendlyError } from "../data/ci-rows";

let redirectError: string | null = null;
let redirectErrorCode: string | null = null;

/** Set when the browser came back from a provider but the exchange failed. */
export const lastRedirectError = () => redirectError;
/** Supabase's error_code of that failure (e.g. identity_already_exists after connecting a provider), when it sent one. */
export const lastRedirectErrorCode = () => redirectErrorCode;
/** Forgets the failure once a screen has shown it. */
export function clearRedirectError() {
  redirectError = null;
  redirectErrorCode = null;
}

/**
 * Finishes a sign-in redirect before the router renders.
 *
 * Supabase sends the browser back to the site root with `?code=…` in the query string. This
 * runs before React renders: the code is read from `location.search`, exchanged for a session,
 * and the address is then replaced with `/overview` (no query, no history entry), so the router
 * mounts on a clean URL with the session already stored. Nothing downstream ever sees the code.
 */
export async function completeAuthRedirect(): Promise<void> {
  if (backend !== "api" || typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const failure = params.get("error_description") ?? params.get("error");
  if (!code && !failure) return;

  if (failure) {
    redirectError = decodeURIComponent(failure);
    redirectErrorCode = params.get("error_code");
  }
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
  if (url.pathname === "") url.pathname = "/"; // "/" opens the last project (App.tsx, Home)
  window.history.replaceState(null, "", url.toString());
}
