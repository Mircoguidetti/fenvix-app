import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { configError, supabaseAnonKey, supabaseUrl } from "./env";

let client: SupabaseClient | null = null;

/**
 * The one Supabase client for the browser. It holds the anon key, which is a public value:
 * every table is protected by row level security, so a signed-out key can read nothing.
 *
 * `detectSessionInUrl` is off because this app uses a hash router: the redirect back from a
 * provider is finished by hand in `src/session/redirect.ts` before React renders.
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

/** True when the browser has everything it needs to talk to Supabase. */
export const supabaseConfigured = () => configError === null;
