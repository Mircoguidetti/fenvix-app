import type { SessionClient, SessionUser } from "./client";

const KEY = "fenvix-session";
const wait = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 150));

let pendingEmail: string | null = null;
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

const titleCase = (s: string) => s.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** Fake sign-in: no network, no credentials. The session is kept in this browser only. */
export const mockSession: SessionClient = {
  isSample: true,
  getSession: () => wait(read()),
  async signInWithProvider(provider) {
    const user: SessionUser = provider === "github" ? { id: "usr_github", name: "Ada Sample", email: "ada@example.com" } : { id: "usr_google", name: "Grace Sample", email: "grace@example.com" };
    write(user);
    return wait(user);
  },
  async requestEmailLink(email) {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("Enter a valid email address.");
    pendingEmail = clean;
    await wait(null);
  },
  async completeEmailLink() {
    if (!pendingEmail) throw new Error("This sign-in link has expired. Request a new one.");
    const user: SessionUser = { id: "usr_email", name: titleCase(pendingEmail.split("@")[0]) || "Sample User", email: pendingEmail };
    pendingEmail = null;
    write(user);
    return wait(user);
  },
  async signOut() {
    write(null);
    await wait(null);
  },
};
