/**
 * Configuration that comes from the environment. Only public values exist in the browser: the Supabase URL and its
 * anon key, and the control plane's address. Nothing secret is ever read here.
 */
import { normalizeApiUrl } from "../data/http";

export type Backend = "supabase" | "mock";

const raw = import.meta.env;

/** "supabase" unless VITE_DATA_BACKEND says otherwise. The checks run against "mock". */
export const backend: Backend = raw.VITE_DATA_BACKEND === "mock" ? "mock" : "supabase";

/**
 * The control-plane API, including /v1 (for example https://api.fenvix.dev/v1). A bare host (https://api.fenvix.dev)
 * gets /v1 added. When it is set, every data screen talks to the control plane (src/data/index.ts); without it the
 * dashboard reads and writes through the Supabase functions and the Data, Users and Network tabs say they are not set
 * up. Not a secret.
 */
export const apiUrl: string = normalizeApiUrl(raw.VITE_API_URL ?? "");

export const supabaseUrl: string = (raw.VITE_SUPABASE_URL ?? "").trim();
export const supabaseAnonKey: string = (raw.VITE_SUPABASE_ANON_KEY ?? "").trim();

/** A hosted project (https://<ref>.supabase.co) or a local one (http://127.0.0.1:54321). */
export function isSupabaseUrl(url: string): boolean {
  const u = url.replace(/\/$/, "");
  return /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u);
}

/** A message to show instead of a broken screen when the environment is incomplete. */
export const configError: string | null =
  backend === "mock"
    ? null
    : !supabaseUrl && !supabaseAnonKey
      ? "This deployment has no Supabase settings. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY and deploy again."
      : !supabaseUrl
        ? "VITE_SUPABASE_URL is missing from this deployment."
        : !supabaseAnonKey
          ? "VITE_SUPABASE_ANON_KEY is missing from this deployment."
          : !isSupabaseUrl(supabaseUrl)
            ? `VITE_SUPABASE_URL does not look like a Supabase project URL: ${supabaseUrl}`
            : null;

/** Where a provider sends the browser back to: the root of the site. */
export function redirectTarget(): string {
  return `${window.location.origin}/`;
}
