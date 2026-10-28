import type { LinkedIdentity, SessionClient, SessionUser } from "./client";
import { LAST_METHOD } from "./redirect";

const KEY = "fenvix-session";
const PENDING = "fenvix-pending-email";
const wait = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 120));

const OWNER: SessionUser = { id: "usr_1", name: "Elena Marsh", email: "elena.marsh@northwind.cloud" };

let memory: SessionUser | null = null;

function read(): SessionUser | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as SessionUser;
  } catch {
    /* storage unavailable: fall back to memory */
  }
  return memory;
}

function write(user: SessionUser | null) {
  memory = user;
  try {
    if (user) localStorage.setItem(KEY, JSON.stringify(user));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function pending(value?: string | null): string | null {
  try {
    if (value === undefined) return sessionStorage.getItem(PENDING);
    if (value === null) sessionStorage.removeItem(PENDING);
    else sessionStorage.setItem(PENDING, value);
  } catch {
    /* ignore */
  }
  return value ?? null;
}

// Ways to sign in, per user: the mock signs in with GitHub as the owner and by email link as anyone else.
const IDENTITIES = "fenvix-identities";
function identities(user: SessionUser | null, value?: LinkedIdentity[]): LinkedIdentity[] {
  if (!user) return [];
  let all: Record<string, LinkedIdentity[]> = {};
  try {
    all = JSON.parse(localStorage.getItem(IDENTITIES) ?? "{}") as Record<string, LinkedIdentity[]>;
  } catch {
    /* storage unavailable */
  }
  if (value) {
    all[user.id] = value;
    try {
      localStorage.setItem(IDENTITIES, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }
  return all[user.id] ?? [user.id === OWNER.id ? { id: "idn_github", provider: "github", email: user.email } : { id: "idn_email", provider: "email", email: user.email }];
}

const titleCase = (s: string) => s.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** Stands in for the real providers until they are wired up. Nothing leaves the browser. */
const listeners = new Set<(user: SessionUser | null) => void>();
const announce = (user: SessionUser | null) => listeners.forEach((l) => l(user));

export const mockSession: SessionClient = {
  configError: null,
  getSession: () => wait(read()),
  async signInWithProvider() {
    write(OWNER);
    announce(OWNER);
    return wait(OWNER);
  },
  async requestEmailLink(email) {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("Enter a valid email address.");
    pending(clean);
    await wait(null);
  },
  async completeEmailLink() {
    const address = pending();
    if (!address) throw new Error("This sign-in link has expired. Request a new one.");
    const user: SessionUser = { id: "usr_2", name: titleCase(address.split("@")[0]) || OWNER.name, email: address };
    pending(null);
    write(user);
    announce(user);
    return wait(user);
  },
  async signOut() {
    write(null);
    announce(null);
    await wait(null);
  },
  listIdentities: () => wait(identities(read())),
  /** Links at once, as if the provider had said yes. */
  async linkProvider(provider) {
    const user = read();
    if (!user) throw new Error("Sign in to continue.");
    const list = identities(user);
    if (!list.some((i) => i.provider === provider)) identities(user, [...list, { id: `idn_${provider}`, provider, email: user.email }]);
    await wait(null);
  },
  async unlinkIdentity(id) {
    const user = read();
    const list = identities(user);
    if (!list.some((i) => i.id === id)) throw new Error("That way to sign in is not linked to your account.");
    if (list.length < 2) throw new Error(LAST_METHOD);
    identities(user, list.filter((i) => i.id !== id));
    await wait(null);
  },
  subscribe(onChange) {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  },
};
