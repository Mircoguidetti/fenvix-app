export type AuthProvider = "github" | "google";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** Picture from the provider, when there is one. */
  avatarUrl?: string | null;
}

/** One way to sign in to the account: a GitHub or Google account, or the emailed link ("email"). */
export interface LinkedIdentity {
  id: string;
  provider: AuthProvider | "email" | (string & {});
  /** The address the provider gave, if any. */
  email: string | null;
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
  /** The signed-in user's ways to sign in. */
  listIdentities(): Promise<LinkedIdentity[]>;
  /**
   * Adds GitHub or Google to the signed-in account: the browser goes to the provider and comes
   * back to Settings, where `lastLinkResult()` (in ./redirect) says how it went.
   */
  linkProvider(provider: AuthProvider): Promise<void>;
  /** Removes a way to sign in. Refused when it is the last one. */
  unlinkIdentity(id: string): Promise<void>;
  /** Calls back whenever the session changes, in this tab or another. Returns an unsubscribe. */
  subscribe?(onChange: (user: SessionUser | null) => void): () => void;
}
