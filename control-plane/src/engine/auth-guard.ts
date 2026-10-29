/**
 * Keeps the control plane from getting its own address blocked by the engine (docs/network-allowlist.md, "The control
 * plane never blocks itself").
 *
 * The engine counts failed sign-ins per address: 5 on one database or 10 on all of them within 60 s block the address
 * (5 minutes, doubling up to an hour). Addresses in its --trusted-networks are never counted; the deployment trusts the
 * control plane's Docker network (infra/). If that is ever wrong, every failed sign-in of the Data Explorer and of the
 * provisioner counts, and some happen without anyone doing anything wrong: a master key rotation half applied, a
 * provisioner password changed in SSM but not in the engine, a customer's allowlist that leaves the control plane out.
 * Once the address is blocked on every database, the provisioner cannot make users for anyone.
 *
 * So the control plane counts its own failures the same way and stops signing in well before the engine's limits: at
 * most `perDatabase` failures per database and `total` per engine (region) in `windowMs`, of which the Data Explorer
 * may use all but `reserve`, kept for the provisioner. An attempt that has not succeeded yet holds a place, so a burst of
 * new connections cannot overshoot. Attempts made with a connection already signed in are not counted (they do not sign
 * in again). The window is the engine's or longer, and a failure is counted when the control plane sees it, which is
 * after the engine counted it: the guard's view is never more lenient than the engine's.
 */
export const ENGINE_LIMITS = { perDatabase: 5, total: 10, windowMs: 60_000 } as const;

export interface AuthGuardLimits { perDatabase: number; total: number; reserve: number; windowMs: number }
export const DEFAULT_LIMITS: AuthGuardLimits = { perDatabase: 2, total: 6, reserve: 2, windowMs: 60_000 };

export type AuthKind = "data" | "provisioner";

/** Thrown instead of signing in. The callers turn it into "unavailable" (try again later), never into the customer's fault. */
export class AuthGuardRefusal extends Error {
  readonly region: string;
  readonly authSource: string;
  constructor(region: string, authSource: string) {
    super("the control plane stopped signing in to the engine for a while after failed attempts");
    this.region = region;
    this.authSource = authSource;
  }
}

export interface AuthAttempt { done(ok: boolean): void }

export class AuthFailureGuard {
  readonly limits: AuthGuardLimits;
  private readonly now: () => number;
  /** region -> times of failures, with their database. */
  private readonly failures = new Map<string, { at: number; db: string }[]>();
  /** region -> attempts in flight, with their database. */
  private readonly flying = new Map<string, Map<object, string>>();

  constructor(o: Partial<AuthGuardLimits> & { now?: () => number } = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== "now")) };
    this.now = o.now ?? Date.now;
  }

  private recent(region: string): { at: number; db: string }[] {
    const all = (this.failures.get(region) ?? []).filter((f) => this.now() - f.at < this.limits.windowMs);
    this.failures.set(region, all);
    return all;
  }

  failuresInWindow(region: string, db?: string): number {
    return this.recent(region).filter((f) => db === undefined || f.db === db).length;
  }

  /** May this process sign in to `authSource` on the engine of `region` now? Throws AuthGuardRefusal if not. */
  begin(region: string, authSource: string, kind: AuthKind): AuthAttempt {
    const recent = this.recent(region);
    const flying = this.flying.get(region) ?? new Map<object, string>();
    this.flying.set(region, flying);
    const onDb = recent.filter((f) => f.db === authSource).length + [...flying.values()].filter((d) => d === authSource).length;
    const all = recent.length + flying.size;
    const cap = kind === "data" ? this.limits.total - this.limits.reserve : this.limits.total;
    if (onDb >= this.limits.perDatabase || all >= cap) throw new AuthGuardRefusal(region, authSource);
    const token = {};
    flying.set(token, authSource);
    let open = true;
    return {
      done: (ok: boolean) => {
        if (!open) return;
        open = false;
        flying.delete(token);
        if (!ok) this.recent(region).push({ at: this.now(), db: authSource });
      },
    };
  }

  /** A failed sign-in that did not go through begin() (a client that had signed in before): counted all the same. */
  failed(region: string, authSource: string): void {
    this.recent(region).push({ at: this.now(), db: authSource });
  }

  /** For logs and tests: failures per region in the window. Addresses and names of databases only, never a credential. */
  state(): Record<string, number> {
    return Object.fromEntries([...this.failures.keys()].map((r) => [r, this.recent(r).length]));
  }
}

/** One per process: the Data Explorer and the provisioner sign in from the same address, so they share the engine's counters. */
export const processAuthGuard = new AuthFailureGuard();
