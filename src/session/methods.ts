/**
 * Sign-in methods of one account (Supabase Auth identities). Supabase links a new provider to an existing account on
 * its own only when the provider reports a verified email the account already has; otherwise a first sign-in with
 * another provider makes a second, separate account. Connecting a provider from Settings (manual linking) attaches it
 * to the account the person is signed in to, whatever its email. Pure, for the unit tests.
 */
import type { AuthProvider } from "./client";

export type MethodKind = AuthProvider | "email";

export interface SignInMethod {
  /** The identity's id (Supabase `identity_id`), what disconnecting needs. */
  id: string;
  kind: MethodKind;
  /** The address the provider gave, when it gave one. */
  email: string | null;
}

export const METHOD_NAMES: Record<MethodKind, string> = { github: "GitHub", google: "Google", email: "Email link" };

/** Providers that can be connected from Settings (an email link needs no connecting: it signs in by address). */
export const CONNECTABLE: AuthProvider[] = ["github", "google"];

/** Supabase identities → the methods shown in Settings; unknown providers are left out. Sorted GitHub, Google, Email. */
export function toMethods(identities: { identity_id: string; provider: string; identity_data?: Record<string, unknown> }[]): SignInMethod[] {
  const order: MethodKind[] = ["github", "google", "email"];
  return identities
    .filter((i): i is typeof i & { provider: MethodKind } => (order as string[]).includes(i.provider))
    .map((i) => ({ id: i.identity_id, kind: i.provider, email: typeof i.identity_data?.email === "string" ? i.identity_data.email : null }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** What a failed connect means, in the words Settings shows. `code` is Supabase's error_code when there is one. */
export function connectProblem(code: string | null | undefined, message: string | null | undefined): string {
  const c = (code ?? "").toLowerCase();
  const m = (message ?? "").toLowerCase();
  if (c === "identity_already_exists" || /already linked to another user|identity.*already exists/.test(m)) {
    return "That account already signs in to a different FENVIX account. Sign in there and delete it (or ask us to), then connect it here.";
  }
  if (c === "manual_linking_disabled" || /manual linking is disabled/.test(m)) {
    return "Connecting another sign-in method is turned off for this site. Ask the site owner to allow manual linking in Supabase.";
  }
  if (c === "single_identity_not_deletable" || /at least 2 identities|only identity/.test(m)) {
    return "This is your only sign-in method. Connect another one before you disconnect it.";
  }
  return message?.trim() || "Could not change your sign-in methods. Try again.";
}
