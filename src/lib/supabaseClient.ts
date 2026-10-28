import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { configError, supabaseAnonKey, supabaseUrl } from "./env";
import { orgHeaders } from "./org";

/** Every request names the organization chosen in the browser; current_workspace() uses it only for a member of it. */
const withOrg: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/rest/v1/")) return fetch(input, init);
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(orgHeaders())) headers.set(k, v);
  return fetch(input, { ...init, headers });
};

let client: SupabaseClient | null = null;

/**
 * The one Supabase client for the browser. It holds the anon key, which is a public value:
 * every table is protected by row level security, so a signed-out key can read nothing.
 *
 * `detectSessionInUrl` is off: the redirect back from a provider is finished by hand in
 * `src/session/redirect.ts` before React renders, so the code never reaches the router.
 */
export function getSupabase(): SupabaseClient {
  if (configError) throw new Error(configError);
  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { flowType: "pkce", detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
      global: { headers: { "x-application-name": "fenvix-dashboard" }, fetch: withOrg },
    });
  }
  return client;
}

/** True when the browser has everything it needs to talk to Supabase. */
export const supabaseConfigured = () => configError === null;
