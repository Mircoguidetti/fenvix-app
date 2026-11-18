import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { configError, supabaseAnonKey, supabaseUrl } from "./env";

let client: SupabaseClient | null = null;

/**
 * The one Supabase client for the browser, for sign-in only (Supabase Auth): the dashboard reads and changes data
 * through the fenvix API, never through Supabase. It holds the anon key, which is a public value.
 *
 * `detectSessionInUrl` is off: the redirect back from a provider is finished by hand in
 * `src/session/redirect.ts` before React renders, so the code never reaches the router.
 */
export function getSupabase(): SupabaseClient {
  if (configError) throw new Error(configError);
  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { flowType: "pkce", detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
      global: { headers: { "x-application-name": "fenvix-dashboard" } },
    });
  }
  return client;
}

/** True when the browser has everything it needs to sign in and reach the API. */
export const supabaseConfigured = () => configError === null;
