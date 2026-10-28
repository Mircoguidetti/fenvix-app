/**
 * Secrets that are shown once and kept nowhere: the password of a database's initial user (docs/database-users.md).
 *
 * The operation that creates the user makes the password here (in this process's memory only), and the request that
 * started the operation takes it out to put it in its answer. Taking removes it, so it is never shown twice; whatever
 * is not taken is forgotten after `ttlMs`. Nothing here is written to Postgres, a log or an idempotency record. With
 * several instances, or after a restart, a password made elsewhere is simply not available here: the answer then says
 * so and the customer resets it.
 */
export class OnceSecrets {
  private readonly m = new Map<string, { value: string; expires: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 10 * 60_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** The secret of `key`, made with `make` the first time (and again once it has expired). */
  getOrMake(key: string, make: () => string): string {
    this.sweep();
    const e = this.m.get(key);
    if (e) return e.value;
    const value = make();
    this.m.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  /** The secret, removed: a second take gets null. */
  take(key: string): string | null {
    this.sweep();
    const e = this.m.get(key);
    this.m.delete(key);
    return e ? e.value : null;
  }

  forget(key: string): void { this.m.delete(key); }

  get size(): number { this.sweep(); return this.m.size; }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.m) if (e.expires <= t) this.m.delete(k);
  }
}
