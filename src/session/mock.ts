import type { SessionClient, SessionUser } from "./client";

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

const titleCase = (s: string) => s.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** Stands in for the real providers until they are wired up. Nothing leaves the browser. */
export const mockSession: SessionClient = {
  getSession: () => wait(read()),
  async signInWithProvider() {
    write(OWNER);
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
    return wait(user);
  },
  async signOut() {
    write(null);
    await wait(null);
  },
};
