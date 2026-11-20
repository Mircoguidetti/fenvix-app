import type { SessionClient, SessionUser } from "./client";
import { connectProblem, type SignInMethod } from "./methods";

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

/** The signed-in mock user, for the other mocks (organizations). */
export const mockCurrentUser = (): SessionUser | null => read();

const titleCase = (s: string) => s.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** The mock account's sign-in methods (this tab only). Starts with the one used to sign in. */
let methods: SignInMethod[] | null = null;
const methodsOf = (user: SessionUser | null): SignInMethod[] =>
  (methods ??= user ? [{ id: "idn_1", kind: user.id === "usr_2" ? "email" : "github", email: user.email }] : []);

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
  async listSignInMethods() {
    return wait([...methodsOf(read())]);
  },
  async connectProvider(provider) {
    const all = methodsOf(read());
    if (all.some((m) => m.kind === provider)) throw new Error(connectProblem("identity_already_exists", null));
    all.push({ id: `idn_${all.length + 1}_${provider}`, kind: provider, email: read()?.email ?? null });
    await wait(null);
  },
  async disconnect(methodId) {
    const all = methodsOf(read());
    if (all.length < 2) throw new Error(connectProblem("single_identity_not_deletable", null));
    methods = all.filter((m) => m.id !== methodId);
    await wait(null);
  },
  async signOut() {
    methods = null;
    write(null);
    announce(null);
    await wait(null);
  },
  subscribe(onChange) {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  },
};
