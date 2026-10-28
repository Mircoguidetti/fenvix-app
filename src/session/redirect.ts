import { backend, configError } from "../lib/env";
import { getSupabase } from "../lib/supabaseClient";
import { friendlyError } from "../data/queries";

/**
 * What a person reads when a provider sign-in or link is refused. Always the same words, whatever
 * Supabase said: an unverified address, an address that belongs to another account and a cancelled
 * consent must read alike, or the answer would tell anyone which addresses have accounts.
 */
export const SIGN_IN_REFUSED =
  "That sign-in did not work. If the email address of your GitHub or Google account is not verified there, verify it and try again, or sign in with an email link. Already use FENVIX another way? Sign in that way, then link this account in Settings.";
export const LINK_REFUSED =
  "That account was not linked. An account can be linked when its email address is verified with the provider (or is this account's address) and it does not already sign in to another FENVIX account.";
export const LAST_METHOD = "Link another way to sign in before removing this one.";

const PROVIDER_LABEL: Record<string, string> = { github: "GitHub", google: "Google", email: "Email link" };
export const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;

const LINK_PENDING = "fenvix-link-pending";
const LINK_PENDING_MS = 10 * 60_000;

let redirectError: string | null = null;
let linkResult: { provider: string; ok: boolean; message: string } | null = null;

/** Set when the browser came back from a provider but the sign-in failed. */
export const lastRedirectError = () => redirectError;

/** How the last "Link GitHub / Google" round trip went. Returned once, then cleared. */
export function takeLinkResult(): { provider: string; ok: boolean; message: string } | null {
  const r = linkResult;
  linkResult = null;
  return r;
}

/** Remembers, for this tab, that the browser is leaving to link a provider (not to sign in). */
export function markLinkPending(provider: string | null): void {
  try {
    if (provider) sessionStorage.setItem(LINK_PENDING, JSON.stringify({ provider, at: Date.now() }));
    else sessionStorage.removeItem(LINK_PENDING);
  } catch {
    /* storage unavailable: the return is then read as a sign-in */
  }
}

function takeLinkPending(): string | null {
  try {
    const raw = sessionStorage.getItem(LINK_PENDING);
    sessionStorage.removeItem(LINK_PENDING);
    const v = raw ? (JSON.parse(raw) as { provider?: string; at?: number }) : null;
    return v?.provider && Date.now() - (v.at ?? 0) < LINK_PENDING_MS ? v.provider : null;
  } catch {
    return null;
  }
}

/**
 * Finishes a sign-in or link redirect before the router renders.
 *
 * Supabase sends the browser back to the site root with `?code=…` in the query string. This
 * runs before React renders: the code is read from `location.search`, exchanged for a session,
 * and the address is then replaced with `/overview` (or `/settings` after linking a provider; no
 * query, no history entry), so the router mounts on a clean URL with the session already stored.
 * Nothing downstream ever sees the code, and Supabase's own error text is never shown.
 */
export async function completeAuthRedirect(): Promise<void> {
  if (backend !== "supabase" || typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of new URLSearchParams(window.location.hash.replace(/^#/, ""))) if (!params.has(k)) params.set(k, v);
  const code = params.get("code");
  const failed = params.has("error") || params.has("error_code") || params.has("error_description");
  if (!code && !failed) return;

  const linking = takeLinkPending();
  const refuse = () => {
    if (linking) linkResult = { provider: linking, ok: false, message: LINK_REFUSED };
    else redirectError = SIGN_IN_REFUSED;
  };

  if (failed) refuse();
  else if (configError) redirectError = configError;
  else {
    try {
      const { error } = await getSupabase().auth.exchangeCodeForSession(code!);
      if (error) {
        if (linking) refuse();
        else redirectError = friendlyError({ message: error.message, status: error.status });
      } else if (linking) {
        linkResult = { provider: linking, ok: true, message: `${providerLabel(linking)} is linked. You can sign in with it from now on.` };
      }
    } catch (e) {
      if (linking) refuse();
      else redirectError = friendlyError({ message: e instanceof Error ? e.message : "" }) || "That sign-in link did not work.";
    }
  }

  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (linking) url.pathname = "/settings";
  else if (url.pathname === "/" || url.pathname === "") url.pathname = "/overview";
  window.history.replaceState(null, "", url.toString());
}
