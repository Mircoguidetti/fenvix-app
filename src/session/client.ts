export type AuthProvider = "github" | "google";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

/**
 * Everything the dashboard needs from sign-in. To use real providers, write an implementation
 * of `SessionClient` and export it from `./index.ts` instead of the mock one. Providers that
 * redirect (GitHub, Google) can navigate away inside `signInWithProvider` and resolve on return.
 */
export interface SessionClient {
  /** The signed-in user, or null. */
  getSession(): Promise<SessionUser | null>;
  signInWithProvider(provider: AuthProvider): Promise<SessionUser>;
  /** Sends a one-time sign-in link to the address. */
  requestEmailLink(email: string): Promise<void>;
  /** Signs in with the token from the emailed link. The mock accepts any token for the last requested address. */
  completeEmailLink(token: string): Promise<SessionUser>;
  signOut(): Promise<void>;
}
