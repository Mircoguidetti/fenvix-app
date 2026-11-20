/**
 * Configuration that comes from the environment. Only public values exist in the browser: the fenvix API's address,
 * and the Supabase URL and anon key (used for sign-in only). Nothing secret is ever read here.
 */
import { normalizeApiUrl } from "../data/api-errors.ts";

/** "api": the fenvix API (every real build). "mock": the sample data, for local development and the checks. */
export type Backend = "api" | "mock";

// `?? {}`: outside Vite (the unit tests in Node) there is no import.meta.env.
const raw: Partial<ImportMetaEnv> = import.meta.env ?? {};

/** "mock" only when VITE_DATA_BACKEND=mock; otherwise the dashboard talks to the API. */
export const backend: Backend = raw.VITE_DATA_BACKEND === "mock" ? "mock" : "api";

/**
 * The fenvix API, including /v1 (for example https://api.fenvix.dev/v1). A bare host gets /v1 added. Every screen
 * reads and changes data through it; Supabase only signs people in. Not a secret.
 */
export const apiUrl: string = normalizeApiUrl(raw.VITE_API_URL ?? "");

export const supabaseUrl: string = (raw.VITE_SUPABASE_URL ?? "").trim();
export const supabaseAnonKey: string = (raw.VITE_SUPABASE_ANON_KEY ?? "").trim();

/** A hosted project (https://<ref>.supabase.co) or a local one (http://127.0.0.1:54321). */
export function isSupabaseUrl(url: string): boolean {
  const u = url.replace(/\/$/, "");
  return /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u);
}

/** What is missing from the build, in the words the sign-in page shows; null when nothing is. Pure, for the unit tests. */
export function configProblem(env: { backend: Backend; apiUrl: string; supabaseUrl: string; supabaseAnonKey: string }): string | null {
  if (env.backend === "mock") return null;
  const missing = [!env.apiUrl && "VITE_API_URL", !env.supabaseUrl && "VITE_SUPABASE_URL", !env.supabaseAnonKey && "VITE_SUPABASE_ANON_KEY"].filter(Boolean) as string[];
  if (missing.length) {
    const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
    return `This deployment is missing ${list}. Set ${missing.length === 1 ? "it" : "them"} where the dashboard is built and deploy again.`;
  }
  if (!/^https?:\/\/[^\s/]+/i.test(env.apiUrl)) return `VITE_API_URL does not look like an address: ${env.apiUrl}`;
  if (!isSupabaseUrl(env.supabaseUrl)) return `VITE_SUPABASE_URL does not look like a Supabase project URL: ${env.supabaseUrl}`;
  return null;
}

/** A message to show on the sign-in page instead of a broken screen when the environment is incomplete. */
export const configError: string | null = configProblem({ backend, apiUrl, supabaseUrl, supabaseAnonKey });

/** Where a provider sends the browser back to: the root of the site. */
export function redirectTarget(): string {
  return `${window.location.origin}/`;
}
