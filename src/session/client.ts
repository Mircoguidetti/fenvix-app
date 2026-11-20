import type { SignInMethod } from "./methods";

export type AuthProvider = "github" | "google";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** Picture from the provider, when there is one. */
  avatarUrl?: string | null;
}

/**
 * Everything the dashboard needs from sign-in. To use real providers, write an implementation
 * of `SessionClient` and export it from `./index.ts` instead of the mock one. Providers that
 * redirect (GitHub, Google) can navigate away inside `signInWithProvider` and resolve on return.
 */
export interface SessionClient {
  /** Set when the app cannot sign anyone in, for example because its settings are missing. */
  readonly configError?: string | null;
  /** The signed-in user, or null. */
  getSession(): Promise<SessionUser | null>;
  signInWithProvider(provider: AuthProvider): Promise<SessionUser>;
  /** Sends a one-time sign-in link to the address. */
  requestEmailLink(email: string): Promise<void>;
  /** Signs in with the token from the emailed link. The mock accepts any token for the last requested address. */
  completeEmailLink(token: string): Promise<SessionUser>;
  signOut(): Promise<void>;
  /** The signed-in account's sign-in methods (GitHub, Google, email link). */
  listSignInMethods(): Promise<SignInMethod[]>;
  /**
   * Attaches another provider to the signed-in account (so signing in with it opens this account, not a new one).
   * Providers that redirect navigate away and come back to Settings.
   */
  connectProvider(provider: AuthProvider): Promise<void>;
  /** Removes one sign-in method; the account keeps at least one. */
  disconnect(methodId: string): Promise<void>;
  /** Calls back whenever the session changes, in this tab or another. Returns an unsubscribe. */
  subscribe?(onChange: (user: SessionUser | null) => void): () => void;
}
