/**
 * Configuration that comes from the environment. Only two public values exist in the browser:
 * the Supabase URL and its anon key. Nothing secret is ever read here.
 */
export type Backend = "supabase" | "mock";

const raw = import.meta.env;

/** "supabase" unless VITE_DATA_BACKEND says otherwise. The checks run against "mock". */
export const backend: Backend = raw.VITE_DATA_BACKEND === "mock" ? "mock" : "supabase";

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
