/**
 * Where to go after signing in (audit G-1686). A signed-out person who opens a deep link (a run or a defect from a pull
 * request comment) is asked to sign in; the provider and the email link always come back to the site root, so the
 * path they asked for is kept here (localStorage: an email link may open in another tab) for one hour and used once.
 * Only a path on this site is kept: never another origin, never a protocol-relative "//host".
 */
const KEY = "fenvix-return-path";
const TTL_MS = 60 * 60 * 1000;

/** A path on this site worth returning to: absolute, not "//", not the root or the sign-in callback. */
export function safeReturnPath(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  const bare = path.split(/[?#]/)[0];
  if (bare === "/" || bare === "/overview" || bare === "/invite") return null;
  if (/[?&](code|error|error_description)=/.test(path)) return null;
  return path;
}

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function rememberReturnPath(path: string, now = Date.now()): void {
  const p = safeReturnPath(path);
  const s = store();
  if (!s) return;
  try {
    if (p) s.setItem(KEY, JSON.stringify({ p, at: now }));
  } catch {
    /* storage full or blocked: the person lands on the root, as before */
  }
}

/** The kept path, once: it is removed as it is read. Null when none, expired, or not safe. */
export function takeReturnPath(now = Date.now()): string | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(KEY);
    s.removeItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { p?: unknown; at?: unknown };
    if (typeof v.p !== "string" || typeof v.at !== "number" || now - v.at > TTL_MS) return null;
    return safeReturnPath(v.p);
  } catch {
    return null;
  }
}

/** Fired by the API client when the API answers 401: the session is over (src/data/api-browser.ts). */
export const SESSION_ENDED_EVENT = "fenvix:session-ended";
const ENDED_KEY = "fenvix-session-ended";

export function markSessionEnded(): void {
  try {
    window.sessionStorage.setItem(ENDED_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** True once after a 401 sent the person back to sign in: the sign-in page says why. */
export function takeSessionEnded(): boolean {
  try {
    const v = window.sessionStorage.getItem(ENDED_KEY) === "1";
    window.sessionStorage.removeItem(ENDED_KEY);
    return v;
  } catch {
    return false;
  }
}
