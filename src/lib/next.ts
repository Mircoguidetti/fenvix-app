/**
 * Where to go after sign-in. A signed-out visit to any console URL goes to /welcome?next=<path and query>; after
 * sign-in the browser returns there, but only to a path of this same site: it must start with "/", not with "//" or
 * "/\" (both read as another host), and must resolve to this origin. Anything else goes to "/". No open redirect.
 *
 * `next` is also kept in sessionStorage (this tab only), so it survives the round-trip to GitHub or Google, which
 * come back to the site root.
 */
const KEY = "fenvix-next";

export function safeNext(raw: string | null | undefined, origin: string): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Browsers ignore tabs and newlines inside URLs: "/\t/evil.com" would read as "//evil.com".
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin) return "/";
    // Normalising can make a path start with "//" again ("/..//evil.com" -> "//evil.com"): check the result too.
    const out = `${url.pathname}${url.search}${url.hash}`;
    return out.startsWith("//") || out.startsWith("/\\") ? "/" : out;
  } catch {
    return "/";
  }
}

/** The welcome URL for a signed-out visit to `path` (path, query and hash of the address asked for). */
export function welcomeUrl(path: string): string {
  return path === "/" || path === "" ? "/welcome" : `/welcome?next=${encodeURIComponent(path)}`;
}

export function rememberNext(next: string): void {
  try {
    sessionStorage.setItem(KEY, next);
  } catch {
    /* storage blocked: the query string still carries it */
  }
}

/** The stored `next`, if any (read without removing it: React may render twice). */
export function storedNext(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetNext(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
